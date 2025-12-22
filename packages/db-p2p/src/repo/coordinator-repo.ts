import type { PendRequest, ActionBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, BlockGets, CommitRequest, RepoMessage, IKeyNetwork, ICluster, ClusterConsensusConfig } from "@optimystic/db-core";
import { ClusterCoordinator } from "./cluster-coordinator.js";
import type { ClusterClient } from "../cluster/client.js";
import type { PeerId } from "@libp2p/interface";
import type { FretService } from "@optimystic/fret";

interface CoordinatorRepoComponents {
	storageRepo: IRepo;
	localCluster?: ICluster;
	localPeerId?: PeerId;
}

export function coordinatorRepo(
	keyNetwork: IKeyNetwork,
	createClusterClient: (peerId: PeerId) => ClusterClient,
	cfg?: Partial<ClusterConsensusConfig> & { clusterSize?: number },
	fretService?: FretService
): (components: CoordinatorRepoComponents) => CoordinatorRepo {
	return (components: CoordinatorRepoComponents) => new CoordinatorRepo(keyNetwork, createClusterClient, components.storageRepo, cfg, components.localCluster, components.localPeerId, fretService);
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
		localCluster?: ICluster,
		localPeerId?: PeerId,
		fretService?: FretService
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
		const localClusterRef = localCluster && localPeerId ? { update: localCluster.update.bind(localCluster), peerId: localPeerId } : undefined;
		this.coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, policy, localClusterRef, fretService);
	}

	async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// For read operations, just use the local store
		// TODO: Implement read-path cluster verification without creating full 2PC transactions
		return await this.storageRepo.get(blockGets, options);
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		const allBlockIds = Object.keys(request.transforms);
		const coordinatingBlockIds = (options as any)?.coordinatingBlockIds ?? allBlockIds;

		const peerCount = await this.coordinator.getClusterSize(coordinatingBlockIds[0]!)
		if (peerCount <= 1) {
			return await this.storageRepo.pend(request, options)
		}

		const message: RepoMessage = {
			operations: [{ pend: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT,
			coordinatingBlockIds
		};

		try {
			await this.coordinator.executeClusterTransaction(coordinatingBlockIds[0]!, message, options);
			return await this.storageRepo.pend(request, options);
		} catch (error) {
			console.error('Failed to complete pend operation:', error)
			throw error
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
			await Promise.all(clusterPromises);

			// If all cluster transactions succeeded, apply the cancel to the local store
			await this.storageRepo.cancel(actionRef, options);
		} catch (error) {
			console.error('Failed to complete cancel operation:', error);
			throw error;
		}
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this commit operation
		const blockIds = request.blockIds;

    const peerCount = await this.coordinator.getClusterSize(blockIds[0]!)
    if (peerCount <= 1) {
      return await this.storageRepo.commit(request, options)
    }

		// Create a single message for the entire commit operation
		const message: RepoMessage = {
			operations: [{ commit: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
		};

    try {
			// Execute cluster transaction using the first block ID
			// All blocks in this operation should map to the same cluster
			await this.coordinator.executeClusterTransaction(blockIds[0]!, message, options);
			return await this.storageRepo.commit(request, options);
    } catch (error) {
      console.error('Failed to complete commit operation:', error)
      throw error
    }
	}
}
