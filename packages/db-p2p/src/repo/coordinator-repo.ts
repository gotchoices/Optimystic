import type { PendRequest, ActionBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, StaleFailure, BlockGets, CommitRequest, RepoMessage, IKeyNetwork, ICluster, ClusterConsensusConfig, BlockId, ActionRev, ActionContext, ClusterRecord } from "@optimystic/db-core";
import { LruMap, blockIdsForTransforms, DEFAULT_SUPER_MAJORITY_THRESHOLD } from "@optimystic/db-core";
import { ClusterCoordinator, ValidatorRejectionError } from "./cluster-coordinator.js";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { FretService } from "p2p-fret";
import { createLogger } from '../logger.js';
import type { IPeerReputation } from "../reputation/types.js";
import { PenaltyReason } from "../reputation/types.js";
import type { ITransactionStateStore } from "../cluster/i-transaction-state-store.js";
import { quorumSize, corroboratorCapacity, selectQuorumRev, type RevClaim, type QuorumRev } from "../cluster/quorum-restore.js";
import { RECONCILE_TIMEOUT_MS } from "../cluster/reconcile-block.js";
import { isMissingBaseRevisionFailure, MISSING_BASE_REVISION_REASON } from "../storage/storage-repo.js";
import type { ReconcileBlockCallback } from "../cluster/cluster-repo.js";

const log = createLogger('coordinator-repo');

/**
 * Acquire a block's content for a cohort-corroborated revision, from the cohort, and persist it.
 *
 * Deliberately the SAME shape as the commit path's {@link ReconcileBlockCallback}, and in the live
 * node the very same instance (`libp2p-node-base` passes its `reconcileBlock` to both): read-driven
 * acquisition needs exactly what reconcile already provides — a per-peer-bounded archive fetch, a
 * quorum vote on the target `(rev, actionId)`, a quorum vote on the *content* at that revision, and a
 * persist through the monotonic, commit-latched `StorageRepo.saveReplicatedBlock` funnel. Reusing it
 * is what keeps read-repair from being a weaker trust path than reconcile.
 */
export type AcquireBlockCallback = ReconcileBlockCallback;

/** True when a freshly-read local revision is strictly ahead of the baseline the repair started from. */
function isAdvanceOver(rev: number | undefined, baselineRev: number | undefined): boolean {
	return typeof rev === 'number' && (baselineRev === undefined || rev > baselineRev);
}

/**
 * Reject if `promise` has not settled within `ms`. The timer is cleared on either outcome, so no
 * handle outlives the race (hence no `unref`, which does not exist off Node).
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * Resolve `undefined` if `promise` has not settled within `ms` — a slow peer is skipped, not an
 * error. Same timer discipline as {@link withDeadline}: one repair pass races this once per cohort
 * peer, so leaving the handles pending would keep the event loop alive for the full timeout after
 * every peer has already answered.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<undefined>(resolve => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	return Promise.race([promise, expiry]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * What one round of polling the cohort learned about a block: the revision the OTHER
 * cohort members corroborated, and what this node itself already holds. The two are kept
 * apart on purpose — the local revision is the baseline being repaired, never evidence
 * about the cluster (see {@link CoordinatorRepo.queryClusterForLatest}) — but the caller
 * still needs it to tell whether the corroborated revision is actually an advance.
 */
interface ClusterLatestQuery {
	/** Highest `(rev, actionId)` corroborated by peers other than this node, if any. */
	corroborated?: ActionRev;
	/** This node's own latest for the block, as answered by the callback's self short-circuit. */
	local?: ActionRev;
}

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
	/**
	 * Optional callback that actually moves a block's bytes from the cohort into local storage once
	 * {@link clusterLatestCallback} has established a corroborated revision this node lacks. Absent →
	 * the read path can still *select* the right revision but converges only when the node already
	 * holds the corroborated action as a promotable pending. See {@link AcquireBlockCallback}.
	 */
	acquireBlockFromCohort?: AcquireBlockCallback;
}

/**
 * Consensus config for the coordinator side, plus the repair yardstick the read-repair path measures
 * a (possibly shrunken) cohort view against. `repairCorroborationClusterSize` is deliberately its own
 * field rather than an overload of {@link ClusterConsensusConfig.assumedClusterSize}: this same object
 * also builds the `ClusterCoordinator`, and a field whose value silently differed from the cluster
 * member's copy of it would be a trap. See `cluster/cluster-policy.ts` for why the two differ.
 */
export type CoordinatorRepoConfig = Partial<ClusterConsensusConfig> & {
	clusterSize?: number;
	repairCorroborationClusterSize?: number;
};

export function coordinatorRepo(
	keyNetwork: IKeyNetwork,
	createClusterClient: (peerId: PeerId) => ICluster,
	cfg?: CoordinatorRepoConfig,
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
		stateStore,
		components.acquireBlockFromCohort
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
	/** Simple-majority threshold from the consensus policy; drives the read-repair corroboration quorum. */
	private readonly simpleMajorityThreshold: number;
	/**
	 * Yardstick the read-repair corroboration floor is measured against; the floor for
	 * {@link corroboratorCapacity}. Resolved by `resolveClusterPolicy` for a real node; falls back to
	 * `assumedClusterSize` and then `clusterSize` for direct constructors (see the constructor), so a
	 * caller that has adopted neither field keeps today's behavior exactly.
	 */
	private readonly repairCorroborationClusterSize: number;
	/** Resolved super-majority threshold the coordinator commits on (mirrors the value handed to ClusterCoordinator). */
	private readonly superMajorityThreshold: number;
	private readonly reputation?: IPeerReputation;
	/** Test seam: overridable clock for window-based read-repair gating. */
	now: () => number = () => Date.now();
	/** Test seam: overridable RNG (0..1) for sample-rate gating. */
	rand: () => number = () => Math.random();

	constructor(
		readonly keyNetwork: IKeyNetwork,
		readonly createClusterClient: (peerId: PeerId) => ICluster,
		private readonly storageRepo: IRepo,
		cfg?: CoordinatorRepoConfig,
		localCluster?: LocalClusterWithExecutionTracking,
		localPeerId?: PeerId,
		fretService?: FretService,
		private readonly clusterLatestCallback?: ClusterLatestCallback,
		reputation?: IPeerReputation,
		stateStore?: ITransactionStateStore,
		private readonly acquireBlockFromCohort?: AcquireBlockCallback
	) {
		this.localPeerId = localPeerId;
		const policy: ClusterConsensusConfig & { clusterSize: number } = {
			clusterSize: cfg?.clusterSize ?? 10,
			assumedClusterSize: cfg?.assumedClusterSize,
			superMajorityThreshold: cfg?.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD,
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
			readRepairSampleRate: cfg?.readRepairSampleRate ?? 0,
			// Default false: an undersized cluster with no confident network-size estimate
			// is REJECTED (fail closed). Callers only opt in for single-node/local/test meshes.
			allowUnvalidatedSmallCluster: cfg?.allowUnvalidatedSmallCluster ?? false
		};
		this.readRepairMode = policy.readRepairMode!;
		this.readRepairWindowMs = policy.readRepairWindowMs!;
		this.readRepairSampleRate = policy.readRepairSampleRate!;
		this.simpleMajorityThreshold = policy.simpleMajorityThreshold;
		this.superMajorityThreshold = policy.superMajorityThreshold;
		// Unlike the membership admission gate (which treats an absent assumedClusterSize as "unknown"
		// and admits — refusing writes outright is unacceptable), this falls back to the replication
		// factor and stays strict: the failure mode of getting this wrong is a block that goes
		// unrepaired, degraded rather than dead, so there is no reason to relax it for a caller that
		// has not adopted the new field. A real node is handed an explicit
		// `repairCorroborationClusterSize` by `resolveClusterPolicy`; the `assumedClusterSize` middle
		// term keeps direct constructors (embedders, existing tests) behaving as before.
		this.repairCorroborationClusterSize =
			cfg?.repairCorroborationClusterSize ?? policy.assumedClusterSize ?? policy.clusterSize;
		this.reputation = reputation;
		const localClusterRef = localCluster && localPeerId ? {
			update: localCluster.update.bind(localCluster),
			peerId: localPeerId,
			wasTransactionExecuted: localCluster.wasTransactionExecuted?.bind(localCluster)
		} : undefined;
		this.coordinator = new ClusterCoordinator(keyNetwork, createClusterClient, policy, localClusterRef, fretService, reputation, stateStore);
	}

	/**
	 * The resolved super-majority threshold this coordinator commits on. Exposed so the composition root
	 * can fail-fast if the coordinator and the cluster member would run different thresholds (see the
	 * coupling assertion in `libp2p-node-base.ts`).
	 */
	get effectiveSuperMajorityThreshold(): number {
		return this.superMajorityThreshold;
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
		// NOTE: a soft-served read now also *acquires* the block durably (see restoreCorroborated), where
		// before it could at most promote a pending this node already held. So a soft serve leaves behind
		// a replica of a block this node is not responsible for, and nothing sweeps those: ring-shift
		// sheds a keyspace RANGE, not "blocks outside my cohort". Fine while soft serves are what they
		// are meant to be — a rare degradation during routing churn — since routing already placed this
		// node near the block. If they ever become routine, gate acquisition (not the serve itself) on
		// isResponsibleForBlock.
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
		// NOTE: NetworkTransactor.get treats an authoritative "absent" ({ state: {} })
		// as final and no longer retries it (ticket txn-perf-authoritative-notfound),
		// relying on this cluster reconciliation to have already run. If a coordinator
		// is ever configured WITHOUT clusterLatestCallback, a missing block is answered
		// from local state alone with no transactor-level retry to compensate. That is
		// fine today (such a coordinator has no cluster to reconcile against), but keep
		// this coupling in mind if a partial-cluster read path is added.
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
					await this.fetchBlockFromCluster(blockId, blockGets.context, localRev);
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

	/**
	 * One repair pass for a block: ask the cohort what it holds, and converge onto that if it is
	 * ahead of `localRev` — the revision the caller's read already loaded, and the baseline every
	 * decision below is measured against.
	 */
	private async fetchBlockFromCluster(blockId: BlockId, context?: ActionContext, localRev?: number): Promise<void> {
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

		const { corroborated, local } = await this.queryClusterForLatest(peerIds, blockId, context);
		// Nothing corroborated: keep local data AND stay eligible for repair — marking the
		// block seen here would suppress the next attempt for the whole read-repair window.
		if (!corroborated) return;

		// The self answer is the sharper baseline (same storage, same context, read alongside the
		// cohort's), but it exists only when `findCluster` returned this node. A soft serve for a
		// block this node is no longer responsible for is absent from its own cohort view, so fall
		// back to the revision the caller's read already loaded. Without the fallback both decisions
		// below degrade to "any local revision is an advance", which restores backwards and reports
		// a sync at the revision the pass started from.
		const baselineRev = local?.rev ?? localRev;

		// Never restore backwards. With this node's own claim excluded from the quorum, a
		// cohort that lags behind the reader corroborates an OLDER revision; adopting it
		// would be a regression, and logging it as a sync would be a lie. The cohort did
		// answer, so the block is verified fresh — mark it seen.
		// NOTE: in a cohort of two, that sole peer is the only corroborator, so a lying one can park
		// the reader here — corroborating the revision it already holds — and re-arm the lazy window
		// on every pass, hiding a real divergence. Bounded by `readRepairWindowMs` (10s default) and
		// no worse than the peer simply staying silent. If two-member cohorts become a supported
		// production topology rather than a dev convenience, stop re-arming the window on a
		// corroboration that came from a single voter.
		if (baselineRev !== undefined && corroborated.rev <= baselineRev) {
			log('cluster-fetch:local-current', { blockId, localRev: baselineRev, clusterRev: corroborated.rev });
			this.markBlocksSeen([blockId]);
			return;
		}

		// Corroborated revision is ahead of ours — converge onto it.
		const rev = await this.restoreCorroborated(blockId, corroborated, baselineRev, peerIds);

		// Log the OUTCOME, not the attempt. Logging `synced` unconditionally reported hundreds of
		// phantom convergences per run and made a real replication defect invisible for two debugging
		// sessions.
		if (rev !== undefined) {
			log('cluster-fetch:synced', { blockId, rev });
		} else {
			log('cluster-fetch:not-restored', { blockId, localRev: baselineRev, clusterRev: corroborated.rev });
		}
		// The block is marked seen either way — the cohort DID answer, so its freshness was checked,
		// which is what the read-repair window tracks. A failed convergence therefore waits out the
		// window before retrying.
		// NOTE: that damping covers only a block this node holds at an OLDER revision. A block entirely
		// missing locally never consults the window (`get` triggers on `isMissing` before
		// `shouldReadRepair`), so a persistently failing acquisition — e.g. a two-node deployment that
		// never set `assumedClusterSize`, where the content quorum can never be met — re-fetches an
		// archive on every read of that block. Correct, and self-limiting once the cohort can agree; if
		// it ever shows as read amplification, gate the acquisition step (not the latest-query) on the
		// same window rather than widening `isMissing`.
		this.markBlocksSeen([blockId]);
	}

	/**
	 * Bring this node up to the cohort-corroborated `corroborated`, returning the revision it holds
	 * afterwards when that is an advance over `baselineRev`, else `undefined`.
	 *
	 * Two mechanisms, cheapest first:
	 *  1. **Promote a local pending** — free, no network, and the only mechanism that existed before
	 *     block acquisition. Covers the node that saw the pend and missed the commit broadcast.
	 *  2. **Acquire the bytes from the cohort** ({@link AcquireBlockCallback}) — covers everything else,
	 *     including a block this node has never seen at all.
	 *
	 * **Why acquisition is gated here and not on a plain local miss.** `BlockStorage.getBlock` returns
	 * `undefined` for a block with no local metadata *without* consulting its restore callback, so that
	 * an insert probing a fresh random block id for a collision does not cost a network fetch. That
	 * remains true: this method runs only after {@link queryClusterForLatest} produced a quorum-
	 * corroborated `(rev, actionId)`, which a genuinely non-existent block can never produce (no peer
	 * claims it, so `selectQuorumRev` declines and `fetchBlockFromCluster` returns before reaching
	 * here). The cost of a genuine absence is unchanged — the latest-query round trip that already
	 * happened — while a block the cohort demonstrably holds is no longer thrown away.
	 *
	 * Cohort peer ids are passed straight through: the callback filters self out and caps its own
	 * corroboration quorum by how many peers could answer at all.
	 */
	private async restoreCorroborated(
		blockId: BlockId,
		corroborated: ActionRev,
		baselineRev: number | undefined,
		cohortPeerIds: string[]
	): Promise<number | undefined> {
		const promoted = await this.promoteCorroborated(blockId, corroborated);
		if (isAdvanceOver(promoted, baselineRev)) {
			return promoted;
		}

		if (!this.acquireBlockFromCohort) {
			return undefined;
		}
		try {
			// Bounded: a stalled cohort peer must not hold up the caller's read. Persisting happens
			// inside the callback via `saveReplicatedBlock`, which takes the per-block commit latch —
			// safe to call from here because the read path holds no latch of its own (`StorageRepo.get`
			// acquires and releases it around the promotion above, and nothing wraps this method).
			// NOTE: `get` walks its block ids sequentially, so the bound is per block, not per call — a
			// multi-block read that is missing N blocks against a wholly stalled cohort waits N × this.
			// Acceptable today (the underlying per-peer archive fetch is itself 1s-bounded and runs the
			// cohort in parallel, so the 5s is a stall ceiling, not a typical cost). If a cold reader
			// batching a wide read ever times out above this layer, repair the block ids concurrently
			// rather than shortening the bound.
			await withDeadline(
				this.acquireBlockFromCohort(blockId, corroborated, cohortPeerIds),
				RECONCILE_TIMEOUT_MS,
				`block acquisition for ${blockId}`
			);
		} catch (err) {
			// Declines are cheap and retryable — nothing was persisted. Report and leave the block behind.
			log('cluster-fetch:acquire-error', { blockId, rev: corroborated.rev, error: (err as Error).message });
			return undefined;
		}
		const acquired = await this.readLocalRev(blockId);
		return isAdvanceOver(acquired, baselineRev) ? acquired : undefined;
	}

	/**
	 * Promote a corroborated action this node already holds as a local pending — the no-network half of
	 * the repair. Returns the local revision afterwards.
	 *
	 * A pending-only block (metadata seeded by `savePendingTransaction`, no committed revision) asked
	 * for a forward revision throws out of `BlockStorage.ensureRevision` when no restore can supply it.
	 * On THIS path that is an absence, not a read failure — acquisition is precisely the mechanism that
	 * can supply it — so the throw is logged and swallowed rather than short-circuiting the caller.
	 */
	private async promoteCorroborated(blockId: BlockId, corroborated: ActionRev): Promise<number | undefined> {
		try {
			return await this.readLocalRev(blockId, { committed: [corroborated], rev: corroborated.rev });
		} catch (err) {
			log('cluster-fetch:promote-unavailable', { blockId, rev: corroborated.rev, error: (err as Error).message });
			return undefined;
		}
	}

	/** This node's own `latest.rev` for a block, optionally driving a promotion context through the read. */
	private async readLocalRev(blockId: BlockId, context?: ActionContext): Promise<number | undefined> {
		const result = await this.storageRepo.get({ blockIds: [blockId], context });
		return result[blockId]?.state?.latest?.rev;
	}

	/**
	 * Query cluster peers for their latest revision and return the highest revision
	 * corroborated by a quorum of distinct peers, alongside this node's own latest.
	 *
	 * Replaces the old "max rev any single peer reports" — which let one lying
	 * peer over-reporting its revision steer restoration — with quorum
	 * corroboration on the exact `(rev, actionId)` pair (see {@link selectQuorumRev}).
	 *
	 * This node's own answer is split out of the claim set rather than counted in it:
	 * `clusterLatestCallback` short-circuits self to local storage, so including it let a
	 * reader whose only peer timed out "corroborate" the very revision it was trying to
	 * repair. It is returned separately so the caller can compare, not vote.
	 *
	 * NOTE: the quorum is corroboration-of-a-claim, NOT Sybil-resistant cohort
	 * membership — a peer minting fresh keypairs still casts a vote, and the claims
	 * themselves are bare assertions (a `BlockArchive` carries no commit certificate, so
	 * there is nothing here to verify a `(rev, actionId)` against). Commit-cert +
	 * membership anchoring is deferred to backlog
	 * `debt-read-repair-commit-cert-verification`.
	 */
	private async queryClusterForLatest(peerIds: string[], blockId: BlockId, context?: ActionContext): Promise<ClusterLatestQuery> {
		// Query peers in parallel for their latest revision (with 1s timeout per peer),
		// tagging each response with the peer that made it so votes stay distinct.
		const latestResults = await Promise.allSettled(
			peerIds.map(async peerIdStr => {
				const peerId = peerIdFromString(peerIdStr);
				const value = await withTimeout(this.clusterLatestCallback!(peerId, blockId, context), 1000);
				return { peerIdStr, value };
			})
		);

		// NOTE: self-exclusion is keyed on `localPeerId`, which is optional for the single-node/test
		// construction this class has always tolerated. Left unset, this node's own answer is counted
		// as a peer claim again. Harmless today — the self answer can only ever corroborate the
		// revision already held, so the pass declines as `local-current` — but if a future caller can
		// make self report something the reader does not hold, make `localPeerId` required instead.
		const selfId = this.localPeerId?.toString();
		let local: ActionRev | undefined;
		const claims: RevClaim[] = [];
		for (const result of latestResults) {
			if (result.status !== 'fulfilled' || !result.value.value) continue;
			const { peerIdStr, value } = result.value;
			if (peerIdStr === selfId) {
				local = value;
				continue;
			}
			claims.push({ peerId: peerIdStr, rev: value.rev, actionId: value.actionId });
		}

		const capacity = corroboratorCapacity(peerIds.filter(id => id !== selfId).length, this.repairCorroborationClusterSize);
		const selected = selectQuorumRev(claims, this.simpleMajorityThreshold, capacity);
		if (!selected) {
			log('cluster-fetch:no-quorum', {
				blockId,
				responders: claims.length,
				required: quorumSize(claims.length, this.simpleMajorityThreshold, capacity)
			});
			return { local };
		}

		// Best-effort: penalize peers whose claim contradicts the corroborated pair
		// (an inflated rev the quorum outvoted, or conflicting content at the agreed
		// rev). A lower rev is just lag, never penalized. Never let this throw.
		this.penalizeContradictingRevClaims(claims, selected, blockId);

		return { corroborated: { actionId: selected.actionId, rev: selected.rev }, local };
	}

	/**
	 * Report peers whose reported latest contradicts the quorum-corroborated pair. Best-effort.
	 *
	 * NOTE: the `rev > selected.rev` branch is NOT provable misbehavior — an honest
	 * peer legitimately ahead of the sampled quorum (an in-flight commit it durably
	 * stored, or other honest holders dropped from the sample by the 1s per-peer
	 * timeout) reports a higher rev and gets penalized (weight 30 → immediate
	 * deprioritize at threshold 20). Distinguishing a liar from an honest leader
	 * needs the commit-cert verification tracked in backlog
	 * `debt-read-repair-penalty-provable-only` / `debt-read-repair-commit-cert-verification`.
	 */
	private penalizeContradictingRevClaims(claims: RevClaim[], selected: QuorumRev, blockId: BlockId): void {
		if (!this.reputation) return;
		try {
			for (const c of claims) {
				const contradicts = c.rev > selected.rev
					|| (c.rev === selected.rev && c.actionId !== selected.actionId);
				if (contradicts) {
					this.reputation.reportPeer(c.peerId, PenaltyReason.InvalidRestoration, `read-repair:${blockId}`);
				}
			}
		} catch (err) {
			log('cluster-fetch:penalize-error', { blockId, error: (err as Error).message });
		}
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		const allBlockIds = blockIdsForTransforms(request.transforms);
		await this.verifyResponsibility(allBlockIds);
		const coordinatingBlockIds = options?.coordinatingBlockIds ?? allBlockIds;

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
			const stale = await this.classifyStaleRejection(error, request, allBlockIds);
			if (stale) return stale;
			throw error;
		}
	}

	/**
	 * Decide whether a cluster validator rejection was an optimistic-concurrency loss — the block
	 * already advanced past the requested revision — rather than a genuine validation fault.
	 * A confirmed loss returns a {@link StaleFailure} carrying `conflict: true` so the caller
	 * receives a non-success *response* that says plainly it is a lost race: network-transactor's
	 * pend then takes its stale branch and both writers (`Collection.sync`, and the coordinator's
	 * multi-collection pendPhase via `isConflictFailure`) retry, instead of a thrown error escaping
	 * mid-batch (which splits multi-tree commits — see PartialCommitError).
	 *
	 * The failure carries no `missing` list: confirmation is a local re-read that reveals the
	 * revision is taken but not which actions took it, and no consumer rebases from `missing`
	 * anyway (it is only counted or logged). `conflict` conveys retryability directly instead.
	 *
	 * Confirmation is purely local: re-read the affected blocks from our own storage and require
	 * `latest.rev >= request.rev`. The signed reject-reason text is never consulted — it is
	 * free-form wire-visible prose and must not become control flow. Anything unconfirmed
	 * (including read errors during confirmation) stays a throw, preserving fail-fast for
	 * genuine validation faults.
	 */
	private async classifyStaleRejection(error: unknown, request: PendRequest, blockIds: BlockId[]): Promise<StaleFailure | undefined> {
		if (!(error instanceof ValidatorRejectionError) || request.rev === undefined) return undefined;
		let results: GetBlockResults;
		try {
			results = await this.storageRepo.get({ blockIds });
		} catch (readError) {
			log('coordinator-repo:pend-stale-classify-read-error', {
				actionId: request.actionId,
				error: (readError as Error).message
			});
			return undefined;
		}
		for (const blockId of blockIds) {
			const latest = results[blockId]?.state.latest;
			if (latest && latest.rev >= request.rev) {
				log('coordinator-repo:pend-stale-classified', {
					actionId: request.actionId,
					blockId,
					latestRev: latest.rev,
					requestedRev: request.rev
				});
				return { success: false, conflict: true, reason: `stale revision: block ${blockId} at rev ${latest.rev}, requested rev ${request.rev}` };
			}
		}
		// NOTE: conservative — when only remote members saw the newer revision (local storage still
		// behind), staleness can't be confirmed locally and the rejection stays a throw. If that
		// shows up in practice, extend confirmation with a quorum read; never trust the reject text.
		return undefined;
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
			// Local cluster didn't execute during consensus. Attempt a local commit, but tolerate
			// local divergence when the cluster already reached consensus — this coordinator was
			// likely picked for commit after missing the pend phase (unreachable during pend, fresh
			// join, etc.). The cluster's majority is authoritative; this peer catches up via sync.
			//
			// Divergence reaches us in BOTH shapes and both must be tolerated identically:
			//   - a THROW ("Pending action … not found"), when we never saw the pend;
			//   - a RETURNED `success:false` carrying `missing-base-revision`, when we saw the pend
			//     but not the revision that created the block (see StorageRepo.internalCommit).
			// Only the throw was tolerated before the refusal existed. Reporting the refusal to the
			// caller instead would surface a committed transaction as a stale loss: db-core's
			// commitPhase treats any returned `success:false` as a permanent stale failure, so the
			// client would retry an action the cluster already landed until it exhausted its budget.
			try {
				const result = await this.storageRepo.commit(request, options);
				if (result.success) {
					this.markBlocksSeen(blockIds);
					return result;
				}
				if (isMissingBaseRevisionFailure(result) && clusterReachedCommitConsensus(record)) {
					return this.tolerateLocalCommitDivergence(request, blockIds, result.reason ?? MISSING_BASE_REVISION_REASON);
				}
				return result;
			} catch (err) {
				if (clusterReachedCommitConsensus(record)) {
					return this.tolerateLocalCommitDivergence(request, blockIds, (err as Error).message);
				}
				throw err;
			}
		} catch (error) {
			log('coordinator-repo:commit-error', { actionId: request.actionId, error: (error as Error).message });
			throw error;
		}
	}

	/**
	 * Report success for a commit the cluster carried but this peer could not apply locally. The
	 * blocks are marked seen so the read path treats them as freshness-checked; convergence comes
	 * from replication (cohort reconcile, or read-driven acquisition), not from replay here.
	 */
	private tolerateLocalCommitDivergence(request: CommitRequest, blockIds: BlockId[], detail: string): CommitResult {
		log('coordinator-repo:commit-local-failed-cluster-succeeded', { actionId: request.actionId, error: detail });
		this.markBlocksSeen(blockIds);
		return { success: true };
	}
}

/** True if a simple majority of cluster peers signed an approving commit. */
function clusterReachedCommitConsensus(record: ClusterRecord): boolean {
	const peerCount = Object.keys(record.peers).length;
	if (peerCount === 0) return false;
	const approvedCommits = Object.values(record.commits).filter(s => s.type === 'approve').length;
	return approvedCommits > peerCount / 2;
}
