import type { BlockId } from '@optimystic/db-core';
import { hashKey, type RingCoord } from 'p2p-fret';
import { peerIdFromString } from '@libp2p/peer-id';
import type { BlockArchive, RestoreCallback } from './struct.js';
import { SyncClient } from '../sync/client.js';
import type { IPeerNetwork } from '@optimystic/db-core';
import type { ArachnodeFretAdapter } from './arachnode-fret-adapter.js';
import { partitionCovers } from './arachnode-partition.js';
import { createLogger } from '../logger.js';

/**
 * Coordinates block restoration across discovered Arachnode storage rings.
 *
 * Queries rings in order of broader coverage (inner rings first):
 * 1. Transaction ring peers (my ring)
 * 2. Inner storage rings (Ring N-1, N-2, ..., Ring 0)
 *
 * Each ring is discovered dynamically via FRET neighbor snapshots.
 */
export class RestorationCoordinator {
	private readonly metrics = {
		totalRequests: 0,
		successByRing: new Map<number, number>(),
		failureByRing: new Map<number, number>(),
		averageDurationMs: 0
	};

	constructor(
		private readonly fretAdapter: ArachnodeFretAdapter,
		private readonly peerNetwork: IPeerNetwork,
		private readonly protocolPrefix: string,
		/** Optional self peer id — used to skip dialing self on solo/bootstrap nodes. */
		private readonly selfPeerId?: string
	) {}

	private readonly log = createLogger('storage:restoration')

	/**
	 * Restore a block by querying discovered storage rings.
	 */
	async restore(blockId: BlockId, rev?: number): Promise<BlockArchive | undefined> {
		const startTime = Date.now();
		this.metrics.totalRequests++;

		// Hash the block id once into the shared coordinate space. Peer responsibility
		// (RingSelector.calculatePartition) and cohort assembly both operate on hashed
		// coords, so restoration must filter in the same space — see getMyRingPeers and
		// filterByPartition below, which reuse this value.
		const blockCoord = await hashKey(new TextEncoder().encode(blockId));

		// 1. Try my transaction ring peers first
		const myPeers = this.getMyRingPeers(blockCoord);
		const myRingDepth = this.getMyRingDepth();

		// Avoid dialing self: on a solo/bootstrap node with no listenAddrs, dialing self
		// either hangs or fails noisily. Filter self out of the ring-peer list so the loop
		// below can no-op cleanly when self is the only candidate.
		const nonSelfMyPeers = this.selfPeerId
			? myPeers.filter(p => p !== this.selfPeerId)
			: myPeers;
		if (nonSelfMyPeers.length === 0 && myRingDepth <= 0) {
			this.log('restore:solo-node-skip blockId=%s', blockId);
			return undefined;
		}

		for (const peerId of nonSelfMyPeers) {
			const archive = await this.queryPeer(peerId, blockId, rev);
			if (archive) {
				this.recordSuccess(myRingDepth, blockId, Date.now() - startTime);
				return archive;
			}
		}
		// My transaction ring was queried and yielded nothing — count it as one ring failure.
		this.recordFailure(myRingDepth);

		// 2. Try inner storage rings (broader coverage)
		for (let ringDepth = myRingDepth - 1; ringDepth >= 0; ringDepth--) {
			const storagePeers = this.fretAdapter.findPeersAtRing(ringDepth);

			// Filter to peers responsible for this block's partition (skip self — cannot dial self).
			const responsiblePeers = this.filterByPartition(storagePeers, blockCoord, ringDepth)
				.filter(p => !this.selfPeerId || p !== this.selfPeerId);

			for (const peerIdStr of responsiblePeers) {
				const archive = await this.queryPeer(peerIdStr, blockId, rev);
				if (archive) {
					this.recordSuccess(ringDepth, blockId, Date.now() - startTime);
					return archive;
				}
			}
			// This inner ring was queried and yielded nothing — count it as one ring failure.
			this.recordFailure(ringDepth);
		}

		// No ring had the data
		const duration = Date.now() - startTime;
		this.log('restore failed for block %s after %dms', blockId, duration)
		return undefined;
	}

	/**
	 * Create a RestoreCallback function that uses this coordinator.
	 */
	createRestoreCallback(): RestoreCallback {
		return async (blockId: BlockId, rev?: number) => {
			return await this.restore(blockId, rev);
		};
	}

	/**
	 * Get peers in my transaction ring for a given block.
	 * @param blockCoord the block id already hashed into the shared coordinate space.
	 */
	private getMyRingPeers(blockCoord: RingCoord): string[] {
		return this.fretAdapter.getFret().assembleCohort(blockCoord, 10);
	}

	/**
	 * Get my own ring depth from Arachnode info.
	 */
	private getMyRingDepth(): number {
		const myInfo = this.fretAdapter.getMyArachnodeInfo();
		return myInfo?.ringDepth ?? 8; // Default to Ring 8
	}

	/**
	 * Filter peers by partition responsibility.
	 * @param blockCoord the block id hashed into the shared coordinate space (same space
	 *   RingSelector.calculatePartition uses for peer partitions).
	 */
	private filterByPartition(peers: string[], blockCoord: RingCoord, ringDepth: number): string[] {
		if (ringDepth === 0) {
			return peers; // Ring 0 covers all blocks
		}

		return peers.filter(peerId => {
			const info = this.fretAdapter.getArachnodeInfo(peerId);
			if (!info || !info.partition) return false;
			// Compare block prefix vs peer partition via the shared responsibility derivation.
			return partitionCovers(info.partition, blockCoord);
		});
	}

	/**
	 * Query a specific peer for a block.
	 */
	private async queryPeer(peerIdStr: string, blockId: BlockId, rev?: number): Promise<BlockArchive | undefined> {
		try {
			const peerId = peerIdFromString(peerIdStr);
			const client = new SyncClient(
				peerId,
				this.peerNetwork,
				this.protocolPrefix
			);

			const response = await client.requestBlock({ blockId, rev });
			return response.success ? response.archive : undefined;
		} catch (error) {
			this.log('queryPeer failed for %s - %o', peerIdStr, error)
			return undefined;
		}
	}

	/**
	 * Record successful restoration from a ring.
	 */
	private recordSuccess(ringDepth: number, blockId: BlockId, durationMs: number): void {
		const count = this.metrics.successByRing.get(ringDepth) ?? 0;
		this.metrics.successByRing.set(ringDepth, count + 1);

		// Update rolling average duration
		const totalSuccesses = Array.from(this.metrics.successByRing.values())
			.reduce((sum, c) => sum + c, 0);
		const prevTotal = this.metrics.averageDurationMs * (totalSuccesses - 1);
		this.metrics.averageDurationMs = (prevTotal + durationMs) / totalSuccesses;

		this.log('[Ring %d] Successfully restored block %s in %dms', ringDepth, blockId, durationMs);
	}

	/**
	 * Record that a ring was queried during a restore but did not yield the block.
	 * Counterpart to {@link recordSuccess}: the ring — not the individual peer query — is the
	 * failure unit, so this increments once per exhausted ring at the points where the peer
	 * loops in {@link restore} complete without returning an archive.
	 */
	private recordFailure(ringDepth: number): void {
		const count = this.metrics.failureByRing.get(ringDepth) ?? 0;
		this.metrics.failureByRing.set(ringDepth, count + 1);
	}

	/**
	 * Get restoration metrics for monitoring.
	 */
	getMetrics(): {
		totalRequests: number;
		successByRing: Map<number, number>;
		failureByRing: Map<number, number>;
		averageDurationMs: number;
	} {
		// Copy the Maps: a bare `{ ...this.metrics }` spreads only the top level, handing the
		// caller the SAME Map instances this coordinator keeps mutating — the snapshot would
		// then change under the caller's feet, and a caller mutation would corrupt internal state.
		return {
			totalRequests: this.metrics.totalRequests,
			successByRing: new Map(this.metrics.successByRing),
			failureByRing: new Map(this.metrics.failureByRing),
			averageDurationMs: this.metrics.averageDurationMs
		};
	}
}

