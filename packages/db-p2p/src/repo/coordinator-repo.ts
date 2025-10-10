import type { PendRequest, TrxBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, BlockGets, CommitRequest, RepoMessage, TrxId, IKeyNetwork, IPeerNetwork } from "@optimystic/db-core";
import { ClusterCoordinator } from "./cluster-coordinator.js";
import type { ClusterClient } from "../cluster/client.js";
import type { PeerId } from "@libp2p/interface";

interface CoordinatorRepoComponents {
	storageRepo: IRepo
}

export function coordinatorRepo(keyNetwork: IKeyNetwork, createClusterClient: (peerId: PeerId) => ClusterClient, cfg?: { clusterSize?: number; allowClusterDownsize?: boolean; clusterSizeTolerance?: number }): (components: CoordinatorRepoComponents) => CoordinatorRepo {
	return (components: CoordinatorRepoComponents) => new CoordinatorRepo(keyNetwork, createClusterClient, components.storageRepo, cfg);
}

/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export class CoordinatorRepo implements IRepo {
	private coordinator: ClusterCoordinator;
	private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds default timeout

	constructor(
		readonly keyNetwork: IKeyNetwork,
		readonly createClusterClient: (peerId: PeerId) => ClusterClient,
		private readonly storageRepo: IRepo,
		cfg?: { clusterSize?: number; allowClusterDownsize?: boolean; clusterSizeTolerance?: number }
	) {
		const policy = {
			clusterSize: cfg?.clusterSize ?? 10,
			allowClusterDownsize: cfg?.allowClusterDownsize ?? true,
			clusterSizeTolerance: cfg?.clusterSizeTolerance ?? 0.5
		};
		this.coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, policy);
	}

	async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// For read operations, we don't necessarily need full consensus
		// We can randomly select a subset of the cluster to ensure we have agreement
		const blockIds = blockGets.blockIds;

		// Use the local store for the initial read
		const localResults = await this.storageRepo.get(blockGets, options);

		// For each block ID, verify with a subset of the cluster
		const verificationPromises = blockIds.map(async blockId => {
			try {
				// Create a message for this get operation with timeout
				const singleBlockGet: BlockGets = {
					blockIds: [blockId],
					context: blockGets.context
				};

				const message: RepoMessage = {
					operations: [{ get: singleBlockGet }],
					expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
				};

				// Execute the cluster transaction for this block
				await this.coordinator.executeClusterTransaction(blockId, message, options);

				// TODO: cross-check the result with the local store
			} catch (error) {
				console.error(`Error verifying block ${blockId} with cluster:`, error);
				// TODO: Deal with potentially inconsistent block
			}
		});

		// Wait for all verifications to complete
		await Promise.allSettled(verificationPromises);

		return localResults;
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this pend operation
		const blockIds = Object.keys(request.transforms);

		// Create a message for this pend operation with timeout
		const message: RepoMessage = {
			operations: [{ pend: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
		};

		const peerCount = await this.coordinator.getClusterSize(blockIds[0]!)
		if (peerCount <= 1) {
			return await this.storageRepo.pend(request, options)
		}

		try {
			await Promise.all(blockIds.map(blockId => this.coordinator.executeClusterTransaction(blockId, message, options)))
			return await this.storageRepo.pend(request, options)
		} catch (error) {
			console.error('Failed to complete pend operation:', error)
			throw error
		}
	}

	async cancel(trxRef: TrxBlocks, options?: MessageOptions): Promise<void> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this cancel operation
		const blockIds = Object.keys(trxRef);

		// Create a message for this cancel operation with timeout
		const message: RepoMessage = {
			operations: [{ cancel: { trxRef } }],
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
			await this.storageRepo.cancel(trxRef, options);
		} catch (error) {
			console.error('Failed to complete cancel operation:', error);
			throw error;
		}
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		// TODO: Verify that we are a proximate node for all block IDs in the request

		// Extract all block IDs affected by this commit operation
		const blockIds = request.blockIds;

		// Create a message for this commit operation with timeout
		const message: RepoMessage = {
			operations: [{ commit: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
		};

		const peerCount = await this.coordinator.getClusterSize(blockIds[0]!)
		if (peerCount <= 1) {
			return await this.storageRepo.commit(request, options)
		}
		try {
			const clusterPromises = blockIds.map(blockId => this.coordinator.executeClusterTransaction(blockId, message, options))
			await Promise.all(clusterPromises)
			return await this.storageRepo.commit(request, options)
		} catch (error) {
			console.error('Failed to complete commit operation:', error)
			throw error
		}
	}
}
