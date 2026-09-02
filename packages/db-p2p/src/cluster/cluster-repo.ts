import type { IRepo, ClusterRecord, ClusterPeers, Signature, RepoMessage, ITransactionValidator, ClusterConsensusConfig, UnvalidatablePendPolicy, CommitResult, PendResult, BlockId, ActionId, ActionRev, CommitRequest, CommitCert, InvalidateRequest } from "@optimystic/db-core";
import type { ICluster } from "@optimystic/db-core";
import type { IPeerNetwork } from "@optimystic/db-core";
import { blockIdsForTransforms, isOwnRevision, DEFAULT_SUPER_MAJORITY_THRESHOLD } from "@optimystic/db-core";
import { computeClusterCommitHash, computeClusterMessageHash, computeClusterPromiseHash, membershipDigest, recordMembershipDigest, clusterVoteSigningPayload, clusterVoteVerificationPayload } from "@optimystic/db-core";
import { verifyInvalidationCertificate, type ArbitratorSetRecompute } from "../dispute/invalidation.js";
import { buildCommitCert, invalidationActionId } from "./commit-cert.js";
import { ClusterClient } from "./client.js";
import type { PeerId, PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdBindsPublicKey } from "./peer-key-binding.js";
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { createLogger } from '../logger.js'
import type { PartitionDetector } from "./partition-detector.js";
import type { FretService } from "p2p-fret";
import type { IPeerReputation } from "../reputation/types.js";
import { PenaltyReason } from "../reputation/types.js";
import type { ITransactionStateStore } from "./i-transaction-state-store.js";
import { isMissingBaseRevisionFailure, type CommitDigestPreview, type ICommitDigestPreviewer, type ICommitProofPersister, type IRevisionActionReader } from "../storage/storage-repo.js";
import { checkPendValidation } from "../pend-validation.js";
import { getAffectedBlockIds } from "./record-operations.js";
import { operationsConflict, resolveRace } from "./race-resolution.js";
import { buildBlockCommitProof, mintSoloCommitProof, type BlockCommitProof } from "./commit-proof.js";
import { RECONCILE_TIMEOUT_MS } from "./reconcile-block.js";

const log = createLogger('cluster-member')

/** State of a transaction in the cluster */
enum TransactionPhase {
	Promising,       // We have voted; still collecting promises from other peers
	OurPromiseNeeded, // We need to provide our promise
	OurConflictVoteNeeded, // We hold a conflicting race winner; we must answer with a conflict vote
	OurCommitNeeded, // We need to provide our commit
	Consensus,       // Transaction has reached consensus
	Rejected,        // Transaction was rejected (validity judgement — enough reject votes)
	ConflictSuperseded, // Terminal but retryable: conflict votes make super-majority unreachable
	Propagating     // Transaction is being propagated
}

/**
 * A phase plus the data its handler needs. Only {@link TransactionPhase.OurConflictVoteNeeded}
 * carries any — `conflictsWith`, the winning rival's messageHash — so the conflict-vote handler need
 * not re-run conflict detection (whose race resolution has side effects) to learn what blocked it.
 * Split by phase rather than an optional field so the handler reads it without an assertion, and so
 * a future phase-with-data cannot silently inherit this one's payload.
 */
type PhaseResult =
	| { phase: TransactionPhase.OurConflictVoteNeeded; conflictsWith: string }
	| { phase: Exclude<TransactionPhase, TransactionPhase.OurConflictVoteNeeded> };

interface TransactionState {
	record: ClusterRecord;
	promiseTimeout?: NodeJS.Timeout;
	resolutionTimeout?: NodeJS.Timeout;
	lastUpdate: number;
}

/**
 * Result of verifying one vote signature. `penalize` distinguishes "identity was never proven"
 * (no key / not Ed25519 / key not bound to the peer id / malformed input — reject, but do NOT
 * report the named peer, whose id may have been attacker-chosen) from "the key IS the one the
 * peer id names, yet the signature does not verify" (reject AND report — a genuine bad vote from
 * that proven identity). Collapsing both into a bare `false` would let a coordinator get an honest
 * peer penalized just by attaching a key it controls under that peer's id.
 */
type VerifyOutcome =
	| { valid: true }
	| { valid: false; penalize: boolean };

/**
 * Actively reconciles a block this member committed without having seen the matching
 * pend (cohort drift between the independent pend and commit cluster-transactions).
 * Pulls the committed revision from a cohort peer that holds it and restores it into
 * local storage. Injected so {@link ClusterMember} stays transport-agnostic — mirrors
 * how `CoordinatorRepo` receives its `clusterLatestCallback`.
 *
 * @param blockId       the under-replicated block to restore
 * @param committed     the committed `(actionId, rev)` agreed by consensus
 * @param cohortPeerIds cohort members to pull from (self already excluded)
 */
export type ReconcileBlockCallback = (blockId: BlockId, committed: ActionRev, cohortPeerIds: string[]) => Promise<void>;

/**
 * Sink for the {@link CommitCert} this member assembled at consensus, fired once per committed action
 * **before** the commit is applied to local storage (so it is already retained when
 * {@link StorageRepo.commit} emits the matching `CollectionChangeEvent` the reactivity bridge reads).
 * The bytes are the cluster's own `approve` commit signatures, forwarded UNCHANGED — never re-signed.
 * Optional; absent on nodes that do not originate reactivity notifications. A throwing sink is
 * isolated + logged (it must never break consensus).
 */
export type CommitCertificateSink = (actionId: ActionId, cert: CommitCert) => void;

/**
 * Applies a consensus-ordered {@link InvalidateRequest} to local storage — the deterministic
 * reversal every member runs once consensus on the invalidation is reached. The implementation
 * recomputes the per-block as-if-`T_inv`-absent content, writes the compensating revisions, and
 * appends the durable invalidation log entry (see `applyInvalidation` in the dispute module). It
 * is injected so {@link ClusterMember} stays storage/log-agnostic (mirrors {@link ReconcileBlockCallback}).
 *
 * The certificate is verified by {@link ClusterMember} *before* the sink is invoked, so a sink
 * implementation may assume `request.resolution` is already a valid challenger-wins certificate.
 * A throwing sink is logged and tolerated (never resets the cluster stream); the in-memory dedup
 * marker is rolled back so a re-broadcast can retry.
 */
export type InvalidationApplySink = (request: InvalidateRequest) => Promise<void>;

/**
 * Optional **layer-2** capability for invalidation-certificate verification: re-derives the
 * legitimately-selected arbitrator set from this member's topology view and judges the carried set
 * (see {@link ArbitratorSetRecompute}). Injected so {@link ClusterMember} stays network-agnostic; the
 * composition root supplies it from FRET when available. When absent (or when the member cannot
 * reconstruct the historical topology), {@link applyConsensusInvalidation} accepts a layer-1-valid
 * certificate and logs that it applied an invalidation it could not fully anchor — the documented
 * interim posture (see `tickets/plan/cohort-topic-membership-cert-trust-anchoring.md`).
 */
export type RecomputeArbitratorSetCapability = ArbitratorSetRecompute;

/**
 * The member's own independently-derived view of a block's responsible cluster, plus FRET's confidence in
 * the underlying network-size estimate (0..1). Returned by {@link DeriveExpectedClusterCallback} and
 * consumed by {@link ClusterMember}'s membership admission gate: the member checks a coordinator-declared
 * peer set against `peers` (its expected set `E`) and gates on `confidence` (low confidence ⇒ fail closed
 * for any downsizing, the partition posture).
 */
export type ExpectedClusterView = {
	/** The member's own derived responsible-peer set for the block (its view of the legitimate cluster). */
	peers: ClusterPeers;
	/** FRET's confidence in the current network-size estimate (0..1); ≤ threshold ⇒ treated as untrusted. */
	confidence: number;
};

/**
 * Independently derive this member's own view of a block's responsible cluster. Injected so
 * {@link ClusterMember} stays transport-agnostic — the composition root supplies it from
 * `IKeyNetwork.findCluster` + FRET (mirroring how the coordinator derives the cluster). Absent on nodes
 * that cannot derive a view (no FRET, unit tests): with no capability AND no asserted
 * {@link ClusterConsensusConfig.assumedClusterSize} the gate preserves legacy approve behavior, but an
 * asserted size still lets the gate fail closed on an unjustified downsize.
 *
 * Wiring this capability also arms the record-shape refusals: a member that CAN derive refuses outright
 * (rather than falling back) when the record names no coordinating block, or names one the record's own
 * operations never touch — those are the sender's free choice, not this member's inability. See
 * {@link ClusterViewDerivation} and {@link ClusterMember} admission gate.
 */
export type DeriveExpectedClusterCallback = (blockId: BlockId) => Promise<ExpectedClusterView>;

/**
 * Why a member does or does not have its own view of a record's cohort. The whole point of the union is
 * that the caller MUST distinguish a fault of the RECEIVER (nothing to check against — stay lenient)
 * from a fault of the SENDER (a record no current coordinator would build — refuse), a distinction a
 * bare `undefined` erased and let a coordinator exploit: by choosing how it filled `coordinatingBlockIds`
 * the coordinator chose which check every member ran.
 *
 * Module-internal on purpose — nothing outside this file consumes it.
 */
type ClusterViewDerivation =
	/** The member resolved a view. Confidence / emptiness is judged by the caller, not here. */
	| { kind: 'view'; view: ExpectedClusterView }
	/** No {@link DeriveExpectedClusterCallback} wired (no FRET, unit tests): nothing to check against. */
	| { kind: 'no-capability' }
	/**
	 * A usable block was named but the lookup itself failed. Receiver fault. Carries no payload: the
	 * error is logged where it is caught, and the gate's response does not depend on which error it was.
	 */
	| { kind: 'underivable' }
	/** The record names no block this member can legitimately derive from. Sender fault. */
	| { kind: 'unusable-record'; variant: 'no-coordinating-block' }
	| { kind: 'unusable-record'; variant: 'unbound-coordinating-block'; blockId: string; affected: number };

/** Stable reject reason a member emits when a declared peer set fails the membership admission gate. */
export const MEMBERSHIP_NOT_ADMITTED = 'membership-not-admitted';

/**
 * Stable reject reason a member emits when its own materialization of a commit's block disagrees
 * with the content digest the transaction author declared (`CommitRequest.blockDigests`). Rides in
 * the reject vote's `rejectReason`, which `clusterVoteSigningPayload` folds into the signed bytes —
 * so the rejection itself is integrity-protected.
 */
export const CONTENT_DIGEST_MISMATCH = 'content-digest-mismatch';

/**
 * The two stable reject reasons a validator-configured member emits from the shared
 * {@link checkPendValidation}: `PEND_NOT_VALIDATABLE` for a pend carrying no `validation` payload
 * under `ClusterConsensusConfig.unvalidatablePendPolicy: 'reject'`, and `VALIDATOR_FAULT` for a
 * checker that threw. Defined in `pend-validation.ts` (which the storage tier runs too, so both
 * tiers refuse with the same prefixes) and re-exported here next to its siblings above.
 */
export { PEND_NOT_VALIDATABLE, VALIDATOR_FAULT } from "../pend-validation.js";

interface ClusterMemberComponents {
	storageRepo: IRepo;
	peerNetwork: IPeerNetwork;
	peerId: PeerId;
	privateKey: PrivateKey;
	protocolPrefix?: string;
	// Reserved for partition-healing consumers (backlog ticket 6.5-partition-healing); not yet read by ClusterMember.
	partitionDetector?: PartitionDetector;
	fretService?: FretService;
	validator?: ITransactionValidator;
	reputation?: IPeerReputation;
	consensusConfig?: ClusterConsensusConfig;
	stateStore?: ITransactionStateStore;
	/** Restores a block under-replicated by cohort drift; see {@link ReconcileBlockCallback}. */
	reconcileBlock?: ReconcileBlockCallback;
	/** Receives the consensus commit cert per committed action; see {@link CommitCertificateSink}. */
	onCommitCertificate?: CommitCertificateSink;
	/** Applies a consensus-ordered invalidation to local storage; see {@link InvalidationApplySink}. */
	onInvalidate?: InvalidationApplySink;
	/** Layer-2 arbitrator-set recompute for invalidation verification; see {@link RecomputeArbitratorSetCapability}. */
	recomputeArbitratorSet?: RecomputeArbitratorSetCapability;
	/** Member-side cluster derivation for the membership admission gate; see {@link DeriveExpectedClusterCallback}. */
	deriveExpectedCluster?: DeriveExpectedClusterCallback;
	/**
	 * Wall clock in unix milliseconds; defaults to `Date.now`. Injectable so a test can age a held
	 * reservation past {@link CONFLICT_STALE_THRESHOLD_MS} without sleeping. It governs BOTH sides of
	 * the reservation's `lastUpdate` — the stamp and the comparison — so the two can never end up on
	 * different time bases.
	 *
	 * NOTE: partial injection, by design. This clock reaches ONLY `lastUpdate`; `message.expiration`,
	 * the promise/resolution timeouts, the periodic expiry sweep and the executed-transaction TTL all
	 * still read the real `Date.now`. So an injected clock must share an epoch with real time (seed it
	 * from `Date.now()`, then advance) — one starting near zero makes every record look long expired
	 * via the un-injected expiration check. Widen the injection if a test needs to drive expiry too.
	 */
	now?: () => number;
}

export function clusterMember(components: ClusterMemberComponents): ClusterMember {
	return new ClusterMember(
		components.storageRepo,
		components.peerNetwork,
		components.peerId,
		components.privateKey,
		components.protocolPrefix,
		components.partitionDetector,
		components.fretService,
		components.validator,
		components.reputation,
		components.consensusConfig,
		components.stateStore,
		components.reconcileBlock,
		components.onCommitCertificate,
		components.onInvalidate,
		components.recomputeArbitratorSet,
		components.deriveExpectedCluster,
		components.now
	);
}

// How long to keep executed transaction records (10 minutes)
const ExecutedTransactionTtlMs = 10 * 60 * 1000;

/**
 * How long a held reservation may go untouched before the conflict scan ({@link ClusterMember.findConflict})
 * sweeps it. Generous relative to a round-trip: the scan frees an ABANDONED coordinator's blocks, so
 * sweeping too eagerly would drop a live transaction whose next delivery is merely in flight.
 * Exported so a test can advance an injected clock past it without restating the number.
 */
export const CONFLICT_STALE_THRESHOLD_MS = 2000;

// Upper bound on an awaited active reconciliation of a divergent commit. Bounds the
// consensus path so a slow/unreachable cohort peer can't stall the cluster stream;
// a timeout is logged and tolerated (never thrown — that would reset the stream).
// Shared with the read path's acquisition (see RECONCILE_TIMEOUT_MS) — same operation, same bound.
const ReconcileTimeoutMs = RECONCILE_TIMEOUT_MS;

/**
 * True when a thrown storage error reports a missing pending action — i.e. this
 * member reached commit-consensus without having seen the matching pend phase.
 * That is recoverable local divergence (reconciled via sync / read-repair), not
 * a transaction fault, so it must not reset the cluster stream.
 */
function isMissingPendingActionError(err: unknown): boolean {
	return err instanceof Error && /pending action .+ not found/i.test(err.message);
}

/**
 * Handles cluster-side operations, managing promises and commits for cluster updates
 * and coordinating with the local storage repo.
 */
export class ClusterMember implements ICluster {
	// Track active transactions by their message hash
	private activeTransactions: Map<string, TransactionState> = new Map();
	// Track executed consensus transactions to prevent duplicate execution (messageHash -> executedAt timestamp)
	private executedTransactions: Map<string, number> = new Map();
	// Local storage's verdict for a pend operation applied during consensus (messageHash -> PendResult).
	// Retained so the coordinator can return storage's real answer instead of fabricating success —
	// a pend that every member refused (rival pending action, or the revision already taken) must
	// reach the writer as a conflict, not a win. Pruned alongside executedTransactions (same TTL).
	private executedPendResults: Map<string, PendResult> = new Map();
	// Local storage's verdict for a COMMIT operation applied during consensus (messageHash ->
	// CommitResult). Retained so the coordinator can detect when the ahead-divergence tolerance in
	// applyConsensusOperation swallowed a refusal whose real cause was a RIVAL action holding the
	// requested revision — the commit-tier acknowledgement hole: a commit that assembled consensus
	// inside every member's signed-but-not-yet-applied window is refused by every member's storage
	// at apply, and without this verdict the coordinator fabricates a success no member durably
	// stored. Pruned alongside executedTransactions (same TTL).
	private executedCommitResults: Map<string, CommitResult> = new Map();
	// Fast in-memory dedup for applied invalidations, keyed `${invalidatedActionId}:${disputeId}`.
	// The durable source of truth is the invalidation log entry (Log.findInvalidation, re-checked
	// inside the sink); this map only spares redundant work when the same invalidation reaches
	// consensus twice (rebroadcast / sync) under different message hashes. (-> appliedAt timestamp)
	private appliedInvalidations: Map<string, number> = new Map();
	// Queue of transactions to clean up
	private cleanupQueue: string[] = [];
	// Serialize concurrent updates for the same transaction
	private pendingUpdates: Map<string, Promise<ClusterRecord>> = new Map();
	// Interval handles for periodic cleanup (stored so dispose() can clear them)
	private readonly expirationInterval: NodeJS.Timeout;
	private readonly cleanupInterval: NodeJS.Timeout;

	/**
	 * Confidence floor at/below which FRET's network-size view is treated as untrustworthy for the
	 * membership gate. Above it the member trusts its derived view (confident path); at/below it the gate
	 * fails closed for downsizing. Matches the coordinator's `validateSmallCluster` confidence gate (> 0.5).
	 */
	private static readonly MembershipConfidenceThreshold = 0.5;

	/**
	 * Effective super-majority threshold this member accepts as sufficient for a commit. Defaults to
	 * {@link DEFAULT_SUPER_MAJORITY_THRESHOLD} (0.75) when no config is supplied — the SAME default the
	 * coordinator uses, so the two can never silently disagree about whether a transaction is final.
	 * (Previously defaulted to 1.0/unanimity, which split the member from a coordinator committing at 0.75.)
	 */
	private readonly superMajorityThreshold: number;
	// Membership admission gate parameters (see {@link admitMembership}). Read once from consensusConfig
	// so the gate has stable thresholds independent of the (untrusted) values a record declares.
	private readonly minAbsoluteClusterSize: number;
	private readonly clusterSizeTolerance: number;
	private readonly membershipAdmissionFraction: number;
	/** Operator-asserted smallest genuine cohort size, or undefined when unknown. */
	private readonly assumedClusterSize: number | undefined;
	private readonly allowUnvalidatedSmallCluster: boolean;
	/** What a validator-configured member does with a pend carrying no `validation` payload — see
	 * {@link ClusterConsensusConfig.unvalidatablePendPolicy}. Read once, like the gate parameters. */
	private readonly unvalidatablePendPolicy: UnvalidatablePendPolicy;
	/** Clock behind the reservation table's `lastUpdate` — see {@link ClusterMemberComponents.now}. */
	private readonly now: () => number;

	constructor(
		private readonly storageRepo: IRepo,
		private readonly peerNetwork: IPeerNetwork,
		private readonly peerId: PeerId,
		private readonly privateKey: PrivateKey,
		private readonly protocolPrefix?: string,
		// Reserved for partition-healing (backlog ticket 6.5-partition-healing); held but not yet consumed.
		_partitionDetector?: PartitionDetector,
		private readonly fretService?: FretService,
		private readonly validator?: ITransactionValidator,
		private readonly reputation?: IPeerReputation,
		consensusConfig?: ClusterConsensusConfig,
		private readonly stateStore?: ITransactionStateStore,
		private readonly reconcileBlock?: ReconcileBlockCallback,
		private readonly onCommitCertificate?: CommitCertificateSink,
		private readonly onInvalidate?: InvalidationApplySink,
		private readonly recomputeArbitratorSet?: RecomputeArbitratorSetCapability,
		private readonly deriveExpectedCluster?: DeriveExpectedClusterCallback,
		now?: () => number
	) {
		this.now = now ?? ((): number => Date.now());
		this.superMajorityThreshold = consensusConfig?.superMajorityThreshold ?? DEFAULT_SUPER_MAJORITY_THRESHOLD;
		this.minAbsoluteClusterSize = consensusConfig?.minAbsoluteClusterSize ?? 3;
		this.clusterSizeTolerance = consensusConfig?.clusterSizeTolerance ?? 0.5;
		this.membershipAdmissionFraction = consensusConfig?.membershipAdmissionFraction ?? 0.75;
		this.assumedClusterSize = consensusConfig?.assumedClusterSize;
		this.allowUnvalidatedSmallCluster = consensusConfig?.allowUnvalidatedSmallCluster ?? false;
		this.unvalidatablePendPolicy = consensusConfig?.unvalidatablePendPolicy ?? 'accept';
		// State the resolved gate parameters once, so an operator diagnosing a membership rejection can see
		// what this node actually resolved. A fact, not a warning: `assumedClusterSize < clusterSize` is the
		// normal default state, so warning on it would fire for every node and be ignored.
		log('cluster-member:admission-config', {
			assumedClusterSize: this.assumedClusterSize,
			minAbsoluteClusterSize: this.minAbsoluteClusterSize,
			membershipAdmissionFraction: this.membershipAdmissionFraction,
			allowUnvalidatedSmallCluster: this.allowUnvalidatedSmallCluster
		});
		// Periodically clean up expired transactions (.unref() so tests/short-lived processes can exit)
		this.expirationInterval = setInterval(() => this.queueExpiredTransactions(), 60000);
		this.expirationInterval.unref();
		// Process cleanup queue
		this.cleanupInterval = setInterval(() => this.processCleanupQueue(), 1000);
		this.cleanupInterval.unref();
	}

	/**
	 * The resolved super-majority threshold this member runs on. Exposed so the composition root can
	 * fail-fast if the member and the coordinator would run different thresholds (see the coupling
	 * assertion in `libp2p-node-base.ts`) — a mismatch is a latent phase-disagreement, caught at startup
	 * rather than mid-consensus.
	 */
	get effectiveSuperMajorityThreshold(): number {
		return this.superMajorityThreshold;
	}

	/**
	 * Clears all interval and timeout handles and empties active state.
	 * Called during node shutdown to prevent leaked timers.
	 */
	dispose(): void {
		clearInterval(this.expirationInterval);
		clearInterval(this.cleanupInterval);
		for (const [, state] of this.activeTransactions) {
			if (state.promiseTimeout) clearTimeout(state.promiseTimeout);
			if (state.resolutionTimeout) clearTimeout(state.resolutionTimeout);
		}
		this.activeTransactions.clear();
		this.cleanupQueue.length = 0;
		this.executedPendResults.clear();
		this.executedCommitResults.clear();
	}

	/**
	 * Checks if a transaction's operations were already executed during consensus.
	 * Used by the coordinator to avoid duplicate execution in CoordinatorRepo.
	 */
	wasTransactionExecuted(messageHash: string): boolean {
		return this.executedTransactions.has(messageHash);
	}

	/**
	 * Local storage's verdict for the pend operation this member applied at consensus for
	 * `messageHash`, when one was retained. The coordinator reads this so the answer a writer gets
	 * is the answer storage gave — the cluster path must not fabricate a success the single-node
	 * path (`CoordinatorRepo.pend`'s `peerCount <= 1` short-circuit) would never produce. Absent for
	 * transactions carrying no pend operation, for transactions applied before this member restarted
	 * (the map is in-memory only; the coordinator then falls back to its fabricated-success shape,
	 * with the promise-phase pending check in {@link validatePendOperations} narrowing that window),
	 * and after the executed-transaction TTL prunes it.
	 */
	getExecutedPendResult(messageHash: string): PendResult | undefined {
		return this.executedPendResults.get(messageHash);
	}

	/**
	 * Commit-shaped sibling of {@link getExecutedPendResult}: local storage's verdict for a commit
	 * operation applied during consensus, when this member retained one. `CoordinatorRepo.commit`
	 * consults it after a locally-executed commit-consensus — a retained refusal whose cause a local
	 * re-read confirms as a rival holding the requested revision is returned to the writer as a
	 * retryable conflict instead of the fabricated success the ahead-divergence tolerance would
	 * otherwise imply. Same availability caveats as the pend accessor: in-memory only, absent for
	 * pre-restart applies, pruned on the executed-transaction TTL.
	 */
	getExecutedCommitResult(messageHash: string): CommitResult | undefined {
		return this.executedCommitResults.get(messageHash);
	}

	/**
	 * Self-sign a one-peer {@link BlockCommitProof} over `message` — a thin delegate to
	 * {@link mintSoloCommitProof} with this member's own id and key. Lives here because this class is
	 * the key holder: `CoordinatorRepo` (the caller, on its solo-cohort commit short-circuit) knows
	 * the local peer id but never sees the private key. Nothing else moves — no record, no consensus
	 * state; the mint is a pure signing operation over the message the caller built.
	 */
	async mintSoloCommitProof(message: RepoMessage): Promise<BlockCommitProof> {
		return mintSoloCommitProof(this.peerId.toString(), this.privateKey, message);
	}

	/**
	 * Handles an incoming cluster update, managing the two-phase commit process
	 * and coordinating with the local storage repo
	 */
	async update(record: ClusterRecord): Promise<ClusterRecord> {
		// Serialize concurrent updates for the same transaction
		const existingUpdate = this.pendingUpdates.get(record.messageHash);
		if (existingUpdate) {
			log('cluster-member:concurrent-update-wait', { messageHash: record.messageHash });
			await existingUpdate;
			// After waiting, continue processing with the new incoming record
			// to ensure proper merging of promises/commits from coordinator
		}

		// Create a promise for this update operation
		const updatePromise = this.processUpdate(record);
		this.pendingUpdates.set(record.messageHash, updatePromise);

		try {
			const result = await updatePromise;
			return result;
		} finally {
			// Remove from pending updates after a short delay to allow concurrent calls to see it
			setTimeout(() => {
				this.pendingUpdates.delete(record.messageHash);
			}, 100).unref();
		}
	}

	private async processUpdate(record: ClusterRecord): Promise<ClusterRecord> {
		const ourId = this.peerId.toString();
		const inboundPhase = record.commits[ourId] ? 'commit' : record.promises[ourId] ? 'promise' : 'initial';
		log('cluster-member:incoming', {
			messageHash: record.messageHash,
			phase: inboundPhase,
			peerCount: Object.keys(record.peers).length,
			promiseCount: Object.keys(record.promises).length,
			commitCount: Object.keys(record.commits).length,
			existingTransaction: this.activeTransactions.has(record.messageHash)
		});

		// Report network size hint to FRET if provided
		if (this.fretService && record.networkSizeHint && record.networkSizeConfidence) {
			try {
				this.fretService.reportNetworkSize(
					record.networkSizeHint,
					record.networkSizeConfidence,
					'cluster'
				);
			} catch (err) {
				// Ignore errors reporting to FRET
			}
		}

		// Validate the incoming record
		await this.validateRecord(record);

		const existingState = this.activeTransactions.get(record.messageHash);
		let currentRecord = existingState?.record || record;
		if (existingState) {
			log('cluster-member:merge-start', {
				messageHash: record.messageHash,
				existingPromises: Object.keys(existingState.record.promises ?? {}),
				existingCommits: Object.keys(existingState.record.commits ?? {}),
				incomingPromises: Object.keys(record.promises ?? {}),
				incomingCommits: Object.keys(record.commits ?? {})
			});
		}

		// If we have an existing record, merge the signatures
		if (existingState) {
			currentRecord = await this.mergeRecords(existingState.record, record);
			log('cluster-member:merge-complete', {
				messageHash: record.messageHash,
				mergedPromises: Object.keys(currentRecord.promises ?? {}),
				mergedCommits: Object.keys(currentRecord.commits ?? {})
			});
		}

		// Drive the phase machine to a FIXPOINT rather than handling one phase per delivery. Each
		// vote this member adds can put the record straight into the next phase (our promise
		// completes super-majority ⇒ our commit is due; our commit completes the majority ⇒
		// consensus; our reject/conflict vote makes the record terminal), and any follow-on phase
		// not re-handled here would silently wait for the coordinator's next delivery — e.g. a
		// member whose promise the coordinator never collected receives the commit-phase record,
		// adds its promise, and must then also commit in the SAME delivery. One loop replaces the
		// hand-written per-branch re-checks that used to cover only the follow-ons their authors
		// thought of. Only the three vote-adding phases continue; each strictly grows the record
		// (adds a promise or commit key), so the loop terminates — the cap guards a
		// phase-computation bug, not a real bound.
		const MaxPhaseSteps = 8;
		let shouldPersist = true;
		phaseLoop: for (let step = 0; ; step++) {
			if (step >= MaxPhaseSteps) {
				log('cluster-member:phase-loop-overflow', { messageHash: record.messageHash, steps: step });
				break;
			}
			const phaseResult = await this.getTransactionPhase(currentRecord);
			log('cluster-member:phase', {
				messageHash: record.messageHash,
				phase: phaseResult.phase,
				step,
				promises: Object.keys(currentRecord.promises ?? {}),
				commits: Object.keys(currentRecord.commits ?? {})
			});
			switch (phaseResult.phase) {
				case TransactionPhase.OurPromiseNeeded:
					log('cluster-member:action-promise', {
						messageHash: record.messageHash
					});
					currentRecord = await this.handlePromiseNeeded(currentRecord);
					log('cluster-member:action-promise-complete', {
						messageHash: record.messageHash,
						promises: Object.keys(currentRecord.promises ?? {})
					});
					// Our own vote can be terminal (a reject where maxAllowedRejections is 0) or complete
					// the super-majority — recompute rather than guess which.
					continue;
				case TransactionPhase.OurConflictVoteNeeded:
					currentRecord = await this.handleConflictVoteNeeded(currentRecord, phaseResult.conflictsWith);
					// Never persist a record we conflict-voted: this member holds the WINNER, and
					// persisting the loser would reserve the same blocks a second time — half of what
					// made the silent-abstention failure self-sustaining.
					shouldPersist = false;
					continue;
				case TransactionPhase.OurCommitNeeded:
					log('cluster-member:action-commit', {
						messageHash: record.messageHash
					});
					currentRecord = await this.handleCommitNeeded(currentRecord);
					log('cluster-member:action-commit-complete', {
						messageHash: record.messageHash,
						commits: Object.keys(currentRecord.commits ?? {})
					});
					shouldPersist = false;
					// Our commit may have completed the majority — recompute; Consensus executes below.
					continue;
				case TransactionPhase.Consensus:
					log('cluster-member:action-consensus', {
						messageHash: record.messageHash
					});
					await this.handleConsensus(currentRecord);
					shouldPersist = false;
					break phaseLoop;
				case TransactionPhase.Rejected:
					log('cluster-member:action-rejected', {
						messageHash: record.messageHash
					});
					await this.handleRejection(currentRecord);
					shouldPersist = false;
					break phaseLoop;
				case TransactionPhase.ConflictSuperseded:
					// Enough conflict votes that super-majority is unreachable. NOT a rejection — the
					// callers retry it as a fresh transaction — so it gets its own terminal phase and the
					// record is cleared rather than held (holding a provably-dead loser would reserve its
					// blocks against the very retry that is supposed to win).
					log('cluster-member:action-conflict-superseded', {
						messageHash: record.messageHash
					});
					shouldPersist = false;
					break phaseLoop;
				case TransactionPhase.Propagating:
					// Transaction is complete and propagating - clean it up
					log('cluster-member:phase-propagating', {
						messageHash: record.messageHash
					});
					shouldPersist = false;
					break phaseLoop;
				case TransactionPhase.Promising:
					// We have already voted (approve, reject, or conflict); the record is still
					// collecting promises from the rest of the cohort. Nothing to add — retain the
					// record only if our vote wasn't a conflict (`shouldPersist` already reflects that).
					log('cluster-member:phase-promising-waiting', {
						messageHash: record.messageHash
					});
					break phaseLoop;
			}
		}

		if (shouldPersist) {
			// Update transaction state
			const timeouts = this.setupTimeouts(currentRecord);
			this.activeTransactions.set(record.messageHash, {
				record: currentRecord,
				lastUpdate: this.now(),
				promiseTimeout: timeouts.promiseTimeout,
				resolutionTimeout: timeouts.resolutionTimeout
			});
			this.persistParticipantState(record.messageHash, currentRecord);
			log('cluster-member:state-persist', {
				messageHash: record.messageHash,
				storedPromises: Object.keys(currentRecord.promises ?? {}),
				storedCommits: Object.keys(currentRecord.commits ?? {})
			});
		} else {
			log('cluster-member:state-clear', {
				messageHash: record.messageHash
			});
			this.clearTransaction(record.messageHash);
		}

		// Skip propagation - the coordinator manages distribution
		// await this.propagateIfNeeded(currentRecord);

		log('cluster-member:update-complete', {
			messageHash: record.messageHash,
			promiseCount: Object.keys(currentRecord.promises).length,
			commitCount: Object.keys(currentRecord.commits).length
		});
		return currentRecord;
	}

	/**
	 * Merges two records, validating that non-signature fields match.
	 * Detects equivocation (same peer changing vote type) and applies penalties.
	 */
	private async mergeRecords(existing: ClusterRecord, incoming: ClusterRecord): Promise<ClusterRecord> {
		log('cluster-member:merge-records', {
			messageHash: existing.messageHash,
			existingPromises: Object.keys(existing.promises ?? {}),
			existingCommits: Object.keys(existing.commits ?? {}),
			incomingPromises: Object.keys(incoming.promises ?? {}),
			incomingCommits: Object.keys(incoming.commits ?? {})
		});
		// Verify that immutable fields match
		if (existing.messageHash !== incoming.messageHash) {
			throw new Error('Message hash mismatch');
		}
		if (ClusterMember.canonicalJson(existing.message) !== ClusterMember.canonicalJson(incoming.message)) {
			throw new Error('Message content mismatch');
		}
		if (existing.membershipVersion === 2 || incoming.membershipVersion === 2) {
			// v2: the sorted peer-id set (captured by membershipDigest) is bound into messageHash, so equal
			// messageHash MUST imply equal membership on any honest path. A mismatch here — different digest
			// or version at equal hash — is a protocol violation (a bug or a hash-collision attack), NOT an
			// honest divergence: two honest members with different views now hold two DIFFERENT hashes, i.e.
			// two competing transactions the race machinery resolves, not one contested record. Log loudly
			// and reject; never silently adopt the incoming set. (validateRecord already proved each record's
			// own digest matches its own peers, so multiaddr / pubkey churn within the SAME id set — which
			// keeps the same digest and hash — does NOT trip this.)
			if (existing.membershipVersion !== incoming.membershipVersion || existing.membershipDigest !== incoming.membershipDigest) {
				log('cluster-member:peers-mismatch-invariant-violation', {
					messageHash: existing.messageHash,
					existingVersion: existing.membershipVersion,
					incomingVersion: incoming.membershipVersion,
					existingDigest: existing.membershipDigest,
					incomingDigest: incoming.membershipDigest,
					existingPeers: Object.keys(existing.peers ?? {}).sort(),
					incomingPeers: Object.keys(incoming.peers ?? {}).sort()
				});
				throw new Error('Peers mismatch');
			}
		} else if (ClusterMember.canonicalJson(existing.peers) !== ClusterMember.canonicalJson(incoming.peers)) {
			// v1 (legacy, membership unbound): full peer-object equality is the only available guard.
			throw new Error('Peers mismatch');
		}

		// Merge signatures with equivocation detection
		const mergedPromises = this.detectEquivocation(
			existing.promises, incoming.promises, 'promise', existing.messageHash
		);
		const mergedCommits = this.detectEquivocation(
			existing.commits, incoming.commits, 'commit', existing.messageHash
		);

		return {
			...existing,
			promises: mergedPromises,
			commits: mergedCommits
		};
	}

	/**
	 * Compares existing vs incoming signatures for the same peers.
	 * If a peer's vote type changed (approve↔reject), that's equivocation:
	 * report a penalty and keep the first-seen signature.
	 * New peers are accepted normally.
	 */
	private detectEquivocation(
		existing: Record<string, Signature>,
		incoming: Record<string, Signature>,
		phase: 'promise' | 'commit',
		messageHash: string
	): Record<string, Signature> {
		// NOTE: relies on validateSignatures() (via validateRecord in processUpdate) having already run on
		// every record reaching here, so each peerId's signature is key-bound. Without that guarantee the
		// Equivocation penalty below would act on self-asserted, unverified peer ids and could frame an
		// honest peer. Do not call this on unvalidated signatures.
		const merged = { ...existing };

		for (const [peerId, incomingSig] of Object.entries(incoming)) {
			const existingSig = existing[peerId];
			if (existingSig) {
				if (existingSig.type !== incomingSig.type) {
					// Equivocation detected: peer changed their vote type
					log('cluster-member:equivocation-detected', {
						peerId,
						phase,
						messageHash,
						existingType: existingSig.type,
						incomingType: incomingSig.type
					});
					this.reputation?.reportPeer(
						peerId,
						PenaltyReason.Equivocation,
						`${phase}:${messageHash}:${existingSig.type}->${incomingSig.type}`
					);
					// Keep first-seen signature — do not let the peer flip their vote
				}
				// Same type: keep existing (no-op, already in merged)
			} else {
				// New peer — accept normally
				merged[peerId] = incomingSig;
			}
		}

		return merged;
	}

	private async validateRecord(record: ClusterRecord): Promise<void> {
		// Reject a record whose membership-binding version this code does not implement. The cluster
		// consensus code is a single deployable unit (all cluster members upgrade together), so a version
		// we don't understand is rejected rather than cross-version-consensus'd.
		if (record.membershipVersion !== undefined && record.membershipVersion !== 1 && record.membershipVersion !== 2) {
			throw new Error(`Unsupported membershipVersion: ${record.membershipVersion}`);
		}

		// v2: the declared membership digest must match the record's own peer set. A record whose declared
		// digest doesn't match its peers is malformed (and its messageHash — computed over that digest —
		// would not bind the real membership).
		// NOTE: recomputes membershipDigest (one SHA256 over the sorted peer-id list) on every incoming v2
		// record; if a hot cluster ever shows this as a cost, memoize per (messageHash → digest).
		if (record.membershipVersion === 2) {
			const expectedDigest = await membershipDigest(record.peers);
			if (expectedDigest !== record.membershipDigest) {
				throw new Error(`Membership digest mismatch: expected=${expectedDigest}, received=${record.membershipDigest ?? 'undefined'}`);
			}
		}

		// Validate message hash matches the message content (v2 folds in the membership digest)
		const expectedHash = await this.computeMessageHash(record);
		if (expectedHash !== record.messageHash) {
			throw new Error(`Message hash mismatch: expected=${expectedHash}, received=${record.messageHash}`);
		}

		// Validate signatures
		await this.validateSignatures(record);

		// Validate expiration
		if (record.message.expiration && record.message.expiration < Date.now()) {
			throw new Error('Transaction expired');
		}
	}

	/**
	 * Compute message hash using the same algorithm as the coordinator. Version-dispatched: a v2 record
	 * folds its membership digest into the preimage, a v1 / unversioned record hashes byte-identically to
	 * before this change. Must match cluster-coordinator.ts createMessageHash().
	 */
	private async computeMessageHash(record: Pick<ClusterRecord, 'message' | 'membershipVersion' | 'membershipDigest'>): Promise<string> {
		return computeClusterMessageHash(record.message, recordMembershipDigest(record));
	}

	private async validateSignatures(record: ClusterRecord): Promise<void> {
		// Validate promise signatures. Reject on any failure, but only report an InvalidSignature
		// penalty when the key was proven to belong to `peerId` (outcome.penalize) — otherwise the id
		// is attacker-chosen and reporting it would let a coordinator frame an honest peer.
		const promiseHash = await this.computePromiseHash(record);
		for (const [peerId, signature] of Object.entries(record.promises)) {
			const outcome = await this.verifySignature(record, peerId, promiseHash, signature);
			if (!outcome.valid) {
				if (outcome.penalize) {
					this.reputation?.reportPeer(peerId, PenaltyReason.InvalidSignature, `promise:${record.messageHash}`);
				}
				throw new Error(`Invalid promise signature from ${peerId}`);
			}
		}

		// Validate commit signatures
		const commitHash = await this.computeCommitHash(record);
		for (const [peerId, signature] of Object.entries(record.commits)) {
			const outcome = await this.verifySignature(record, peerId, commitHash, signature);
			if (!outcome.valid) {
				if (outcome.penalize) {
					this.reputation?.reportPeer(peerId, PenaltyReason.InvalidSignature, `commit:${record.messageHash}`);
				}
				throw new Error(`Invalid commit signature from ${peerId}`);
			}
		}
	}

	/**
	 * Deterministic JSON: sorts object keys so comparisons are order-independent.
	 * NOTE: this is a second copy of the canonicalization in db-core `membership.ts` (which feeds the hash
	 * preimages). It is used here only for equality checks (message-content / v1-peers compare), and those
	 * run *after* a messageHash-equality gate, so a drift between the two can't silently forge agreement —
	 * but keep them byte-identical. If a third caller appears, promote to a single exported helper.
	 */
	private static canonicalJson(value: unknown): string {
		return JSON.stringify(value, (_, v) =>
			v && typeof v === 'object' && !Array.isArray(v)
				? Object.keys(v).sort().reduce((o: Record<string, unknown>, k) => { o[k] = v[k]; return o; }, {})
				: v
		);
	}

	private async computePromiseHash(record: ClusterRecord): Promise<string> {
		return computeClusterPromiseHash(record.messageHash, record.message, recordMembershipDigest(record));
	}

	private async computeCommitHash(record: ClusterRecord): Promise<string> {
		return computeClusterCommitHash(record.messageHash, record.message, record.promises, recordMembershipDigest(record));
	}

	private async signVote(hash: string, type: Signature['type'], extra?: string): Promise<string> {
		const sigBytes = await this.privateKey.sign(clusterVoteSigningPayload(hash, type, extra));
		return uint8ArrayToString(sigBytes, 'base64url');
	}

	/**
	 * Verify one vote signature and classify the outcome (see {@link VerifyOutcome}). Total on hostile
	 * input: a missing/empty key, a non-Ed25519 id, a key not bound to `peerId`, or malformed bytes all
	 * yield `{ valid:false, penalize:false }` (reject without penalizing an unproven identity) rather
	 * than throwing. Only after the key is proven to be the one `peerId` names does a failed
	 * cryptographic verify yield `{ valid:false, penalize:true }`.
	 *
	 * NOTE: the binding check (`peerIdBindsPublicKey`) proves the vote was signed by the key `peerId`
	 * names — it does NOT establish that `peerId` is legitimately in the cohort. A coordinator minting
	 * fresh keypairs and using each key's own derived id passes this for every one. Sybil/cohort
	 * membership is a separate layer (cohort-topic membership certificates), not solved here.
	 */
	private async verifySignature(record: ClusterRecord, peerId: string, hash: string, signature: Signature): Promise<VerifyOutcome> {
		const peerInfo = record.peers[peerId];
		if (!peerInfo?.publicKey?.length) {
			// No key to check against — identity not proven. Reject without penalty.
			return { valid: false, penalize: false };
		}
		let keyBytes: Uint8Array;
		try {
			// publicKey is base64url-encoded string (JSON-serialization safe)
			keyBytes = uint8ArrayFromString(peerInfo.publicKey, 'base64url');
		} catch {
			return { valid: false, penalize: false };
		}
		// The key must be the one `peerId` provably names, else the vote could be attributed to any peer
		// id while signed by a key the coordinator controls. Binding failure ⇒ identity unproven ⇒ no penalty.
		if (!peerIdBindsPublicKey(peerId, keyBytes)) {
			return { valid: false, penalize: false };
		}
		try {
			const pubKey = publicKeyFromRaw(keyBytes);
			const payload = clusterVoteVerificationPayload(hash, signature);
			const sigBytes = uint8ArrayFromString(signature.signature, 'base64url');
			const ok = await pubKey.verify(payload, sigBytes);
			// Key is bound to peerId: a failed verify is a genuine bad vote from a proven identity → penalize.
			// NOTE: residual — an Ed25519 peer's public key is derivable from its (public) id, so an attacker
			// can attach a victim's REAL key with a garbage signature and still trip this InvalidSignature
			// penalty on the victim. Binding narrows framing (the attacker must use the victim's own key, not
			// an arbitrary one) but cannot eliminate it here: a single signature can't distinguish "victim
			// signed badly" from "someone pasted the victim's public key + junk". Fully closing it needs an
			// authenticated membership/channel layer (cohort-topic membership certs), out of scope for this fix.
			return ok ? { valid: true } : { valid: false, penalize: true };
		} catch {
			// Malformed signature bytes / key decode failure: reject, but do not penalize on unparseable input.
			return { valid: false, penalize: false };
		}
	}

	private async getTransactionPhase(record: ClusterRecord): Promise<PhaseResult> {
		const peerCount = Object.keys(record.peers).length;
		const promiseCount = Object.keys(record.promises).length;
		const ourId = this.peerId.toString();

		const superMajority = Math.ceil(peerCount * this.superMajorityThreshold);
		const maxAllowedRejections = peerCount - superMajority;

		// Check for rejections — rejected if too many rejections to ever reach super-majority.
		// ONLY `reject` votes count here: a `conflict` vote is "not now", never a validity
		// judgement, so it must not push a record into the permanent `Rejected` phase.
		const rejectedPromises = Object.values(record.promises).filter(s => s.type === 'reject');
		const conflictPromises = Object.values(record.promises).filter(s => s.type === 'conflict');
		const rejectedCommits = Object.values(record.commits).filter(s => s.type === 'reject');
		if (rejectedPromises.length > maxAllowedRejections || this.hasMajority(rejectedCommits.length, peerCount)) {
			return { phase: TransactionPhase.Rejected };
		}

		// Conflict votes don't judge validity, but enough of them still make super-majority
		// unreachable — a distinct terminal outcome (retryable as a fresh transaction) so logs and
		// reputation-adjacent paths keep meaning what they say.
		if (conflictPromises.length > 0 && rejectedPromises.length + conflictPromises.length > maxAllowedRejections) {
			return { phase: TransactionPhase.ConflictSuperseded };
		}

		// Check if we need to vote. A lost race is answered with a conflict vote, not silence:
		// absence used to mean both "unreachable" and "refusing in favour of a rival", and the
		// coordinator could not tell the two apart. Once our conflict vote is merged into
		// `promises`, this branch is skipped forever — a conflict vote is terminal for this record;
		// a retry must be a fresh transaction (new messageHash), which `CoordinatorRepo.pend`
		// already mints per call.
		if (!record.promises[ourId]) {
			const conflict = this.findConflict(record);
			if (conflict) {
				return { phase: TransactionPhase.OurConflictVoteNeeded, conflictsWith: conflict.blockedBy };
			}
			return { phase: TransactionPhase.OurPromiseNeeded };
		}

		// Check if we have enough approved promises to proceed to commit. Deliberately blind to what
		// OUR own vote was: the rest of the cohort reaching super-majority is the commit rule
		// (Theorem 1 Case 2), so a member that rejected — or conflict-voted — still signs the commit
		// the cohort decided on rather than stalling it. Only the rejection/superseded thresholds
		// above can stop a record here, and both are checked first.
		//
		// NOTE: signing the commit drops this member's reservation on the record
		// (`shouldPersist = false` in the caller), and the phase fixpoint means that can now happen on
		// the FIRST delivery when the record already arrives at super-majority, rather than a
		// round-trip later. The safety argument is quorum intersection (Theorem 9: no rival can
		// assemble its own super-majority once this one has), NOT the reservation — the reservation
		// only orders *concurrently-pending* rivals.
		//
		// The lost update this predicted WAS observed (a pend admitted between a rival's
		// pend-consensus and commit-consensus, then refused by every member's storage at apply and
		// still reported to the writer as a success). Holding the reservation until `handleConsensus`
		// would not have closed it — the loser was approved before the winner's apply had even
		// reached most members — so the cure went elsewhere: `validatePendOperations` now rejects a
		// pend whose blocks are held by a different unresolved STORAGE pending record (the durable
		// reservation that spans pend-apply → commit/cancel), and the coordinator returns storage's
		// retained apply verdict instead of fabricating success (`getExecutedPendResult`). Residual:
		// a member that has not yet applied the rival's pend abstains from that vote, and only the
		// coordinating node's own verdict is threaded back — see the handoff notes on
		// `CoordinatorRepo.pend`.
		const approvedPromises = Object.values(record.promises).filter(s => s.type === 'approve');
		if (approvedPromises.length >= superMajority && !record.commits[ourId]) {
			return { phase: TransactionPhase.OurCommitNeeded };
		}

		// Check if still collecting promises
		if (promiseCount < peerCount && approvedPromises.length < superMajority) {
			return { phase: TransactionPhase.Promising };
		}

		// Check for consensus
		const approvedCommits = Object.values(record.commits).filter(s => s.type === 'approve');
		if (this.hasMajority(approvedCommits.length, peerCount)) {
			return { phase: TransactionPhase.Consensus };
		}

		return { phase: TransactionPhase.Propagating };
	}

	private hasMajority(count: number, total: number): boolean {
		return count > total / 2;
	}

	private async handlePromiseNeeded(record: ClusterRecord): Promise<ClusterRecord> {
		// Membership admission gate runs BEFORE pend validation: a member independently checks the declared
		// peer set is a legitimate cluster it belongs to, and refuses (reject vote) rather than rubber-stamping
		// a set the coordinator chose (e.g. a self-shrunk minority-partition set). On admission failure we skip
		// pend validation entirely and emit the membership rejection.
		const validationResult = await this.evaluatePromise(record);

		const promiseHash = await this.computePromiseHash(record);
		const type = validationResult.valid ? 'approve' as const : 'reject' as const;
		const rejectReason = validationResult.valid ? undefined : validationResult.reason;
		const sig = await this.signVote(promiseHash, type, rejectReason);

		const signature: Signature = validationResult.valid
			? { type: 'approve', signature: sig }
			: { type: 'reject', signature: sig, rejectReason };

		if (!validationResult.valid) {
			log('cluster-member:validation-rejected', {
				messageHash: record.messageHash,
				reason: validationResult.reason
			});
		}

		return {
			...record,
			promises: {
				...record.promises,
				[this.peerId.toString()]: signature
			}
		};
	}

	/**
	 * Answer a record that lost the deterministic race to a transaction this member already holds
	 * (`docs/correctness.md` Theorems 1 & 9: the loser is TOLD it lost, not ignored — an unanswered
	 * loss is indistinguishable from an unreachable cohort at the coordinator). `conflictWith` — the
	 * winning rival's messageHash — is folded into the signed payload, so the claim is
	 * integrity-protected in transit and readable without parsing prose. NOT a validity judgement:
	 * {@link getTransactionPhase} never counts conflict votes toward the permanent-rejection
	 * threshold, and the coordinator surfaces them as a retryable loss, never a validator rejection.
	 */
	private async handleConflictVoteNeeded(record: ClusterRecord, conflictWith: string): Promise<ClusterRecord> {
		log('cluster-member:action-conflict-vote', {
			messageHash: record.messageHash,
			conflictWith
		});
		const promiseHash = await this.computePromiseHash(record);
		const sig = await this.signVote(promiseHash, 'conflict', conflictWith);
		const signature: Signature = { type: 'conflict', signature: sig, conflictWith };

		return {
			...record,
			promises: {
				...record.promises,
				[this.peerId.toString()]: signature
			}
		};
	}

	/**
	 * The full promise-phase decision for a record: admit the declared membership FIRST, then (only if
	 * admitted) validate its pend operations, then its commit operations. Failing any yields a
	 * `{ valid:false, reason }` the caller turns into a `reject` vote. Keeping the three separate keeps
	 * the reason strings distinct — a `membership-not-admitted` reject is a different signal (feeds the
	 * dispute path) than a stale-revision / custom-validator reject, which is different again from a
	 * `content-digest-mismatch` (see {@link validateCommitOperations}). A record carries pend OR commit
	 * operations, so in practice exactly one of the latter two has anything to inspect.
	 */
	private async evaluatePromise(record: ClusterRecord): Promise<{ valid: boolean; reason?: string }> {
		const admission = await this.admitMembership(record);
		if (!admission.admit) {
			return { valid: false, reason: admission.reason ?? MEMBERSHIP_NOT_ADMITTED };
		}
		const pendValidation = await this.validatePendOperations(record);
		if (!pendValidation.valid) {
			return pendValidation;
		}
		// Revision staleness before content digests: a commit whose revision a rival already took can
		// never win, and the sharper stale reject also skips the per-block digest previews (the digest
		// check would abstain on such a block anyway — its local base rev no longer matches the
		// declared one).
		const commitRevValidation = await this.validateCommitRevisions(record);
		if (!commitRevValidation.valid) {
			return commitRevValidation;
		}
		return await this.validateCommitOperations(record);
	}

	/**
	 * Membership admission gate. Decides whether the coordinator-declared peer set (`record.peers`, call it
	 * `D`) is a *legitimate* cluster this member may vote inside, judged against the member's OWN
	 * independently-derived view — not against anything the (untrusted) record declares about its size.
	 * Evaluated on the promise path before the member signs an approve.
	 *
	 * The predicate admits `D` iff ALL hold:
	 *  1. **Self-membership** — this member's id ∈ `D`; else this block is not its responsibility (and a
	 *     coordinator must not route a record to a non-member to pad approval counts).
	 *  2. **Not a self-shrink below the floor** — with a confident derived view `E`, `|D| ≥ ⌈fraction·|E|⌉`
	 *     (and ≥ minAbsoluteClusterSize). `|E|` is the member's own confident cluster-size estimate `K_est`,
	 *     so a minority-partition set (small `D`) is rejected against the member's larger view.
	 *  3. **Consistency with the derived view** — `|D △ E|` within `clusterSizeTolerance·|E|`; honest churn
	 *     of a peer or two is absorbed, a wholesale-disjoint or half-size set is not.
	 *
	 * **Inadmissible records come first.** Before any of that, a member that CAN derive refuses outright a
	 * record whose coordinating block is the sender's free choice rather than a fact about the record: one
	 * that names no coordinating block at all, or names a block the record's own operations never touch.
	 * Those are defects of the SENDER, and no current coordinator produces them; treating them as "cannot
	 * derive" would hand a dishonest coordinator the choice of which check every member ran. A member with
	 * no derivation capability never reaches this refusal — it has nothing to check against.
	 *
	 * **Fail-closed posture.** When the member cannot confidently derive `E` — no capability, a bound
	 * block whose lookup failed or returned an empty/low-confidence view (low FRET confidence is exactly
	 * what a partition induces) — it must refuse any *downsizing* decision — but it
	 * needs a size reference to judge "downsize" against, and it may NOT borrow `clusterSize` for that:
	 * `clusterSize` is the replication factor (what a cohort should aim for), not a claim about how many
	 * peers exist, so a small deployment configured with the default 10 would refuse every write. The
	 * fallback yardstick is instead {@link ClusterConsensusConfig.assumedClusterSize} — the operator's own
	 * assertion of the smallest cohort this deployment can genuinely field — run through the SAME
	 * {@link admissionFloor} as the confident path, so the fallback can never be stricter than the measured
	 * path (it was: it demanded the full configured size, with no fraction and no slack for churn or a peer
	 * not yet discovered). With NEITHER a confident view NOR an asserted size the gate cannot judge a
	 * downsize at all, so it preserves the legacy approve behavior (backward-compatible for nodes/tests with
	 * no derivation wired). `allowUnvalidatedSmallCluster` is the explicit opt-in (single-node / local dev
	 * knowingly below the safe floor), matching the coordinator's `validateSmallCluster` semantics.
	 */
	private async admitMembership(record: ClusterRecord): Promise<{ admit: boolean; reason?: string }> {
		const ourId = this.peerId.toString();
		const declared = Object.keys(record.peers ?? {});

		// Predicate 1: self-membership. Always enforced (independent of any opt-in): a member does not vote
		// in a cluster it is not part of.
		if (!declared.includes(ourId)) {
			log('cluster-member:admission-reject', { messageHash: record.messageHash, reason: 'self-not-member', declaredSize: declared.length });
			return { admit: false, reason: `${MEMBERSHIP_NOT_ADMITTED}:self-not-member` };
		}

		// Explicit opt-in: knowingly transact below the safe floor (single-node / local dev). Skips the
		// size/consistency gates AND the record-shape refusals below, but not self-membership above: it
		// already bypasses the far stronger confident predicates, so making a weaker check the one thing it
		// cannot bypass would be incoherent.
		if (this.allowUnvalidatedSmallCluster) {
			return { admit: true };
		}

		const derivation = await this.deriveExpectedClusterView(record);

		// Split the sender's faults from this member's own. A record that names no coordinating block, or
		// names one its own operations never touch, is one no current coordinator builds (every production
		// sender goes through `ClusterCoordinator.executeClusterTransaction`, which stamps a bound id) — so
		// it is inadmissible, not merely underived. Collapsing these into the lenient fallback let a
		// dishonest coordinator choose which check every member ran, just by how it filled one field.
		// Exhaustive switch on purpose: a future `kind` must not silently join the lenient bucket.
		switch (derivation.kind) {
			case 'unusable-record': {
				log('cluster-member:admission-reject', {
					messageHash: record.messageHash,
					reason: derivation.variant,
					declaredSize: declared.length
				});
				// The count of affected block ids, not the list: this string is signed into the vote and lands
				// in dispute records, so a wide multi-block pend must not produce an unbounded reason.
				// NOTE: `blockId` itself is copied verbatim from the (untrusted) record and nothing upstream
				// bounds its length — fine while block ids are short content hashes; if a record ever carries
				// a pathological id, truncate it here rather than signing an arbitrarily large reason string.
				// A fresh record carries no signatures, so `validateRecord` does not authenticate the sender
				// before this point; what keeps it harmless is that the reason is bounded by the record the
				// sender already transmitted (no amplification), not that the path is authenticated.
				return {
					admit: false,
					reason: derivation.variant === 'no-coordinating-block'
						? `${MEMBERSHIP_NOT_ADMITTED}:no-coordinating-block`
						: `${MEMBERSHIP_NOT_ADMITTED}:unbound-coordinating-block (blockId=${derivation.blockId}, affected=${derivation.affected})`
				};
			}
			// Receiver-side outcomes: a resolved view, no capability at all, or a bound block whose lookup
			// failed. All three keep today's behaviour, judged below.
			case 'view':
			case 'no-capability':
			case 'underivable':
				break;
			default: {
				// `never` is the compile-time half of the guard: adding a `kind` without deciding its side
				// of the sender/receiver split fails the build here. The runtime half returns a real
				// verdict — fail closed — rather than the derivation object, which is not one.
				const exhaustive: never = derivation;
				return { admit: false, reason: `${MEMBERSHIP_NOT_ADMITTED}:${(exhaustive as { kind: string }).kind}` };
			}
		}

		const derived = derivation.kind === 'view' ? derivation.view : undefined;
		// An empty derived view (kEst === 0) carries no usable reference set: measured against it every
		// non-empty declared set is wholly "inconsistent" (maxDiff = ceil(tol·0) = 0), which would spuriously
		// reject a legitimate full cluster — a stricter, worse outcome than an absent view. Treat empty as
		// not-confident so it takes the fail-closed-or-legacy branch below instead. (Not normally reachable:
		// a responsible member's findCluster includes at least itself; this guards a transient empty read.)
		const derivedSize = derived !== undefined ? Object.keys(derived.peers ?? {}).length : 0;
		const confident = derived !== undefined
			&& derived.confidence > ClusterMember.MembershipConfidenceThreshold
			&& derivedSize > 0;

		if (!confident) {
			// Fail closed for downsizing under low/absent confidence, measured against the operator's asserted
			// cohort size rather than the replication factor. With no asserted size the gate cannot tell a
			// downsize from a legitimately small cluster at all, so it preserves legacy approve behavior.
			if (this.assumedClusterSize === undefined) {
				return { admit: true };
			}
			const floor = this.admissionFloor(this.assumedClusterSize);
			if (declared.length >= floor) {
				return { admit: true };
			}
			log('cluster-member:admission-reject', {
				messageHash: record.messageHash,
				reason: 'low-confidence-downsize',
				declaredSize: declared.length,
				floor,
				assumedClusterSize: this.assumedClusterSize,
				confidence: derived?.confidence
			});
			// The numbers ride along in the reason: this rejection is caused by *local* configuration, and
			// without them a coordinator (or an operator reading a dispute record) has no hint which knob did it.
			// NOTE: two honest members with different local config now emit *different* reason strings for the
			// same record. Nothing compares reasons across peers today (`disputeEvidence.rejectReasons` is a
			// per-peer map, and the signed payload hashes the string each vote carries); if anything ever groups
			// or dedupes dispute reasons by string equality, group on the `membership-not-admitted:<variant>`
			// prefix, not the whole string.
			return {
				admit: false,
				reason: `${MEMBERSHIP_NOT_ADMITTED}:low-confidence-downsize (declared=${declared.length}, floor=${floor}, assumedClusterSize=${this.assumedClusterSize})`
			};
		}

		const expected = Object.keys(derived!.peers ?? {});
		const kEst = expected.length;

		// Predicate 2: floor derived from the member's OWN confident estimate.
		const floor = this.admissionFloor(kEst);
		if (declared.length < floor) {
			log('cluster-member:admission-reject', {
				messageHash: record.messageHash,
				reason: 'below-floor',
				declaredSize: declared.length,
				floor,
				kEst
			});
			return {
				admit: false,
				reason: `${MEMBERSHIP_NOT_ADMITTED}:below-floor (declared=${declared.length}, floor=${floor}, kEst=${kEst})`
			};
		}

		// Predicate 3: consistency with the derived view within tolerance.
		const symmetricDiff = ClusterMember.symmetricDifferenceSize(declared, expected);
		const maxDiff = Math.ceil(this.clusterSizeTolerance * kEst);
		if (symmetricDiff > maxDiff) {
			log('cluster-member:admission-reject', {
				messageHash: record.messageHash,
				reason: 'inconsistent-with-derived-view',
				declaredSize: declared.length,
				kEst,
				symmetricDiff,
				maxDiff
			});
			return { admit: false, reason: `${MEMBERSHIP_NOT_ADMITTED}:inconsistent-with-derived-view` };
		}

		return { admit: true };
	}

	/**
	 * The smallest declared peer set admissible against a cohort-size reference `k`, whether `k` is
	 * measured (the confident path's `kEst`) or asserted (`assumedClusterSize`). One function so the
	 * fallback can never be stricter than the measured path — which it was, demanding the full configured
	 * size with no fraction and no slack. Clamped at `minAbsoluteClusterSize`, so a degenerate `k` of 0, 1
	 * or negative yields the absolute floor rather than a floor that admits everything. A non-finite scaled
	 * size (a `NaN` or `Infinity` config value) is likewise treated as no usable reference rather than
	 * propagating: an unguarded `NaN` floor fails EVERY comparison, which would silently make the node
	 * reject every unconfident write.
	 *
	 * NOTE: partition safety needs `2 · membershipAdmissionFraction · superMajorityThreshold > 1` — each
	 * side of a split must recruit `fraction · threshold · K` distinct honest members, and two sides cannot
	 * both find them in one K-peer cluster. At the shipped defaults (0.75 · 0.75 — both default to
	 * `DEFAULT_SUPER_MAJORITY_THRESHOLD` / `membershipAdmissionFraction`'s own default) that product is
	 * 1.125. If either default is ever lowered, re-check Theorem 2 in `docs/correctness.md` before shipping it.
	 */
	private admissionFloor(k: number): number {
		const scaled = Math.ceil(this.membershipAdmissionFraction * k);
		return Math.max(this.minAbsoluteClusterSize, Number.isFinite(scaled) ? scaled : 0);
	}

	/**
	 * Derive this member's own view of the record's block cluster via the injected capability, reporting
	 * *why* when it cannot — see {@link ClusterViewDerivation}. Four outcomes, deliberately not collapsed
	 * into one `undefined`: the member has no capability; the lookup failed; the record named no
	 * coordinating block; the record named a block its own operations never touch. The last two are the
	 * sender's choices and {@link admitMembership} refuses them; the first two are this member's own
	 * limitation and stay lenient. Derived from the record's coordinating block, the same key the
	 * coordinator used to select the cluster.
	 *
	 * Read off `record.message`, NOT a top-level record field: `messageHash` covers the message only, so
	 * only the in-message copy is tamper-evident to a relaying peer. (There is no top-level copy any more —
	 * see {@link ClusterRecord.message}.)
	 */
	private async deriveExpectedClusterView(record: ClusterRecord): Promise<ClusterViewDerivation> {
		// Capability check FIRST, before the record's field is even read: a member with nothing to derive
		// against must never report a sender fault — it has no standing to judge the record's shape.
		if (!this.deriveExpectedCluster) {
			return { kind: 'no-capability' };
		}
		// NOTE: only `coordinatingBlockIds[0]` is read. A pend may declare the whole consolidated batch
		// here; the gate needs one block to derive a cohort from, and the coordinator's choke point puts
		// the cohort key it actually selected against at index 0.
		const blockId = record.message.coordinatingBlockIds?.[0];
		if (blockId === undefined) {
			// Covers both an absent field and a present-but-empty array — distinct wire shapes, same
			// defect: the record names nothing to derive from. Every production sender routes through
			// `ClusterCoordinator.executeClusterTransaction`, which stamps a bound id when the message has
			// none, so no honest record reaches here.
			//
			// No rolling-upgrade gate guards this refusal, and `membershipVersion` is NOT that gate:
			// `validateRecord` accepts v1 and unversioned records, and the choke point that stamps the
			// field onto commit/cancel records (`commit-and-cancel-records-omit-the-coordinating-block`)
			// landed without bumping the version — so a peer on a build older than that one sends
			// commit/cancel records this refuses. The decision is that cluster consensus deploys as one
			// unit and this project makes no cross-build compatibility promise; if that ever changes,
			// the gate belongs here (admit an unversioned record on the lenient path), not in the caller.
			log('cluster-member:coordinating-block-absent', { messageHash: record.messageHash });
			return { kind: 'unusable-record', variant: 'no-coordinating-block' };
		}
		// Hashing the field makes it tamper-evident to RELAYS, but the coordinator is the party this gate
		// exists to check and it picks the field before it computes the hash. Unbound, a Byzantine
		// coordinator declares a shrunken cohort `D` and names a coordinating block whose real cohort
		// resembles `D`: every member then derives that block's cohort, finds kEst = |D|, symmetric
		// difference 0, and admits — the gate fully defeated. Binding the coordinating block to a block the
		// record's OWN operations touch removes that free choice. `getAffectedBlockIds` is the same block
		// extraction conflict detection already runs on this message — one definition, so the set a
		// coordinating id must come from cannot drift from the set the record is judged to touch.
		const affected = getAffectedBlockIds(record.message.operations);
		if (!affected.includes(blockId)) {
			log('cluster-member:coordinating-block-unbound', {
				messageHash: record.messageHash,
				coordinatingBlockId: blockId
			});
			// Refuse, do not fall back: the fallback floor is the posture for a fault of THIS member, and
			// letting a sender-chosen defect land there let the coordinator pick which check ran. Reported
			// as a reject vote rather than a throw so the member emits a signed `reject` and dispute
			// accounting keeps working — this stays out of `validateRecord`'s failure surface.
			//
			// `affected` is empty for a record with no operations, so any named block is unbound and the
			// record is refused — correct (a record with no operations is malformed), and why `affected=0`
			// can legitimately appear in the reason string.
			return { kind: 'unusable-record', variant: 'unbound-coordinating-block', blockId, affected: affected.length };
		}
		// Which block a member derived its cohort view from is the single most useful fact when an
		// admission decision has to be explained after the fact — and the only externally visible sign
		// that the confident predicates ran at all rather than the fallback floor.
		log('cluster-member:derive-expected-cluster', { messageHash: record.messageHash, blockId });
		try {
			// NOTE: derives (findCluster) once per inbound record on the promise path — one routing lookup
			// per vote. If this shows up as hot, cache the derived view per (blockId, short TTL): it is a
			// pure read of current topology, so a few-seconds-stale view is safe for admission.
			return { kind: 'view', view: await this.deriveExpectedCluster(blockId as BlockId) };
		} catch (err) {
			log('cluster-member:derive-expected-cluster-error', { messageHash: record.messageHash, error: (err as Error).message });
			// Receiver fault: a bound block whose lookup threw. Stays lenient (the `assumedClusterSize`
			// fallback) — that is the partition posture, and refusing here would make a transient routing
			// hiccup refuse every write.
			return { kind: 'underivable' };
		}
	}

	/** |A △ B| over two id lists (order-independent set symmetric difference). */
	private static symmetricDifferenceSize(a: string[], b: string[]): number {
		const setA = new Set(a);
		const setB = new Set(b);
		let count = 0;
		for (const x of setA) if (!setB.has(x)) count++;
		for (const x of setB) if (!setA.has(x)) count++;
		return count;
	}

	/**
	 * Validates pend operations in a cluster record using the transaction validator.
	 * Also checks for stale revisions, and for blocks held by a different unresolved pending
	 * action, to prevent consensus on operations that storage would refuse at apply.
	 * Returns success if no validator is configured (backwards compatibility).
	 */
	private async validatePendOperations(record: ClusterRecord): Promise<{ valid: boolean; reason?: string }> {
		// Find pend operations in the message
		for (const operation of record.message.operations) {
			if ('pend' in operation) {
				const pendRequest = operation.pend;
				const blockIds = blockIdsForTransforms(pendRequest.transforms);
				// One state read serves both checks below: `latest` for staleness, `pendings` for the
				// unresolved-rival check.
				const blockResults = await this.storageRepo.get({ blockIds });

				// Check for stale revisions before allowing consensus
				if (pendRequest.rev !== undefined) {
					for (const blockId of blockIds) {
						const blockResult = blockResults[blockId];
						if (blockResult?.unavailable !== undefined) {
							// This member cannot establish the block's revision, so it cannot judge
							// staleness. Vote reject rather than approve on an answer it knows is a
							// guess — approving would let a stale pend reach consensus on the strength
							// of a member that could not check it. (Before StorageRepo caught
							// materialization faults per block, this read threw out of the promise
							// handler; rejecting keeps the fail-closed posture with a signed reason.)
							log('cluster-member:validation-block-unavailable', {
								messageHash: record.messageHash,
								blockId,
								reason: blockResult.unavailable
							});
							return { valid: false, reason: `block ${blockId} unavailable (${blockResult.unavailable}): cannot verify revision` };
						}
						const latest = blockResult?.state?.latest;
						if (latest !== undefined && latest.rev >= pendRequest.rev) {
							// Self is excluded so a redelivered pend for this same action stays
							// approvable — the same exclusion the pending-rival check below documents,
							// and the same rule storage applies (see {@link isOwnRevision}).
							if (isOwnRevision(latest, pendRequest.rev, pendRequest.actionId)) {
								continue;
							}
							log('cluster-member:validation-stale-revision', {
								messageHash: record.messageHash,
								blockId,
								requestedRev: pendRequest.rev,
								latestRev: latest.rev
							});
							// Deliberately prose-only: this reason is fed to computeSigningPayload, signed,
							// and carried as Signature.rejectReason, so adding a structured revision here
							// would change the signed byte layout and the Signature type — every peer would
							// have to agree on the new format or verification breaks across versions. This
							// is NOT a StaleFailure producer, so StaleFailure.staleAt does not apply; the
							// coordinator's own local re-read (CoordinatorRepo.classifyStaleRejection)
							// supplies that number when it can confirm the revision itself.
							return { valid: false, reason: `stale revision: block ${blockId} at rev ${latest.rev}, requested rev ${pendRequest.rev}` };
						}
					}
				}

				// Reject a pend whose blocks are held by a DIFFERENT unresolved pending action. This is
				// the durable reservation the in-memory table (`findConflict` / `activeTransactions`)
				// cannot provide: that table clears the moment the rival's PEND record reaches
				// consensus, but the rival's storage pending record — written at pend-apply, removed at
				// commit or cancel — spans exactly the pend→commit window in which `latest.rev` has not
				// yet advanced. Storage's own pend would refuse this request at consensus-apply for the
				// same reason (`StorageRepo.pend`'s listPendingTransactions scan); voting reject here
				// moves that verdict into the phase where the cohort aggregates it, so the loser is
				// refused with a real answer instead of burning a consensus round it cannot win. A
				// member that has not yet applied the rival's pend has no record and simply abstains
				// from this reason; the coordinator returning the retained apply verdict
				// (getExecutedPendResult) catches that residual. Self is excluded so a redelivered pend
				// for this same action stays approvable. An unavailable block carries no `pendings` and
				// abstains (the rev branch above already fail-closes when a revision claim is at stake).
				// Reason stays plain prose: it is fed to computeSigningPayload and carried as
				// Signature.rejectReason, exactly like the stale-revision reason above.
				for (const blockId of blockIds) {
					const rivals = (blockResults[blockId]?.state?.pendings ?? []).filter(actionId => actionId !== pendRequest.actionId);
					if (rivals.length > 0) {
						log('cluster-member:validation-pending-conflict', {
							messageHash: record.messageHash,
							blockId,
							actionId: pendRequest.actionId,
							rivals
						});
						return { valid: false, reason: `pending conflict: block ${blockId} held by unresolved action(s) ${rivals.join(', ')}` };
					}
				}

				// Re-check the transaction when a validator is configured. The unvalidatable-pend
				// policy and the throwing-validator catch live in the shared `checkPendValidation`,
				// which the storage tier runs too, so a member cannot vote approve on a shape its own
				// storage would refuse at apply. Its reasons are fed to computeSigningPayload and
				// carried as Signature.rejectReason, exactly like the stale-revision reason above, so
				// a fail-closed refusal here is signed evidence rather than a lost vote.
				const validator = this.validator;
				const validation = await checkPendValidation(
					pendRequest,
					validator && (({ transaction, operationsHash }) => validator.validate(transaction, operationsHash)),
					this.unvalidatablePendPolicy,
					event => event.kind === 'unvalidatable'
						// An operator can grep this line to see how much traffic goes unchecked.
						? log('cluster-member:pend-unvalidatable', {
							messageHash: record.messageHash,
							actionId: pendRequest.actionId,
							policy: event.policy
						})
						: log('cluster-member:validator-fault', {
							messageHash: record.messageHash,
							error: event.error
						})
				);
				if (!validation.valid) {
					return { valid: false, reason: validation.reason };
				}
			}
		}

		return { valid: true };
	}

	/**
	 * Promise-round check that a commit record's requested revision is not already committed HERE
	 * under a different action. This is the member-side arm that keeps a DEAD rival's re-broadcast
	 * commit from assembling consensus: after a race winner commits and members clear its record
	 * from the reservation table, a loser's re-driven commit meets no conflict votes — without this
	 * check every caught-up member would abstain (the content-digest check below abstains for
	 * update-only transforms whose base moved) and the loser could reach commit-consensus for a
	 * write no member will ever durably store (its apply is refused stale and tolerated as 'ahead'
	 * divergence — see `applyConsensusOperation`).
	 *
	 * Same "must run on the promise round" rule as {@link validateCommitOperations}: the
	 * commit-round vote is deliberately blind, so promise votes are the only ones that carry
	 * "I checked this". The four-way rule, per committed block:
	 *  - no local `latest`, or `latest.rev < commit.rev` → abstain (approve). Preserves the
	 *    lagging-member tolerance (`coordinator-repo-commit-divergence.spec.ts`): a member behind
	 *    the commit cannot judge it.
	 *  - `latest.rev === commit.rev` with the SAME action → abstain (approve). Idempotent
	 *    redelivery of an already-durable commit; rejecting would make the writer rebase and
	 *    re-append an action that already landed — a duplicate entry. (Storage's `alreadyDone`
	 *    partition returns success for this shape at apply.)
	 *  - `latest.rev === commit.rev` with a DIFFERENT action → reject: a rival took the revision.
	 *  - `latest.rev > commit.rev` → consult the {@link IRevisionActionReader} capability for who
	 *    holds `commit.rev`: a different action → reject; the same action → abstain (already
	 *    durable, history simply moved on); no record / capability absent / read fault → abstain.
	 *
	 * Never throws out of the vote path: any read fault is an abstain (mirroring the digest check's
	 * preview-error arm), because a member that fails to vote at all is worse than one that
	 * abstains. Reason stays plain prose — it is fed to computeSigningPayload and carried as
	 * Signature.rejectReason, exactly like the stale-revision pend reject.
	 *
	 * Residual (see the commit-tier handoff): a member that signed the winner's commit but has not
	 * yet APPLIED it sits in a window where it holds neither the winner's record (reservation
	 * dropped at commit-sign, `shouldPersist = false`) nor the winner's revision (storage still
	 * behind) — it abstains here. A capability-less member, or one with history truncated below
	 * `latest`, abstains at `latest.rev > commit.rev` too. A rival's commit can therefore still
	 * pass the promise round if EVERY member is simultaneously in one of those states — on a fast
	 * cohort that window is the COMMON case, not the corner. The backstop is downstream of
	 * consensus: every member's apply then refuses the rival as stale, the coordinating node's own
	 * member retains that refusal (`getExecutedCommitResult`), and `CoordinatorRepo.commit`
	 * confirms the rival against local storage and answers the writer with a retryable conflict
	 * instead of a fabricated success. `ConflictRaceLostError` conversion and classified
	 * rejections close the re-drive route the same way.
	 */
	private async validateCommitRevisions(record: ClusterRecord): Promise<{ valid: boolean; reason?: string }> {
		for (const operation of record.message.operations) {
			if (!('commit' in operation)) {
				continue;
			}
			const commit = operation.commit;
			let blockResults: Awaited<ReturnType<IRepo['get']>>;
			try {
				// The member's raw storage repo (no cluster recursion) — the same seam
				// validatePendOperations reads on every pend vote.
				blockResults = await this.storageRepo.get({ blockIds: commit.blockIds });
			} catch (err) {
				log('cluster-member:commit-staleness-read-error', {
					messageHash: record.messageHash,
					actionId: commit.actionId,
					error: err instanceof Error ? err.message : String(err)
				});
				continue; // a local read fault is an abstain, never an escape out of the vote path
			}
			for (const blockId of commit.blockIds) {
				const latest = blockResults[blockId]?.state?.latest;
				if (!latest || latest.rev < commit.rev) {
					continue; // behind (or block never seen): cannot judge — abstain
				}
				if (isOwnRevision(latest, commit.rev, commit.actionId)) {
					continue; // idempotent redelivery of an already-durable commit — MUST NOT reject
				}
				if (latest.rev === commit.rev) {
					log('cluster-member:validation-stale-commit', {
						messageHash: record.messageHash,
						blockId,
						actionId: commit.actionId,
						rev: commit.rev,
						committedBy: latest.actionId
					});
					return { valid: false, reason: `stale commit: block ${blockId} rev ${commit.rev} committed by a different action` };
				}
				// latest.rev > commit.rev: latest can no longer name who took commit.rev — ask the
				// revision index. Structural probe, same pattern as previewCommitDigest below: a repo
				// without the capability abstains.
				const reader = this.storageRepo as IRepo & Partial<IRevisionActionReader>;
				if (typeof reader.getRevisionAction !== 'function') {
					continue;
				}
				let takenBy: ActionId | undefined;
				try {
					takenBy = await reader.getRevisionAction(blockId, commit.rev);
				} catch (err) {
					log('cluster-member:commit-staleness-revision-read-error', {
						messageHash: record.messageHash,
						blockId,
						rev: commit.rev,
						error: err instanceof Error ? err.message : String(err)
					});
					continue; // read fault → abstain
				}
				if (takenBy !== undefined && takenBy !== commit.actionId) {
					log('cluster-member:validation-stale-commit', {
						messageHash: record.messageHash,
						blockId,
						actionId: commit.actionId,
						rev: commit.rev,
						committedBy: takenBy,
						latestRev: latest.rev
					});
					return { valid: false, reason: `stale commit: block ${blockId} rev ${commit.rev} committed by a different action` };
				}
				// takenBy === commit.actionId (already durable, history moved on) or undefined
				// (truncated history — unknown): abstain either way.
			}
		}
		return { valid: true };
	}

	/**
	 * Promise-round check of a commit record's declared content digests
	 * (`CommitRequest.blockDigests`) against what this member's OWN pended copy of each transform
	 * would materialize (`StorageRepo.previewCommitDigest`). This is what makes a promise approval on
	 * a commit record MEAN something about content: before this hook, the promise round validated
	 * nothing for commits (`validatePendOperations` only inspects pend operations).
	 *
	 * MUST run on the promise round, not the commit round: the commit-round vote is cast deliberately
	 * blind — `getTransactionPhase` signs the commit whenever promise approvals reach super-majority,
	 * regardless of this member's own promise vote — so promise approvals are the only votes that
	 * carry "I checked this". Do not move it.
	 *
	 * Checkable/abstain rule, keyed on the member's OWN pended transform (the payload the client
	 * authored, delivered at pend — a hostile declarer cannot force or dodge a check by mis-declaring
	 * `baseRev`):
	 *  - transform carries an `insert` → base-independent, ALWAYS check (declared `baseRev` ignored);
	 *  - `updates` only → check iff this member's local base rev equals the declared `baseRev`
	 *    (StorageRepo.commit accepts any `latest.rev < request.rev`, so a lagging member applying an
	 *    update-only transform to an older base legitimately materializes different bytes);
	 *  - `delete` only / no base / unmaterializable base → materializes nothing to compare, abstain;
	 *  - no pending transform for the action (this member never saw the pend) → abstain.
	 * "Abstain" = contribute no content attestation: approve exactly as before this check existed.
	 *
	 * Residual: a false digest survives only when the declarer lies AND enough of the cohort is
	 * simultaneously unable to check (lagging on update-only blocks, missed pends) that no honest
	 * checker is left — any single caught-up honest member rejects. Strictly stronger than before,
	 * when commit signatures bound no content at all. Verifying/persisting a durable content proof is
	 * later work (persist-block-commit-proof).
	 */
	private async validateCommitOperations(record: ClusterRecord): Promise<{ valid: boolean; reason?: string }> {
		// Capability probe: `storageRepo` is typed IRepo, and only a repo that owns the local
		// materialization can preview one. A repo without the capability abstains everywhere (also
		// keeps mock-repo harnesses and non-storage compositions on the legacy approve path).
		// NOTE: probing structurally means a decorating/caching repo later inserted at this seam
		// silently disables the whole check with no signal. `ICommitDigestPreviewer` exists so such a
		// decorator has a named contract to forward; if a non-forwarding wrapper is ever wired here,
		// promote this to a typed component field rather than widening the probe.
		const repo = this.storageRepo as IRepo & Partial<ICommitDigestPreviewer>;
		if (typeof repo.previewCommitDigest !== 'function') {
			return { valid: true };
		}

		for (const operation of record.message.operations) {
			if (!('commit' in operation)) {
				continue;
			}
			const commit = operation.commit;
			// An upgraded member receiving a commit with no declarations abstains everywhere.
			if (!commit.blockDigests) {
				continue;
			}
			// One Set per commit operation: the surplus-entry filter below is a membership test per
			// declared id, and `blockIds` is a per-coordinator batch that can be wide.
			const committedIds = new Set<string>(commit.blockIds);
			// NOTE: previews run one block at a time, so a commit declaring N blocks adds N sequential
			// preview round-trips (each 1-3 block-storage reads plus a structuredClone of the base and
			// the transform) to this member's promise-round latency. Unmeasured, and sequencing buys the
			// short-circuit on the first mismatch. If wide commits ever show up as promise latency,
			// fan the previews out with Promise.all and reduce the results, rather than sampling a
			// subset of the declared ids — a skipped id is an unchecked id.
			for (const [blockId, declared] of Object.entries(commit.blockDigests)) {
				// Surplus (or hostile) entry for a block this commit does not even cover: ignore it —
				// never throw out of the vote path, and never reject on content nobody is committing.
				if (!committedIds.has(blockId)) {
					continue;
				}
				// `blockDigests` is untrusted wire data with no ingress schema behind it, so the entry
				// need not be the shape the type promises. A malformed entry is treated as an omitted
				// one (abstain) rather than a mismatch: rejecting on it would let a garbled request
				// look like forged content, and reading through it would throw a TypeError out of the
				// vote path — this member would then fail to vote at all instead of voting reject.
				if (typeof declared?.digest !== 'string') {
					continue;
				}
				let preview: CommitDigestPreview | undefined;
				try {
					preview = await repo.previewCommitDigest(blockId as BlockId, commit.actionId, commit.rev);
				} catch (err) {
					log('cluster-member:content-digest-preview-error', {
						messageHash: record.messageHash,
						blockId,
						error: err instanceof Error ? err.message : String(err)
					});
					continue; // a local preview fault is an abstain, never a content judgement
				}
				// No pend seen here, or the transform materializes nothing to compare (tombstone,
				// updates with no base, unmaterializable base) → abstain.
				if (preview === undefined || preview.digest === undefined) {
					continue;
				}
				// `typeof === 'number'` rather than `!== undefined` for the same untrusted-shape reason
				// as the digest guard above: a non-numeric declared baseRev can never equal a local
				// one, so it degrades to an abstain instead of comparing junk.
				const checkable = preview.baseIndependent
					|| (typeof declared.baseRev === 'number' && preview.baseRev === declared.baseRev);
				if (!checkable) {
					continue;
				}
				if (preview.digest !== declared.digest) {
					log('cluster-member:content-digest-mismatch', {
						messageHash: record.messageHash,
						blockId,
						actionId: commit.actionId,
						rev: commit.rev,
						declaredDigest: declared.digest,
						declaredBaseRev: declared.baseRev,
						previewDigest: preview.digest,
						previewBaseRev: preview.baseRev,
						baseIndependent: preview.baseIndependent
					});
					// One vote per record: a single mismatching block rejects the whole record.
					return { valid: false, reason: CONTENT_DIGEST_MISMATCH };
				}
			}
		}

		return { valid: true };
	}

	private async handleCommitNeeded(record: ClusterRecord): Promise<ClusterRecord> {
		if (this.hasLocalCommit(record)) {
			return record;
		}
		const commitHash = await this.computeCommitHash(record);
		const sig = await this.signVote(commitHash, 'approve');
		const signature: Signature = {
			type: 'approve',
			signature: sig
		};

		return {
			...record,
			commits: {
				...record.commits,
				[this.peerId.toString()]: signature
			}
		};
	}

	/**
	 * Executes operations after consensus is reached.
	 *
	 * @warning This method executes on ALL cluster peers, not just the coordinator.
	 * Each peer independently applies the operations to its local storage.
	 *
	 * @pitfall **Check-then-act race** - The in-memory guard must be checked AND set
	 * atomically (before any `await`) to prevent duplicate execution; JavaScript's
	 * single-threaded nature makes that synchronous check-and-set atomic. The durable
	 * marker, by contrast, is persisted only *after* apply succeeds — writing it eagerly
	 * would leave a stuck marker on a caught fault or a crash mid-apply, silently dropping
	 * the transaction on this member on redelivery.
	 *
	 * @pitfall **Independent node storage** - Each node has its own storage. After consensus,
	 * each node applies operations locally. Nodes must fetch missing blocks from cluster
	 * peers via `restoreCallback` if they don't have prior revisions.
	 *
	 * @see docs/internals.md "Check-Then-Act Race in Consensus" and "Independent Node Storage" pitfalls
	 */
	private async handleConsensus(record: ClusterRecord): Promise<void> {
		// Check persistent store first for post-recovery dedup (in-memory map is cleared on restart).
		// wasTransactionExecutedAsync also checks the in-memory map as a fast path.
		if (await this.wasTransactionExecutedAsync(record.messageHash)) {
			log('cluster-member:consensus-already-executed', { messageHash: record.messageHash });
			return;
		}
		// Check-and-set ATOMICALLY to prevent race condition where multiple calls
		// pass the async check before any completes. Since JavaScript is single-threaded,
		// this synchronous check-and-set is atomic before any await.
		if (this.executedTransactions.has(record.messageHash)) {
			log('cluster-member:consensus-already-executed', { messageHash: record.messageHash });
			return;
		}
		// Set the in-memory guard IMMEDIATELY, before any async operations: its synchronous
		// check-and-set (line above's `has` + this `set`) is what prevents the concurrent
		// apply-window race where two handleConsensus calls for the same hash both pass the
		// async check. The durable marker is deliberately NOT written here — see below.
		const executedAt = Date.now();
		this.executedTransactions.set(record.messageHash, executedAt);

		try {
			for (const operation of record.message.operations) {
				await this.applyConsensusOperation(record, operation);
			}
		} catch (err) {
			// A genuinely unexpected fault (e.g. storage I/O) — roll back the in-memory
			// marker so a corrected retry can re-run, and propagate so the caller learns
			// the real cause. The durable marker was never written (it lands only after
			// apply succeeds, below), so there is nothing to roll back. Recoverable local
			// divergence is absorbed inside applyConsensusOperation and never reaches here.
			// A retained pend verdict rolls back with the marker: it belongs to an apply
			// that is now considered not-executed, and a re-run will retain a fresh one.
			this.executedTransactions.delete(record.messageHash);
			this.executedPendResults.delete(record.messageHash);
			this.executedCommitResults.delete(record.messageHash);
			throw err;
		}

		// Persist the durable marker only now that apply has actually succeeded. Writing it
		// eagerly (before the loop) would leave a stuck marker on a caught fault OR a crash
		// mid-apply, and on redelivery handleConsensus short-circuits at the async
		// wasTransactionExecuted check — silently dropping the transaction on this member
		// forever. The durable marker exists only for post-restart dedup (the in-memory map
		// is empty after restart), and the narrow window between "apply succeeded" and
		// "durable write landed" is safe to re-run on restart: re-applying an
		// already-applied consensus transaction is idempotent (the "ahead" divergence path
		// in applyConsensusOperation tolerates it as a no-op), so it converges rather than
		// dropping. Fire-and-forget: a persist failure must not fail the apply that succeeded.
		this.stateStore?.markExecuted(record.messageHash, executedAt)
			.catch(err => log('cluster-member:persist-executed-error', { messageHash: record.messageHash, error: (err as Error).message }));
	}

	/**
	 * Applies one consensus-approved operation to local storage.
	 *
	 * By the time we reach here the cluster has *already* reached consensus, so the
	 * operation is authoritative cluster-wide. A failure applying it to THIS member's
	 * local store therefore does not mean the operation is invalid — it means our
	 * local state has diverged from the agreed history:
	 *
	 *   - **ahead**: we already hold a newer revision, so a stale pend/commit is a
	 *     no-op for us (`StorageRepo.commit` returns `success:false` with `missing`);
	 *   - **behind**: we missed the prior `pend` cluster-transaction (cohort drift
	 *     between the independent pend and commit phases, or transient unreachability),
	 *     so we lack the pending action — `StorageRepo.commit` *throws* "Pending
	 *     action … not found";
	 *   - **behind (no base)**: we DID see the pend, but we never saw the revision that
	 *     created the block, so the transform has nothing to apply to —
	 *     `StorageRepo.commit` returns `success:false` with a `missing-base-revision`
	 *     reason rather than recording a revision it could not materialize.
	 *
	 * For both **behind** cases we hold no usable revision of the committed blocks, so we
	 * actively reconcile: pull the committed revision from a cohort peer that holds it
	 * (`reconcileBlock`) and restore it locally. Lazy read-repair on a later read cannot
	 * recover it on its own when cohort drift has left the block under-replicated (no
	 * reachable peer the reader sees holds the newer rev), so reconciling here is what
	 * keeps cross-cohort transactions converging. For the **ahead** case we already hold
	 * ≥ the committed rev, so we tolerate the no-op without reconciling downward.
	 *
	 * Whatever happens, we must NOT reset the stream: throwing here would reset the
	 * cluster stream the coordinator is awaiting and surface as a spurious
	 * `StreamResetError`, sinking an otherwise-successful transaction. So divergence —
	 * and any reconciliation failure — is tolerated (logged for observability). A
	 * genuinely *invalid* pend can never get this far: it is rejected during the promise
	 * phase (`validatePendOperations`, which validates pend ops only — commits carry no
	 * promise-phase validation).
	 *
	 * The propagate-vs-tolerate split keys off the failure's *nature* via `CommitResult`,
	 * not throw-vs-return: a missing pend (thrown "not found") or a stale/ahead commit
	 * (`success:false` with `missing`) is divergence and tolerated, whereas a genuine
	 * mid-commit `internalCommit` fault (`success:false` with a bare `reason`, no
	 * `missing`) is propagated so {@link handleConsensus} rolls back the executed marker
	 * and rethrows — exactly like an unexpected thrown fault.
	 */
	private async applyConsensusOperation(record: ClusterRecord, operation: RepoMessage['operations'][number]): Promise<void> {
		const messageHash = record.messageHash;
		if ('get' in operation) {
			await this.storageRepo.get(operation.get);
			return;
		}
		if ('cancel' in operation) {
			await this.storageRepo.cancel(operation.cancel.actionRef);
			return;
		}
		if ('pend' in operation) {
			const result = await this.storageRepo.pend(operation.pend);
			// Retain the verdict either way so the coordinator can hand the writer storage's real
			// answer (see getExecutedPendResult). A refusal here is NOT local divergence the way a
			// commit refusal is: pend-consensus confers no durability — a refusal carrying `pending`
			// (a rival's unresolved action holds the blocks) or `missing` (the requested revision is
			// already committed) is the optimistic-concurrency verdict, and swallowing it acknowledged
			// writes that no member stored.
			this.executedPendResults.set(messageHash, result);
			if (!result.success) {
				log('cluster-member:consensus-pend-diverged', {
					messageHash,
					actionId: operation.pend.actionId,
					reason: result.reason,
					hasMissing: !!result.missing?.length,
					hasPending: !!result.pending?.length
				});
			}
			return;
		}
		if ('commit' in operation) {
			const commit = operation.commit;
			// Capture the consensus commit cert BEFORE applying to storage: StorageRepo.commit emits the
			// CollectionChangeEvent synchronously at the end of the call below, and the reactivity bridge
			// resolves the cert from that event — so it must already be retained when commit() returns.
			//
			// The commit-vote signed preimage is computed HERE, before the synchronous capture+commit
			// sequence below: it is the exact bytes each approving signer endorsed
			// (`utf8(commitHash + ":approve")`), reproduced from this already-validated `record` (its
			// commit signatures were verified against the same `computeCommitHash`). Reactivity sets a
			// notification's `digest` from it so a subscriber's threshold-verify over `digest` succeeds.
			// The one `await` happens before `captureCommitCert` runs, so the cert is still retained
			// synchronously before `commit()` emits its change event (do not move this past the commit).
			// Gated on the sink: with no reactivity wired the preimage has no consumer, so a sink-less
			// node pays neither the extra `sha256` nor the extra microtask — the true zero-cost default.
			if (this.onCommitCertificate) {
				const commitSignedPayload = clusterVoteSigningPayload(await this.computeCommitHash(record), 'approve');
				this.captureCommitCert(record, commit.actionId, commitSignedPayload);
			}
			// Project the consensus record into a durable BlockCommitProof and hand it down the commit
			// path — StorageRepo persists it only where the local materialization matches the declared
			// digest (see persistProofIfContentMatches). A cheap projection (no hashing/signing).
			// `undefined` for a v1 / unversioned record: its hashes bind no peer set, so it is never
			// certifiable — logged so an operator can see why a cohort retains no proofs. The cast is the
			// named ICommitProofPersister contract; a plain IRepo mock ignores the extra argument.
			const proof = buildBlockCommitProof(record);
			if (proof === undefined) {
				log('cluster-member:commit-proof-skipped', {
					messageHash,
					actionId: commit.actionId,
					membershipVersion: record.membershipVersion
				});
			}
			let result: CommitResult;
			try {
				result = await (this.storageRepo as IRepo & ICommitProofPersister).commit(commit, undefined, proof);
			} catch (err) {
				// `StorageRepo.commit` throws (rather than returning success:false) when
				// the pending action is missing — the canonical "behind" signal: this
				// member reached commit-consensus without the matching pend (cohort drift).
				if (isMissingPendingActionError(err)) {
					log('cluster-member:consensus-commit-diverged', {
						messageHash,
						actionId: commit.actionId,
						divergence: 'behind',
						reason: (err as Error).message
					});
					// We hold no revision of these blocks; pull the committed revision from a
					// cohort peer so the block is no longer under-replicated. Best-effort:
					// failures are logged inside, never thrown (a throw would reset the stream).
					await this.reconcileDivergentCommit(record, commit);
					return;
				}
				throw err;
			}
			// Retain the verdict either way (see getExecutedCommitResult): a success confirms local
			// durability, and an ahead-shaped refusal is the only evidence the coordinator has that
			// the tolerance below swallowed a rival's win at the requested revision. The
			// missing-pending throw path above retains nothing — no CommitResult exists there, and
			// the coordinator's fabricated-success fallback plus cohort reconcile is the right shape
			// for a member that is genuinely behind.
			this.executedCommitResults.set(messageHash, result);
			if (!result.success) {
				// success:false is a StaleFailure. `missing` ⇒ ahead/stale divergence
				// (we already hold ≥ this rev): tolerate, do NOT reconcile downward. A
				// missing-base reason ⇒ behind divergence, reconcile (below). Any other bare
				// `reason` with no `missing` ⇒ a genuine internalCommit fault: propagate so
				// handleConsensus rolls back the executed marker and rethrows.
				//
				// NOTE: this 'ahead' tolerance is what turns a rival's commit that somehow reaches
				// consensus into a reported success no member durably stored (consensus without
				// durability — the commit-tier acknowledgement hole). It must stay: a member
				// genuinely ahead of a redelivered/lagging commit is the common, correct case. The
				// guards live UPSTREAM: `validateCommitRevisions` rejects the rival at the promise
				// round, `CoordinatorRepo.commit` returns lost races as retryable conflicts instead
				// of re-driving them, and the verdict retained just above (getExecutedCommitResult)
				// lets the coordinating node convert its OWN member's rival-confirmed refusal into a
				// conflict answer — that last guard is what closes the signed-but-not-yet-applied
				// window, where two commits for one revision both assemble consensus because signing
				// drops each member's reservation before applying advances its storage. If
				// consensus-without-durability is ever observed again, look at those guards' abstain
				// residuals (non-coordinating members' verdicts are not threaded back; capability-less
				// or history-truncated storage abstains), not at this branch.
				if (result.missing?.length) {
					log('cluster-member:consensus-commit-diverged', {
						messageHash,
						actionId: commit.actionId,
						divergence: 'ahead',
						reason: result.reason,
						hasMissing: true
					});
					return;
				}
				// This member holds no materializable base for one of the blocks, so
				// `StorageRepo.commit` REFUSED rather than record a revision it could never serve.
				// Same "behind" divergence as a missing pend — and the same cure: pull the committed
				// revision from a cohort peer. Reconciling here (after commit released its per-block
				// latches) is what makes refusing safe; fetching inside the commit path would deadlock
				// against the latch `saveReplicatedBlock` needs to persist what it fetched.
				if (isMissingBaseRevisionFailure(result)) {
					log('cluster-member:consensus-commit-diverged', {
						messageHash,
						actionId: commit.actionId,
						divergence: 'behind',
						reason: result.reason
					});
					await this.reconcileDivergentCommit(record, commit);
					return;
				}
				throw new Error(`Consensus commit for action ${commit.actionId} failed: ${result.reason ?? 'unknown reason'}`);
			}
			return;
		}
		if ('invalidate' in operation) {
			await this.applyConsensusInvalidation(record, operation.invalidate);
			return;
		}
	}

	/**
	 * Applies a consensus-ordered invalidation on this member: dedup → certificate verification →
	 * capture the invalidation's commit cert (for reactivity reuse) → delegate the compensating write +
	 * durable log append to the injected {@link InvalidationApplySink}.
	 *
	 * Like every other branch of {@link applyConsensusOperation}, a failure here is tolerated rather
	 * than thrown — a throw would reset the cluster stream. A forged/sub-threshold certificate is
	 * rejected (and never reaches the sink); a sink fault is logged and its dedup marker rolled back
	 * so a re-broadcast can retry. The durable, authoritative dedup is the invalidation log entry the
	 * sink consults; the in-memory map is only a fast path.
	 */
	private async applyConsensusInvalidation(record: ClusterRecord, request: InvalidateRequest): Promise<void> {
		const messageHash = record.messageHash;
		const dedupKey = `${request.invalidatedActionId}:${request.resolution.disputeId}`;
		if (this.appliedInvalidations.has(dedupKey)) {
			log('cluster-member:consensus-invalidate-duplicate', { messageHash, dedupKey });
			return;
		}

		// Certificate verification BEFORE apply — never trust the originator's say-so. Verify the proof
		// against THIS request's own target: the votes are bound to the transaction the dispute resolved,
		// so a genuine proof carried in a request that points at a different (innocent) action/blocks fails
		// here (the network-facing replay boundary, #2). The proof is also bound to the legitimately-selected
		// arbitrator set (#1): membership + the challenger's set signature gate it (layer 1), and when a
		// recompute capability is wired we re-derive the eligible set from our topology and reject a forged
		// one (layer 2). When we cannot reconstruct the historical topology, we accept on layer 1 and LOG
		// that the invalidation was applied without full anchoring — the documented interim posture.
		const certified = await verifyInvalidationCertificate(
			request.resolution,
			{ invalidatedActionId: request.invalidatedActionId, blockIds: request.blockIds },
			{
				recomputeArbitratorSet: this.recomputeArbitratorSet,
				onUnanchored: (info) => log('cluster-member:consensus-invalidate-unanchored', {
					messageHash,
					invalidatedActionId: request.invalidatedActionId,
					disputeId: info.disputeId,
					reason: info.reason,
					arbitratorSetSize: info.arbitratorSet.length
				})
			}
		);
		if (!certified) {
			log('cluster-member:consensus-invalidate-reject-certificate', {
				messageHash,
				invalidatedActionId: request.invalidatedActionId,
				disputeId: request.resolution.disputeId,
				outcome: request.resolution.outcome
			});
			return;
		}

		// Capture the invalidation's own commit cert — the threshold signature the cohort produced for
		// THIS consensus-ordered `invalidate` op (over `computeCommitHash(record)`), the reversal analogue
		// of the commit-cert capture in {@link applyConsensusOperation}. Reactivity reuses it bit-for-bit
		// as the invalidation notification's `sig` (never re-signed). Keyed on the deterministic
		// {@link invalidationActionId} the invalidation's change event also carries, so the bridge's
		// cert extractor resolves it. Gated on the sink — a node with no reactivity wired pays nothing.
		if (this.onCommitCertificate) {
			const invSignedPayload = clusterVoteSigningPayload(await this.computeCommitHash(record), 'approve');
			this.captureCommitCert(record, invalidationActionId(request.invalidatedActionId, request.resolution.disputeId), invSignedPayload);
		}

		if (!this.onInvalidate) {
			log('cluster-member:consensus-invalidate-no-sink', { messageHash, dedupKey });
			return;
		}

		this.appliedInvalidations.set(dedupKey, Date.now());
		try {
			await this.onInvalidate(request);
			log('cluster-member:consensus-invalidate-applied', {
				messageHash,
				invalidatedActionId: request.invalidatedActionId,
				disputeId: request.resolution.disputeId,
				blockCount: request.blockIds.length
			});
		} catch (err) {
			// Tolerate (don't reset the stream); roll back the marker so a re-broadcast retries.
			this.appliedInvalidations.delete(dedupKey);
			log('cluster-member:consensus-invalidate-sink-error', { messageHash, dedupKey, error: (err as Error).message });
		}
	}

	/**
	 * Record the consensus commit cert for `actionId` into the injected {@link CommitCertificateSink},
	 * if one is wired. The cert is built from the agreed `record.commits` (the per-member `approve`
	 * commit signatures), forwarded UNCHANGED for reactivity to reuse. `signedPayload` is the exact
	 * commit-vote preimage those signatures were produced over (`utf8(commitHash + ":approve")`),
	 * computed by the caller from the same `record` *before* the synchronous commit — reactivity sets a
	 * notification's `digest` from it so a real threshold-verify over `digest` succeeds. Stays
	 * **synchronous** (no `await` here) so the cert is retained before `StorageRepo.commit` emits its
	 * change event. No-op (zero cost) when no sink is configured; a throwing sink is isolated + logged so
	 * it can never break consensus.
	 */
	private captureCommitCert(record: ClusterRecord, actionId: ActionId, signedPayload: Uint8Array): void {
		if (!this.onCommitCertificate) {
			return;
		}
		const minSigs = Math.ceil(Object.keys(record.peers).length * this.superMajorityThreshold);
		try {
			this.onCommitCertificate(actionId, buildCommitCert(record, minSigs, signedPayload));
		} catch (err) {
			log('cluster-member:commit-cert-sink-error', { actionId, error: (err as Error).message });
		}
	}

	/**
	 * After tolerating a "behind" commit divergence, pull the committed revision of
	 * each block from a cohort peer that holds it and restore it locally. Best-effort:
	 * a missing callback, an empty cohort, or a per-block failure/timeout is logged and
	 * tolerated — never thrown, since a throw out of consensus execution resets the
	 * cluster stream.
	 */
	private async reconcileDivergentCommit(record: ClusterRecord, commit: CommitRequest): Promise<void> {
		if (!this.reconcileBlock) {
			log('cluster-member:consensus-commit-reconcile-skip', { messageHash: record.messageHash, reason: 'no-callback' });
			return;
		}
		const cohortPeerIds = Object.keys(record.peers).filter(id => id !== this.peerId.toString());
		if (cohortPeerIds.length === 0) {
			log('cluster-member:consensus-commit-reconcile-skip', { messageHash: record.messageHash, reason: 'no-cohort-peers' });
			return;
		}
		const committed: ActionRev = { actionId: commit.actionId, rev: commit.rev };
		await Promise.all(
			commit.blockIds.map(blockId => this.reconcileOneBlock(record.messageHash, blockId, committed, cohortPeerIds))
		);
	}

	/** Reconcile a single block, bounding the awaited callback and swallowing failures. */
	private async reconcileOneBlock(messageHash: string, blockId: BlockId, committed: ActionRev, cohortPeerIds: string[]): Promise<void> {
		try {
			await this.withReconcileTimeout(this.reconcileBlock!(blockId, committed, cohortPeerIds), blockId);
			// "attempted", not "reconciled": the callback returns void, and a quorum decline is a
			// normal, non-throwing outcome — so reaching here means the pass ran to completion, NOT
			// that anything was restored. `reconcile:restored` (reconcile-block.ts) is the line that
			// says the bytes actually landed; `reconcile:no-rev-quorum` / `reconcile:no-content-quorum`
			// say they did not.
			log('cluster-member:consensus-commit-reconcile-attempted', { messageHash, blockId, rev: committed.rev });
		} catch (err) {
			log('cluster-member:consensus-commit-reconcile-failed', {
				messageHash,
				blockId,
				rev: committed.rev,
				error: (err as Error).message
			});
		}
	}

	/** Bound an awaited reconcile so a slow/unreachable cohort peer can't stall consensus. */
	private withReconcileTimeout<T>(promise: Promise<T>, blockId: BlockId): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`reconcile for block ${blockId} timed out after ${ReconcileTimeoutMs}ms`)),
				ReconcileTimeoutMs
			);
			timer.unref();
		});
		return Promise.race([promise, timeout]).finally(() => {
			if (timer) clearTimeout(timer);
		});
	}

	private async handleRejection(_record: ClusterRecord): Promise<void> {
		// Clean up any resources - will be cleared by shouldPersist = false in the main flow
	}

	private setupTimeouts(record: ClusterRecord): { promiseTimeout?: NodeJS.Timeout; resolutionTimeout?: NodeJS.Timeout } {
		if (!record.message.expiration) {
			return {};
		}

		return {
			promiseTimeout: setTimeout(
				() => this.handleExpiration(record.messageHash),
				record.message.expiration - Date.now()
			).unref(),
			resolutionTimeout: setTimeout(
				() => this.resolveWithPeers(record.messageHash),
				record.message.expiration + 5000 - Date.now()
			).unref()
		};
	}

	/**
	 * Scan this member's reservation table (`activeTransactions`) for a held transaction that
	 * conflicts with `record` AND wins the deterministic race against it. Returns the winner's
	 * identity — `{ blockedBy: messageHash }` — rather than a bare boolean, because that identity is
	 * exactly what the resulting conflict vote must name (`Signature.conflictWith`); the old boolean
	 * lost it. `undefined` means no blocking conflict. Side-effectful on the way through: stale
	 * entries are swept, and a held transaction that LOSES the race to `record` is cleared.
	 */
	private findConflict(record: ClusterRecord): { blockedBy: string } | undefined {
		// Same clock as the `lastUpdate` stamp (the `shouldPersist` set and `persistParticipantState`),
		// so an injected test clock ages entries instead of putting stamp and comparison on different bases.
		const now = this.now();

		const incomingBlockIds = getAffectedBlockIds(record.message.operations);
		log('cluster-member:findConflict-check', {
			messageHash: record.messageHash,
			activeCount: this.activeTransactions.size,
			incomingBlockIds
		});

		for (const [existingHash, state] of Array.from(this.activeTransactions.entries())) {
			// Defensive only — no caller can reach it today. `getTransactionPhase` calls this scan solely
			// when `!record.promises[ourId]`, and every write into `activeTransactions` already carries our
			// vote (the `shouldPersist` set happens after the phase loop recorded it; `recoverTransactions`
			// restores what that same branch persisted; `handleExpiration` re-sets with our reject added).
			// A redelivery at a known hash is merged with the held record first (`mergeRecords`, first-seen
			// wins), so our vote is present by the time the phase is computed. Kept because the scan is on
			// the vote path, where self-blocking would be silent and permanent.
			if (existingHash === record.messageHash) {
				continue;
			}

			const existingBlockIds = getAffectedBlockIds(state.record.message.operations);
			log('cluster-member:findConflict-compare', {
				existing: existingHash,
				incoming: record.messageHash,
				existingBlockIds,
				incomingBlockIds
			});

			// Sweep abandoned reservations BEFORE the race is decided: an entry nobody is driving any
			// more must not win a contest it should not be in and block a live rival for its whole life.
			if (now - state.lastUpdate > CONFLICT_STALE_THRESHOLD_MS) {
				log('cluster-member:stale-cleanup', {
					messageHash: existingHash,
					age: now - state.lastUpdate
				});
				this.clearTransaction(existingHash);
				continue;
			}

			if (operationsConflict(state.record.message.operations, record.message.operations)) {
				// Use race resolution to determine winner
				const resolution = resolveRace(state.record, record);

				if (resolution === 'keep-existing') {
					log('cluster-member:race-keep-existing', {
						existing: existingHash,
						incoming: record.messageHash
					});
					return { blockedBy: existingHash }; // Reject incoming, naming the winner
				} else {
					// Accept incoming, abort existing
					log('cluster-member:race-accept-incoming', {
						existing: existingHash,
						incoming: record.messageHash
					});
					this.clearTransaction(existingHash);
					// `continue`, not `break`: the incoming transaction may overlap several held
					// reservations, and beating one says nothing about the rest. Stopping here would let it
					// walk past a second, still-live rival it actually loses to.
					continue;
				}
			}
		}

		return undefined; // No blocking conflicts
	}

	private async propagateIfNeeded(record: ClusterRecord): Promise<void> {
		const promises = [];
		for (const peerId of Object.keys(record.peers)) {
			if (peerId === this.peerId.toString()) continue;

			try {
				const client = ClusterClient.create(peerIdFromString(peerId), this.peerNetwork, this.protocolPrefix);
				promises.push(client.update(record));
			} catch (error) {
				log('ERROR: Failed to propagate to peer %s: %o', peerId, error);
			}
		}
		await Promise.allSettled(promises);
	}

	private async handleExpiration(messageHash: string): Promise<void> {
		const state = this.activeTransactions.get(messageHash);
		if (!state) return;

		if (!state.record.promises[this.peerId.toString()]) {
			const rejectReason = 'Transaction expired';
			const promiseHash = await this.computePromiseHash(state.record);
			const sig = await this.signVote(promiseHash, 'reject', rejectReason);
			const signature: Signature = {
				type: 'reject',
				signature: sig,
				rejectReason
			};

			const updatedRecord = {
				...state.record,
				promises: {
					...state.record.promises,
					[this.peerId.toString()]: signature
				}
			};

			this.activeTransactions.set(messageHash, {
				...state,
				record: updatedRecord
			});

			await this.propagateIfNeeded(updatedRecord);
		}
	}

	private async resolveWithPeers(messageHash: string): Promise<void> {
		// This method is disabled - the coordinator handles all retry logic
		// Keeping the skeleton in case we need peer-initiated recovery in the future
		log('cluster-member:resolve-skipped', { messageHash, reason: 'coordinator-handles-retry' });
	}

	private queueExpiredTransactions(): void {
		const now = Date.now();
		for (const [messageHash, state] of Array.from(this.activeTransactions.entries())) {
			if (state.record.message.expiration && state.record.message.expiration < now) {
				this.cleanupQueue.push(messageHash);
			}
		}
		// Also clean up old executed transaction records
		const expirationThreshold = now - ExecutedTransactionTtlMs;
		for (const [messageHash, executedAt] of Array.from(this.executedTransactions.entries())) {
			if (executedAt < expirationThreshold) {
				this.executedTransactions.delete(messageHash);
				this.executedPendResults.delete(messageHash);
				this.executedCommitResults.delete(messageHash);
			}
		}
		// Prune old applied-invalidation dedup markers on the same TTL.
		for (const [dedupKey, appliedAt] of Array.from(this.appliedInvalidations.entries())) {
			if (appliedAt < expirationThreshold) {
				this.appliedInvalidations.delete(dedupKey);
			}
		}
		this.stateStore?.pruneExecuted(expirationThreshold)
			.catch(err => log('cluster-member:prune-executed-error', { error: (err as Error).message }));
	}

	private async processCleanupQueue(): Promise<void> {
		while (this.cleanupQueue.length > 0) {
			const messageHash = this.cleanupQueue.shift();
			if (!messageHash) continue;

			const state = this.activeTransactions.get(messageHash);
			if (!state) continue;

			// NOTE: an expired entry already in a terminal phase is deliberately left alone here —
			// `processUpdate` clears those on the update that made them terminal, so reaching this point
			// in one means that update never arrived. It is not stranded: `findConflict`'s 2 s staleness
			// sweep drops it on the next conflicting arrival. But on a member that then goes idle the
			// entry lingers until traffic returns. If member memory ever shows entries outliving their
			// expiration, delete unconditionally here instead of exempting the terminal phases.
			const { phase } = await this.getTransactionPhase(state.record);
			if (phase !== TransactionPhase.Consensus && phase !== TransactionPhase.Rejected) {
				this.activeTransactions.delete(messageHash);
			}
		}
	}

	private hasLocalCommit(record: ClusterRecord): boolean {
		const ourId = this.peerId.toString();
		return Boolean(record.commits[ourId]);
	}

	private clearTransaction(messageHash: string): void {
		const state = this.activeTransactions.get(messageHash);
		if (!state) {
			log('cluster-member:clear-miss', { messageHash });
			return;
		}
		if (state.promiseTimeout) {
			clearTimeout(state.promiseTimeout);
		}
		if (state.resolutionTimeout) {
			clearTimeout(state.resolutionTimeout);
		}
		this.activeTransactions.delete(messageHash);
		this.stateStore?.deleteParticipantState(messageHash)
			.catch(err => log('cluster-member:persist-delete-error', { messageHash, error: (err as Error).message }));
		log('cluster-member:clear-done', {
			messageHash,
			remaining: Array.from(this.activeTransactions.keys())
		});
	}

	/** Fire-and-forget persist — errors are logged, never thrown. */
	private persistParticipantState(messageHash: string, record: ClusterRecord): void {
		if (!this.stateStore) return;
		this.stateStore.saveParticipantState(messageHash, {
			messageHash,
			record,
			lastUpdate: this.now()
		}).catch(err => log('cluster-member:persist-error', { messageHash, error: (err as Error).message }));
	}

	/**
	 * Recover member transactions from persistent store after a restart.
	 * Called during node startup, before accepting new requests.
	 */
	async recoverTransactions(): Promise<void> {
		if (!this.stateStore) return;
		const now = Date.now();

		// 1. Prune expired executed entries from persistent store
		await this.stateStore.pruneExecuted(now - ExecutedTransactionTtlMs);
		// Note: executed transactions are checked via wasTransactionExecutedAsync() at runtime,
		// which falls back to the persistent store when the in-memory map misses.

		// 2. Restore active participant states
		const participantStates = await this.stateStore.getAllParticipantStates();
		for (const state of participantStates) {
			const { messageHash } = state;
			// Expired — clean up
			if (state.record.message.expiration && state.record.message.expiration < now) {
				log('cluster-member:recovery-expired', { messageHash });
				await this.stateStore.deleteParticipantState(messageHash);
				continue;
			}
			// Restore into activeTransactions with fresh timeouts
			log('cluster-member:recovery-restore', { messageHash });
			const timeouts = this.setupTimeouts(state.record);
			this.activeTransactions.set(messageHash, {
				record: state.record,
				lastUpdate: state.lastUpdate,
				promiseTimeout: timeouts.promiseTimeout,
				resolutionTimeout: timeouts.resolutionTimeout
			});
		}

		log('cluster-member:recovery-complete', {
			restoredActive: this.activeTransactions.size,
			restoredExecuted: this.executedTransactions.size
		});
	}

	/**
	 * Checks if a transaction's operations were already executed during consensus.
	 * Falls back to the persistent store when the in-memory map misses.
	 */
	async wasTransactionExecutedAsync(messageHash: string): Promise<boolean> {
		if (this.executedTransactions.has(messageHash)) return true;
		if (!this.stateStore) return false;
		const persisted = await this.stateStore.wasExecuted(messageHash);
		if (persisted) {
			// Re-populate in-memory map for future synchronous checks
			this.executedTransactions.set(messageHash, Date.now());
		}
		return persisted;
	}
}

