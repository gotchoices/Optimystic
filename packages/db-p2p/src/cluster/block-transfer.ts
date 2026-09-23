import type { IPeerNetwork } from '@optimystic/db-core';
import type { PartitionDetector } from './partition-detector.js';
import type { ProofRetainingRepo } from '../storage/block-archive.js';
import { pushBlockToPeers, type PushBlockOutcome, type PushRefusal } from './block-transfer-service.js';
import type { GrowthOutcome, RebalanceEvent } from './rebalance-monitor.js';
import { createLogger } from '../logger.js';

const log = createLogger('block-transfer');

/** One line per peer that did not confirm, under the calling path's tag (`push` / `confirm`). */
function logRefusals(path: 'push' | 'confirm', blockId: string, refusals: readonly PushRefusal[]): void {
	for (const refusal of refusals) {
		if (refusal.reason === 'unreachable') {
			log('%s:peer-error block=%s peer=%s err=%s', path, blockId, refusal.peerId, refusal.error);
		} else {
			log('%s:peer-rejected block=%s peer=%s (receiver did not persist)', path, blockId, refusal.peerId);
		}
	}
}

export interface BlockTransferConfig {
	/** Max concurrent transfers. Default: 4 */
	maxConcurrency?: number;
	/**
	 * Timeout per block transfer (ms). Default: 30000. A push or confirm is bounded PER PEER, as two
	 * deadlines of this length: one on the dial and one on the reply (the
	 * `BlockTransferClient.pushBlocks` deadlines, which abort the dial and tear down a silent stream
	 * rather than leaving them running).
	 */
	transferTimeoutMs?: number;
	/** Retry attempts for failed transfers. Default: 2 */
	maxRetries?: number;
	/** Whether to push blocks to new owners proactively. Default: true */
	enablePush?: boolean;
}

/**
 * Outcome of reacting to a {@link RebalanceEvent}. The `released` list is the gate the caller opens
 * before it may stop serving a lost block: a block appears here ONLY after it was confirmed
 * replicated to the event's floor of new owners. Everything in `retained` stays tracked and served
 * (its push failed, was partition-skipped, or could not reach the floor) and is retried on the next
 * rebalance. See `docs/arachnode-ring-handoff.md` § Part 2.
 */
export interface RebalanceReactionResult {
	/** Lost blocks confirmed replicated to ≥ floor new owners — safe to release. */
	released: string[];
	/** Lost blocks whose replication could not be confirmed — keep serving, retry later. */
	retained: string[];
	/** Grown blocks confirmed pushed to every newly co-responsible peer (capped by the floor). */
	replicated: string[];
	/**
	 * Grown blocks that could not be confirmed on the new peers this pass. Nothing is released off
	 * this list — the node keeps the block either way. The retry lives in the monitor: the caller
	 * feeds each block's {@link GrowthOutcome} (in `growth`) back via
	 * `RebalanceMonitor.recordGrowthOutcome`, so an unconfirmed peer stays out of the seen set and
	 * the next check re-detects it.
	 */
	underReplicated: string[];
	/**
	 * Per-block feedback for the growth arm, keyed by block id. A block reported `grown` that the
	 * reaction had NO information about (its confirm was deduped against one already in flight) has
	 * no entry — the monitor must leave that block's state untouched.
	 */
	growth: Map<string, GrowthOutcome>;
}

/**
 * Coordinates block transfers in response to rebalance events.
 *
 * For lost blocks: confirms the block replicated to the floor of new responsible peers before
 * reporting it releasable (see {@link confirmReplicated}).
 *
 * For grown blocks (still owned, but a peer became newly co-responsible): pushes the block to those
 * peers (see {@link replicateGrown}).
 *
 * A block this node has GAINED responsibility for needs no reaction here: `RebalanceMonitor` reports
 * `gained` only for a block in its tracked set, and that set holds what this node's own storage
 * already has (see `RebalanceEvent.gained`'s doc), so there is nothing to fetch.
 */
export class BlockTransferCoordinator {
	private readonly maxConcurrency: number;
	private readonly transferTimeoutMs: number;
	private readonly maxRetries: number;
	private readonly enablePush: boolean;
	private inFlight = new Set<string>();
	private concurrency = 0;
	private readonly waitQueue: Array<() => void> = [];

	constructor(
		/**
		 * The node's OWN store, proof accessor REQUIRED (not the optional `ArchiveServingRepo`
		 * shape): every push this class makes is certified out of it, and a repo without the
		 * accessor would make `sourceBlockCertification` return meta-only for every block — so
		 * every push would be refused by a receiver running the default `requirePushCertificate`,
		 * silently and with no type error. Same reasoning as `createServedRepoProxy`'s.
		 */
		private readonly repo: ProofRetainingRepo,
		private readonly peerNetwork: IPeerNetwork,
		private readonly partitionDetector: PartitionDetector,
		private readonly protocolPrefix: string = '',
		config: BlockTransferConfig = {}
	) {
		this.maxConcurrency = config.maxConcurrency ?? 4;
		this.transferTimeoutMs = config.transferTimeoutMs ?? 30000;
		this.maxRetries = config.maxRetries ?? 2;
		this.enablePush = config.enablePush ?? true;
	}

	/**
	 * Push blocks that this node has lost responsibility for to new owners, stopping at the first
	 * owner that accepts each.
	 *
	 * NOTE: nothing in `src` calls this. The lost-block arm of {@link handleRebalanceEvent} moved to
	 * {@link confirmReplicated} (which must count holders, not stop at one) when release became
	 * confirm-gated, and `enablePush` — the only config field this method reads — is likewise
	 * unreachable: `libp2p-node-base` constructs this class with no {@link BlockTransferConfig} at
	 * all. Kept as the fire-and-forget primitive for a caller that wants placement without a floor;
	 * delete it, and `enablePush` with it, if none appears.
	 */
	async pushBlocks(
		blockIds: string[],
		newOwners: Map<string, string[]>
	): Promise<{ succeeded: string[]; failed: string[] }> {
		if (!this.enablePush) {
			return { succeeded: [], failed: [] };
		}
		if (this.partitionDetector.detectPartition()) {
			log('push:partition-detected, skipping %d blocks', blockIds.length);
			return { succeeded: [], failed: blockIds };
		}

		const succeeded: string[] = [];
		const failed: string[] = [];

		const ids = blockIds.filter(id => !this.inFlight.has(`push:${id}`) && newOwners.has(id));

		await Promise.all(ids.map(id => this.executePush(id, newOwners, succeeded, failed)));

		return { succeeded, failed };
	}

	/**
	 * Handle a complete rebalance event — **confirm** lost blocks replicated to the floor before
	 * reporting them releasable, and push grown blocks to their newly co-responsible peers.
	 *
	 * `event.gained` is deliberately not acted on here. `RebalanceMonitor` reports `gained` only for a
	 * block in its tracked set (see `RebalanceEvent.gained`'s doc), and that set is built from this
	 * node's own storage — its commits, the replicas it received, the blocks it repaired, plus the
	 * restart seed's scan of its own metadata store — so there is nothing to fetch. The one entry that
	 * is not committed content is the seed's accepted over-inclusion of pend-only blocks
	 * (`seedOwnedBlocksFromStorage`'s NOTE), and fetching for those would be wrong rather than
	 * missing: a pend is not a committed revision anyone can serve.
	 *
	 * NOTE: if `trackedBlocks` ever grows a source that reports a COMMITTED block this node does not
	 * hold (a declared-placement feed, say), a pull hook would belong here — but it would have to
	 * persist and verify what it fetched first, the way `cluster/reconcile-block.ts`'s corroborating
	 * repair does, not adopt a single unverified peer's answer the way `RestorationCoordinator.restore`
	 * does.
	 *
	 * The lost path pushes to confirm, not fire-and-forget: it runs {@link confirmReplicated} against
	 * the event's `newOwners` and `floor`, so `released` contains only blocks that landed on ≥ floor
	 * new owners. The caller gates its `untrackBlock` (release + GC-eligibility) on `released` and
	 * leaves `retained` blocks tracked/served for the next rebalance. This closes the
	 * release-before-confirm hole (`docs/arachnode-ring-handoff.md` § Why the current code violates it
	 * #2).
	 */
	async handleRebalanceEvent(event: RebalanceEvent): Promise<RebalanceReactionResult> {
		log('rebalance:start gained=%d lost=%d grown=%d floor=%d',
			event.gained.length, event.lost.length, event.grown.size, event.floor);

		const floor = Math.max(1, event.floor);
		const [confirmResult, growResult] = await Promise.all([
			event.lost.length > 0 && event.newOwners.size > 0
				? this.confirmReplicated(event.lost, event.newOwners, floor)
				: { confirmed: [], unconfirmed: [...event.lost] },
			this.replicateGrown(event.grown, floor)
		]);

		log('rebalance:done released=%d/%d replicated=%d/%d',
			confirmResult.confirmed.length, event.lost.length,
			growResult.confirmed.length, event.grown.size);

		return {
			released: confirmResult.confirmed,
			retained: confirmResult.unconfirmed,
			replicated: growResult.confirmed,
			underReplicated: growResult.unconfirmed,
			growth: growResult.growth
		};
	}

	/**
	 * Push each GROWN block (still owned; new peers became co-responsible) to its newly
	 * co-responsible peers, reusing {@link executeConfirm} per block. The per-block floor is
	 * `min(event floor, new-peer count)`: passing the raw event floor would be wrong when fewer new
	 * peers exist than the floor — `executeConfirm` could then never reach the floor and would burn
	 * `maxRetries` re-pushing peers that already accepted. Nothing is released off this path (the
	 * node KEEPS the block either way); the confirmed/unconfirmed split is reporting only. The
	 * in-flight `confirm:<id>` key dedups against a concurrent lost-confirm for the same block —
	 * such a block gets NO `growth` entry (no information), so the monitor leaves it untouched.
	 * `enablePush` deliberately does not gate this (same rationale as the NOTE in
	 * {@link confirmReplicated}); the growth arm as a whole is gated by the `rebalance.enabled`
	 * wiring in `libp2p-node-base`.
	 *
	 * Per-block {@link GrowthOutcome} rules:
	 * - floor met → all reported peers satisfied, complete. Deliberately includes peers
	 *   `executeConfirm` skipped once the floor was reached — the block is adequately replicated,
	 *   and re-pushing the remainder on every check forever would be a live loop.
	 * - no local data → all reported peers satisfied, complete (nothing to replicate; see NOTE).
	 * - otherwise → only the peers that actually confirmed, incomplete (retried by the monitor).
	 */
	private async replicateGrown(
		grown: Map<string, string[]>,
		floor: number
	): Promise<{ confirmed: string[]; unconfirmed: string[]; growth: Map<string, GrowthOutcome> }> {
		const confirmed: string[] = [];
		const unconfirmed: string[] = [];
		const growth = new Map<string, GrowthOutcome>();
		if (grown.size === 0) {
			return { confirmed, unconfirmed, growth };
		}

		if (this.partitionDetector.detectPartition()) {
			// Mirrors confirmReplicated's guard (replicateGrown drives executeConfirm directly). An
			// incomplete outcome with nothing satisfied keeps every reported peer un-seen AND counts an
			// attempt, so a partition mid-reaction is retried like any other failed push.
			log('grow:partition-detected, leaving %d blocks unconfirmed', grown.size);
			for (const [blockId, newPeers] of grown) {
				if (newPeers.length === 0) continue;
				unconfirmed.push(blockId);
				growth.set(blockId, { satisfiedPeers: [], complete: false });
			}
			return { confirmed, unconfirmed, growth };
		}

		await Promise.all([...grown.entries()].map(async ([blockId, newPeers]) => {
			if (newPeers.length === 0) return;
			const result = await this.executeConfirm(
				blockId,
				new Map([[blockId, newPeers]]),
				Math.min(floor, newPeers.length) // both ≥ 1 here: the caller clamps floor, empty newPeers returned above
			);
			if (result === null) return; // confirm already in flight — no information, no entry
			if (result.confirmed) {
				confirmed.push(blockId);
				growth.set(blockId, { satisfiedPeers: [...newPeers], complete: true });
			} else if (result.noLocalData) {
				// NOTE: nothing local to push — a tracked block this node cannot read (the restart
				// seed's pend-only over-inclusion, or a read that came back empty). The reported peers are
				// recorded satisfied so this does not become a permanent retry loop; nothing is lost by
				// it, since a block this node cannot read is one it cannot replicate FROM, and these
				// cohort peers are exactly the holders a later read repair would fetch it from. If the
				// node later obtains the block by another route (a fresh local commit, a spread push),
				// these peers stay recorded and are never pushed — benign for the same reason.
				unconfirmed.push(blockId);
				growth.set(blockId, { satisfiedPeers: [...newPeers], complete: true });
			} else {
				unconfirmed.push(blockId);
				growth.set(blockId, { satisfiedPeers: [...result.confirmedPeers], complete: false });
			}
		}));

		return { confirmed, unconfirmed, growth };
	}

	/**
	 * Confirm each block is replicated to at least `floor` qualifying owners — the gate the ring-shift
	 * handoff (Phase B) and the rebalance release both open before a block may stop being served.
	 *
	 * For each block, this pushes to the candidate owners and counts how many report holding a current
	 * replica: a holder confirms when the push response does NOT list the block in `missing` (it either
	 * already had it or accepted the push — `handlePush` reports `accepted` only on a received-AND-persisted
	 * block). A block is `confirmed` only when that count reaches `floor`; otherwise it is `unconfirmed`
	 * and the caller keeps serving it. Per-block timeout + retry mirror {@link pushBlocks}. During a
	 * detected partition every block is left unconfirmed (consistent with the push guard), so a partition
	 * mid-handoff aborts rather than releases.
	 *
	 * @param owners  blockId → candidate owner peer ids. The caller MUST have already excluded self and
	 *   any same-range mover (a peer shedding the same sub-range), so every id here is a qualifying holder.
	 * @param floor   required confirming owners per block (the replication floor `N`).
	 */
	async confirmReplicated(
		blockIds: string[],
		owners: Map<string, string[]>,
		floor: number
	): Promise<{ confirmed: string[]; unconfirmed: string[] }> {
		// NOTE: unlike pushBlocks, this deliberately does NOT honor `enablePush` — confirmation
		// fundamentally requires pushing to verify replication, and skipping it would leave every
		// block unconfirmed → never released → the node never sheds. So `enablePush:false` no longer
		// suppresses pushes on the rebalance/handoff release path (it only gates the legacy pushBlocks
		// fire-and-forget). If a config ever needs "never move data at all", gate the release wiring,
		// not this primitive.
		if (this.partitionDetector.detectPartition()) {
			log('confirm:partition-detected, leaving %d blocks unconfirmed', blockIds.length);
			return { confirmed: [], unconfirmed: [...blockIds] };
		}
		if (floor <= 0) {
			// A non-positive floor cannot be safely "met"; refuse to release rather than release for free.
			return { confirmed: [], unconfirmed: [...blockIds] };
		}

		const confirmed: string[] = [];
		const unconfirmed: string[] = [];

		const ids = blockIds.filter(id => !this.inFlight.has(`confirm:${id}`));
		await Promise.all(ids.map(async id => {
			const result = await this.executeConfirm(id, owners, floor);
			if (result === null) return; // raced into flight after the filter — no information
			(result.confirmed ? confirmed : unconfirmed).push(id);
		}));

		return { confirmed, unconfirmed };
	}

	private async executePush(
		blockId: string,
		newOwners: Map<string, string[]>,
		succeeded: string[],
		failed: string[]
	): Promise<void> {
		const key = `push:${blockId}`;
		if (this.inFlight.has(key)) return;
		this.inFlight.add(key);

		try {
			const owners = newOwners.get(blockId);
			if (!owners || owners.length === 0) {
				failed.push(blockId);
				return;
			}

			for (let attempt = 0; ; attempt++) {
				await this.acquireSemaphore();
				let pushed = false;
				try {
					// The shared read-certify-push loop, stopping at the FIRST new owner that accepts. A
					// receiver running the default `requirePushCertificate` rejects a push with no proof,
					// so a block whose proof this node never retained (pre-proof history, a diverged
					// commit) simply fails to place here and is retried/kept as today.
					const outcome = await this.pushBlock(blockId, owners, 1);
					if (outcome.status !== 'pushed') {
						log('push:no-local-data block=%s status=%s', blockId, outcome.status);
						failed.push(blockId);
						return;
					}
					logRefusals('push', blockId, outcome.refusals);
					pushed = outcome.confirmed.length > 0;
					if (pushed) log('push:ok block=%s peer=%s', blockId, outcome.confirmed[0]);
				} finally {
					this.releaseSemaphore();
				}

				if (pushed) {
					succeeded.push(blockId);
					return;
				}
				if (attempt < this.maxRetries) {
					log('push:retry block=%s attempt=%d', blockId, attempt + 1);
					await this.delay(this.backoffMs(attempt));
					continue;
				}
				log('push:failed block=%s', blockId);
				failed.push(blockId);
				return;
			}
		} finally {
			this.inFlight.delete(key);
		}
	}

	/**
	 * Confirm one block replicated to ≥ `floor` distinct qualifying owners. Reads the local block once
	 * per attempt, pushes to each candidate owner (stopping once the floor is reached), and counts
	 * distinct owners that report holding it (not `missing`). Retries the whole round up to
	 * `maxRetries` before giving up.
	 *
	 * Returns `null` when a confirm for this block is already in flight (no information — the caller
	 * must not record anything for it). Otherwise: `confirmed` iff the floor was met; `confirmedPeers`
	 * is the union of owners that confirmed across every attempt (a peer that accepted a push holds a
	 * replica even if a later round missed it — the floor decision itself stays per-round, unchanged);
	 * `noLocalData` marks the nothing-local-to-push case. The lost-block release path uses only
	 * `confirmed`; the growth arm consumes the other two.
	 */
	private async executeConfirm(
		blockId: string,
		owners: Map<string, string[]>,
		floor: number
	): Promise<{ confirmed: boolean; confirmedPeers: Set<string>; noLocalData: boolean } | null> {
		const key = `confirm:${blockId}`;
		if (this.inFlight.has(key)) return null;
		this.inFlight.add(key);

		try {
			const allConfirmedPeers = new Set<string>();
			const candidateOwners = owners.get(blockId) ?? [];
			if (candidateOwners.length === 0) {
				// No qualifying holder to confirm against — cannot release; keep serving.
				return { confirmed: false, confirmedPeers: allConfirmedPeers, noLocalData: false };
			}

			for (let attempt = 0; ; attempt++) {
				await this.acquireSemaphore();
				let confirmCount = 0;
				try {
					// The shared read-certify-push loop, once per attempt, stopping once `floor` DISTINCT
					// owners hold a current replica. A confirming holder either takes a certified replica
					// or reports the block missing (see executePush).
					const outcome = await this.pushBlock(blockId, candidateOwners, floor);
					if (outcome.status !== 'pushed') {
						// No local bytes to prove replication with — cannot confirm; keep serving. An
						// `unavailable` read (this node could not find out what it holds) is folded in
						// here as it always was: neither outcome can confirm anything.
						log('confirm:no-local-data block=%s status=%s', blockId, outcome.status);
						return { confirmed: false, confirmedPeers: allConfirmedPeers, noLocalData: true };
					}
					logRefusals('confirm', blockId, outcome.refusals);
					for (const peerId of outcome.confirmed) {
						// NOTE: allConfirmedPeers never un-records a peer. A holder that confirms in one
						// round and reports `missing` in a later one stays recorded, on the reasoning that
						// `handlePush` answers non-missing only after persisting. If the receiver ever
						// gains a path that drops a just-persisted block (an eviction sweep, a rejected
						// revision), the growth arm would record a peer that no longer holds a replica —
						// intersect against the LAST round's confirmed peers instead of unioning.
						allConfirmedPeers.add(peerId);
					}
					confirmCount = outcome.confirmed.length;
				} finally {
					this.releaseSemaphore();
				}

				if (confirmCount >= floor) {
					log('confirm:ok block=%s holders=%d/%d', blockId, confirmCount, floor);
					return { confirmed: true, confirmedPeers: allConfirmedPeers, noLocalData: false };
				}
				if (attempt < this.maxRetries) {
					log('confirm:retry block=%s holders=%d/%d attempt=%d', blockId, confirmCount, floor, attempt + 1);
					await this.delay(this.backoffMs(attempt));
					continue;
				}
				log('confirm:unmet block=%s holders=%d/%d', blockId, confirmCount, floor);
				return { confirmed: false, confirmedPeers: allConfirmedPeers, noLocalData: false };
			}
		} finally {
			this.inFlight.delete(key);
		}
	}

	/**
	 * This coordinator's binding of the shared push loop: rebalance reason, this node's protocol
	 * prefix, and `transferTimeoutMs` as BOTH per-peer deadlines (see {@link BlockTransferConfig}).
	 */
	private pushBlock(blockId: string, peerIds: readonly string[], stopAfterConfirmed: number): Promise<PushBlockOutcome> {
		return pushBlockToPeers(this.repo, this.peerNetwork, blockId, peerIds, {
			reason: 'rebalance',
			protocolPrefix: this.protocolPrefix,
			stopAfterConfirmed,
			dialTimeoutMs: this.transferTimeoutMs,
			responseTimeoutMs: this.transferTimeoutMs
		});
	}

	// --- Semaphore for concurrency limiting ---

	private async acquireSemaphore(): Promise<void> {
		if (this.concurrency < this.maxConcurrency) {
			this.concurrency++;
			return;
		}
		await new Promise<void>(resolve => this.waitQueue.push(resolve));
		this.concurrency++;
	}

	private releaseSemaphore(): void {
		this.concurrency--;
		const next = this.waitQueue.shift();
		if (next) next();
	}

	// --- Helpers ---

	private backoffMs(attempt: number): number {
		return Math.min(1000 * Math.pow(2, attempt), 10000);
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
