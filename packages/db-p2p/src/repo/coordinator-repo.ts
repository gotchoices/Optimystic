import type { PendRequest, ActionBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, BlockGets, CommitRequest, RepoMessage, IKeyNetwork, ICluster, ClusterConsensusConfig, BlockId, ActionRev, ActionContext, ClusterRecord } from "@optimystic/db-core";
import { LruMap, blockIdsForTransforms } from "@optimystic/db-core";
import { ClusterCoordinator } from "./cluster-coordinator.js";
import type { ClusterClient } from "../cluster/client.js";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { FretService } from "p2p-fret";
import { createLogger } from '../logger.js';
import type { IPeerReputation } from "../reputation/types.js";
import type { ITransactionStateStore } from "../cluster/i-transaction-state-store.js";

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
export type ClusterLatestCallback = (peerId: PeerId, blockId: BlockId, context?: ActionContext) => Promise<ActionRev | undefined>;

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
	fretService?: FretService,
	reputation?: IPeerReputation,
	stateStore?: ITransactionStateStore
): (components: CoordinatorRepoComponents) => CoordinatorRepo {
	return (components: CoordinatorRepoComponents) => new CoordinatorRepo(
		keyNetwork,
		createClusterClient,
		components.storageRepo,
		cfg,
		components.localCluster,
		components.localPeerId,
		fretService,
		components.clusterLatestCallback,
		reputation,
		stateStore
	);
}

/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export class CoordinatorRepo implements IRepo {
	private coordinator: ClusterCoordinator;
	private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds default timeout
	private readonly localPeerId?: PeerId;
	private readonly responsibilityCache = new LruMap<string, { inCluster: boolean, expires: number }>(1000);
	private static readonly RESPONSIBILITY_TTL_MS = 60_000;
	private readonly lastSeenCommitMs = new LruMap<string, number>(1000);
	private readonly readRepairMode: 'off' | 'lazy' | 'paranoid';
	private readonly readRepairWindowMs: number;
	private readonly readRepairSampleRate: number;
	/** Test seam: overridable clock for window-based read-repair gating. */
	now: () => number = () => Date.now();
	/** Test seam: overridable RNG (0..1) for sample-rate gating. */
	rand: () => number = () => Math.random();

	constructor(
		readonly keyNetwork: IKeyNetwork,
		readonly createClusterClient: (peerId: PeerId) => ClusterClient,
		private readonly storageRepo: IRepo,
		cfg?: Partial<ClusterConsensusConfig> & { clusterSize?: number },
		localCluster?: LocalClusterWithExecutionTracking,
		localPeerId?: PeerId,
		fretService?: FretService,
		private readonly clusterLatestCallback?: ClusterLatestCallback,
		reputation?: IPeerReputation,
		stateStore?: ITransactionStateStore
	) {
		this.localPeerId = localPeerId;
		const policy: ClusterConsensusConfig & { clusterSize: number } = {
			clusterSize: cfg?.clusterSize ?? 10,
			superMajorityThreshold: cfg?.superMajorityThreshold ?? 0.75,
			simpleMajorityThreshold: cfg?.simpleMajorityThreshold ?? 0.51,
			minAbsoluteClusterSize: cfg?.minAbsoluteClusterSize ?? 3,
			allowClusterDownsize: cfg?.allowClusterDownsize ?? true,
			clusterSizeTolerance: cfg?.clusterSizeTolerance ?? 0.5,
			partitionDetectionWindow: cfg?.partitionDetectionWindow ?? 60000,
			commitBroadcastRetryInitialMs: cfg?.commitBroadcastRetryInitialMs ?? 250,
			commitBroadcastRetryBackoffFactor: cfg?.commitBroadcastRetryBackoffFactor ?? 2,
			commitBroadcastRetryMaxIntervalMs: cfg?.commitBroadcastRetryMaxIntervalMs ?? 8000,
			commitBroadcastRetryMaxAttempts: cfg?.commitBroadcastRetryMaxAttempts ?? 5,
			commitBroadcastImmediateRetries: cfg?.commitBroadcastImmediateRetries ?? 1,
			promiseImmediateRetries: cfg?.promiseImmediateRetries ?? 1,
			readRepairMode: cfg?.readRepairMode ?? 'lazy',
			readRepairWindowMs: cfg?.readRepairWindowMs ?? 10000,
			readRepairSampleRate: cfg?.readRepairSampleRate ?? 0
		};
		this.readRepairMode = policy.readRepairMode!;
		this.readRepairWindowMs = policy.readRepairWindowMs!;
		this.readRepairSampleRate = policy.readRepairSampleRate!;
		const localClusterRef = localCluster && localPeerId ? {
			update: localCluster.update.bind(localCluster),
			peerId: localPeerId,
			wasTransactionExecuted: localCluster.wasTransactionExecuted?.bind(localCluster)
		} : undefined;
		this.coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, policy, localClusterRef, fretService, reputation, stateStore);
	}

	/** Recover coordinator transactions from persistent store after a restart. */
	async recoverTransactions(): Promise<void> {
		await this.coordinator.recoverTransactions();
	}

	/**
	 * Check if this node is in the cluster for a given block.
	 * Uses findCluster membership — in the real network layer, self is always
	 * included in the cohort when this node is responsible. This serves as a
	 * defense-in-depth guard for requests that arrive at the wrong node.
	 * Returns true if localPeerId is not set (backward compat for single-node/test setups).
	 */
	private async isResponsibleForBlock(blockId: BlockId): Promise<boolean> {
		if (!this.localPeerId) return true;

		const cached = this.responsibilityCache.get(blockId);
		if (cached && cached.expires > Date.now()) {
			return cached.inCluster;
		}

		const blockIdBytes = new TextEncoder().encode(blockId);
		let inCluster: boolean;
		try {
			const peers = await this.keyNetwork.findCluster(blockIdBytes);
			inCluster = this.localPeerId.toString() in peers;
		} catch (err) {
			log('proximity:check-error', { blockId, error: (err as Error).message });
			// On failure, assume responsible to avoid false rejections
			return true;
		}

		this.responsibilityCache.set(blockId, { inCluster, expires: Date.now() + CoordinatorRepo.RESPONSIBILITY_TTL_MS });
		log('proximity:checked', { blockId, inCluster });
		return inCluster;
	}

	/**
	 * Verify this node is responsible for all given block IDs. Throws if not.
	 */
	private async verifyResponsibility(blockIds: BlockId[]): Promise<void> {
		const notResponsible: BlockId[] = [];
		for (const blockId of blockIds) {
			if (!await this.isResponsibleForBlock(blockId)) {
				notResponsible.push(blockId);
			}
		}
		if (notResponsible.length > 0) {
			log('proximity:rejected', { blockIds: notResponsible });
			throw new Error(`Not responsible for block(s): ${notResponsible.join(', ')}`);
		}
	}

	async get(blockGets: BlockGets, options?: MessageOptions): Promise<GetBlockResults> {
		// Soft proximity check — warn but still serve reads for graceful degradation
		for (const blockId of blockGets.blockIds) {
			if (!await this.isResponsibleForBlock(blockId)) {
				log('proximity:get-warning', { blockId, msg: 'serving read for non-responsible block' });
			}
		}

		// First try local storage
		const localResult = await this.storageRepo.get(blockGets, options);

		// Decide per-block whether to consult cluster peers. Two triggers:
		//   (a) Missing — block isn't present locally at all (legacy behavior).
		//   (b) Stale-by-policy — block is present but read-repair policy says verify.
		// Skip cluster fetch if this is already a sync request (to prevent recursive queries).
		const skipClusterFetch = (options as any)?.skipClusterFetch;
		if (this.clusterLatestCallback && !skipClusterFetch) {
			for (const blockId of blockGets.blockIds) {
				const localEntry = localResult[blockId];
				const localRev = localEntry?.state?.latest?.rev;
				const isMissing = !localEntry?.state?.latest;
				const isStale = !isMissing && this.shouldReadRepair(blockId);
				if (!isMissing && !isStale) continue;

				if (isStale) {
					log('cluster-tx:read-repair-triggered', {
						blockId,
						mode: this.readRepairMode,
						ageMs: this.ageMs(blockId),
						localRev
					});
				}

				try {
					await this.fetchBlockFromCluster(blockId, blockGets.context);
					const refreshed = await this.storageRepo.get({ blockIds: [blockId], context: blockGets.context }, options);
					const newRev = refreshed[blockId]?.state?.latest?.rev;
					if (refreshed[blockId]) {
						localResult[blockId] = refreshed[blockId];
					}
					if (isStale) {
						if (typeof newRev === 'number' && typeof localRev === 'number' && newRev > localRev) {
							log('cluster-tx:read-repair-applied', { blockId, oldRev: localRev, newRev });
						} else {
							log('cluster-tx:read-repair-noop', { blockId });
						}
					}
				} catch (err) {
					log('cluster-fetch:error', { blockId, error: (err as Error).message });
				}
			}
		}

		return localResult;
	}

	/** Decide whether the read-repair policy wants us to consult the cluster for a present-but-possibly-stale block. */
	private shouldReadRepair(blockId: BlockId): boolean {
		switch (this.readRepairMode) {
			case 'off': return false;
			case 'paranoid': return true;
			case 'lazy': {
				const lastSeen = this.lastSeenCommitMs.get(blockId);
				if (lastSeen == null) return true;
				if (this.now() - lastSeen > this.readRepairWindowMs) return true;
				if (this.readRepairSampleRate > 0 && this.rand() < this.readRepairSampleRate) return true;
				return false;
			}
		}
	}

	/** Milliseconds since we last marked this block fresh, or undefined if never. */
	private ageMs(blockId: BlockId): number | undefined {
		const lastSeen = this.lastSeenCommitMs.get(blockId);
		return lastSeen == null ? undefined : this.now() - lastSeen;
	}

	/** Mark blocks as freshly observed from cluster authority (post-commit or post-fetch). */
	private markBlocksSeen(blockIds: BlockId[]): void {
		const now = this.now();
		for (const id of blockIds) {
			this.lastSeenCommitMs.set(id, now);
		}
	}

	/**
	 * Test seam: directly set the last-seen timestamp for a block. Used by read-repair
	 * specs to simulate "the local commit happened at time T" without needing to drive
	 * a full pend/commit cycle through the cluster coordinator.
	 */
	setLastSeenForTest(blockId: BlockId, ts: number): void {
		this.lastSeenCommitMs.set(blockId, ts);
	}

	private async fetchBlockFromCluster(blockId: BlockId, context?: ActionContext): Promise<void> {
		if (!this.clusterLatestCallback) return;

		const blockIdBytes = new TextEncoder().encode(blockId);
		const peers = await this.keyNetwork.findCluster(blockIdBytes);
		const peerIds = peers ? Object.keys(peers) : [];
		if (peerIds.length === 0) return;

		// Solo-cluster short-circuit: the only responsible peer is us. There is no
		// remote to sync from, so skip the callback entirely. Querying ourselves
		// would dial self via SyncClient — pointless at best, and on nodes without
		// listen addresses (e.g. solo WebSocket-only) the dial can hang.
		if (
			peerIds.length === 1
			&& this.localPeerId
			&& peerIds[0] === this.localPeerId.toString()
		) {
			log('cluster-fetch:solo-self-skip', { blockId });
			return;
		}

		const clusterLatest = await this.queryClusterForLatest(peerIds, blockId, context);
		if (clusterLatest) {
			// Found on cluster - trigger restoration to sync the block
			await this.storageRepo.get({ blockIds: [blockId], context: { committed: [clusterLatest], rev: clusterLatest.rev } });
			log('cluster-fetch:synced', { blockId, rev: clusterLatest.rev });
			this.markBlocksSeen([blockId]);
		}
	}

	/**
	 * Query cluster peers to find the maximum latest revision for a block.
	 */
	private async queryClusterForLatest(peerIds: string[], blockId: BlockId, context?: ActionContext): Promise<ActionRev | undefined> {
		let maxLatest: ActionRev | undefined;

		// Add timeout wrapper to prevent hanging on unresponsive peers
		const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> =>
			Promise.race([
				promise,
				new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), timeoutMs))
			]);

		// Query peers in parallel for their latest revision (with 1s timeout per peer)
		const latestResults = await Promise.allSettled(
			peerIds.map(peerIdStr => {
				const peerId = peerIdFromString(peerIdStr);
				return withTimeout(this.clusterLatestCallback!(peerId, blockId, context), 1000);
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
		const allBlockIds = blockIdsForTransforms(request.transforms);
		await this.verifyResponsibility(allBlockIds);
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
				blockIds: allBlockIds
			};
		} catch (error) {
			log('coordinator-repo:pend-error', { actionId: request.actionId, error: (error as Error).message });
			throw error;
		}
	}

	async cancel(actionRef: ActionBlocks, options?: MessageOptions): Promise<void> {
		const blockIds = actionRef.blockIds;
		await this.verifyResponsibility(blockIds);

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
		await this.verifyResponsibility(blockIds);

		const peerCount = await this.coordinator.getClusterSize(blockIds[0]!);
		if (peerCount <= 1) {
			const result = await this.storageRepo.commit(request, options);
			if (result.success) this.markBlocksSeen(blockIds);
			return result;
		}

		const message: RepoMessage = {
			operations: [{ commit: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
		};

		try {
			const { record, localExecuted } = await this.coordinator.executeClusterTransaction(blockIds[0]!, message, options);
			if (localExecuted) {
				this.markBlocksSeen(blockIds);
				return { success: true };
			}
			// Local cluster didn't execute during consensus. Attempt a local commit,
			// but tolerate failure (e.g., "pending action not found") when the cluster
			// already reached consensus — this coordinator was likely picked for commit
			// after missing the pend phase (unreachable during pend, fresh join, etc.).
			// The cluster's majority is authoritative; this peer will catch up via sync.
			try {
				const result = await this.storageRepo.commit(request, options);
				if (result.success) this.markBlocksSeen(blockIds);
				return result;
			} catch (err) {
				if (clusterReachedCommitConsensus(record)) {
					log('coordinator-repo:commit-local-failed-cluster-succeeded', {
						actionId: request.actionId,
						error: (err as Error).message
					});
					this.markBlocksSeen(blockIds);
					return { success: true };
				}
				throw err;
			}
		} catch (error) {
			log('coordinator-repo:commit-error', { actionId: request.actionId, error: (error as Error).message });
			throw error;
		}
	}
}

/** True if a simple majority of cluster peers signed an approving commit. */
function clusterReachedCommitConsensus(record: ClusterRecord): boolean {
	const peerCount = Object.keys(record.peers).length;
	if (peerCount === 0) return false;
	const approvedCommits = Object.values(record.commits).filter(s => s.type === 'approve').length;
	return approvedCommits > peerCount / 2;
}
