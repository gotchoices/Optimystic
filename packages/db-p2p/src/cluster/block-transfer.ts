import type { IRepo, IPeerNetwork } from '@optimystic/db-core';
import { peerIdFromString } from '@libp2p/peer-id';
import type { PartitionDetector } from './partition-detector.js';
import type { RestorationCoordinator } from '../storage/restoration-coordinator-v2.js';
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
	 * Handle a complete rebalance event — pull gained, push lost.
	 */
	async handleRebalanceEvent(event: RebalanceEvent): Promise<void> {
		log('rebalance:start gained=%d lost=%d', event.gained.length, event.lost.length);

		const [pullResult, pushResult] = await Promise.all([
			event.gained.length > 0 ? this.pullBlocks(event.gained) : { succeeded: [], failed: [] },
			event.lost.length > 0 && event.newOwners.size > 0
				? this.pushBlocks(event.lost, event.newOwners)
				: { succeeded: [], failed: [] }
		]);

		log('rebalance:done pull=%d/%d push=%d/%d',
			pullResult.succeeded.length, event.gained.length,
			pushResult.succeeded.length, event.lost.length);
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
