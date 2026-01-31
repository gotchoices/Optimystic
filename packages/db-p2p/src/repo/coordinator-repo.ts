import type { PendRequest, ActionBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, BlockGets, CommitRequest, RepoMessage, IKeyNetwork, ICluster, ClusterConsensusConfig, BlockId, ActionRev } from "@optimystic/db-core";
import { ClusterCoordinator } from "./cluster-coordinator.js";
import type { ClusterClient } from "../cluster/client.js";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { FretService } from "p2p-fret";
import { createLogger } from '../logger.js';

const log = createLogger('coordinator-repo');

/**
 * Extended cluster interface that includes the ability to check if a transaction was executed.
 * This is used by CoordinatorRepo to avoid duplicate execution.
 */
interface LocalClusterWithExecutionTracking extends ICluster {
	wasTransactionExecuted?(messageHash: string): boolean;
}

/**
 * Callback to query a cluster peer for their latest revision of a block.
 * Returns the peer's latest ActionRev if they have the block, undefined otherwise.
 */
export type ClusterLatestCallback = (peerId: PeerId, blockId: BlockId) => Promise<ActionRev | undefined>;

interface CoordinatorRepoComponents {
	storageRepo: IRepo;
	localCluster?: LocalClusterWithExecutionTracking;
	localPeerId?: PeerId;
	/**
	 * Optional callback to query cluster peers for their latest block revision.
	 * Used for read-path cluster verification to discover unknown revisions.
	 */
	clusterLatestCallback?: ClusterLatestCallback;
}

export function coordinatorRepo(
	keyNetwork: IKeyNetwork,
	createClusterClient: (peerId: PeerId) => ClusterClient,
	cfg?: Partial<ClusterConsensusConfig> & { clusterSize?: number },
	fretService?: FretService
): (components: CoordinatorRepoComponents) => CoordinatorRepo {
	return (components: CoordinatorRepoComponents) => new CoordinatorRepo(
		keyNetwork,
		createClusterClient,
		components.storageRepo,
		cfg,
		components.localCluster,
		components.localPeerId,
		fretService,
		components.clusterLatestCallback
	);
}

/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export class CoordinatorRepo implements IRepo {
	private coordinator: ClusterCoordinator;
	private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds default timeout

	constructor(
		readonly keyNetwork: IKeyNetwork,
		readonly createClusterClient: (peerId: PeerId) => ClusterClient,
		private readonly storageRepo: IRepo,
		cfg?: Partial<ClusterConsensusConfig> & { clusterSize?: number },
		localCluster?: LocalClusterWithExecutionTracking,
		localPeerId?: PeerId,
		fretService?: FretService,
		private readonly clusterLatestCallback?: ClusterLatestCallback
	) {
		const policy: ClusterConsensusConfig & { clusterSize: number } = {
			clusterSize: cfg?.clusterSize ?? 10,
			superMajorityThreshold: cfg?.superMajorityThreshold ?? 0.75,
			simpleMajorityThreshold: cfg?.simpleMajorityThreshold ?? 0.51,
			minAbsoluteClusterSize: cfg?.minAbsoluteClusterSize ?? 3,
			allowClusterDownsize: cfg?.allowClusterDownsize ?? true,
			clusterSizeTolerance: cfg?.clusterSizeTolerance ?? 0.5,
			partitionDetectionWindow: cfg?.partitionDetectionWindow ?? 60000
		};
		const localClusterRef = localCluster && localPeerId ? {
			update: localCluster.update.bind(localCluster),
			peerId: localPeerId,
			wasTransactionExecuted: localCluster.wasTransactionExecuted?.bind(localCluster)
		} : undefined;
		this.coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, policy, localClusterRef, fretService);
	}

	async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		// First try local storage
		const localResult = await this.storageRepo.get(blockGets, options);

		// Check for blocks that weren't found locally - try to fetch from cluster peers
		// Skip cluster fetch if this is already a sync request (to prevent recursive queries)
		const skipClusterFetch = (options as any)?.skipClusterFetch;
		if (this.clusterLatestCallback && !skipClusterFetch) {
			for (const blockId of blockGets.blockIds) {
				const localEntry = localResult[blockId];
				// If block not found locally (no state), try cluster peers
				if (!localEntry?.state?.latest) {
					try {
						await this.fetchBlockFromCluster(blockId);
						// Re-fetch after sync
						const refreshed = await this.storageRepo.get({ blockIds: [blockId], context: blockGets.context }, options);
						if (refreshed[blockId]) {
							localResult[blockId] = refreshed[blockId];
						}
					} catch (err) {
						log('cluster-fetch:error', { blockId, error: (err as Error).message });
					}
				}
			}
		}

		return localResult;
	}

	private async fetchBlockFromCluster(blockId: BlockId): Promise<void> {
		if (!this.clusterLatestCallback) return;

		// Query cluster for the block
		const clusterLatest = await this.queryClusterForLatest(blockId);
		if (clusterLatest) {
			// Found on cluster - trigger restoration to sync the block
			await this.storageRepo.get({ blockIds: [blockId], context: { committed: [clusterLatest], rev: clusterLatest.rev } });
			log('cluster-fetch:synced', { blockId, rev: clusterLatest.rev });
		}
	}

	/**
	 * Query cluster peers to find the maximum latest revision for a block.
	 */
	private async queryClusterForLatest(blockId: BlockId): Promise<ActionRev | undefined> {
		const blockIdBytes = new TextEncoder().encode(blockId);
		const peers = await this.keyNetwork.findCluster(blockIdBytes);
		if (!peers || Object.keys(peers).length === 0) {
			return undefined;
		}

		const peerIds = Object.keys(peers);
		let maxLatest: ActionRev | undefined;

		// Add timeout wrapper to prevent hanging on unresponsive peers
		const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> =>
			Promise.race([
				promise,
				new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeoutMs))
			]);

		// Query peers in parallel for their latest revision (with 3 second timeout per peer)
		const latestResults = await Promise.allSettled(
			peerIds.map(peerIdStr => {
				const peerId = peerIdFromString(peerIdStr);
				return withTimeout(this.clusterLatestCallback!(peerId, blockId), 3000);
			})
		);

		for (const result of latestResults) {
			if (result.status === 'fulfilled' && result.value) {
				const peerLatest = result.value;
				if (!maxLatest || peerLatest.rev > maxLatest.rev) {
					maxLatest = peerLatest;
				}
			}
		}

		return maxLatest;
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		const allBlockIds = Object.keys(request.transforms);
		const coordinatingBlockIds = (options as any)?.coordinatingBlockIds ?? allBlockIds;

		const peerCount = await this.coordinator.getClusterSize(coordinatingBlockIds[0]!);
		if (peerCount <= 1) {
			return await this.storageRepo.pend(request, options);
		}

		const message: RepoMessage = {
			operations: [{ pend: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT,
			coordinatingBlockIds
		};

		try {
			const { localExecuted } = await this.coordinator.executeClusterTransaction(coordinatingBlockIds[0]!, message, options);
			log('coordinator-repo:pend-cluster-complete', {
				actionId: request.actionId,
				localExecuted
			});
			// Only call storageRepo if local cluster didn't already execute during consensus
			if (!localExecuted) {
				const result = await this.storageRepo.pend(request, options);
				log('coordinator-repo:pend-fallback-result', {
					actionId: request.actionId,
					success: result.success,
					hasMissing: !!(result as any).missing?.length,
					hasPending: !!(result as any).pending?.length
				});
				return result;
			}
			// Local cluster already executed - return success
			return {
				success: true,
				pending: [],
				blockIds: Object.keys(request.transforms)
			};
		} catch (error) {
			log('coordinator-repo:pend-error', { actionId: request.actionId, error: (error as Error).message });
			throw error;
		}
	}

	async cancel(actionRef: ActionBlocks, options?: MessageOptions): Promise<void> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this cancel operation
		const blockIds = actionRef.blockIds;

		// Create a message for this cancel operation with timeout
		const message: RepoMessage = {
			operations: [{ cancel: { actionRef } }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
		};

		try {
			// For each block ID, execute a cluster transaction
			const clusterPromises = blockIds.map(blockId =>
				this.coordinator.executeClusterTransaction(blockId, message, options)
			);

			// Wait for all cluster transactions to complete
			const results = await Promise.all(clusterPromises);

			// Only call storageRepo if local cluster didn't already execute during consensus
			const anyLocalExecuted = results.some(r => r.localExecuted);
			if (!anyLocalExecuted) {
				await this.storageRepo.cancel(actionRef, options);
			}
		} catch (error) {
			log('coordinator-repo:cancel-error', { actionId: actionRef.actionId, error: (error as Error).message });
			throw error;
		}
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		const blockIds = request.blockIds;

		const peerCount = await this.coordinator.getClusterSize(blockIds[0]!);
		if (peerCount <= 1) {
			return await this.storageRepo.commit(request, options);
		}

		const message: RepoMessage = {
			operations: [{ commit: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
		};

		try {
			const { localExecuted } = await this.coordinator.executeClusterTransaction(blockIds[0]!, message, options);
			// Only call storageRepo if local cluster didn't already execute during consensus
			if (!localExecuted) {
				return await this.storageRepo.commit(request, options);
			}
			// Local cluster already executed - return success
			return { success: true };
		} catch (error) {
			log('coordinator-repo:commit-error', { actionId: request.actionId, error: (error as Error).message });
			throw error;
		}
	}
}
