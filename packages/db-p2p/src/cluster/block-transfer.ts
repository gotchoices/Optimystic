import type { IRepo, IPeerNetwork } from '@optimystic/db-core';
import { peerIdFromString } from '@libp2p/peer-id';
import type { PartitionDetector } from './partition-detector.js';
import type { RestorationCoordinator } from '../storage/restoration-coordinator.js';
import { BlockTransferClient, sourceBlockMeta } from './block-transfer-service.js';
import type { GrowthOutcome, RebalanceEvent } from './rebalance-monitor.js';
import { createLogger } from '../logger.js';

const log = createLogger('block-transfer');

export interface BlockTransferConfig {
	/** Max concurrent transfers. Default: 4 */
	maxConcurrency?: number;
	/** Timeout per block transfer (ms). Default: 30000 */
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
	/** Gained blocks successfully pulled (now durably held locally). */
	pulled: string[];
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
 * For gained blocks: delegates to RestorationCoordinator.restore() which
 * already handles ring-based discovery and fetching.
 *
 * For lost blocks: proactively pushes block data to new responsible peers
 * via the BlockTransfer protocol.
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
		private readonly repo: IRepo,
		private readonly peerNetwork: IPeerNetwork,
		private readonly restorationCoordinator: RestorationCoordinator,
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
	 * Pull blocks that this node has gained responsibility for.
	 * Uses RestorationCoordinator to discover holders and fetch block data.
	 */
	async pullBlocks(blockIds: string[]): Promise<{ succeeded: string[]; failed: string[] }> {
		if (this.partitionDetector.detectPartition()) {
			log('pull:partition-detected, skipping %d blocks', blockIds.length);
			return { succeeded: [], failed: blockIds };
		}

		const succeeded: string[] = [];
		const failed: string[] = [];

		const ids = blockIds.filter(id => !this.inFlight.has(`pull:${id}`));

		await Promise.all(ids.map(id => this.executePull(id, succeeded, failed)));

		return { succeeded, failed };
	}

	/**
	 * Push blocks that this node has lost responsibility for to new owners.
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
	 * Handle a complete rebalance event — pull gained, and **confirm** lost blocks replicated to the
	 * floor before reporting them releasable.
	 *
	 * The lost path no longer pushes fire-and-forget: it runs {@link confirmReplicated} against the
	 * event's `newOwners` and `floor`, so `released` contains only blocks that landed on ≥ floor new
	 * owners. The caller gates its `untrackBlock` (release + GC-eligibility) on `released` and leaves
	 * `retained` blocks tracked/served for the next rebalance. This closes the release-before-confirm
	 * hole (`docs/arachnode-ring-handoff.md` § Why the current code violates it #2).
	 */
	async handleRebalanceEvent(event: RebalanceEvent): Promise<RebalanceReactionResult> {
		log('rebalance:start gained=%d lost=%d grown=%d floor=%d',
			event.gained.length, event.lost.length, event.grown.size, event.floor);

		const floor = Math.max(1, event.floor);
		const [pullResult, confirmResult, growResult] = await Promise.all([
			event.gained.length > 0 ? this.pullBlocks(event.gained) : { succeeded: [], failed: [] },
			event.lost.length > 0 && event.newOwners.size > 0
				? this.confirmReplicated(event.lost, event.newOwners, floor)
				: { confirmed: [], unconfirmed: [...event.lost] },
			this.replicateGrown(event.grown, floor)
		]);

		log('rebalance:done pull=%d/%d released=%d/%d replicated=%d/%d',
			pullResult.succeeded.length, event.gained.length,
			confirmResult.confirmed.length, event.lost.length,
			growResult.confirmed.length, event.grown.size);

		return {
			pulled: pullResult.succeeded,
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
				// NOTE: nothing local to replicate (the gained∩grown first-observation case) — the
				// reported peers are recorded satisfied so this does not become a permanent retry loop
				// (those cohort peers are the pull's own source). If the node later obtains the block by
				// another route (a fresh local commit, a spread push), these peers stay recorded and are
				// never pushed — benign today, since a gained block's data comes from these very peers.
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

	private async executePull(
		blockId: string,
		succeeded: string[],
		failed: string[]
	): Promise<void> {
		const key = `pull:${blockId}`;
		if (this.inFlight.has(key)) return;
		this.inFlight.add(key);

		try {
			for (let attempt = 0; ; attempt++) {
				await this.acquireSemaphore();
				let archive: Awaited<ReturnType<RestorationCoordinator['restore']>>;
				try {
					archive = await this.withTimeout(
						this.restorationCoordinator.restore(blockId),
						this.transferTimeoutMs
					);
				} finally {
					this.releaseSemaphore();
				}

				if (archive) {
					log('pull:ok block=%s', blockId);
					succeeded.push(blockId);
					return;
				}
				if (attempt < this.maxRetries) {
					log('pull:retry block=%s attempt=%d', blockId, attempt + 1);
					await this.delay(this.backoffMs(attempt));
					continue;
				}
				log('pull:failed block=%s', blockId);
				failed.push(blockId);
				return;
			}
		} finally {
			this.inFlight.delete(key);
		}
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
			for (let attempt = 0; ; attempt++) {
				await this.acquireSemaphore();
				let pushed = false;
				try {
					const owners = newOwners.get(blockId);
					if (!owners || owners.length === 0) {
						failed.push(blockId);
						return;
					}

					// Read block data from local storage
					const result = await this.repo.get({ blockIds: [blockId] });
					const blockResult = result[blockId];
					if (!blockResult?.block) {
						log('push:no-local-data block=%s', blockId);
						failed.push(blockId);
						return;
					}

					const blockData = new TextEncoder().encode(JSON.stringify(blockResult.block));
					const blockMeta = sourceBlockMeta(blockId, blockResult);

					// Push to at least one new owner
					for (const ownerPeerIdStr of owners) {
						try {
							const peerId = peerIdFromString(ownerPeerIdStr);
							const client = new BlockTransferClient(peerId, this.peerNetwork, this.protocolPrefix);
							const response = await this.withTimeout(
								client.pushBlocks([blockId], [blockData], 'rebalance', blockMeta),
								this.transferTimeoutMs
							);

							if (response && !response.missing.includes(blockId)) {
								pushed = true;
								log('push:ok block=%s peer=%s', blockId, ownerPeerIdStr);
								break;
							}
						} catch (err) {
							log('push:peer-error block=%s peer=%s err=%s',
								blockId, ownerPeerIdStr, (err as Error).message);
						}
					}
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
					// Read block data from local storage once per attempt.
					const result = await this.repo.get({ blockIds: [blockId] });
					const blockResult = result[blockId];
					if (!blockResult?.block) {
						// No local bytes to prove replication with — cannot confirm; keep serving.
						log('confirm:no-local-data block=%s', blockId);
						return { confirmed: false, confirmedPeers: allConfirmedPeers, noLocalData: true };
					}

					const blockData = new TextEncoder().encode(JSON.stringify(blockResult.block));
					const blockMeta = sourceBlockMeta(blockId, blockResult);

					// Count DISTINCT owners that hold a current replica; stop once the floor is reached.
					const confirmedPeers = new Set<string>();
					for (const ownerPeerIdStr of candidateOwners) {
						if (confirmedPeers.size >= floor) break;
						try {
							const peerId = peerIdFromString(ownerPeerIdStr);
							const client = new BlockTransferClient(peerId, this.peerNetwork, this.protocolPrefix);
							const response = await this.withTimeout(
								client.pushBlocks([blockId], [blockData], 'rebalance', blockMeta),
								this.transferTimeoutMs
							);
							if (response && !response.missing.includes(blockId)) {
								confirmedPeers.add(ownerPeerIdStr);
								// NOTE: allConfirmedPeers never un-records a peer. A holder that confirms in one
								// round and reports `missing` in a later one stays recorded, on the reasoning that
								// `handlePush` answers non-missing only after persisting. If the receiver ever
								// gains a path that drops a just-persisted block (an eviction sweep, a rejected
								// revision), the growth arm would record a peer that no longer holds a replica —
								// intersect against the LAST round's confirmedPeers instead of unioning.
								allConfirmedPeers.add(ownerPeerIdStr);
							}
						} catch (err) {
							log('confirm:peer-error block=%s peer=%s err=%s',
								blockId, ownerPeerIdStr, (err as Error).message);
						}
					}
					confirmCount = confirmedPeers.size;
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

	private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
		return Promise.race([
			promise,
			new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms))
		]);
	}
}
