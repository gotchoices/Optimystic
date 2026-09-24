import { peerIdFromString } from "@libp2p/peer-id";
import type { ClusterRecord, IKeyNetwork, RepoMessage, BlockId, ClusterPeers, MessageOptions, ClusterConsensusConfig, ICluster, PendResult, CommitResult, StaleFailure } from "@optimystic/db-core";
import { CURRENT_MEMBERSHIP_VERSION, computeClusterMessageHash, isConflictFailure, membershipDigest, routingKeyForBlock } from "@optimystic/db-core";
import { Pending } from "@optimystic/db-core";
import type { PeerId } from "@libp2p/interface";
import { createLogger, verbose } from '../logger.js'
import type { ClusterLogPeerOutcome } from './types.js'
import type { FretService } from "p2p-fret";
import type { IPeerReputation } from "../reputation/types.js";
import { PenaltyReason } from "../reputation/types.js";
import type { ITransactionStateStore } from "../cluster/i-transaction-state-store.js";
import { ResponsibilityRefusalError } from "./responsibility.js";

const log = createLogger('cluster')

/**
 * Pick each peer's OWN {@link ClusterRecord.applyOutcomes} entry out of the record that peer answered
 * with, and key it under the peer we actually asked.
 *
 * Taking only `response.applyOutcomes[peerId]` — rather than spreading the whole map — is what keeps
 * one member from reporting outcomes on other members' behalf: a peer that echoes back a record full
 * of entries contributes exactly one, its own. The field is unsigned advisory data (see its doc
 * comment for why that is safe), so this is a shaping rule, not a security boundary.
 *
 * Returns `undefined` when no peer reported anything, so the common case adds no empty object to the
 * record.
 */
function collectApplyOutcomes(
	responses: ReadonlyArray<{ peerId: string; response?: ClusterRecord | null }>
): ClusterRecord['applyOutcomes'] {
	let collected: NonNullable<ClusterRecord['applyOutcomes']> | undefined;
	for (const { peerId, response } of responses) {
		const own = response?.applyOutcomes?.[peerId];
		if (own === undefined) continue;
		collected ??= {};
		collected[peerId] = own;
	}
	return collected;
}

/** Fold collected outcomes into a record in place, later report winning per peer. No-op for `undefined`. */
function mergeApplyOutcomes(record: ClusterRecord, collected: ClusterRecord['applyOutcomes']): void {
	if (collected === undefined) return;
	record.applyOutcomes = { ...record.applyOutcomes, ...collected };
}

/** Fold the commit signatures of every answered response into a record in place. */
function mergeCommits(record: ClusterRecord, responses: ReadonlyArray<{ response?: ClusterRecord | null }>): void {
	for (const { response } of responses) {
		if (response) record.commits = { ...record.commits, ...response.commits };
	}
}

/** One member's answer to a delivery; `response` is absent, and `error` present, when it failed. */
interface MemberDelivery {
	peerId: string;
	success: boolean;
	response?: ClusterRecord;
	error?: string;
}

/**
 * The members of `deliveries` that still need the consensus record: one whose delivery failed, one
 * whose response does not report having run the consensus apply (`MemberApplyOutcome.executed`,
 * which a member on an older build never sets), and one that reports a refused commit —
 * sending it the record again gives a behind member another reconcile once the coordinating member
 * holds the revision (`ClusterMember.handleAlreadyExecuted`). Each member is judged by its own entry
 * in its own response, as {@link collectApplyOutcomes} takes it.
 */
function membersAwaitingConsensus(deliveries: readonly MemberDelivery[]): string[] {
	return deliveries
		.filter(({ peerId, response }) => {
			const own = response?.applyOutcomes?.[peerId];
			return own?.executed !== true || own.commit?.success === false;
		})
		.map(({ peerId }) => peerId);
}

/**
 * Consensus refused a transaction: enough members voted reject that super-majority became
 * impossible. A typed error (rather than a bare `Error`) so the repo layer above can distinguish
 * "the cluster voted this down" from transport/availability failures WITHOUT string-matching the
 * rejection reasons — those are free-form text that is part of each member's signed vote payload
 * (see cluster-repo's `computeSigningPayload`), so their wording must never become control flow.
 * `CoordinatorRepo.pend` uses this to decide whether a rejection is a retryable stale-revision
 * loss (confirmed against local storage) or a genuine validation fault.
 */
export class ValidatorRejectionError extends Error {
	constructor(
		message: string,
		/** Per-peer reject reasons, verbatim from the vote signatures (free-form, wire-visible). */
		readonly rejectReasons: Record<string, string>
	) {
		super(message);
		this.name = 'ValidatorRejectionError';
	}
}

/**
 * The transaction lost a conflict race: one or more members answered with a signed `conflict`
 * vote (they hold a rival transaction that won the deterministic race on the same blocks) and
 * approvals fell short of super-majority. Distinct from {@link ValidatorRejectionError} — nobody
 * judged this write invalid; it lost an optimistic-concurrency race and a fresh retry can win.
 * `CoordinatorRepo.pend` AND `CoordinatorRepo.commit` both convert this into a `StaleFailure` with
 * `conflict: true` so the normal retry machinery (`isConflictFailure`) absorbs it; it should escape
 * as a thrown error only from other paths. The commit conversion matters as much as the pend one:
 * at the moment this is thrown zero members approved and the members hold the winner — nothing of
 * the loser landed — yet a THROWN commit error is retried verbatim by db-core's `commitCollection`
 * (it treats throws as transport faults), and that re-driven commit races into the window after
 * members apply the winner and clear its reservation, where it can assemble a consensus no member
 * will durably store. A returned conflict is instead surfaced immediately as a stale loss, and the
 * writer re-reads and re-drives the whole pend+commit at a fresh revision. The conflicting peers
 * and the winning hashes ride as structured data (from the signed `conflictWith` fields), never
 * parsed out of prose.
 */
export class ConflictRaceLostError extends Error {
	constructor(
		message: string,
		/** peerId → messageHash of the rival transaction that member holds as the race winner. */
		readonly conflicts: Record<string, string>
	) {
		super(message);
		this.name = 'ConflictRaceLostError';
	}
}

/**
 * The transaction's pend could not proceed because one or more members answered with a signed `held`
 * vote: the requested blocks are reserved by a different unresolved action in that member's durable
 * storage. Sibling of {@link ConflictRaceLostError} and retryable for the same reason — nobody judged
 * this write invalid; it queued behind a reservation that disappears when the holder commits or
 * cancels.
 *
 * The two are separate because they name different things. A conflict vote names the winning rival's
 * `messageHash`, which the member holds whole; a held vote can only name the rival's **action id**,
 * because it fires in the window where the rival has left the member's in-memory table but not yet its
 * storage. `CoordinatorRepo.pend` converts this into a `StaleFailure` with `conflict: true` so the
 * normal retry machinery (`isConflictFailure`) absorbs it, exactly as it does a lost race.
 *
 * Only a PEND record can produce it: `held` votes come from `ClusterMember.validatePendOperations`,
 * which inspects pend operations only, so `CoordinatorRepo.commit` never meets one.
 */
export class BlocksHeldError extends Error {
	constructor(
		message: string,
		/** peerId → actionId of the unresolved action that member's storage says holds the blocks. */
		readonly heldBy: Record<string, string>
	) {
		super(message);
		this.name = 'BlocksHeldError';
	}
}

/** Cancel handle for an injected timer; cancels a not-yet-fired timer (safe no-op after fire/cancel). */
export type TimerCancel = () => void;

/**
 * Production timer binding: a one-shot `setTimeout` whose handle is **unref'd** so a pending
 * commit-retry (or the deferred transaction cleanup) never keeps an otherwise-idle process alive.
 * The returned handle clears the timeout (idempotent). Mirrors the reactivity rotation
 * re-registration scheduler's `defaultSetTimer` (see reactivity/rotation-rereg-scheduler.ts).
 */
function defaultSetTimer(fn: () => void, delayMs: number): TimerCancel {
	const handle = setTimeout(fn, delayMs);
	// An idle retry/cleanup timer must not pin a process (mirror rotation re-registration + push-state gossip).
	(handle as { unref?: () => void }).unref?.();
	return (): void => clearTimeout(handle);
}

/**
 * Optional injection seam for deterministic time. Production leaves both undefined and gets
 * `Date.now` + an unref'd `setTimeout`; tests inject a fake clock + timer queue so scheduled
 * commit-retries fire in virtual (not wall-clock) time.
 */
export interface ClusterCoordinatorClock {
	/** Clock (Unix ms). Defaults to `Date.now`. */
	now?: () => number;
	/** Schedule a one-shot timer, returning a cancel handle. Defaults to an unref'd `setTimeout`. */
	setTimer?: (fn: () => void, delayMs: number) => TimerCancel;
}

/**
 * Manages the state of cluster transactions for a specific block ID
 */
interface CommitRetryState {
	pendingPeers: Set<string>;
	attempt: number;
	intervalMs: number;
	cancel?: TimerCancel;
}

/**
 * Which terminal exit released a transaction's bookkeeping, reported as the `reason` field of
 * `cluster-tx:transaction-remove`: the commit finished with no retry pending, a live retry ran out
 * of peers to chase, or a retry gave up with peers still missing (the `cluster-tx:retry-abort` case).
 */
type ReleaseReason = 'complete' | 'retry-finished' | 'retry-abandoned';

interface ClusterTransactionState {
	messageHash: string;
	record: ClusterRecord;
	pending: Pending<ClusterRecord>;
	lastUpdate: number;
	promiseTimeout?: NodeJS.Timeout;
	resolutionTimeout?: NodeJS.Timeout;
	retry?: CommitRetryState;
}

/** Manages distributed transactions across clusters */
/**
 * What a cohort lookup established about a block's cohort. `resolved: false` covers BOTH a lookup
 * that threw and one that answered with nobody: neither names a destination for a write, and the
 * durability class both produce is the same (`unrouted`). `reason` is for logs only — never branch
 * on it.
 */
export type CohortResolution =
	| { readonly resolved: true; readonly peerIds: readonly string[] }
	| { readonly resolved: false; readonly reason: string };

export class ClusterCoordinator {
	private transactions: Map<string, ClusterTransactionState> = new Map();
	private readonly retryInitialIntervalMs: number;
	private readonly retryBackoffFactor: number;
	private readonly retryMaxIntervalMs: number;
	private readonly retryMaxAttempts: number;
	private readonly commitBroadcastImmediateRetries: number;
	private readonly promiseImmediateRetries: number;
	/** Injected clock/timer seam; production defaults to `Date.now` + unref'd `setTimeout`. */
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, delayMs: number) => TimerCancel;

	constructor(
		private readonly keyNetwork: IKeyNetwork,
		/** Factory for a per-peer cluster RPC handle; only `update` is ever called, hence `ICluster`. */
		private readonly createClusterClient: (peerId: PeerId) => ICluster,
		private readonly cfg: ClusterConsensusConfig & { clusterSize: number },
		private readonly localCluster?: {
			update: (record: ClusterRecord) => Promise<ClusterRecord>;
			peerId: PeerId;
			wasTransactionExecuted?: (messageHash: string) => boolean;
			/** Local storage's verdict for a pend applied during consensus; see ClusterMember.getExecutedPendResult. */
			getExecutedPendResult?: (messageHash: string) => PendResult | undefined;
			/** Local storage's verdict for a commit applied during consensus; see ClusterMember.getExecutedCommitResult. */
			getExecutedCommitResult?: (messageHash: string) => CommitResult | undefined;
			/** One more reconcile for a behind-refused commit, once remote members hold it; see ClusterMember.reconcileRefusedCommit. */
			reconcileRefusedCommit?: (record: ClusterRecord) => Promise<void>;
		},
		private readonly fretService?: FretService,
		private readonly reputation?: IPeerReputation,
		private readonly stateStore?: ITransactionStateStore,
		clock?: ClusterCoordinatorClock
	) {
		this.retryInitialIntervalMs = cfg.commitBroadcastRetryInitialMs ?? 250;
		this.retryBackoffFactor = cfg.commitBroadcastRetryBackoffFactor ?? 2;
		this.retryMaxIntervalMs = cfg.commitBroadcastRetryMaxIntervalMs ?? 8000;
		this.retryMaxAttempts = cfg.commitBroadcastRetryMaxAttempts ?? 5;
		this.commitBroadcastImmediateRetries = cfg.commitBroadcastImmediateRetries ?? 1;
		this.promiseImmediateRetries = cfg.promiseImmediateRetries ?? 1;
		this.now = clock?.now ?? ((): number => Date.now());
		this.setTimer = clock?.setTimer ?? defaultSetTimer;
	}

	/**
	 * Invoke one cluster member's `update`, retrying transient REMOTE failures up to
	 * `immediateRetries` times before surfacing the error. The local cluster is invoked
	 * exactly once — a local throw is a real fault (validation / merge / consensus), not a
	 * transient transport blip. A remote call rides a libp2p stream that a circuit-relay
	 * ("limited") connection can reset once a per-circuit cap or reservation lapses, which
	 * surfaces as a StreamResetError; an immediate retry on the (usually still-warm)
	 * connection recovers most of those without escalating the peer to a failure. Shared by
	 * the promise-collection, commit-collection, and commit-broadcast phases so all three
	 * react to a relayed reset the same way.
	 */
	private async updateMember(peerIdStr: string, record: ClusterRecord, immediateRetries: number, phase: string): Promise<ClusterRecord> {
		const isLocal = this.localCluster && peerIdStr === this.localCluster.peerId.toString();
		if (isLocal) {
			return await this.localCluster!.update(record);
		}
		const maxAttempts = 1 + Math.max(0, immediateRetries);
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await this.createClusterClient(peerIdFromString(peerIdStr)).update(record);
			} catch (err) {
				lastError = err;
				if (attempt < maxAttempts) {
					log('cluster-tx:member-update-retry', {
						messageHash: record.messageHash,
						peerId: peerIdStr,
						phase,
						attempt,
						error: err instanceof Error ? err.message : String(err)
					});
				}
			}
		}
		throw lastError;
	}

	/**
	 * Creates a base58btc string hash uniquely identifying a transaction. For a v2 record the caller
	 * threads in the {@link membershipDigest} of the peer set so the responsible membership is bound into
	 * the identity (two different peer sets ⇒ two different hashes). Omitting `membershipDigestValue`
	 * reproduces the legacy v1 hash byte-for-byte.
	 *
	 * NOTE: the whole `message` is hashed (canonicalJson), so a transaction's advisory aged priority —
	 * which rides inside the pend operation as `pend.validation.transaction.priority` (multi-collection) or
	 * `pend.priority` (single-collection) — is automatically covered here and by the derived
	 * promise/commit hashes. That is what makes priority integrity-protected in transit: a relaying peer
	 * cannot strip or inflate it without invalidating the message hash the members verify. No separate
	 * priority-hashing step is needed.
	 */
	private async createMessageHash(message: RepoMessage, membershipDigestValue?: string): Promise<string> {
		return computeClusterMessageHash(message, membershipDigestValue);
	}

	/**
	 * The ONE cohort lookup every accessor on this class derives from: the raw peer map when the key
	 * network answered, otherwise the reason it did not. A thrown `findCluster` is logged here and
	 * nowhere else. Callers that need the map (`executeClusterTransaction`, which builds the record's
	 * `peers`) go through {@link getClusterForBlock}; callers that need to know whether the cohort
	 * RESOLVED go through {@link resolveCohort}.
	 */
	private async lookupCluster(blockId: BlockId): Promise<{ peers: ClusterPeers } | { reason: string }> {
		try {
			const peers = await this.keyNetwork.findCluster(routingKeyForBlock(blockId));
			const peerIds = Object.keys(peers ?? {});
			log('cluster-tx:cluster-members', { blockId, peerIds });
			return { peers: peers ?? {} };
		} catch (e) {
			log('WARN findCluster failed for %s: %o', blockId, e)
			return { reason: `findCluster threw: ${(e as Error)?.message ?? String(e)}` };
		}
	}

	/**
	 * Gets all peers in the cluster for a specific block ID. Empty when the lookup failed — the
	 * consensus path treats "no cohort" and "lookup failed" alike (there is nobody to run consensus
	 * with either way); a caller that must tell them apart uses {@link resolveCohort}.
	 */
	private async getClusterForBlock(blockId: BlockId): Promise<ClusterPeers> {
		const outcome = await this.lookupCluster(blockId);
		return 'peers' in outcome ? outcome.peers : {};
	}

	/**
	 * Whether the block's cohort could be established, and who it is. The primitive behind
	 * {@link getClusterPeerIds} and {@link getClusterSize}: a lookup that threw and a lookup that named
	 * nobody used to reach every caller as the same empty list, and `CoordinatorRepo`'s solo
	 * short-circuit then acknowledged a write it had no idea where to send exactly as it acknowledged a
	 * write to a genuine cohort of one (GitHub #19). Both shapes are still `resolved: false` here —
	 * neither names a destination — but they are distinguishable from a resolved cohort, which is what
	 * the write's durability class needs (`unrouted` vs `local`).
	 */
	async resolveCohort(blockId: BlockId): Promise<CohortResolution> {
		const outcome = await this.lookupCluster(blockId);
		if ('reason' in outcome) return { resolved: false, reason: outcome.reason };
		const peerIds = Object.keys(outcome.peers);
		if (peerIds.length === 0) return { resolved: false, reason: 'findCluster named nobody' };
		return { resolved: true, peerIds };
	}

	/**
	 * A node never runs a cluster transaction for a cohort it is not in. Behind members reconcile from the
	 * coordinator's own proof-carrying copy (its member applies before the consensus broadcast, and a
	 * member that applied earlier, on receipt of the commit round, is sent the record again once it has),
	 * and a coordinator outside `record.peers` is not a reconcile target — so a cohort with no holder would stay
	 * behind and the commit durability gate would refuse, having first put this node's vote and storage
	 * where the cohort does not look. The invariant is held here, at the one place a record's `peers` is
	 * chosen, rather than left to the routing convention.
	 *
	 * Fires only on a RESOLVED cohort (at least one peer) that excludes the wired local member. An empty
	 * cohort is a failed lookup, not a cohort this node is outside of, so it is left to `executeTransaction`'s
	 * size checks; `CoordinatorRepo`'s solo short-circuit keeps unresolved and single-peer cohorts away from
	 * this method altogether in any case. After its responsibility check, what remains is a multi-member
	 * cohort that changed inside the responsibility cache's staleness window. With no local member wired the guard does not apply: that
	 * bypass exists for wiring without an identity (direct constructors, some tests), never for production.
	 */
	private assertLocalMemberInCohort(blockId: BlockId, peers: ClusterPeers): void {
		if (!this.localCluster) return;
		const peerIds = Object.keys(peers);
		const selfId = this.localCluster.peerId.toString();
		if (peerIds.length === 0 || peerIds.includes(selfId)) return;
		log('cluster-tx:not-in-cohort', { blockId, selfId, peerIds });
		throw new ResponsibilityRefusalError('not-responsible', [blockId],
			`refusing to coordinate a cluster transaction for a cohort this node is not in: ${peerIds.join(', ')}`);
	}

	private makeRecord(peers: ClusterPeers, messageHash: string, message: RepoMessage, membershipDigestValue: string): ClusterRecord {
		const peerCount = Object.keys(peers ?? {}).length;
		const record: ClusterRecord = {
			messageHash,
			peers,
			// v2: bind the responsible membership into the signed identity. messageHash was computed over
			// this same digest, so a different peer set would have produced a different messageHash.
			membershipVersion: CURRENT_MEMBERSHIP_VERSION,
			membershipDigest: membershipDigestValue,
			message,
			promises: {},
			commits: {},
			suggestedClusterSize: peerCount || undefined,
			minRequiredSize: this.cfg.allowClusterDownsize ? undefined : this.cfg.clusterSize
		};

		// Add network size hint if available
		if (this.fretService) {
			try {
				const estimate = this.fretService.getNetworkSizeEstimate();
				if (estimate.size_estimate > 0) {
					record.networkSizeHint = estimate.size_estimate;
					record.networkSizeConfidence = estimate.confidence;
				}
			} catch (err) {
				// Ignore errors getting size estimate
			}
		}

		return record;
	}

	/**
	 * Initiates a 2-phase transaction for a specific block ID.
	 * Returns the cluster record and whether the local cluster already executed the operations.
	 */
	async executeClusterTransaction(blockId: BlockId, message: RepoMessage, _options?: MessageOptions): Promise<{
		record: ClusterRecord;
		localExecuted: boolean;
		/**
		 * Local storage's verdict for a pend operation this node's own cluster member applied during
		 * consensus, when the member retained one. Meaningful only when `localExecuted` is true;
		 * absent for non-pend messages, for a member that predates the retention, or after the
		 * retention TTL. `CoordinatorRepo.pend` returns this instead of fabricating a success.
		 */
		localPendResult?: PendResult;
		/**
		 * Local storage's verdict for a commit operation this node's own cluster member applied
		 * during consensus, when the member retained one. Same availability contract as
		 * `localPendResult`. `CoordinatorRepo.commit` uses a retained refusal to detect a rival's
		 * win swallowed by the member-side ahead-divergence tolerance, instead of fabricating a
		 * success no member durably stored. Read after the consensus broadcast, so a behind member's
		 * verdict already reflects the reconcile it ran against the remote members that applied in the
		 * commit round, and any second one `broadcastMergedRecord` gave it.
		 */
		localCommitResult?: CommitResult;
		/**
		 * Conflict-shaped pend refusals reported by OTHER cohort members on their consensus responses
		 * (`ClusterRecord.applyOutcomes`), keyed by peer id. This is the arm `localPendResult` cannot
		 * cover: the refusing member is frequently not the coordinating node, and its verdict used to
		 * stay on that member while the writer was told the pend won. Unsigned advisory data — an
		 * entry means "retry", never "this write was invalid". Absent when nobody reported one.
		 *
		 * Residual: a member that reaches consensus only via the scheduled commit-retry timer applies
		 * after this method has already resolved, so its refusal arrives too late to appear here. The
		 * member-side commit-promise guard (`validateCommitAgainstRefusedPend`) is the backstop for
		 * that path.
		 */
		cohortPendRefusals?: { [peerId: string]: StaleFailure };
		/**
		 * What OTHER cohort members reported about durably holding a commit after applying it at
		 * consensus (`ClusterRecord.applyOutcomes[peer].commit`), keyed by peer id — successes AND
		 * refusals, because `CoordinatorRepo.commit`'s durability gate counts the successes against
		 * the cohort the commit ran on and acknowledges only a majority. Each member's verdict is
		 * measured after its own reconcile, so a member that pulled the revision from a cohort peer
		 * reports success. Self is excluded for the same reason as `cohortPendRefusals` (its verdict
		 * travels as `localCommitResult`). Unsigned advisory data: a false success is one holder the
		 * member's signed approve vote already admitted to the majority; a false refusal is retry
		 * pressure. Absent when nobody reported one (a pend message, or pre-upgrade members).
		 *
		 * Same residual as `cohortPendRefusals`: a member reached only by the scheduled commit-retry
		 * timer applies after this method has resolved, and its report arrives too late to count —
		 * the gate then refuses honestly and the writer re-drives.
		 */
		cohortCommitOutcomes?: { [peerId: string]: CommitResult };
	}> {
		// The coordinating block id is derived HERE, from the key this method is already handed, rather
		// than being set by each caller's message builder: a member's membership admission gate derives
		// its own cohort view from this field, and a builder that forgets it silently downgrades the gate
		// to its fallback floor on that path (which is how `commit` and `cancel` used to strand writes —
		// admitted at pend, refused at commit). Doing it at the single choke point means a future message
		// builder cannot reintroduce the gap.
		//
		// Two constraints this shape exists to satisfy:
		//  - COPY, never mutate: `CoordinatorRepo.cancel` builds ONE message and hands the same object to
		//    N concurrent calls, one per block. In-place mutation would leak one block's id into another
		//    block's transaction.
		//  - Preserve an already-present list: `pend` deliberately declares the whole consolidated batch,
		//    not just its first block, so this must not overwrite it. Tested on `length`, not on the
		//    field: an empty list carries no id for a member to derive from, so preserving one would be
		//    the same silent downgrade to the fallback floor this choke point exists to prevent.
		const coordinated: RepoMessage = message.coordinatingBlockIds?.length
			? message
			: { ...message, coordinatingBlockIds: [blockId] };

		// Get the cluster peers for this block
		const peers = await this.getClusterForBlock(blockId);
		this.assertLocalMemberInCohort(blockId, peers);

		// Bind the responsible membership into the transaction identity (v2): the digest is folded into
		// the messageHash below, so two different peer sets produce two different messageHashes rather
		// than one hash with a silent internal disagreement about who is responsible.
		const membershipDigestValue = await membershipDigest(peers);

		// Create a unique hash for this transaction (over message + membership digest). Hashing the
		// coordinating-block-bearing copy is what makes the field tamper-evident in transit — and it also
		// makes a multi-block `cancel` produce a distinct hash per block, where before two blocks with
		// identical cohorts collided on one `messageHash` in `this.transactions` / `wasTransactionExecuted`.
		const messageHash = await this.createMessageHash(coordinated, membershipDigestValue);

		// Create a cluster record for this transaction
		const record = this.makeRecord(peers, messageHash, coordinated, membershipDigestValue);
		log('cluster-tx:start', {
			messageHash,
			blockId,
			peerCount: Object.keys(peers ?? {}).length,
			allowDownsize: this.cfg.allowClusterDownsize,
			configuredSize: this.cfg.clusterSize,
			suggestedSize: record.suggestedClusterSize,
			minRequiredSize: record.minRequiredSize
		});

		// Create a new pending transaction
		const transactionPromise = this.executeTransaction(peers, record);
		const pending = new Pending(transactionPromise);

		// Store the transaction state
		const state: ClusterTransactionState = {
			messageHash,
			record,
			pending,
			lastUpdate: this.now()
		};
		this.transactions.set(messageHash, state);
		this.persistCoordinatorState(messageHash, record, 'promising');
		log('cluster-tx:transaction-store', {
			messageHash,
			transactionKeys: Array.from(this.transactions.keys())
		});

		// Wait for the transaction to complete
		try {
			const result = await pending.result();
			// Check if the local cluster already executed the operations during consensus
			const localExecuted = this.localCluster?.wasTransactionExecuted?.(messageHash) ?? false;
			const localPendResult = localExecuted ? this.localCluster?.getExecutedPendResult?.(messageHash) : undefined;
			const localCommitResult = localExecuted ? this.localCluster?.getExecutedCommitResult?.(messageHash) : undefined;
			// Self is excluded: this node's own member verdict is already carried, more directly and
			// without the wire round trip, by `localPendResult` — and leaving it in both places would
			// make the coordinator's "prefer local" rule ambiguous.
			// Re-checked here rather than trusted: members are supposed to report only conflict-shaped
			// refusals, but the field arrives off the wire, so anything else (a success, a bare-reason
			// fault, a malformed entry) is dropped instead of being handed to a caller that would read
			// it as a retryable conflict.
			const selfId = this.localCluster?.peerId.toString();
			const cohortPendRefusals: { [peerId: string]: StaleFailure } = {};
			// The commit arm is re-checked the same way, to the shape the gate reads: a plain
			// `success: true`, or an object whose `success` is `false`. Anything else off the wire is
			// dropped rather than counted as a holder.
			const cohortCommitOutcomes: { [peerId: string]: CommitResult } = {};
			for (const [peerId, outcome] of Object.entries(result.applyOutcomes ?? {})) {
				if (peerId === selfId) continue;
				const pend = outcome?.pend;
				if (pend !== undefined && !pend.success && isConflictFailure(pend)) {
					cohortPendRefusals[peerId] = pend;
				}
				const commit = outcome?.commit;
				if (commit !== null && typeof commit === 'object' && (commit.success === true || commit.success === false)) {
					cohortCommitOutcomes[peerId] = commit;
				}
			}
			return {
				record: result,
				localExecuted,
				...(localPendResult === undefined ? {} : { localPendResult }),
				...(localCommitResult === undefined ? {} : { localCommitResult }),
				...(Object.keys(cohortPendRefusals).length === 0 ? {} : { cohortPendRefusals }),
				...(Object.keys(cohortCommitOutcomes).length === 0 ? {} : { cohortCommitOutcomes })
			};
		} finally {
			const stored = this.transactions.get(messageHash);
			const retrySnapshot = stored?.retry ? {
				attempt: stored.retry.attempt,
				pending: Array.from(stored.retry.pendingPeers ?? [])
			} : undefined;
			log('cluster-tx:complete', {
				messageHash,
				finalPromises: stored ? Object.keys(stored.record.promises ?? {}) : undefined,
				finalCommits: stored ? Object.keys(stored.record.commits ?? {}) : undefined,
				retry: retrySnapshot
			});
			// A live retry still owns the release: it holds the record it is re-sending, and whichever
			// way it ends (all peers commit, or the budget runs out) releases the entry then.
			if (!stored?.retry) {
				this.releaseTransaction(messageHash, 'complete');
			}
		}
	}

	/**
	 * Executes the full transaction process
	 */
	private async executeTransaction(peers: ClusterPeers, record: ClusterRecord): Promise<ClusterRecord> {
		const peerCount = Object.keys(peers).length;

		// Validate against minimum cluster size
		if (peerCount < this.cfg.minAbsoluteClusterSize) {
			const validated = await this.validateSmallCluster(peerCount, peers);
			if (!validated) {
				log('cluster-tx:reject-too-small', {
					peerCount,
					minRequired: this.cfg.minAbsoluteClusterSize
				});
				throw new Error(`Cluster size ${peerCount} below minimum ${this.cfg.minAbsoluteClusterSize} and not validated`);
			}
			log('cluster-tx:small-cluster-validated', { peerCount });
		}

		// Check configured cluster size
		if (!this.cfg.allowClusterDownsize && peerCount < this.cfg.clusterSize) {
			log('cluster-tx:reject-downsize', { peerCount, required: this.cfg.clusterSize });
			throw new Error(`Cluster size ${peerCount} below configured minimum ${this.cfg.clusterSize}`);
		}

		// Collect promises with super-majority requirement
		const promised = await this.collectPromises(peers, record);
		const superMajority = Math.ceil(peerCount * this.cfg.superMajorityThreshold);

		// Count approvals, rejections and the two RETRYABLE refusals separately. A `conflict` vote is a
		// member saying "not now — I hold the race winner"; a `held` vote is a member saying "not now —
		// a different unresolved action holds these blocks in my storage". Neither may count toward
		// approvals OR rejections, or a transient refusal would masquerade as a validator rejection
		// (permanent) or as silence (indistinguishable from an unreachable cohort) — both wrong.
		const promises = promised.record.promises;
		const approvalCount = Object.values(promises).filter(sig => sig.type === 'approve').length;
		const rejectionCount = Object.values(promises).filter(sig => sig.type === 'reject').length;
		const conflictCount = Object.values(promises).filter(sig => sig.type === 'conflict').length;
		const heldCount = Object.values(promises).filter(sig => sig.type === 'held').length;

		// Check if rejections make super-majority impossible
		// If more than (peerCount - superMajority) nodes reject, we can never reach super-majority
		const maxAllowedRejections = peerCount - superMajority;
		// Whether the merged record itself PROVES super-majority unreachable — the same sum a member
		// re-derives as `ConflictSuperseded`/`Rejected` from the signed votes, which is what makes an
		// abandonment broadcast proof-carrying rather than an unauthenticated "forget this".
		const refusalsProveUnreachable = rejectionCount + conflictCount + heldCount > maxAllowedRejections;
		if (rejectionCount > maxAllowedRejections) {
			const rejectReasonsByPeer = Object.fromEntries(Object.entries(promises)
				.flatMap(([peerId, sig]) => sig.type === 'reject' ? [[peerId, sig.rejectReason ?? 'unknown'] as const] : []));
			const rejectReasons = Object.entries(rejectReasonsByPeer)
				.map(([peerId, reason]) => `${peerId}: ${reason}`)
				.join('; ');
			log('cluster-tx:rejected-by-validators', {
				messageHash: record.messageHash,
				peerCount,
				rejections: rejectionCount,
				maxAllowed: maxAllowedRejections,
				reasons: rejectReasons
			});
			this.updateTransactionRecord(promised.record, 'rejected-by-validators');
			// Abandoning here without telling anyone leaves every member that voted holding this
			// transaction in its own reservation table, blocking its blocks until that member's
			// staleness sweep fires — and each retry we throw back to the caller plants a fresh
			// reservation, so the block never frees. The merged record carries enough signed
			// rejections to *prove* the transaction is dead, so replaying it to the cohort makes
			// every member recompute `Rejected` and clear immediately. Proof-carrying, so a member
			// need not trust us: it verifies the signatures it is shown.
			this.broadcastAbandonment(promised.record, 'rejected-by-validators');
			throw new ValidatorRejectionError(
				`Transaction rejected by validators (${rejectionCount}/${peerCount} rejected): ${rejectReasons}`,
				rejectReasonsByPeer);
		}

		// A conflict-answered shortfall is a LOST RACE, not a validator verdict and not silence.
		// Checked after the rejection threshold (a genuine validator rejection still wins) and
		// before the generic shortfall (which must stay reserved for the genuinely-silent cohort).
		if (conflictCount > 0 && approvalCount < superMajority) {
			const conflicts = Object.fromEntries(Object.entries(promises)
				.flatMap(([peerId, sig]) => sig.type === 'conflict' ? [[peerId, sig.conflictWith] as const] : []));
			log('cluster-tx:conflict-race-lost', {
				messageHash: record.messageHash,
				peerCount,
				approvals: approvalCount,
				rejections: rejectionCount,
				conflicts,
				superMajority
			});
			this.updateTransactionRecord(promised.record, 'conflict-race-lost');
			// Broadcast only when the merged record itself PROVES the transaction can no longer reach
			// super-majority (members re-derive ConflictSuperseded/Rejected from the signed votes and
			// clear their reservations immediately). Below that bar the record proves nothing and a
			// broadcast would be the unauthenticated "forget this" the shortfall NOTE below refuses.
			if (refusalsProveUnreachable) {
				this.broadcastAbandonment(promised.record, 'conflict-race-lost');
			}
			throw new ConflictRaceLostError(
				`Conflict race lost: ${conflictCount}/${peerCount} member(s) hold a conflicting winner (${approvalCount}/${superMajority} approvals)`,
				conflicts);
		}

		// A `held`-answered shortfall is the OTHER retryable refusal: the pend queued behind a rival's
		// unresolved reservation. Checked after the conflict branch so a lost race still wins when both
		// answer — a conflict vote names the winning transaction's messageHash, which is strictly more
		// actionable than an action id — and, like it, before the generic shortfall, which must stay
		// reserved for the genuinely-silent cohort.
		if (heldCount > 0 && approvalCount < superMajority) {
			const heldBy = Object.fromEntries(Object.entries(promises)
				.flatMap(([peerId, sig]) => sig.type === 'held' ? [[peerId, sig.heldBy] as const] : []));
			log('cluster-tx:pend-blocks-held', {
				messageHash: record.messageHash,
				peerCount,
				approvals: approvalCount,
				rejections: rejectionCount,
				heldBy,
				superMajority
			});
			this.updateTransactionRecord(promised.record, 'pend-blocks-held');
			if (refusalsProveUnreachable) {
				this.broadcastAbandonment(promised.record, 'pend-blocks-held');
			}
			throw new BlocksHeldError(
				`Pend blocks held: ${heldCount}/${peerCount} member(s) hold an unresolved rival action (${approvalCount}/${superMajority} approvals)`,
				heldBy);
		}

		if (peerCount > 1 && approvalCount < superMajority) {
			log('cluster-tx:supermajority-failed', {
				messageHash: record.messageHash,
				peerCount,
				approvals: approvalCount,
				rejections: rejectionCount,
				superMajority,
				threshold: this.cfg.superMajorityThreshold
			});
			this.updateTransactionRecord(promised.record, 'supermajority-failed');
			// NOTE: deliberately NOT broadcast, unlike the rejected-by-validators branch above. With
			// conflict-answered shortfalls peeled off above, we get here only because peers did not
			// answer at all, so the record carries no signed evidence that the transaction is dead — a
			// broadcast would be an unauthenticated "forget this" that any caller could use to clear a
			// live transaction out of a member's reservation table. Members that DID vote are freed by
			// their own staleness sweep instead.
			// NOTE: the message below is load-bearing wire text — the consuming repo
			// (sereus cadre-core control-write-retry) matches it verbatim to retry a genuinely-silent
			// cohort. Keep it byte-identical, and never fold `conflict` or `held` votes into its
			// rejection count.
			throw new Error(`Failed to get super-majority: ${approvalCount}/${peerCount} approvals (needed ${superMajority}, ${rejectionCount} rejections)`);
		}

		// Mark as disputed when minority rejections exist but super-majority approves
		if (rejectionCount > 0 && approvalCount >= superMajority) {
			const rejectingPeers: string[] = [];
			const rejectReasons: { [peerId: string]: string } = {};
			for (const [peerId, sig] of Object.entries(promises)) {
				if (sig.type === 'reject') {
					rejectingPeers.push(peerId);
					rejectReasons[peerId] = sig.rejectReason ?? 'unknown';
				}
			}
			promised.record.disputed = true;
			promised.record.disputeEvidence = { rejectingPeers, rejectReasons };
			log('cluster-tx:disputed', {
				messageHash: record.messageHash,
				rejectingPeers,
				rejectReasons,
				approvalCount,
				rejectionCount,
				peerCount
			});
			// [dispute-subsystem-dormant] Evidence is computed and persisted but initiateDispute() is
			// intentionally NOT called here. Dispute origination stays dormant pending arbitrator-set
			// anchoring — without it a forged synthetic cohort passes resolution.
			// Gate: tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring
			// Wiring plan: tickets/backlog/feat-dispute-subsystem-live-activation
		}

		this.persistCoordinatorState(promised.record.messageHash, promised.record, 'committing');
		return await this.commitTransaction(promised.record);
	}

	/**
	 * The block's cohort peer ids as currently derivable. Empty when the cohort did not resolve
	 * ({@link resolveCohort}: `findCluster` threw, or named nobody), so a caller branching on
	 * `length <= 1` is also taking the degraded-routing branch. Derived from `resolveCohort` rather
	 * than re-deriving the cohort, so there is exactly one lookup rule.
	 */
	async getClusterPeerIds(blockId: BlockId): Promise<string[]> {
		const cohort = await this.resolveCohort(blockId);
		return cohort.resolved ? [...cohort.peerIds] : [];
	}

	/** {@link getClusterPeerIds}, counted. Derived from it rather than re-deriving the cohort, so the
	 *  size a caller branches on and the ids it logs can never come from two different rules. */
	async getClusterSize(blockId: BlockId): Promise<number> {
		return (await this.getClusterPeerIds(blockId)).length;
	}

	/**
	 * Validate that a small cluster size is legitimate by querying remote peers
	 * for their network size estimates. Returns true if estimates roughly agree.
	 */
	private async validateSmallCluster(localSize: number, _peers: ClusterPeers): Promise<boolean> {
		// If we have FRET and it shows confident estimate
		if (this.fretService) {
			try {
				const estimate = this.fretService.getNetworkSizeEstimate();
				if (estimate.confidence > 0.5) {
					// Check if FRET estimate roughly matches observed cluster size
					const orderOfMagnitude = Math.floor(Math.log10(estimate.size_estimate + 1));
					const localOrderOfMagnitude = Math.floor(Math.log10(localSize + 1));

					// If within same order of magnitude, accept it
					if (Math.abs(orderOfMagnitude - localOrderOfMagnitude) <= 1) {
						log('cluster-tx:small-cluster-validated-by-fret', {
							localSize,
							fretEstimate: estimate.size_estimate,
							confidence: estimate.confidence,
							sources: estimate.sources
						});
						return true;
					}
				}
			} catch (err) {
				// Ignore errors
			}
		}

		// Fallback: with no confident network-size estimate, fail CLOSED by default.
		// An undersized cluster with no way to justify its size is unsafe (a lone/
		// near-lone node could rubber-stamp its own writes), so reject unless the
		// operator has explicitly opted in via allowUnvalidatedSmallCluster (e.g.
		// single-node / local dev knowingly running below the floor).
		const admit = this.cfg.allowUnvalidatedSmallCluster ?? false;
		log('cluster-tx:small-cluster-no-confident-estimate', {
			localSize,
			reason: 'no-confident-network-size-estimate',
			admit
		});
		return admit;
	}

	/**
	 * The promise round: this node's own member votes first, in process, and the record that fans out
	 * to the remote members carries that vote ({@link prevoteLocalPromise}).
	 *
	 * The pre-vote is what makes `resolveRace` (`packages/db-p2p/src/cluster/race-resolution.ts`) the
	 * arbiter it is documented to be. Its first comparison is the count of `approve` promise votes, and
	 * a vote-less record loses that comparison to any rival a member has already voted on — including
	 * the member's own coordinator's write. So a fan-out that went out unvoted decided every first-round
	 * collision by arrival order, and the priority and message-hash tie-breaks below the count never ran.
	 * On a two-member cohort where each writer coordinates through its own node that was a guaranteed
	 * double loss: each member held its own coordinator's record and refused the other's, neither write
	 * reached the promise bar, and both writers backed off and re-drove. With both records carrying one
	 * approval the counts tie, the tie-breaks run, and every member computes the same winner
	 * (docs/correctness.md Theorem 9).
	 *
	 * Merging the member's promises here cannot invalidate a signature the way a LATE promise can on the
	 * commit round (backlog `bug-a-late-promise-invalidates-the-commit-signatures-already-collected`):
	 * a commit signature covers the promise map it was signed over, and at this point in the transaction
	 * no commit signature exists anywhere — the commit round has not run, and no member signs a commit
	 * before it sees a super-majority of approved promises. Keep that true: anything that would let a
	 * commit signature exist before the promise round completes brings that defect here.
	 */
	private async collectPromises(peers: ClusterPeers, record: ClusterRecord): Promise<{ record: ClusterRecord }> {
		const peerIds = Object.keys(peers);
		const summary: ClusterLogPeerOutcome[] = [];
		if (verbose) {
			const peerDetail = peerIds.map(id => ({
				id: id.substring(0, 12),
				addrs: peers[id]?.multiaddrs?.length ?? 0
			}));
			log('cluster-tx:promise-peers', { messageHash: record.messageHash, peers: peerDetail });
		}
		// Self votes first, and its outcome IS its outcome for the round — success or throw. The round
		// then leaves it out, so the local member is invoked exactly once in the promise phase, which is
		// the contract `cluster-coordinator-promise-retry.spec.ts` pins ("does NOT retry the LOCAL
		// cluster on a throw"): a local throw is a real fault, and re-including self on that path would
		// call it a second time.
		const selfId = this.localCluster?.peerId.toString();
		const prevote = await this.prevoteLocalPromise(record);
		if (prevote) summary.push(prevote);
		const roundPeers = prevote ? peerIds.filter(id => id !== selfId) : peerIds;
		// For each remaining peer, create a client and request a promise. A remote promise rides
		// a libp2p stream that a relayed (limited) connection can reset transiently, so
		// each remote request gets `promiseImmediateRetries` in-line re-attempts before
		// it counts as a failure — without this a single relayed reset drops the peer and
		// sinks super-majority (the commit broadcast already has the same guard).
		// Every peer here is remote: `record.peers` is the map `peerIds` was taken from, so the only
		// local member this round could have held is the one the pre-vote above just removed.
		const promiseRequests = roundPeers.map(peerIdStr => {
			log('cluster-tx:promise-request', { messageHash: record.messageHash, peerId: peerIdStr, isLocal: false });
			return new Pending(this.updateMember(peerIdStr, record, this.promiseImmediateRetries, 'promise'));
		});

		// Wait for all promises to complete
		const results = await Promise.all(promiseRequests.map((p, idx) => p.result().then(res => {
			const peerIdStr = roundPeers[idx]!;
			log('cluster-tx:promise-response', {
				messageHash: record.messageHash,
				peerId: peerIdStr,
				success: true,
				returnedPromises: Object.keys(res.promises ?? {}),
				returnedCommits: Object.keys(res.commits ?? {})
			});
			summary.push({ peerId: peerIdStr, success: true });
			return res;
		}).catch(err => {
			const peerIdStr = roundPeers[idx]!;
			log('cluster-tx:promise-response', { messageHash: record.messageHash, peerId: peerIdStr, success: false, error: err });
			summary.push({ peerId: peerIdStr, success: false, error: err instanceof Error ? err.message : String(err) });
			this.reputation?.reportPeer(peerIdStr, PenaltyReason.ConsensusTimeout, `promise:${record.messageHash}`);
			return null;
		})));
		const successes = summary.filter(entry => entry.success).map(entry => entry.peerId);
		const failures = summary.filter(entry => !entry.success);
		log('cluster-tx:promise-summary', {
			messageHash: record.messageHash,
			successes,
			failures
		});

		log('cluster-tx:promise-merge-begin', {
			messageHash: record.messageHash,
			initialPromises: Object.keys(record.promises ?? {}),
			transactionsKeys: Array.from(this.transactions.keys()),
			hasTransaction: this.transactions.has(record.messageHash)
		});

		// Merge all promises into the record
		for (const result of results.filter(Boolean) as ClusterRecord[]) {
			log('cluster-tx:promise-merge-input', {
				messageHash: record.messageHash,
				resultFrom: Object.keys(result.promises ?? {}),
				recordBefore: Object.keys(record.promises ?? {})
			});
			const resultPromises = Object.keys(result.promises ?? {});
			log('cluster-tx:promise-merge-result', {
				messageHash: record.messageHash,
				peerPromises: resultPromises
			});
			if (typeof record.suggestedClusterSize === 'number' && typeof result.suggestedClusterSize === 'number') {
				const expected = result.suggestedClusterSize;
				const actual = Object.keys(peers).length;
				const maxDiff = Math.ceil(Math.max(1, expected * this.cfg.clusterSizeTolerance));
				if (Math.abs(actual - expected) > maxDiff) {
					log('cluster-tx:size-variance', { expected, actual, tolerance: this.cfg.clusterSizeTolerance });
				}
			}
			record.promises = { ...record.promises, ...result.promises };
			log('cluster-tx:promise-merge-after', {
				messageHash: record.messageHash,
				mergedPromises: Object.keys(record.promises ?? {})
			});
		}
		log('cluster-tx:promise-merge', {
			messageHash: record.messageHash,
			mergedPromises: Object.keys(record.promises ?? {})
		});
		log('cluster-tx:promise-merge-end', {
			messageHash: record.messageHash,
			finalPromises: Object.keys(record.promises ?? {}),
			transactionsEntry: this.transactions.get(record.messageHash)
		});
		this.updateTransactionRecord(record, 'after-promises');
		return { record };
	}

	/**
	 * Have this node's own member cast its promise vote on `record`, in process, before the record
	 * fans out, and merge its vote into `record`. The promise-round twin of {@link presignLocalCommit},
	 * and the reason {@link collectPromises} runs it is in that method's own comment.
	 *
	 * Returns the member's outcome for the round's summary — which is where the caller's per-peer
	 * logging and reputation accounting read it — on BOTH paths, so the round leaves self out whether
	 * the member voted or threw. That is the difference from {@link presignLocalCommit}, which returns
	 * `false` on a throw and lets the round include self: the commit round has the consensus broadcast
	 * and the commit-retry timer behind it, while the promise phase's contract is that the local member
	 * is invoked exactly ONCE — a local throw is a real fault (validation / merge / consensus), not
	 * transport churn worth a second call. `undefined` means there is no local member in this cohort
	 * (some test wiring), and the round then runs over every peer unchanged.
	 *
	 * Only `promises` is merged, not `commits` — which is exactly what the round itself merges from
	 * every other member's answer, so the pre-vote is not a second rule. A commit signature normally
	 * cannot exist yet: a member signs one only on a super-majority of approved promises, and one vote
	 * is that only in a cohort of one, which `CoordinatorRepo`'s solo path keeps away from this class.
	 * Were one to arrive anyway — a cohort that shrank between `resolveCohort` and
	 * {@link getClusterForBlock}, admitted by `allowUnvalidatedSmallCluster` — the member reaches
	 * consensus and applies during the pre-vote, and the commit signature dropped here is simply
	 * re-collected by {@link presignLocalCommit} on the next round, as it was when self voted inside
	 * the round.
	 */
	private async prevoteLocalPromise(record: ClusterRecord): Promise<ClusterLogPeerOutcome | undefined> {
		const selfId = this.localCluster?.peerId.toString();
		if (selfId === undefined || !(selfId in record.peers)) {
			return undefined;
		}
		log('cluster-tx:promise-request', { messageHash: record.messageHash, peerId: selfId, isLocal: true, prevote: true });
		try {
			// A copy, so the member cannot mutate the record the fan-out is about to send.
			const response = await this.localCluster!.update({ ...record });
			record.promises = { ...record.promises, ...response.promises };
			log('cluster-tx:promise-response', {
				messageHash: record.messageHash,
				peerId: selfId,
				success: true,
				prevote: true,
				returnedPromises: Object.keys(response.promises ?? {}),
				returnedCommits: Object.keys(response.commits ?? {})
			});
			return { peerId: selfId, success: true };
		} catch (err) {
			log('cluster-tx:promise-response', { messageHash: record.messageHash, peerId: selfId, success: false, prevote: true, error: err });
			this.reputation?.reportPeer(selfId, PenaltyReason.ConsensusTimeout, `promise:${record.messageHash}`);
			return { peerId: selfId, success: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	/**
	 * The commit round, then the consensus delivery. Runs once the promise round reached super-majority.
	 *
	 * **This node's own member votes to commit first, in process, and its signature rides on the commit
	 * round** ({@link presignLocalCommit}). A remote member receiving that record adds its own commit,
	 * and in a cohort of two (2 of 2) or three (2 of 3) that is already the strict majority its phase
	 * loop needs for consensus, so it applies in the same delivery and answers with its apply report
	 * stamped on. What a member accepts does not change: it reaches consensus only on commit signatures
	 * it verified, and it signed its own commit only after seeing a super-majority of approved promises.
	 * It is the same kind of record the consensus broadcast carries, arriving one round earlier. In a
	 * cohort of four or more the coordinator's commit plus one member's is short of a majority, so
	 * nobody applies on receipt and the broadcast below works as it always did.
	 *
	 * Once the merged commits reach the majority, {@link broadcastMergedRecord} delivers the record to
	 * this node's member and then only to the remote members still needing it
	 * ({@link membersAwaitingConsensus}). With every remote member healthy in a small cohort that list is
	 * empty, so a consensus operation costs each remote member two calls (promise, commit) instead of
	 * three. When the pre-sign is unavailable the round runs as it did before — every member in
	 * parallel, this node's included — and the broadcast then reaches every member.
	 */
	private async commitTransaction(record: ClusterRecord): Promise<ClusterRecord> {
		const selfId = this.localCluster?.peerId.toString();
		const presigned = await this.presignLocalCommit(record);
		const roundPeers = Object.keys(record.peers).filter(id => !presigned || id !== selfId);
		const deliveries = await this.collectCommits(record, roundPeers);
		// A member can reach consensus during THIS round (see above), so its apply report arrives on
		// these responses. The broadcast's copy wins on overlap, being the later of the two.
		mergeApplyOutcomes(record, collectApplyOutcomes(deliveries));
		mergeCommits(record, deliveries);
		log('cluster-tx:commit-merge', {
			messageHash: record.messageHash,
			presigned,
			mergedCommits: Object.keys(record.commits)
		});
		this.updateTransactionRecord(record, 'after-commit');

		if (!this.hasCommitMajority(record)) {
			this.scheduleOrClearRetry(record, deliveries.filter(d => !d.success).map(d => d.peerId));
			return record;
		}
		log('cluster-tx:commit-majority-reached', {
			messageHash: record.messageHash,
			commitCount: Object.keys(record.commits).length,
			peerCount: Object.keys(record.peers).length,
			threshold: this.cfg.simpleMajorityThreshold
		});
		// This node's member is not in the list: the broadcast decides its delivery itself.
		const awaiting = membersAwaitingConsensus(deliveries.filter(d => d.peerId !== selfId));
		const { failures, applyOutcomes } = await this.broadcastMergedRecord(record, awaiting);
		mergeApplyOutcomes(record, applyOutcomes);
		// The scheduled retry works from the stored copy, and reads its apply outcomes to decide on the
		// coordinating member's second reconcile, so it needs the broadcast's too.
		this.updateTransactionRecord(record, 'after-broadcast');
		this.scheduleOrClearRetry(record, failures);
		return record;
	}

	/**
	 * Have this node's own member vote to commit on the promise-complete record, in process, before the
	 * commit round goes out, and merge its signature into `record`. True when the member answered: the
	 * round then leaves it out, and the consensus broadcast delivers it the merged record (should it
	 * have answered without a commit — its phase was not `OurCommitNeeded` — it is no worse off than
	 * in the round, where it would have answered the same). False when there is no local member in the
	 * cohort (some test wiring) or the member threw (an expired message, or `validateRecord` refused):
	 * the round then runs with it included, as it always did.
	 *
	 * The member cannot reach consensus here: the record carries no commit yet, and its own is a
	 * majority only in a cohort of one, which `CoordinatorRepo`'s solo path keeps away from this class.
	 * Were one to arrive anyway, the member would apply here and the broadcast would skip it as
	 * already executed.
	 */
	private async presignLocalCommit(record: ClusterRecord): Promise<boolean> {
		const selfId = this.localCluster?.peerId.toString();
		if (selfId === undefined || !(selfId in record.peers)) {
			return false;
		}
		try {
			const response = await this.localCluster!.update({ ...record });
			// Its promise too, not only its commit. A member whose promise round delivery failed (possible
			// only in a cohort of four or more, where super-majority can be reached without it) adds its
			// promise here and signs its commit over a commit hash covering it; a round that carried the
			// commit without the promise would fail every remote member's signature check.
			record.promises = { ...record.promises, ...response.promises };
			mergeCommits(record, [{ response }]);
			log('cluster-tx:commit-presign', { messageHash: record.messageHash, signed: response.commits[selfId] !== undefined });
			return true;
		} catch (err) {
			log('cluster-tx:commit-presign-error', {
				messageHash: record.messageHash,
				error: err instanceof Error ? err.message : String(err)
			});
			return false;
		}
	}

	/**
	 * Send `record` to each of `peerIds` in parallel for its commit vote. No per-peer immediate retry:
	 * a failure here is recovered by the consensus broadcast's in-line retry and the scheduled
	 * commit-retry timer. (The promise round has no such backstop, which is why `collectPromises` gets
	 * the immediate retry instead.)
	 */
	private async collectCommits(record: ClusterRecord, peerIds: readonly string[]): Promise<MemberDelivery[]> {
		if (verbose) {
			const peerDetail = peerIds.map(id => ({
				id: id.substring(0, 12),
				addrs: record.peers[id]?.multiaddrs?.length ?? 0
			}));
			log('cluster-tx:commit-peers', { messageHash: record.messageHash, peers: peerDetail });
		}
		// A snapshot: the members answer from the record as sent, and `record` is merged into only after
		// every answer is in.
		const payload: ClusterRecord = { ...record };
		const selfId = this.localCluster?.peerId.toString();
		const deliveries = await Promise.all(peerIds.map(peerId => {
			log('cluster-tx:commit-request', { messageHash: record.messageHash, peerId, isLocal: peerId === selfId });
			return this.deliver(payload, peerId, 0, 'commit');
		}));
		for (const { peerId, success } of deliveries) {
			if (!success) this.reputation?.reportPeer(peerId, PenaltyReason.ConsensusTimeout, `commit:${record.messageHash}`);
		}
		log('cluster-tx:commit-summary', {
			messageHash: record.messageHash,
			successes: deliveries.filter(d => d.success).map(d => d.peerId),
			failures: deliveries.filter(d => !d.success).map(({ peerId, error }) => ({ peerId, error }))
		});
		return deliveries;
	}

	/** Whether `record`'s commit signatures reach the simple majority (>50%) that proves the commit. */
	private hasCommitMajority(record: ClusterRecord): boolean {
		const peerCount = Object.keys(record.peers).length;
		return Object.keys(record.commits).length >= Math.floor(peerCount * this.cfg.simpleMajorityThreshold) + 1;
	}

	/** Schedule a commit retry for `missingPeers`, or clear any pending one when nobody is missing. */
	private scheduleOrClearRetry(record: ClusterRecord, missingPeers: string[]): void {
		if (missingPeers.length > 0) {
			this.scheduleCommitRetry(record.messageHash, record, missingPeers);
		} else {
			this.clearRetry(record.messageHash);
		}
	}

	/**
	 * One {@link updateMember} call whose failure is logged and returned rather than thrown, so a
	 * parallel round can read every member's answer.
	 */
	private async deliver(record: ClusterRecord, peerId: string, immediateRetries: number, phase: string): Promise<MemberDelivery> {
		try {
			return { peerId, success: true, response: await this.updateMember(peerId, record, immediateRetries, phase) };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			log('cluster-tx:member-delivery-error', { messageHash: record.messageHash, peerId, phase, error });
			return { peerId, success: false, error };
		}
	}

	/**
	 * Deliver the consensus record — carrying a majority of commit signatures — to the members that
	 * still have to apply it: this node's own member first, awaited, unless it already applied
	 * ({@link deliverToLocalMember}); then `remoteTargets` in parallel. Each remote delivery gets
	 * `commitBroadcastImmediateRetries` in-line re-attempts before it counts as failed: the connection
	 * the commit round used is usually still warm, so an immediate retry recovers most transient stream
	 * errors without falling back to the scheduled retry timer. This node's member is invoked exactly
	 * once — a local failure is a real fault, not a transient one.
	 *
	 * **Delivery order is load-bearing: this node's own member first, then the remote members.** A
	 * member that is behind (it never saw the pend, or holds no base for the block) reconciles the
	 * committed revision from `record.peers` during its apply. Once the coordinating member has applied
	 * it holds the revision, and its copy carries the cohort's commit proof (`buildBlockCommitProof`),
	 * which `createReconcileBlock` accepts from a single holder, so a whole cohort of behind members can
	 * heal from it. This is also why `remoteTargets` includes members that have ALREADY applied but
	 * report a refused commit: in a cohort of three or fewer a remote member applies on receipt of the
	 * commit round ({@link commitTransaction}), before this node's member, so a behind one reconciled
	 * while nobody held the revision. Sending it the record again now gives it another reconcile
	 * (`ClusterMember.handleAlreadyExecuted`), and its answer carries the refreshed verdict. A
	 * coordinator outside `record.peers` is not a reconcile target and gains nothing from this order;
	 * the durability gate in `CoordinatorRepo.commit` is what makes that shape refuse rather than
	 * acknowledge.
	 *
	 * The mirror case — the coordinating member is ITSELF behind — mostly heals on its own: in a small
	 * cohort a remote member applied during the commit round, so this node's member finds a holder on
	 * its first reconcile. Where no remote member has applied yet (a cohort of four or more, where
	 * nobody applies on receipt), that first reconcile runs before anyone holds the revision and
	 * retains a refusal. So once a remote member reports holding the revision, this node's member gets
	 * one more reconcile (`reconcileRefusedCommit`). The member skips it unless its retained refusal has
	 * the behind shape, so only a behind coordinator pays the extra fetch. It finishes before this
	 * method returns, so `executeClusterTransaction` reads the refreshed verdict.
	 */
	private async broadcastMergedRecord(record: ClusterRecord, remoteTargets: readonly string[]): Promise<{ failures: string[]; applyOutcomes?: ClusterRecord['applyOutcomes'] }> {
		const local = await this.deliverToLocalMember(record);
		const remote = await Promise.all(remoteTargets.map(peerId =>
			this.deliver(record, peerId, this.commitBroadcastImmediateRetries, 'commit-broadcast')));
		const deliveries = local === undefined ? remote : [local, ...remote];
		// This delivery is where most members apply the operations, so their responses carry the only
		// report the coordinator ever gets of what each member's OWN storage said. Collecting it here is
		// what lets a pend refused by a non-coordinating member reach the writer as a conflict instead of
		// the fabricated success that used to fork the block.
		//
		// Each peer's entry is taken from that peer's OWN response and re-keyed under the peer we asked,
		// so a member cannot report an outcome on another member's behalf by echoing a record full of
		// entries. Unsigned and advisory either way — see ClusterRecord.applyOutcomes.
		const applyOutcomes = collectApplyOutcomes(deliveries);
		// NOTE: after a healing second reconcile, `applyOutcomes[selfId].commit` still carries the
		// pre-reconcile refusal. Nothing reads the self entry today (the gate reads
		// `localCommitResult`); if anything starts to, re-stamp it from `getExecutedCommitResult` here.
		// NOTE: in a 3+ cohort this also runs when the remote holders already form a majority without
		// this member — one extra fetch that heals its copy; gate on the remote count if it ever shows up.
		if (this.localMemberHasApplied(record, local) && this.remoteMemberHolds(record, applyOutcomes)) {
			await this.reconcileLocalMemberAgain(record);
		}
		return {
			failures: deliveries.filter(d => !d.success).map(d => d.peerId),
			...(applyOutcomes === undefined ? {} : { applyOutcomes })
		};
	}

	/**
	 * Deliver `record` to this node's own member, awaited. `undefined` — nothing sent — when there is
	 * no local member in the cohort, or it has already applied the record.
	 */
	private async deliverToLocalMember(record: ClusterRecord): Promise<MemberDelivery | undefined> {
		const selfId = this.localCluster?.peerId.toString();
		if (selfId === undefined || !(selfId in record.peers) || this.localCluster!.wasTransactionExecuted?.(record.messageHash) === true) {
			return undefined;
		}
		return await this.deliver(record, selfId, 0, 'commit-broadcast');
	}

	/** This node's member is in the cohort and has applied the record: just now (`local`), or before. */
	private localMemberHasApplied(record: ClusterRecord, local: MemberDelivery | undefined): boolean {
		const selfId = this.localCluster?.peerId.toString();
		return selfId !== undefined && selfId in record.peers && (local?.success ?? true);
	}

	/** Whether any remote member reports holding the commit, on this delivery or an earlier one. */
	private remoteMemberHolds(record: ClusterRecord, latest: ClusterRecord['applyOutcomes']): boolean {
		const selfId = this.localCluster?.peerId.toString();
		const outcomes = { ...record.applyOutcomes, ...latest };
		return Object.keys(record.peers).some(id => id !== selfId && outcomes[id]?.commit?.success === true);
	}

	/**
	 * Give this node's own member its second reconcile (see {@link broadcastMergedRecord}). The
	 * member contract is never to throw; the catch keeps a broken seam from failing a transaction
	 * the remote members already applied.
	 */
	private async reconcileLocalMemberAgain(record: ClusterRecord): Promise<void> {
		try {
			await this.localCluster?.reconcileRefusedCommit?.(record);
		} catch (err) {
			log('cluster-tx:local-reconcile-again-error', {
				messageHash: record.messageHash,
				error: err instanceof Error ? err.message : String(err)
			});
		}
	}

	/**
	 * Fire-and-forget replay of an abandoned transaction's record to every peer in its cohort.
	 *
	 * Called only where the record itself proves the transaction is dead (enough signed rejections that
	 * super-majority is unreachable). Each member re-derives `TransactionPhase.Rejected` from the votes
	 * it verifies and drops the entry from its own reservation table, freeing the blocks immediately
	 * instead of after its 2 s staleness window. No new message type and no wire-format change — this is
	 * the same `update()` every other phase uses.
	 *
	 * Never awaited into the caller's throw and never rethrows: an abandonment must not turn into a
	 * *different* failure, and the staleness sweep remains the backstop if delivery fails.
	 */
	private broadcastAbandonment(record: ClusterRecord, reason: string): void {
		const peerIds = Object.keys(record.peers);
		log('cluster-tx:abandon-broadcast', { messageHash: record.messageHash, reason, peerIds });
		void Promise.all(peerIds.map(async peerIdStr => {
			try {
				await this.updateMember(peerIdStr, record, 0, 'abandon-broadcast');
			} catch (err) {
				log('cluster-tx:abandon-broadcast-error', {
					messageHash: record.messageHash,
					peerId: peerIdStr,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}));
	}

	private updateTransactionRecord(record: ClusterRecord, stage: string): void {
		const state = this.transactions.get(record.messageHash);
		if (!state) {
			log('cluster-tx:transaction-update-miss', { messageHash: record.messageHash, stage });
			return;
		}
		state.record = { ...record };
		state.lastUpdate = this.now();
		log('cluster-tx:transaction-update', {
			messageHash: record.messageHash,
			stage,
			promises: Object.keys(record.promises ?? {}),
			commits: Object.keys(record.commits ?? {})
		});
	}

	private scheduleCommitRetry(messageHash: string, _record: ClusterRecord, missingPeers: string[]): void {
		const state = this.transactions.get(messageHash);
		if (!state) {
			return;
		}
		const existing = state.retry;
		const nextAttempt = (existing?.attempt ?? 0) + 1;
		if (nextAttempt > this.retryMaxAttempts) {
			log('cluster-tx:retry-abort', { messageHash, missingPeers });
			this.releaseTransaction(messageHash, 'retry-abandoned');
			return;
		}
		if (missingPeers.length === 0) {
			this.clearRetry(messageHash);
			return;
		}
		const pendingPeers = new Set(missingPeers);
		const baseInterval = existing ? Math.min(existing.intervalMs * this.retryBackoffFactor, this.retryMaxIntervalMs) : this.retryInitialIntervalMs;
		existing?.cancel?.();
		const cancel = this.setTimer(() => {
			void this.retryCommits(messageHash);
		}, baseInterval);
		state.retry = {
			pendingPeers,
			attempt: nextAttempt,
			intervalMs: baseInterval,
			cancel
		};
		this.persistCoordinatorState(messageHash, state.record, 'broadcasting', {
			pendingPeers: Array.from(pendingPeers),
			attempt: nextAttempt,
			intervalMs: baseInterval
		});
		log('cluster-tx:retry-scheduled', { messageHash, attempt: nextAttempt, missingPeers, delayMs: baseInterval });
	}

	private async retryCommits(messageHash: string): Promise<void> {
		const state = this.transactions.get(messageHash);
		if (!state?.retry) {
			return;
		}
		const { pendingPeers, attempt } = state.retry;
		if (pendingPeers.size === 0) {
			this.clearRetry(messageHash);
			return;
		}
		const record = state.record;
		const selfId = this.localCluster?.peerId.toString();
		log('cluster-tx:retry-start', { messageHash, attempt, peerIds: Array.from(pendingPeers) });
		// Each pending member gets the record as it stands: it adds its commit, and applies once the
		// record then carries a majority, which in a small cohort this very delivery can complete. This
		// node's member is left to the consensus broadcast below once the record already carries a
		// majority; before that (the commit round failed on it too) it is asked for its commit like the rest.
		const payload: ClusterRecord = { ...record };
		const selfToBroadcast = this.hasCommitMajority(record);
		const deliveries = await Promise.all(Array.from(pendingPeers)
			.filter(peerId => !selfToBroadcast || peerId !== selfId)
			.map(peerId => this.deliver(payload, peerId, 0, 'commit-retry')));
		mergeCommits(record, deliveries);
		mergeApplyOutcomes(record, collectApplyOutcomes(deliveries));
		for (const { peerId, success } of deliveries) {
			if (success) pendingPeers.delete(peerId);
		}
		if (this.hasCommitMajority(record)) {
			// The retry may itself have assembled the majority (a two-member cohort whose remote member
			// missed the commit round), and then this node's member has not applied; a remote member that
			// applied on receipt before this node's member did may hold a behind refusal; and in a cohort
			// of four or more the members that answered here have not applied at all. The consensus
			// broadcast covers all three, in its usual order, and delivers this node's member unless it
			// already applied.
			const { failures, applyOutcomes } = await this.broadcastMergedRecord(record,
				membersAwaitingConsensus(deliveries.filter(d => d.success && d.peerId !== selfId)));
			mergeApplyOutcomes(record, applyOutcomes);
			if (selfId !== undefined) pendingPeers.delete(selfId);
			for (const peerId of failures) pendingPeers.add(peerId);
		}
		log('cluster-tx:retry-complete', {
			messageHash,
			attempt,
			successes: deliveries.filter(d => d.success).map(d => d.peerId),
			failures: deliveries.filter(d => !d.success).map(({ peerId, error }) => ({ peerId, error })),
			stillPending: Array.from(pendingPeers)
		});
		if (pendingPeers.size === 0) {
			log('cluster-tx:retry-finished', { messageHash });
			this.clearRetry(messageHash);
			return;
		}
		if (!this.transactions.has(messageHash)) {
			return;
		}
		this.scheduleCommitRetry(messageHash, state.record, Array.from(pendingPeers));
	}

	/**
	 * A live retry has nothing left to chase: every peer it was re-sending to has committed. The guard
	 * is what keeps the ordinary all-peers-committed path quiet — there {@link scheduleOrClearRetry}
	 * calls this with no retry ever armed, and the `finally` of {@link executeClusterTransaction}
	 * releases the entry moments later, so releasing here too would print two removal lines.
	 */
	private clearRetry(messageHash: string): void {
		const state = this.transactions.get(messageHash);
		if (!state?.retry) {
			return;
		}
		this.releaseTransaction(messageHash, 'retry-finished');
	}

	/**
	 * Release one transaction's bookkeeping — the in-memory entry, any armed retry, and the persisted
	 * coordinator state — from whichever of the three terminal exits reached it. Routing them all
	 * through here, rather than deleting ad hoc at each, is what keeps a terminal path added later
	 * from forgetting the cleanup; the abandoned-retry exit is the one that used to, leaving the whole
	 * `ClusterRecord` held for the life of the process.
	 *
	 * The deletes stay on the 100 ms deferral the completion path has always used, so any in-flight
	 * member response still finds a live entry to merge into. The deferral is armed whether or not an
	 * entry is held here: a hash already gone from memory can still have persisted state to delete,
	 * which is what the completion path did before and must keep doing.
	 */
	private releaseTransaction(messageHash: string, reason: ReleaseReason): void {
		const state = this.transactions.get(messageHash);
		if (state?.retry) {
			state.retry.cancel?.();
			state.retry = undefined;
		}
		this.setTimer(() => {
			this.transactions.delete(messageHash);
			this.deleteCoordinatorState(messageHash);
			log('cluster-tx:transaction-remove', {
				messageHash,
				reason,
				remaining: Array.from(this.transactions.keys())
			});
		}, 100);
	}

	/** Fire-and-forget persist — errors are logged, never thrown. */
	private persistCoordinatorState(
		messageHash: string,
		record: ClusterRecord,
		phase: 'promising' | 'committing' | 'broadcasting',
		retryState?: { pendingPeers: string[]; attempt: number; intervalMs: number }
	): void {
		if (!this.stateStore) return;
		this.stateStore.saveCoordinatorState(messageHash, {
			messageHash,
			record,
			lastUpdate: this.now(),
			phase,
			retryState
		}).catch(err => log('cluster-tx:persist-error', { messageHash, error: (err as Error).message }));
	}

	/** Fire-and-forget delete — errors are logged, never thrown. */
	private deleteCoordinatorState(messageHash: string): void {
		if (!this.stateStore) return;
		this.stateStore.deleteCoordinatorState(messageHash)
			.catch(err => log('cluster-tx:persist-delete-error', { messageHash, error: (err as Error).message }));
	}

	/**
	 * Recover coordinator transactions from persistent store after a restart.
	 * Called during node startup, before accepting new requests.
	 */
	async recoverTransactions(): Promise<void> {
		if (!this.stateStore) return;
		const states = await this.stateStore.getAllCoordinatorStates();
		for (const state of states) {
			const { messageHash } = state;
			// Expired — clean up
			if (state.record.message.expiration && state.record.message.expiration < this.now()) {
				log('cluster-tx:recovery-expired', { messageHash });
				await this.stateStore.deleteCoordinatorState(messageHash);
				continue;
			}
			// Broadcasting phase with retry state — resume retries
			if (state.phase === 'broadcasting' && state.retryState) {
				log('cluster-tx:recovery-resume-broadcast', { messageHash, attempt: state.retryState.attempt });
				const pending = new Pending(Promise.resolve(state.record));
				const txState: ClusterTransactionState = {
					messageHash,
					record: state.record,
					pending,
					lastUpdate: state.lastUpdate
				};
				this.transactions.set(messageHash, txState);
				// Schedule retry from where we left off
				this.scheduleCommitRetry(messageHash, state.record, state.retryState.pendingPeers);
				continue;
			}
			// Promising or committing — cannot resume (caller context is gone)
			log('cluster-tx:recovery-stale', { messageHash, phase: state.phase });
			await this.stateStore.deleteCoordinatorState(messageHash);
		}
	}
}
