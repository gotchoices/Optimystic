import type { IRepo, IPeerNetwork } from '@optimystic/db-core';
import { peerIdFromString } from '@libp2p/peer-id';
import type { PartitionDetector } from './partition-detector.js';
import type { RestorationCoordinator } from '../storage/restoration-coordinator.js';
import { BlockTransferClient } from './block-transfer-service.js';
import type { RebalanceEvent } from './rebalance-monitor.js';
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
		log('rebalance:start gained=%d lost=%d floor=%d', event.gained.length, event.lost.length, event.floor);

		const floor = Math.max(1, event.floor);
		const [pullResult, confirmResult] = await Promise.all([
			event.gained.length > 0 ? this.pullBlocks(event.gained) : { succeeded: [], failed: [] },
			event.lost.length > 0 && event.newOwners.size > 0
				? this.confirmReplicated(event.lost, event.newOwners, floor)
				: { confirmed: [], unconfirmed: [...event.lost] }
		]);

		log('rebalance:done pull=%d/%d released=%d/%d',
			pullResult.succeeded.length, event.gained.length,
			confirmResult.confirmed.length, event.lost.length);

		return {
			pulled: pullResult.succeeded,
			released: confirmResult.confirmed,
			retained: confirmResult.unconfirmed
		};
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
		await Promise.all(ids.map(id => this.executeConfirm(id, owners, floor, confirmed, unconfirmed)));

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

					// Push to at least one new owner
					for (const ownerPeerIdStr of owners) {
						try {
							const peerId = peerIdFromString(ownerPeerIdStr);
							const client = new BlockTransferClient(peerId, this.peerNetwork, this.protocolPrefix);
							const response = await this.withTimeout(
								client.pushBlocks([blockId], [blockData]),
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
	 * Confirm one block replicated to ≥ `floor` distinct qualifying owners. Reads the local block once,
	 * pushes to each candidate owner (stopping once the floor is reached), and counts distinct owners
	 * that report holding it (not `missing`). Retries the whole round up to `maxRetries` before giving
	 * up. Records the block in `confirmed` iff the floor was met, otherwise in `unconfirmed`.
	 */
	private async executeConfirm(
		blockId: string,
		owners: Map<string, string[]>,
		floor: number,
		confirmed: string[],
		unconfirmed: string[]
	): Promise<void> {
		const key = `confirm:${blockId}`;
		if (this.inFlight.has(key)) return;
		this.inFlight.add(key);

		try {
			const candidateOwners = owners.get(blockId) ?? [];
			if (candidateOwners.length === 0) {
				// No qualifying holder to confirm against — cannot release; keep serving.
				unconfirmed.push(blockId);
				return;
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
						unconfirmed.push(blockId);
						return;
					}

					const blockData = new TextEncoder().encode(JSON.stringify(blockResult.block));

					// Count DISTINCT owners that hold a current replica; stop once the floor is reached.
					const confirmedPeers = new Set<string>();
					for (const ownerPeerIdStr of candidateOwners) {
						if (confirmedPeers.size >= floor) break;
						try {
							const peerId = peerIdFromString(ownerPeerIdStr);
							const client = new BlockTransferClient(peerId, this.peerNetwork, this.protocolPrefix);
							const response = await this.withTimeout(
								client.pushBlocks([blockId], [blockData]),
								this.transferTimeoutMs
							);
							if (response && !response.missing.includes(blockId)) {
								confirmedPeers.add(ownerPeerIdStr);
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
					confirmed.push(blockId);
					return;
				}
				if (attempt < this.maxRetries) {
					log('confirm:retry block=%s holders=%d/%d attempt=%d', blockId, confirmCount, floor, attempt + 1);
					await this.delay(this.backoffMs(attempt));
					continue;
				}
				log('confirm:unmet block=%s holders=%d/%d', blockId, confirmCount, floor);
				unconfirmed.push(blockId);
				return;
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
