import type { BlockId, IRepo } from '@optimystic/db-core';
import type { PeerId, IPeerNetwork } from '@optimystic/db-core';
import { peerIdFromString } from '@libp2p/peer-id';
import type { PartitionDetector } from './partition-detector.js';
import type { RestorationCoordinator } from '../storage/restoration-coordinator-v2.js';
import { BlockTransferClient, type BlockTransferRequest, type BlockTransferResponse } from './block-transfer-service.js';
import { createLogger } from '../logger.js';

const log = createLogger('block-transfer');

/**
 * Rebalance event describing gained/lost block responsibilities.
 * Matches the RebalanceMonitor spec from the sibling ticket.
 */
export interface RebalanceEvent {
	/** Block IDs this node has gained responsibility for */
	gained: string[];
	/** Block IDs this node has lost responsibility for */
	lost: string[];
	/** Peers that are now closer for the lost blocks: blockId → peerId[] */
	newOwners: Map<string, string[]>;
	/** Timestamp of the topology change that triggered this */
	triggeredAt: number;
}

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

interface TransferTask {
	blockId: string;
	attempt: number;
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

		const tasks = blockIds
			.filter(id => !this.inFlight.has(`pull:${id}`))
			.map(id => ({ blockId: id, attempt: 0 }));

		await Promise.all(tasks.map(task => this.executePull(task, succeeded, failed)));

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

		const tasks = blockIds
			.filter(id => !this.inFlight.has(`push:${id}`) && newOwners.has(id))
			.map(id => ({ blockId: id, attempt: 0 }));

		await Promise.all(tasks.map(task => this.executePush(task, newOwners, succeeded, failed)));

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
		task: TransferTask,
		succeeded: string[],
		failed: string[]
	): Promise<void> {
		const key = `pull:${task.blockId}`;
		if (this.inFlight.has(key)) return;
		this.inFlight.add(key);

		try {
			await this.acquireSemaphore();
			try {
				const archive = await this.withTimeout(
					this.restorationCoordinator.restore(task.blockId),
					this.transferTimeoutMs
				);

				if (archive) {
					log('pull:ok block=%s', task.blockId);
					succeeded.push(task.blockId);
				} else if (task.attempt < this.maxRetries) {
					log('pull:retry block=%s attempt=%d', task.blockId, task.attempt + 1);
					this.inFlight.delete(key);
					await this.delay(this.backoffMs(task.attempt));
					await this.executePull({ ...task, attempt: task.attempt + 1 }, succeeded, failed);
					return;
				} else {
					log('pull:failed block=%s', task.blockId);
					failed.push(task.blockId);
				}
			} finally {
				this.releaseSemaphore();
			}
		} finally {
			this.inFlight.delete(key);
		}
	}

	private async executePush(
		task: TransferTask,
		newOwners: Map<string, string[]>,
		succeeded: string[],
		failed: string[]
	): Promise<void> {
		const key = `push:${task.blockId}`;
		if (this.inFlight.has(key)) return;
		this.inFlight.add(key);

		try {
			await this.acquireSemaphore();
			try {
				const owners = newOwners.get(task.blockId);
				if (!owners || owners.length === 0) {
					failed.push(task.blockId);
					return;
				}

				// Read block data from local storage
				const result = await this.repo.get({ blockIds: [task.blockId] });
				const blockResult = result[task.blockId];
				if (!blockResult?.block) {
					log('push:no-local-data block=%s', task.blockId);
					failed.push(task.blockId);
					return;
				}

				const blockData = new TextEncoder().encode(JSON.stringify(blockResult.block));

				// Push to at least one new owner
				let pushed = false;
				for (const ownerPeerIdStr of owners) {
					try {
						const peerId = peerIdFromString(ownerPeerIdStr);
						const client = new BlockTransferClient(peerId, this.peerNetwork, this.protocolPrefix);
						const response = await this.withTimeout(
							client.pushBlocks([task.blockId], [blockData]),
							this.transferTimeoutMs
						);

						if (response && !response.missing.includes(task.blockId)) {
							pushed = true;
							log('push:ok block=%s peer=%s', task.blockId, ownerPeerIdStr);
							break;
						}
					} catch (err) {
						log('push:peer-error block=%s peer=%s err=%s',
							task.blockId, ownerPeerIdStr, (err as Error).message);
					}
				}

				if (pushed) {
					succeeded.push(task.blockId);
				} else if (task.attempt < this.maxRetries) {
					log('push:retry block=%s attempt=%d', task.blockId, task.attempt + 1);
					this.inFlight.delete(key);
					await this.delay(this.backoffMs(task.attempt));
					await this.executePush({ ...task, attempt: task.attempt + 1 }, newOwners, succeeded, failed);
					return;
				} else {
					log('push:failed block=%s', task.blockId);
					failed.push(task.blockId);
				}
			} finally {
				this.releaseSemaphore();
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
