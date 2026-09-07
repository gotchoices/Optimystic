import type { PendRequest, ActionBlocks, IRepo, MessageOptions, CommitResult, GetBlockResults, PendResult, StaleFailure, BlockGets, CommitRequest, RepoMessage, IKeyNetwork, ICluster, ClusterConsensusConfig, BlockId, ActionId, ActionRev, ActionContext, ClusterRecord, BlockUnavailableReason, ActionPending } from "@optimystic/db-core";
import { LruMap, blockIdsForTransforms, highestStaleAt, isConflictFailure, isOwnRevision, DEFAULT_SUPER_MAJORITY_THRESHOLD } from "@optimystic/db-core";
import { ClusterCoordinator, ConflictRaceLostError, ValidatorRejectionError } from "./cluster-coordinator.js";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { FretService } from "p2p-fret";
import { createLogger } from '../logger.js';
import type { IPeerReputation } from "../reputation/types.js";
import { PenaltyReason } from "../reputation/types.js";
import type { ITransactionStateStore } from "../cluster/i-transaction-state-store.js";
import { quorumSize, corroboratorCapacity, selectQuorumRev, certifiedEquivocation, CORROBORATION_FLOOR, type RevClaim, type QuorumRev } from "../cluster/quorum-restore.js";
import { certifyClaim, isAttributableProofFailure, proofThresholds, type ProofAnchoring } from "../cluster/certified-claims.js";
import { DEFAULT_CLUSTER_SIZE } from "../cluster/cluster-policy.js";
import { RECONCILE_TIMEOUT_MS } from "../cluster/reconcile-block.js";
import { isMissingBaseRevisionFailure, MISSING_BASE_REVISION_REASON, type ICommitProofPersister, type IRevisionActionReader } from "../storage/storage-repo.js";
import { buildBlockCommitProof, type BlockCommitProof } from "../cluster/commit-proof.js";
import type { ReconcileBlockCallback } from "../cluster/cluster-repo.js";
import type { CertifiedActionRev } from "../storage/block-archive.js";

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

/** How long one cohort peer gets to answer the latest-revision consult before it counts as silent. */
const LATEST_QUERY_TIMEOUT_MS = 1000;

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
 * What one round of polling the cohort learned about a block: the revision the OTHER
 * cohort members corroborated, and what this node itself already holds. The two are kept
 * apart on purpose — the local revision is the baseline being repaired, never evidence
 * about the cluster (see {@link CoordinatorRepo.queryClusterForLatest}) — but the caller
 * still needs it to tell whether the corroborated revision is actually an advance.
 */
interface ClusterLatestQuery {
	/** Highest `(rev, actionId)` corroborated by peers other than this node, if any. */
	corroborated?: ActionRev;
	/**
	 * This node's own latest for the block, as answered by the callback's self short-circuit.
	 * Typed as a {@link CertifiedActionRev} because that short-circuit reads the local proof too —
	 * of no use to this node (it trusts its own storage), but the type stays honest about what the
	 * value carries rather than silently erasing it.
	 */
	local?: CertifiedActionRev;
	/**
	 * Cohort peers (self excluded) that never answered the consult — the callback rejected
	 * (dial failure, protocol error) or blew the per-peer deadline. Silence, not evidence:
	 * these are never counted as claims, but while this is non-empty a caller must not treat
	 * "nothing corroborated" as an authoritative absence, because a silent peer could be the
	 * sole holder.
	 */
	silent: string[];
	/**
	 * Highest revision any cohort peer CLAIMED when no claim met the corroboration quorum
	 * (set only alongside an absent `corroborated`). The claim failed quorum, so it must
	 * never drive restoration — it exists so `get` can report content it serves below this
	 * revision as possibly behind ({@link GetBlockResult.unconfirmedAheadRev}) instead of
	 * confirmed. When a quorum DOES corroborate, higher uncorroborated claims are dropped
	 * as before: the quorum's affirmative answer outweighs a lone voter (which may simply
	 * be ahead on an in-flight commit), and stamping doubt there would mark every read that
	 * races a commit broadcast.
	 */
	uncorroboratedRev?: number;
	/**
	 * Cohort peers OTHER than this node that answered the consult at all — with a claim or with
	 * "I hold nothing". `silent` says who could not be asked; this says who could, and the two
	 * together are exactly the non-self cohort view this pass saw (`answered` ∪ `silent`, no
	 * overlap). Empty with a non-empty `silent` means this node reached NOBODY, which is a
	 * different fact from partial silence: there is no better-informed answer to be had from
	 * this node's position (see {@link AbsenceVerdict}).
	 *
	 * Was a bare count, and `answered.length` is still that number wherever only the count is
	 * wanted. The IDENTITIES are what let a claim recorded by an EARLIER pass be matched against
	 * the peers that actually made it: an answer refutes only the claim it bears on (see
	 * {@link CoordinatorRepo.recordAheadClaim}).
	 */
	answered: string[];
	/**
	 * Every claim this consult collected, whatever the quorum then did with it — the ones a
	 * corroborated selection was built from included. The caller derives a claim's CLAIMANTS
	 * from these (the peers claiming at or above the revision in doubt), which is what
	 * {@link CoordinatorRepo.recordAheadClaim} later matches against `silent` to decide whether
	 * a recorded memo may be weakened. Read-only: selection has already run and nothing
	 * downstream may re-vote off these.
	 */
	claims: readonly RevClaim[];
	/**
	 * Why this pass's corroboration decline is provably PERMANENT, when it is (see
	 * {@link DeadlockReason}). Computed fresh on EVERY declining pass — the once-per-episode
	 * suppression in {@link CoordinatorRepo.reportRepairDeadlock} applies to the LOG LINE, never to
	 * this verdict — because the caller's arming decision has to fire on every qualifying pass (the
	 * read-repair window expires and the next pass must re-arm), not only on the first. Set only
	 * alongside an absent {@link corroborated}; absent here means the decline is, or at least may
	 * be, transient — a silent peer, a plain shortfall, an agreed absence — and re-asking can learn.
	 */
	deadlock?: DeadlockReason;
	/**
	 * How the corroborated selection was supported, present exactly when {@link corroborated} is:
	 * `voters` counts the distinct corroborating supporters (the certified claimants, when the
	 * certified rule selected), and `certified` marks a selection whose corroboration is a verified
	 * cohort commit proof's signature set rather than other voters. Observability only — selection
	 * has already run and nothing downstream re-votes off this; it exists so "this node's currency
	 * rests on one peer's word" is visible in the `cluster-fetch:local-current` line without
	 * re-deriving it from the claim set.
	 */
	corroboration?: { voters: number; certified?: true };
}

/**
 * What earlier repair passes left unresolved for one block. Two independent facts share one entry
 * — and one map — on purpose: both are "what the last repair pass could not finish", both are
 * cleared by the same event (the block converging), and `CoordinatorRepo` already keeps more
 * per-block maps than anyone can hold in their head (backlog
 * `debt-freshness-state-scattered-across-coordinator-repo`).
 *
 * An entry exists exactly while at least one of the two is set; both clear together in
 * {@link CoordinatorRepo.flagUnconfirmedCurrency} once this node reaches the claimed revision.
 */
interface AheadClaimState {
	/**
	 * The cohort-claimed revision the last freshness consult could not settle — the doubt
	 * {@link CoordinatorRepo.flagUnconfirmedCurrency} stamps onto reads served below it. Absent once a
	 * consult finds nothing ahead of what this node holds.
	 */
	rev?: number;
	/**
	 * Which cohort peers reported {@link rev} when the claim was recorded — the peers whose later
	 * answer is evidence ABOUT this claim, and the only peers whose silence may keep it standing
	 * against a consult that would retire it or revise it downward. Nobody else can speak for them:
	 * a peer that never knew the claimed revision saying "I hold nothing" is not a refutation of it
	 * (see {@link CoordinatorRepo.recordAheadClaim}).
	 *
	 * One pass contributes at most a cohort's width; passes at an unchanged `rev` union rather than
	 * replace, so under churn the set is bounded by the distinct peers that ever claimed that exact
	 * revision (see the NOTE at the union). Meaningless without `rev`, and written and cleared with
	 * it — the pair is one fact. `deadlocksReported` keeps its own independent lifetime.
	 */
	claimants?: readonly string[];
	/**
	 * Which `cluster-fetch:repair-deadlock` reasons have already been said for this block (see
	 * {@link CoordinatorRepo.reportRepairDeadlock}). Neither reason is about any one revision — one is
	 * about the cohort's size, the other about how many of its peers hold the block — so both survive
	 * {@link CoordinatorRepo.recordAheadClaim} clearing `rev`: without that, a block whose cohort
	 * claims nothing *ahead* of the reader would re-announce the same permanent condition on every
	 * single pass, the noise this line exists to replace.
	 *
	 * Tracked per REASON rather than as one flag: the two diagnose different faults and send the
	 * operator to different places, so an episode that starts as `cohort-too-small` and becomes
	 * `sole-holder` (the operator added machines, which is what that reason told them to do) has to be
	 * able to say the second thing. Bounded at two entries by the reason union itself.
	 */
	deadlocksReported?: readonly DeadlockReason[];
}

/**
 * Why a corroboration decline is provably permanent — see {@link CoordinatorRepo.reportRepairDeadlock}
 * for what makes each provable and which remedy each sends the operator to.
 */
type DeadlockReason = 'cohort-too-small' | 'sole-holder';

/** The `cohort-too-small` wording: the cohort cannot field the quorum however healthy its peers are. */
function cohortTooSmallMessage(
	cohortPeers: number,
	claimants: number,
	requiredEvenIfAllAnswered: number,
	repairCorroborationClusterSize: number
): string {
	return `Block repair cannot converge for this block and the condition is PERMANENT, not transient: ` +
		`this node's cohort has ${cohortPeers} peer(s) besides itself, all of them answered ` +
		`(${claimants} hold the block), but accepting a revision would need ${requiredEvenIfAllAnswered} ` +
		`agreeing peers even if every one of those ${cohortPeers} answered and agreed. No later pass can reach ` +
		`that, however healthy every peer is, so this node's copy of the block stays as it is. Repair needs ` +
		`${CORROBORATION_FLOOR} cohort peers BESIDES the reader to answer and agree, relaxed to 1 only for a ` +
		`cohort that DECLARES it is smaller; repairCorroborationClusterSize currently resolves to ` +
		`${repairCorroborationClusterSize}. Two things produce this, and this node cannot tell them ` +
		`apart: (1) the deployment really does run this few machines — set clusterPolicy.assumedClusterSize ` +
		`to the number you actually run (it does not lower clusterSize / the replication factor), or set an ` +
		`honest clusterSize, and run at least ${CORROBORATION_FLOOR + 2} machines for any tolerance of one ` +
		`unreachable peer; or (2) this node's view of the cohort has shrunk below the real deployment — a ` +
		`partition or a routing problem, which configuration will not fix. Check the peer count above ` +
		`against the machines you run before changing anything.`;
}

/**
 * The `sole-holder` wording: the cohort is big enough, but only one of its peers holds the block.
 *
 * Every claim here is scoped to THIS NODE'S COHORT PEERS, which is the whole of what the pass
 * observed. It deliberately does not say "only one machine in the deployment holds this block": this
 * node's own copy is excluded from the claim set (it cannot corroborate the revision it is trying to
 * repair), so a reader that holds the block itself would make that reading false — and a scary
 * all-caps line an operator can disprove by looking at their own disks is worth less than no line.
 * For the same reason the remedy is "another COHORT PEER holding it" rather than "a second copy":
 * with the reader holding one, a second copy already exists and is still not enough.
 */
function soleHolderMessage(cohortPeers: number): string {
	return `Block repair cannot converge for this block and the condition is PERMANENT, not transient: ` +
		`ONLY ONE COHORT PEER HOLDS THIS BLOCK. Of this node's ${cohortPeers} cohort peers, 1 reports holding ` +
		`it and the other ${cohortPeers - 1} answered that they hold NOTHING — an answer, not silence, so this ` +
		`is the whole picture and not a slow pass. Repair adopts a revision only when ${CORROBORATION_FLOOR} ` +
		`peers BESIDES this node agree on it, and a lone holder cannot second itself, so every later pass ` +
		`declines identically. This node's own copy, if it has one, is the copy being repaired and does not ` +
		`count toward that number. MORE MACHINES DO NOT FIX THIS, and neither does any cluster-size setting — ` +
		`what is missing is ANOTHER COHORT PEER HOLDING THE BLOCK. The usual cause is data written while the ` +
		`deployment (or this block's cohort) was smaller: a block that had one holder then still has one holder ` +
		`now, because the two paths that would replicate it — read-repair and reconcile — both decline on this ` +
		`same rule. Committing any new revision of the block writes it to the current cohort and clears this. ` +
		`(A lone holder whose answer carries a valid cohort commit proof for its revision IS adopted without a ` +
		`second voter — reaching this message means the one holder attached no such proof, or one that did not ` +
		`verify.)`;
}

/**
 * What one block's pending-conflict refusals have added up to, for ONE unchanged set of holders.
 *
 * A block is reserved by an unresolved pending action for the span between that action's pend and
 * its commit or cancel, and while the reservation stands every OTHER writer's pend for the block is
 * refused. That is the healthy optimistic-concurrency loss. The unhealthy case has the identical
 * per-refusal shape and differs only in repetition: the same holder refusing DISTINCT later actions
 * without end, because the holder is never going to commit or cancel (see
 * {@link CoordinatorRepo.noteStuckReservation}).
 *
 * Counted per (block, holders) rather than per block: a holder that changes is the healthy cycle —
 * the previous reservation resolved and another writer took the block — so a new holder starts a new
 * count and gets its own chance to speak.
 */
interface StuckReservationWatch {
	/** The rival action ids the refusals in this episode named, sorted so the comparison is stable. */
	holders: readonly ActionId[];
	/**
	 * Distinct action ids these holders have refused. Distinct ACTIONS, not refusals: one writer
	 * retrying is one writer, because a sync reuses a single action id across all of its retry
	 * attempts (`Collection.syncInternal` mints the id once and `syncAttempts` reuses it for every
	 * attempt of that cycle). Emptied at the
	 * moment the episode is reported — the count is in the line, and nothing reads the ids again —
	 * so the set is bounded by {@link STUCK_RESERVATION_DISTINCT_ACTIONS}.
	 */
	refused: Set<ActionId>;
	/** True once this episode has been named; suppresses every later refusal against these holders. */
	reported: boolean;
}

/**
 * How many DISTINCT later actions one unchanged holder must refuse on a block before the refusals are
 * named as a stuck reservation rather than as an ordinary lost race.
 *
 * **Why a count of distinct actions and not something else.** Elapsed time answers the wrong question
 * — a slow writer is not a stuck one, and a holder legitimately keeps its reservation for as long as
 * its own commit takes. A raw refusal count answers the wrong question too: a single writer retrying
 * a lost race produces a run of refusals under ONE action id (see {@link StuckReservationWatch.refused}).
 * What no healthy holder can produce is an unbounded stream of *different* writers all losing to it,
 * because a healthy holder's reservation lasts one pend-to-commit window.
 *
 * **Why 8.** The bound to clear is how many distinct actions can honestly be refused inside one such
 * window. Measured on the in-process mesh, in the healthy-contention arm of
 * `test/stuck-reservation-named.spec.ts`: a holder that pends, is raced by other writers, and then
 * commits refuses **2** distinct actions per episode — the two rivals — and the count resets on every
 * holder change. `concurrent-diary-append-acknowledgement.spec.ts` races three writers at one diary
 * and cannot exceed that either, for the same reason: at most (writers - 1) rivals can lose to one
 * winner. 8 is four times the measured healthy figure, and it is a floor a genuinely stuck block
 * clears trivially (the field instance refused hundreds).
 *
 * **The bound stated exactly.** It is distinct SYNC CYCLES, not distinct writers: one writer that
 * exhausts a sync's retry budget and is re-driven by its caller mints a fresh id for the next cycle,
 * so it can contribute more than one. That does not widen the window much — a cycle only ends in
 * exhaustion after `DefaultMaxAttempts` (10) attempts of backoff, roughly 21s (see the exhaustion
 * NOTE in `Collection.syncAttempts`), so a lone writer needs a holder to keep the block for upwards
 * of two and a half minutes before it reaches 8 by itself, which is not a healthy holder.
 *
 * **What the margin does NOT cover, stated honestly.** A block with more than 8 distinct writers
 * racing it inside a single pend-to-commit round trip could reach 8 with a perfectly healthy holder.
 * That is a diagnostic false positive on a log line and nothing else — this counter never refuses,
 * expires, or deletes anything (see {@link CoordinatorRepo.noteStuckReservation}) — and the remedy if
 * a deployment ever hits it is to raise this number, not to add a control path. Raising it costs
 * detection latency on low-traffic blocks, which need this many distinct write ATTEMPTS before the
 * condition can be named at all.
 */
const STUCK_RESERVATION_DISTINCT_ACTIONS = 8;

/** Whether two sorted holder lists name the same reservation — i.e. whether a refusal continues an
 *  existing episode or starts a new one. Both sides come from the same sort, so this is a plain
 *  element-wise comparison; a block normally has exactly one holder, since a member's own pend refuses
 *  a second one (`ClusterMember.validatePendOperations`). */
function sameHolders(a: readonly ActionId[], b: readonly ActionId[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The stuck-reservation wording: written for an operator reading logs, in the same register as
 * {@link cohortTooSmallMessage} and {@link soleHolderMessage} — what is stuck, what will and will not
 * clear it, and what to do next.
 *
 * The claim is deliberately about the RESERVATION, not about the writer's intent: this node cannot
 * see whether the holding process is alive, only that it has held the block across enough unrelated
 * later actions that no retry is going to win. So the line says what is provable (the block accepts
 * no writes while this record stands, and nothing on the node removes it) and points at the one check
 * that settles the rest.
 */
function stuckReservationMessage(holders: readonly ActionId[], refusedActions: number): string {
	const held = holders.join(', ');
	return `This block is WEDGED BEHIND A PENDING WRITE THAT IS NOT COMPLETING, and retrying will never ` +
		`clear it: action(s) ${held} reserved the block and have now refused ${refusedActions} DISTINCT, ` +
		`unrelated later actions. Each of those refusals on its own looks exactly like an ordinary ` +
		`optimistic-concurrency loss, which is normal and healthy — the repetition is what is not. A ` +
		`healthy rival holds a block only for its own pend-to-commit window and then releases it by ` +
		`committing or cancelling; a reservation that keeps refusing NEW writers is holding the block ` +
		`against every writer on every machine, and each of them loses again identically. EXACTLY TWO ` +
		`THINGS CLEAR IT: a cancel for action(s) ${held} on this block (route it through the cohort so ` +
		`every member drops the record), or that same action's own commit landing. Nothing on the node ` +
		`expires it — there is no sweep for abandoned pending records — so until one of those two happens ` +
		`the block takes NO writes while continuing to serve reads and to look healthy in every other ` +
		`respect. The usual cause is a writer that went away between a failed or half-applied commit and ` +
		`the cancel it owed, so check whether whatever ran ${held} still exists before cancelling on its ` +
		`behalf. This line is a diagnosis and nothing more: this node does not expire, refuse, or delete ` +
		`the record on the strength of it.`;
}

/**
 * What one repair pass established about a block that is still MISSING locally after it.
 * Ordered by how firmly the block is ruled out; `get` consults it only on the missing path.
 */
type AbsenceVerdict =
	/** Nobody to ask (empty cohort, or solo-self), or every non-self cohort member answered
	 *  "I hold nothing". As confirmed as an absence gets — stays authoritative, which is what
	 *  keeps the routine new-collection probe at one round trip. */
	| 'confirmed'
	/** Some of the cohort answered and some could not be asked. (A consult that THROWS produces
	 *  no verdict at all — `get`'s catch arm reports it directly.) */
	| 'unconfirmed'
	/** No cohort member outside this node could be asked at all. Mutually exclusive with
	 *  `claimed` in practice: a claim requires a non-self peer to have answered, which is
	 *  exactly what this verdict rules out. The precedence below still orders the pair, so
	 *  the mapping stays total, but there is no reachable case to test. */
	| 'isolated'
	/** A peer claimed a revision this pass did not converge onto — quorum declined it, or a
	 *  quorum corroborated it and acquisition failed. */
	| 'claimed';

/**
 * What one consult established about whether this node's copy is CURRENT — the currency
 * counterpart to {@link AbsenceVerdict}. Three cases, and two rules the difference between them
 * exists to state:
 *
 *  - A CONSULT THAT REACHED NOBODY REFUTES NOTHING. An earlier pass's recorded doubt
 *    ({@link CoordinatorRepo.unsettledAheadClaims}) may only be cleared by evidence, and "nobody
 *    answered" is not evidence.
 *  - AN ANSWER REFUTES ONLY THE CLAIM IT BEARS ON. A peer that never reported the claimed
 *    revision saying "I hold nothing" says nothing about a claim another peer made; only the
 *    claimants can retire their own word. So BOTH cases that reached somebody carry `silent` —
 *    who could not be asked — rather than a pre-baked "refuted", and
 *    {@link CoordinatorRepo.recordAheadClaim} weighs it against the claim it actually holds.
 *    That applies to `unsettled-claim` too, which weakens a recorded claim whenever its own
 *    revision is LOWER: same erasure, one step less obvious.
 *
 * Kept as a named union rather than an optional number so a `return` added later cannot mean
 * "nothing is ahead" by leaving a field off — the compiler asks.
 */
type CurrencyVerdict =
	/** The consult reached the cohort and nothing it heard is ahead of this node. NOT by itself a
	 *  refutation of a recorded memo: it carries the evidence — `answered` and `silent`, the two
	 *  halves of the non-self cohort view — so `recordAheadClaim` can ask whether the peers that
	 *  MADE the recorded claim are among the ones that spoke. */
	| { kind: 'nothing-ahead'; answered: readonly string[]; silent: readonly string[] }
	/** No cohort member outside this node was asked (no cohort, solo-self, no callback) or none
	 *  answered. No evidence either way: a recorded memo stands exactly as it was. */
	| { kind: 'no-evidence' }
	/** Cohort peers `claimants` claim `rev`, strictly ahead of what this node holds, and this pass
	 *  did not converge onto it — quorum declined the claim, or corroborated it and acquisition
	 *  failed. `claimants` is recorded with the claim: it is who must later answer for it.
	 *  `silent` is the same evidence `nothing-ahead` carries, needed for the same reason: this
	 *  verdict REPLACES a recorded claim, so when its `rev` is lower it must not do so behind the
	 *  back of a claimant that could not be asked. */
	| { kind: 'unsettled-claim'; rev: number; claimants: readonly string[]; silent: readonly string[] };

/**
 * Extended cluster interface that includes the ability to check if a transaction was executed.
 * This is used by CoordinatorRepo to avoid duplicate execution.
 */
interface LocalClusterWithExecutionTracking extends ICluster {
	wasTransactionExecuted?(messageHash: string): boolean;
	/** Local storage's verdict for a pend applied during consensus; see ClusterMember.getExecutedPendResult. */
	getExecutedPendResult?(messageHash: string): PendResult | undefined;
	/** Local storage's verdict for a commit applied during consensus; see ClusterMember.getExecutedCommitResult. */
	getExecutedCommitResult?(messageHash: string): CommitResult | undefined;
	/** Self-sign a one-peer commit proof for the solo-cohort commit path; see ClusterMember.mintSoloCommitProof.
	 *  Optional like its siblings: absent on a bare ICluster double, and then the solo path simply
	 *  commits proof-less — exactly the pre-mint behavior. */
	mintSoloCommitProof?(message: RepoMessage): Promise<BlockCommitProof>;
}

/**
 * A cohort peer's answer to the latest-revision consult. Defined with the archive shape it is
 * projected from (`storage/block-archive.ts`) and re-exported here so it reads next to the callback
 * that returns it; see {@link CertifiedActionRev} there for what the optional proof does and does
 * not mean.
 */
export type { CertifiedActionRev } from "../storage/block-archive.js";

/**
 * Callback to query a cluster peer for their latest revision of a block. Three-way contract:
 *  - resolves a `CertifiedActionRev` — the peer answered and holds the block at that revision;
 *  - resolves `undefined` — the peer answered and holds NOTHING (an absent claim);
 *  - REJECTS — the peer could not be asked at all (dial failure, protocol error).
 *
 * The distinction between the last two is load-bearing: `queryClusterForLatest` counts a
 * rejection as a SILENT peer, which stops `CoordinatorRepo.get` from reporting a locally-missing
 * block as an authoritative absent, while a resolved `undefined` is a real answer that keeps the
 * absent authoritative. Implementations must therefore let transport errors propagate rather than
 * swallowing them into `undefined` (see the implementations in `libp2p-node-base` and the mesh
 * harness's `silentPeers` failure knob). Slowness needs no handling here — the caller deadlines
 * each query and treats expiry as silence.
 */
export type ClusterLatestCallback = (peerId: PeerId, blockId: BlockId, context?: ActionContext) => Promise<CertifiedActionRev | undefined>;

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
	/**
	 * Optional layer-2 anchoring for the cohort commit proofs the latest-revision consult verifies
	 * (`cluster/certified-claims.ts`): re-derive the block's cohort and LOG the overlap with the
	 * proof's signers, plus surface proofs accepted without that comparison. Purely observational —
	 * never a gate — and absent in production wiring today; `certifyClaim` logs unanchored
	 * acceptance internally regardless.
	 */
	proofAnchoring?: ProofAnchoring;
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
		components.acquireBlockFromCohort,
		components.proofAnchoring
	);
}

/**
 * The slice of {@link ClusterCoordinator} that {@link CoordinatorRepo} actually consumes.
 *
 * It exists so a test double has something COMPLETE to satisfy. The doubles in
 * `test/coordinator-repo-*.spec.ts` replace the private `coordinator` field wholesale, and while
 * that field was typed as the whole class and the doubles were assigned through
 * `as unknown as { coordinator: unknown }`, every method this class newly called on the coordinator
 * type-checked fine and then threw `... is not a function` at runtime in every spec holding a
 * double — `getClusterPeerIds` cost 21 specs exactly that way. Widening this interface now breaks
 * the doubles at COMPILE time, at the point of widening, which is where the cost belongs.
 *
 * NOTE: the doubles still name the private field by string (`{ coordinator: ... }`), so renaming
 * `CoordinatorRepo.coordinator` would make those casts silently stop applying and every double
 * revert to being ignored. If that field is ever renamed, grep the specs for `coordinator:`.
 */
export interface ICoordinatorClusterSeam {
	getClusterSize(blockId: BlockId): Promise<number>;
	getClusterPeerIds(blockId: BlockId): Promise<string[]>;
	executeClusterTransaction(blockId: BlockId, message: RepoMessage, options?: MessageOptions): Promise<{
		record: ClusterRecord;
		localExecuted: boolean;
		localPendResult?: PendResult;
		localCommitResult?: CommitResult;
	}>;
	recoverTransactions(): Promise<void>;
}

/** Cluster coordination repo - uses local store, as well as distributes changes to other nodes using cluster consensus. */
export class CoordinatorRepo implements IRepo {
	private coordinator: ICoordinatorClusterSeam;
	private readonly DEFAULT_TIMEOUT = 30000; // 30 seconds default timeout
	private readonly localPeerId?: PeerId;
	private readonly responsibilityCache = new LruMap<string, { inCluster: boolean, expires: number }>(1000);
	private static readonly RESPONSIBILITY_TTL_MS = 60_000;
	private readonly lastSeenCommitMs = new LruMap<string, number>(1000);
	/** Per block, what earlier repair passes left unresolved — see {@link AheadClaimState}.
	 *  Outlives the consult on purpose: the read-repair window skips consults for blocks checked
	 *  recently, and a doubt dropped there is a stale answer served as confirmed again.
	 *  NOTE: LRU-bounded like `lastSeenCommitMs`; an eviction under >1000 doubted blocks loses the
	 *  doubt until the next consult re-derives it (one read-repair window later, at worst) and lets
	 *  {@link reportRepairDeadlock} say its piece a second time. */
	private readonly unsettledAheadClaims = new LruMap<string, AheadClaimState>(1000);
	/**
	 * Per block, what its pending-conflict refusals have added up to — see {@link StuckReservationWatch}
	 * and {@link noteStuckReservation}. Deliberately its OWN map rather than a third fact hung off
	 * {@link unsettledAheadClaims}: that entry belongs to the read-repair path and is cleared by a block
	 * converging on a revision, whereas this one belongs to the write path and is cleared by the block
	 * accepting a write. Sharing the entry would mean teaching both of those lifetimes about a fact
	 * neither owns (backlog `debt-freshness-state-scattered-across-coordinator-repo` is the standing
	 * argument for collapsing all of this per-block state behind one collaborator; adding a fourth
	 * carve-out to the freshness entry would have made that harder, not easier).
	 *
	 * NOTE: LRU-bounded like its siblings. An eviction under >1000 conflicted blocks loses an episode's
	 * say-once flag, so the line can repeat once for that block — the same bounded duplication
	 * {@link reportRepairDeadlock} accepts, and far cheaper than the unbounded silence it replaces.
	 *
	 * NOTE: per COORDINATOR, and a block's coordinator is whichever peer the writer's key lookup
	 * resolved — normally stable, but cohort churn or a routing change moves it. When it moves, the
	 * count restarts on the new coordinator (the condition is named later) and the old one may name the
	 * same episode again (the condition is named twice). Fine while a wedged block is diagnosed by
	 * searching for its id; if a churning deployment ever makes duplicate lines the noisy failure this
	 * one exists to replace, the say-once state has to move to where the record lives (the member's own
	 * storage) rather than to where the refusal was classified.
	 */
	private readonly stuckReservations = new LruMap<string, StuckReservationWatch>(1000);
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
	/** Per-instance logger, namespaced by peer id when `localPeerId` is known (degrades to the un-suffixed namespace when not — the single-node/test construction has always tolerated its absence). */
	private readonly log: ReturnType<typeof createLogger>;
	/** Test seam: overridable clock for window-based read-repair gating. */
	now: () => number = () => Date.now();
	/** Test seam: overridable RNG (0..1) for sample-rate gating. */
	rand: () => number = () => Math.random();

	constructor(
		readonly keyNetwork: IKeyNetwork,
		readonly createClusterClient: (peerId: PeerId) => ICluster,
		private readonly storageRepo: IRepo,
		cfg?: CoordinatorRepoConfig,
		private readonly localCluster?: LocalClusterWithExecutionTracking,
		localPeerId?: PeerId,
		fretService?: FretService,
		private readonly clusterLatestCallback?: ClusterLatestCallback,
		reputation?: IPeerReputation,
		stateStore?: ITransactionStateStore,
		private readonly acquireBlockFromCohort?: AcquireBlockCallback,
		private readonly proofAnchoring?: ProofAnchoring
	) {
		this.localPeerId = localPeerId;
		this.log = createLogger('coordinator-repo', localPeerId?.toString());
		const policy: ClusterConsensusConfig & { clusterSize: number } = {
			// Same constant `resolveClusterPolicy` gives a node that declares no clusterSize, not a
			// second literal: a direct constructor (the readme's manual-wiring path) and the node
			// assembly must land on the same width or the two disagree about the same key's cohort.
			clusterSize: cfg?.clusterSize ?? DEFAULT_CLUSTER_SIZE,
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
			wasTransactionExecuted: localCluster.wasTransactionExecuted?.bind(localCluster),
			getExecutedPendResult: localCluster.getExecutedPendResult?.bind(localCluster),
			getExecutedCommitResult: localCluster.getExecutedCommitResult?.bind(localCluster)
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
			this.log('proximity:check-error', { blockId, error: (err as Error).message });
			// On failure, assume responsible to avoid false rejections
			return true;
		}

		this.responsibilityCache.set(blockId, { inCluster, expires: Date.now() + CoordinatorRepo.RESPONSIBILITY_TTL_MS });
		this.log('proximity:checked', { blockId, inCluster });
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
			this.log('proximity:rejected', { blockIds: notResponsible });
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
				this.log('proximity:get-warning', { blockId, msg: 'serving read for non-responsible block' });
			}
		}

		// First try local storage
		const localResult = await this.storageRepo.get(blockGets, options);

		// Decide per-block whether to consult cluster peers. Two triggers:
		//   (a) Missing — block isn't present locally at all (legacy behavior).
		//   (b) Stale-by-policy — block is present but read-repair policy says verify.
		// Skip cluster fetch if this is already a sync request (to prevent recursive queries).
		// A sync read is also never marked `unavailable` here — the consult it skips is the
		// one whose failure the flag reports, and flagging would feed the recursion this
		// bypass exists to prevent. (Storage-level 'unmaterializable' flags still pass
		// through untouched; they report local state, not the consult.)
		const skipClusterFetch = (options as any)?.skipClusterFetch;
		// NOTE: NetworkTransactor.get treats an authoritative "absent" ({ state: {} })
		// as final and no longer retries it (ticket txn-perf-authoritative-notfound),
		// relying on this cluster reconciliation to have already run. When the consult
		// FAILS outright — or runs without ruling the block out and the block stays
		// missing — the entry is flagged `unavailable` below with a reason naming what
		// the consult established (see AbsenceVerdict and the mapping in the loop body),
		// which re-enables the transactor-level retry against a different peer. If a
		// coordinator is configured WITHOUT clusterLatestCallback, there is no cohort to
		// consult and the local answer IS the whole truth — it stays authoritative, with
		// no flag and no transactor-level retry to compensate. That is fine (such a
		// coordinator has no cluster to reconcile against), but keep this coupling in
		// mind if a partial-cluster read path is added.
		if (this.clusterLatestCallback && !skipClusterFetch) {
			for (const blockId of blockGets.blockIds) {
				const localEntry = localResult[blockId];
				const localRev = localEntry?.state?.latest?.rev;
				const isMissing = !localEntry?.state?.latest;
				const isStale = !isMissing && this.shouldReadRepair(blockId);
				if (!isMissing && !isStale) {
					// No consult this pass — the read-repair window says this block was checked
					// recently. An unsettled claim an earlier pass recorded still applies: the doubt
					// is a property of what this node HOLDS, not of whether a consult just ran.
					// Without this, every read inside the window after a failed convergence would
					// serve the same content as confirmed — the exact silent lie this marker exists
					// to end, re-opened for `readRepairWindowMs` at a time.
					this.flagUnconfirmedCurrency(localResult, blockId, blockGets.context);
					continue;
				}

				if (isStale) {
					this.log('cluster-tx:read-repair-triggered', {
						blockId,
						mode: this.readRepairMode,
						ageMs: this.ageMs(blockId),
						localRev
					});
				}

				try {
					const { absence, currency } = await this.fetchBlockFromCluster(blockId, blockGets.context, localRev);
					const refreshed = await this.storageRepo.get({ blockIds: [blockId], context: blockGets.context }, options);
					const newRev = refreshed[blockId]?.state?.latest?.rev;
					if (refreshed[blockId]) {
						localResult[blockId] = refreshed[blockId];
					}
					if (isStale) {
						if (typeof newRev === 'number' && typeof localRev === 'number' && newRev > localRev) {
							this.log('cluster-tx:read-repair-applied', { blockId, oldRev: localRev, newRev });
						} else {
							this.log('cluster-tx:read-repair-noop', { blockId });
						}
					}
					// The consult ran but could not rule the block out, and the verdict names the
					// evidence (see AbsenceVerdict): part of the cohort was silent (`unconfirmed`
					// → 'peers-unreachable' — another coordinator may know better), no cohort
					// member outside this node could be asked at all (`isolated` →
					// 'cohort-unreachable' — there is no better-connected coordinator to re-ask),
					// or a peer positively claimed a revision this pass could neither corroborate
					// nor acquire (`claimed` → 'claimed-elsewhere' — the block is known to exist
					// somewhere). Either way a still-missing block must not pose as an
					// authoritative absent. When the whole cohort answers "holds nothing" the
					// absent stays authoritative (`confirmed`) — the new-collection probe against
					// a healthy cohort stays one round-trip.
					if (isMissing && absence !== 'confirmed') {
						this.flagUnconfirmedAbsence(localResult, blockId,
							absence === 'claimed' ? 'claimed-elsewhere'
								: absence === 'isolated' ? 'cohort-unreachable'
									: 'peers-unreachable');
					}
					// A PRESENT block served below a cohort claim the repair could not settle is
					// the mirror lie: real content posing as confirmed-current. A consult that
					// REACHED THE CLAIMANTS is the authority on that claim, so it replaces whatever
					// an earlier one recorded — including clearing it when those peers claim nothing
					// any more. One that reached nobody (`currency.kind === 'no-evidence'` — no
					// cohort, solo-self, or total silence) refutes nothing, and neither does one
					// whose answers came from peers that never made the claim; `recordAheadClaim`
					// weighs the verdict's evidence against the recorded claimants, and only in the
					// direction that could hide a stale serve (a higher claim always lands). The missing
					// case is excluded — it is the absence path above, and a bare absent below a
					// claim already reads as either authoritative (cohort answered, nothing
					// corroborated) or flagged.
					if (!isMissing) {
						this.recordAheadClaim(blockId, currency);
						this.flagUnconfirmedCurrency(localResult, blockId, blockGets.context);
					}
				} catch (err) {
					this.log('cluster-fetch:error', { blockId, error: (err as Error).message });
					// The consult that was supposed to make this answer trustworthy did not run.
					// NOTE: a consult that THROWS (e.g. `findCluster` itself rejected) is reported
					// 'peers-unreachable' even on an isolated node: a failed cohort lookup is a
					// routing failure and says nothing about how many cohort members were
					// reachable. If `findCluster` on an isolated node turns out to throw routinely
					// rather than return a stale cohort view, revisit — that would put the
					// isolated case back under this vaguer reason.
					if (isMissing) {
						this.flagUnconfirmedAbsence(localResult, blockId, 'peers-unreachable');
					} else {
						// It told us nothing, so it refutes nothing: an earlier pass's unsettled
						// claim stands.
						this.flagUnconfirmedCurrency(localResult, blockId, blockGets.context);
					}
				}
			}
		}

		return localResult;
	}

	/**
	 * Downgrade an absence the coordinator could not confirm to the given `unavailable` reason —
	 * a flag `NetworkTransactor.get` retries against another peer instead of taking as final.
	 * The reason names the evidence (see {@link AbsenceVerdict} for the mapping in `get`); this
	 * method only decides WHETHER the entry may carry a flag at all.
	 *
	 * No-op once the entry carries a real answer (the consult restored the block) or a sharper flag
	 * (storage's `'unmaterializable'`), so callers only need to establish that the answer is a guess.
	 *
	 * "Carries a real answer" is tested as `entry.block !== undefined`, NOT as `state.latest` being
	 * set. The two used to move together, so `state.latest` read as a serviceable proxy — but a
	 * pending-only insert (pended, not yet committed) served through the pending overlay has real
	 * CONTENT and no committed revision at all, so its `state.latest` is undefined. Flagging that
	 * entry would mark a block this node is positively holding as an unconfirmed absence, and
	 * `NetworkTransactor`'s `isAuthoritative` keys off the flag alone — the read would burn its
	 * retry budget re-asking other peers for content it already has. `state.latest` stays in the
	 * test as well so a stale-but-real committed answer is likewise never downgraded.
	 */
	private flagUnconfirmedAbsence(results: GetBlockResults, blockId: BlockId, reason: BlockUnavailableReason): void {
		const entry = results[blockId];
		if (!entry) {
			results[blockId] = { state: {}, unavailable: reason };
		} else if (entry.block === undefined && !entry.state?.latest && entry.unavailable === undefined) {
			entry.unavailable = reason;
		}
	}

	/**
	 * Remember (or forget) the cohort claim a freshness consult could not settle for a block, per
	 * that consult's {@link CurrencyVerdict}. Entries are also dropped once this node reaches the
	 * claimed revision (see {@link flagUnconfirmedCurrency}), which is what bounds the map.
	 *
	 * **The weakening rule, in one sentence.** A recorded claim may be WEAKENED — retired, or
	 * revised down to a lower revision — when at least one non-self cohort member answered this
	 * consult AND no peer that MADE the claim was silent in it. Everything else about the rule
	 * follows from that, and each of the three cases a claimant can be in has its own reason:
	 *
	 *  - A claimant that ANSWERED, on a consult that found nothing ahead of it, has retired its
	 *    own word. Its answer is evidence about its own claim — the only kind that counts.
	 *  - A claimant that was SILENT blocks weakening. Nobody else can speak for it; a peer that
	 *    never knew the claimed revision answering "I hold nothing" is not a refutation.
	 *  - A claimant that is NEITHER answered nor silent has left this node's cohort view:
	 *    `findCluster` no longer holds it responsible for the block, so its old word no longer
	 *    binds the current cohort. This is what BOUNDS the doubt — see the membership discussion
	 *    at `nothingAheadVerdict` in {@link fetchBlockFromCluster}.
	 *
	 * Note the arithmetic that makes it a one-liner: the non-self cohort IS `answered` ∪ `silent`,
	 * so "answered, or gone from the cohort" is exactly "not silent". No membership set has to be
	 * carried or diffed.
	 *
	 * RAISING a claim needs no licence — a higher claimed revision subsumes the one it replaces,
	 * so `flagUnconfirmedCurrency` stamps everything it used to and more. Only the weakening
	 * direction can hide a stale serve, which is why the gate below is one test applied to both
	 * shapes rather than a rule attached to retirement alone.
	 *
	 * Forgetting requires EVIDENCE. A consult that reached nobody (`no-evidence`) refutes nothing
	 * and leaves the memo exactly as it was. That used to be a rule the caller had to obey and
	 * could not: the old `claimedAheadRev: number | undefined` said the same thing for "peers
	 * refuted the claim" and for "nobody was asked", so every non-consulting exit silently erased
	 * the doubt and served stale content as confirmed-current. The verdict type states the
	 * difference instead, so a new exit cannot mean the wrong one by omission — and `nothing-ahead`
	 * now carries the evidence rather than a pre-baked refutation for the same reason, so a caller
	 * cannot assert a refutation it did not observe.
	 */
	private recordAheadClaim(blockId: BlockId, currency: CurrencyVerdict): void {
		if (currency.kind === 'no-evidence') return;
		const prior = this.unsettledAheadClaims.get(blockId);
		const priorRev = prior?.rev;
		// The one gate, applied to both shapes that can weaken a recorded claim: retiring it
		// (`nothing-ahead`) and revising it down to a lower revision (`unsettled-claim` below
		// `priorRev`) are the same act, and a lower claim replacing a higher one used to slip past
		// the retirement rule and erase the higher claimant's word exactly as an unrelated peer's
		// "I hold nothing" once did. Only the claimants' own silence protects their claim, though:
		// everyone else's silence is irrelevant to it, and degrading this into "any silence blocks
		// weakening" would flag a block forever behind one permanently unreachable cohort peer.
		const weakensPrior = priorRev !== undefined
			&& (currency.kind === 'nothing-ahead' || currency.rev < priorRev);
		if (weakensPrior) {
			const silentClaimants = (prior?.claimants ?? []).filter(id => currency.silent.includes(id));
			if (silentClaimants.length > 0) {
				// The operator's only signal that a block's doubt CANNOT settle from this node's
				// position: the peer that claimed the revision is unreachable, so every read of the
				// block stays marked possibly-stale until it answers or leaves the cohort view.
				// NOTE: emitted per pass, not say-once. In `lazy` mode `readRepairWindowMs` (10s
				// default) rate-limits consults, so this is at most one line per window; in
				// `paranoid` mode a consult runs on EVERY read and so this logs on every read. If
				// that ever shows as noise, move it behind a say-once flag on the entry (beside
				// `deadlocksReported`) rather than dropping the line — it is the only place the
				// condition is named.
				this.log('cluster-fetch:claim-unrefutable', { blockId, rev: priorRev, silentClaimants });
				return;	// the memo stands exactly as recorded
			}
		}
		if (currency.kind === 'nothing-ahead') {
			// Nothing recorded to retire, or a consult nobody outside this node answered — which
			// `fetchBlockFromCluster` reports as `no-evidence` rather than this verdict, so the
			// second test is the type's guarantee restated, not a reachable path.
			if (priorRev === undefined || currency.answered.length === 0) return;
			// The consult is the authority on the CLAIM, and only on the claim. A recorded deadlock is
			// not about any revision — it is about how many machines this deployment can field, or how
			// many of them hold the block — so it outlives the claim that first exposed it and is
			// dropped only when the block converges (see {@link flagUnconfirmedCurrency}).
			if (prior?.deadlocksReported) this.unsettledAheadClaims.set(blockId, { deadlocksReported: prior.deadlocksReported });
			else this.unsettledAheadClaims.delete(blockId);
			return;
		}
		// Repeated claims at the SAME revision accumulate claimants: pass 1 hears it from A, pass 2
		// hears it from B while A is silent, and retiring later on B's answer alone would ignore A's
		// still-unanswered word. A claim at a DIFFERENT revision replaces outright — a higher one
		// subsumes the old, and a lower one has just passed the weakening gate above, so every peer
		// that made the older claim has either answered this pass or left the cohort view.
		// NOTE: the same-revision union never prunes, so a claimant that departed the cohort while
		// the revision stayed stuck lingers in the list. Inert (a departed peer is never `silent`,
		// so it never blocks weakening) and bounded per pass by cohort width, but across many passes
		// with churn the list is bounded only by how many distinct peers ever claimed that exact
		// revision. Prune against the pass's `answered` ∪ `silent` if a long-lived stuck block ever
		// shows this entry growing.
		const claimants = priorRev === currency.rev
			? [...new Set([...(prior?.claimants ?? []), ...currency.claimants])]
			: [...currency.claimants];
		this.unsettledAheadClaims.set(blockId, {
			rev: currency.rev,
			claimants,
			...(prior?.deadlocksReported ? { deadlocksReported: prior.deadlocksReported } : {})
		});
	}

	/**
	 * Stamp {@link GetBlockResult.unconfirmedAheadRev} on an entry sitting behind an unsettled
	 * cohort claim — served committed content the coordinator cannot confirm is current.
	 * Deliberately narrow; ALL of these must hold:
	 *  - a consult (this read's or an earlier one's, see {@link recordAheadClaim}) left a claim
	 *    unsettled for this block;
	 *  - the entry carries a committed revision (a present block, or a committed tombstone) —
	 *    never a plain absent, which is the absence path's business;
	 *  - that served revision is still strictly BELOW the claim: the repair did not converge, and
	 *    nothing committed past the claim in the meantime (if it did, the claim is settled and the
	 *    memo is dropped here);
	 *  - the caller asked for a view that should contain the claim: an unpinned "latest" read, or
	 *    a pin at/above the claimed revision. A read pinned BELOW the claim is being served
	 *    correctly and stays unstamped — this keeps a collection's context-pinned data reads
	 *    quiet while its unpinned tail read (the one seam where fresher truth could arrive —
	 *    Collection.bootstrapContext) speaks up.
	 * NOT covered, on purpose: a cohort that is merely silent and claims nothing (pinned as
	 * authoritative by the merely-STALE spec in coordinator-repo-unavailable.spec.ts) — silence
	 * carries no revision to be behind of.
	 *
	 * Pin comparability: `ActionContext.rev` and a block's `state.latest.rev` count the same
	 * per-collection revision sequence — `Collection.bootstrapContext` seeds the context straight
	 * from the tail block's `latest.rev`, and `syncInternal` commits every block of an action at
	 * `context.rev + 1` — so `context.rev >= claimedRev` is a well-defined comparison. `state.latest`
	 * is this node's newest revision for the block even on a pinned read (StorageRepo reports the
	 * content's own revision separately as `materialized`), which is exactly the number "is this
	 * node behind the claim?" asks about.
	 */
	private flagUnconfirmedCurrency(results: GetBlockResults, blockId: BlockId, context?: ActionContext): void {
		const claimedRev = this.unsettledAheadClaims.get(blockId)?.rev;
		if (claimedRev === undefined) return;
		const entry = results[blockId];
		if (!entry || entry.unavailable !== undefined) return;
		const servedRev = entry.state?.latest?.rev;
		if (typeof servedRev !== 'number') return;
		if (servedRev >= claimedRev) {
			// Caught up — by this pass's repair or by a commit that landed since. Nothing to doubt, and
			// nothing deadlocked either: repair demonstrably converged for this block, so a later
			// non-convergence is a new episode and gets to say so again.
			this.unsettledAheadClaims.delete(blockId);
			return;
		}
		if (context !== undefined && context.rev < claimedRev) return;
		entry.unconfirmedAheadRev = claimedRev;
		this.log('cluster-tx:read-unconfirmed', { blockId, servedRev, claimedAheadRev: claimedRev });
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
	 * True when a commit's approve votes form a strict majority of the FULL cohort — the only case
	 * where "this node committed" is evidence that no rival commit moved past it. Two strict
	 * majorities of one cohort must share a voter, so a rival that also reached a full-cohort
	 * majority would have surfaced here as a conflict vote instead of approving both. A commit below
	 * that bar — the solo short-circuit under a larger declared cohort, or a record that enrolled
	 * fewer than a full-cohort majority — rules nothing out; it still succeeds, it just must not arm
	 * the lazy read-repair window ({@link markBlocksSeen}), so the next read consults the cohort as
	 * if the commit had not happened.
	 *
	 * What it does NOT rule out, at any vote count: a rival that assembled its own quorum on a
	 * SHRUNKEN cohort view, which needs no full-cohort majority to complete
	 * ({@link clusterReachedCommitConsensus} accepts an enrolled-subset majority). Two commits that
	 * land at one revision on disjoint quorums are a fork, and healing one is
	 * `docs/partition-healing.md`'s business, not a freshness window's.
	 *
	 * Denominator: the full cohort, never the enrolled/reachable subset — `record.peers` is exactly
	 * the thing a downsize shrinks (contrast `clusterReachedCommitConsensus`, whose enrolled-subset
	 * majority answers "did consensus complete", a different question — leave it be).
	 * {@link repairCorroborationClusterSize} is the declared yardstick resolved for this same
	 * shrunken-view trap on the repair side, maxed with the observed cohort for the case where
	 * routing sees more peers than were declared.
	 */
	private commitQuorumRulesOutRivals(approvals: number, observedCohortSize: number): boolean {
		const fullCohortSize = Math.max(observedCohortSize, this.repairCorroborationClusterSize);
		return approvals > fullCohortSize / 2;
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
	 *
	 * Returns the two things `get` needs beyond the storage side effects:
	 *  - `absence` — the verdict on this node's local absence of the block (see
	 *    {@link AbsenceVerdict}): whether the pass may rule the block out, and on what evidence.
	 *    Only `'confirmed'` lets a still-missing block be reported as an authoritative absent.
	 *    Paths that consult nobody (no cohort, solo-self) are `'confirmed'`: there, the local
	 *    answer genuinely is the whole truth. When several verdicts apply at once the sharpest
	 *    evidence wins: `claimed` > `isolated` > `unconfirmed` > `confirmed` — a peer positively
	 *    saying "it exists" outranks any amount of silence.
	 *  - `currency` — the verdict on whether what this node holds is CURRENT (see
	 *    {@link CurrencyVerdict}). `unsettled-claim` means a cohort peer claimed a revision
	 *    strictly ahead of what this node holds and the pass did NOT converge onto it: the claim
	 *    failed the corroboration quorum, or was corroborated but could not be acquired. Content
	 *    `get` serves below that revision cannot be confirmed current (see
	 *    {@link GetBlockResult.unconfirmedAheadRev}); the claim itself must never drive
	 *    restoration. `nothing-ahead` and `no-evidence` differ in exactly one way that matters:
	 *    `nothing-ahead` carries the evidence that can retire an earlier pass's memo (and does
	 *    retire it when the memo's claimants are among the peers that answered), `no-evidence`
	 *    leaves it standing untouched. Required, not optional, so an exit added later has to say
	 *    which it means.
	 */
	private async fetchBlockFromCluster(blockId: BlockId, context?: ActionContext, localRev?: number): Promise<{ absence: AbsenceVerdict; currency: CurrencyVerdict }> {
		if (!this.clusterLatestCallback) return { absence: 'confirmed', currency: { kind: 'no-evidence' } };

		const blockIdBytes = new TextEncoder().encode(blockId);
		const peers = await this.keyNetwork.findCluster(blockIdBytes);
		const peerIds = peers ? Object.keys(peers) : [];
		// NOTE: deliberately does NOT call `markBlocksSeen` — unlike the solo-self exit below.
		// An empty cohort is a ROUTING FAILURE, not a settled answer, and `Libp2pKeyPeerNetwork`
		// cannot even produce one (its `findCluster` always includes self); the only producer
		// today is the mesh harness's injected `findClusterFails`. Arming the read-repair window
		// here would suppress a genuine repair for a whole `readRepairWindowMs` after a transient
		// blip, and re-entering costs no network work beyond the `findCluster` the read already
		// makes. Do not "fix" this by symmetry with the solo-self exit.
		// Currency: nobody was asked, so nothing was refuted — an earlier pass's unsettled claim stands.
		if (peerIds.length === 0) return { absence: 'confirmed', currency: { kind: 'no-evidence' } };

		// Solo-cluster short-circuit: the only responsible peer is us. There is no
		// remote to sync from, so skip the callback entirely. Querying ourselves
		// would dial self via SyncClient — pointless at best, and on nodes without
		// listen addresses (e.g. solo WebSocket-only) the dial can hang.
		if (
			peerIds.length === 1
			&& this.localPeerId
			&& peerIds[0] === this.localPeerId.toString()
		) {
			this.log('cluster-fetch:solo-self-skip', { blockId });
			// Arm the lazy read-repair window. Without this the window is never stamped,
			// `shouldReadRepair` reads `lastSeen == null` forever, and every read re-enters this
			// exit — read -> stale -> consult -> solo skip -> no-op -> still stale, unbounded
			// (GitHub issue #8: a solo node spent 47 minutes on a cold schema apply, logging 3,880
			// triggers against 3,879 no-ops).
			// What arming claims, precisely: NOT that this node has no rivals. A self-only cohort
			// is also what `Libp2pKeyPeerNetwork.findCluster` returns while genuine same-network
			// peers are still 'unknown' mid-identify (see its membership-scoping comment). It
			// claims only that re-asking sooner than one window cannot learn anything the next
			// `findCluster` would not, since this exit runs no other query — so a cohort that
			// appears, grows, or finishes identifying is consulted within one `readRepairWindowMs`.
			// NOTE: that self-heal delay IS `readRepairWindowMs` — 10s by default, well under
			// bootstrap. If it is ever configured into the minutes, a cold node would serve
			// unverified reads for that whole period; gate arming on cohort provenance if so.
			// Deliberately opposite to the commit-side rule that withholds arming from a commit
			// whose quorum proves nothing about rivals: that damps nothing, this bounds an
			// otherwise unbounded loop. Landing both, keep both — see the specs for each.
			this.markBlocksSeen([blockId]);
			// Currency: this exit queried NOBODY, so it refutes nothing — an earlier pass's unsettled
			// claim survives it. Note the coupling with the arming just above: retained doubt now
			// persists for up to `readRepairWindowMs` before a consult can refute it. That is correct
			// and deliberate — the window damps repair EFFORT, not honesty — and it is the same
			// coupling the comment at the final exit below describes. Arming the window and keeping
			// the memo are answers to different questions; do not collapse them.
			return { absence: 'confirmed', currency: { kind: 'no-evidence' } };
		}

		const { corroborated, corroboration, local, silent, answered, claims, uncorroboratedRev, deadlock } = await this.queryClusterForLatest(peerIds, blockId, context);
		// Any silence taints the WHOLE consult, not a fraction of it (fail-closed): one silent
		// peer could be the sole holder, and the cost — an extra transactor-level retry against
		// another coordinator — is paid only while a peer is actually unreachable. Silence with
		// NOBODY else reached at all is its own verdict: partial silence says "ask a better-
		// connected coordinator", total silence says there is no better-informed answer to be
		// had from this node.
		const silenceVerdict: AbsenceVerdict =
			silent.length > 0 ? (answered.length === 0 ? 'isolated' : 'unconfirmed') : 'confirmed';
		// The CURRENCY half's counterpart: the verdict to use at every exit that found nothing ahead.
		// A consult that reached NOBODY outside this node refutes nothing, so a memo an earlier pass
		// recorded must survive it. Keyed on `answered` (cohort members other than this node that
		// answered at all) rather than on `silenceVerdict === 'isolated'`: the two agree in every
		// reachable state — an empty `answered` with an EMPTY silent set would need a cohort of
		// nothing but self, which the solo short-circuit above already took — but stating the rule
		// in terms of "did anyone answer" says what it means without depending on that argument.
		// Computed once here, like `silenceVerdict`, so it is stated in one place instead of
		// re-derived at four `return`s.
		//
		// Deliberately NOT the same shape as `silenceVerdict` above, and no longer a defect that it
		// is not: the two answer DIFFERENT QUESTIONS. `silenceVerdict` asks whether this pass saw
		// the whole cohort, which partial silence answers "no" (fail-closed: one silent peer could
		// be the sole holder of a block this node lacks entirely). This one carries EVIDENCE rather
		// than a verdict, because whether an answer refutes anything depends on the claim being
		// weighed: `recordAheadClaim` retires a memo only when a claimant answered and no claimant
		// was silent. Do not "harmonize" them into one three-level verdict; and do not collapse this
		// back to a bare `refuted`, which is what let a peer that never knew the claim retire it.
		//
		// **How doubt settles when a claimant never comes back — not a timer.** A permanently silent
		// claimant would keep a block marked forever, so what bounds the doubt is COHORT MEMBERSHIP:
		// `Libp2pKeyPeerNetwork.findCluster` builds `peerIds` from the live routing table, so a peer
		// that is genuinely gone leaves the cohort view, stops appearing in `silent`, and stops
		// blocking retirement. Two consequences, both accepted:
		//  - If a dead peer never leaves the cohort view, the memo stands forever. That is a
		//    membership defect to fix in the membership layer, not a licence to lie here — the block
		//    genuinely IS possibly stale while a responsible cohort member holds a revision nobody
		//    can obtain. `cluster-fetch:claim-unrefutable` (see `recordAheadClaim`) gives the
		//    operator a name for it rather than erasing the doubt silently.
		//  - A transiently-shrunken cohort view can retire a live claim early: `findCluster` never
		//    admits a not-yet-identified peer, so one mid-identify is briefly absent and briefly
		//    looks departed. Self-correcting — when it rejoins still holding the higher revision, the
		//    next consult re-records the claim from its answer. One window of clean reads, versus the
		//    permanent denial the alternative rule ("only a fully-answered cohort refutes") produces
		//    from a single unreachable peer.
		const nothingAheadVerdict: CurrencyVerdict =
			answered.length === 0 ? { kind: 'no-evidence' } : { kind: 'nothing-ahead', answered, silent };
		/** The peers whose word this pass would be recording: those claiming at or above `rev`. A
		 *  claimant is who must later answer for the claim, so a peer claiming something LOWER is
		 *  not one — its answer says nothing about the revision in doubt. */
		const claimantsAtOrAbove = (rev: number): string[] =>
			claims.filter(c => c.rev >= rev).map(c => c.peerId);
		// Nothing corroborated: keep local data AND (usually) stay eligible for repair — marking the
		// block seen suppresses the next attempt for the whole read-repair window, which is only
		// right when re-asking sooner could not teach this node anything (see the `deadlock` arming
		// below for the one decline where that is provable).
		// An uncorroborated claim strictly ahead of what this node holds still travels up as
		// doubt: the answer about to be served may be behind it, and only the caller knows
		// whether that matters for the view it was asked for.
		if (!corroborated) {
			const uncorroboratedBaseline = local?.rev ?? localRev;
			// A claim — even one the quorum declined — is a peer positively attesting the block
			// exists, the sharpest fact this pass can surface. It outranks silence.
			const absence: AbsenceVerdict = uncorroboratedRev !== undefined ? 'claimed' : silenceVerdict;
			// A claim present but NOT ahead of the baseline falls to the shared verdict — which
			// resolves to `nothing-ahead` in practice here, since `uncorroboratedRev` can only exist
			// when a peer answered. Using the shared value anyway keeps the rule stated once.
			const currency: CurrencyVerdict =
				uncorroboratedRev !== undefined
					&& (uncorroboratedBaseline === undefined || uncorroboratedRev > uncorroboratedBaseline)
					? { kind: 'unsettled-claim', rev: uncorroboratedRev, claimants: claimantsAtOrAbove(uncorroboratedRev), silent }
					: nothingAheadVerdict;
			// Arm the lazy read-repair window when — and only when — the decline is provably
			// PERMANENT for the cohort-size reason: `cohort-too-small` means the cohort cannot field
			// the quorum even if every member answered and agreed (an undeclared two-machine cohort
			// against the default floor is the ordinary producer), so repeating the identical
			// hopeless consult sooner than one window teaches nothing — the same justification the
			// solo-self exit arms under. Every other decline stays unarmed, because there re-asking
			// CAN genuinely learn: a silent peer can recover (and the verdict is never computed off a
			// pass with silence — the guard in classifyRepairDeadlock is load-bearing here, not just
			// for the log), a `sole-holder`'s missing copy can arrive (the cohort-growth push, or a
			// commit), and a plain shortfall can fill. The doubt memo above is untouched either way:
			// the window damps repair EFFORT, never honesty — reads inside it still carry
			// `unconfirmedAheadRev` via flagUnconfirmedCurrency (pinned in
			// coordinator-repo-small-cohort-arming.spec.ts). Note the verdict arrives on EVERY
			// qualifying pass while the deadlock LOG stays once-per-episode — the split in
			// reportRepairDeadlock is what lets the window re-arm after it expires without the log
			// repeating.
			if (deadlock === 'cohort-too-small') {
				this.markBlocksSeen([blockId]);
			}
			return { absence, currency };
		}

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
		// NOTE: accepted tradeoff — this arm arms the lazy window even when the corroboration came
		// from a SINGLE voter (a two-member cohort's sole partner, or a single-signer certified
		// claim). The once-proposed remedy — stop re-arming on a single-voter corroboration — was
		// weighed and REJECTED when cohorts of one and two became supported production topology
		// (ticket `small-cohort-arming-rule`), for three reasons:
		//  1. Re-asking the sole partner sooner learns nothing: the repeat consult reaches the same
		//     one peer, and a lying peer repeats the lie. Same justification as the solo-self exit —
		//     not "the partner is trusted", but "a faster cadence cannot produce new evidence".
		//  2. Not arming punishes only the honest: an honest partner corroborating "you are current"
		//     is also a single voter, so refusing to arm makes every healthy two-machine cohort pay
		//     one network round trip per read, forever, while buying zero protection against a
		//     dishonest partner.
		//  3. The residual threat is a WITHHOLDING attack, and no consult cadence or proof rule
		//     touches it: a commit proof certifies "revision R was committed", nothing can certify
		//     "no revision after R exists", so a sole partner withholding a newer revision is
		//     indistinguishable from that revision never existing. Kept narrow by the commit rule —
		//     a two-member commit needs BOTH members' signatures (super-majority and majority both
		//     resolve to 2 of 2; ClusterMember.hasMajority) — so a revision the reader never
		//     co-signed can exist only across the reader's own storage loss, or from a commit under
		//     a different cohort shape (a partition-era solo commit, whose single-signer proof the
		//     partner can present or withhold).
		// What was bought instead is observability: `voters` (and `certified`) on the line below say
		// when this node's currency rests on one peer's word, without re-deriving it from logs.
		// Revisit only if a cadence-independent freshness signal (e.g. cross-cohort anchoring) ever
		// exists to arm against — a shorter cadence alone can never be the fix, per reason 1.
		if (baselineRev !== undefined && corroborated.rev <= baselineRev) {
			this.log('cluster-fetch:local-current', {
				blockId, localRev: baselineRev, clusterRev: corroborated.rev,
				voters: corroboration?.voters,
				...(corroboration?.certified ? { certified: true } : {})
			});
			this.markBlocksSeen([blockId]);
			// Only reachable when this node HOLDS a revision (the baseline), so `get` never
			// consults this verdict — computed consistently rather than hard-coded.
			// Currency: the cohort corroborated at or below what this node holds, so nothing is
			// ahead. Only reachable when a peer answered (a corroboration requires claims), so the
			// shared verdict resolves to `nothing-ahead` and a memo whose claimants are among those
			// answers is cleared.
			return { absence: silenceVerdict, currency: nothingAheadVerdict };
		}

		// Corroborated revision is ahead of ours — converge onto it.
		const rev = await this.restoreCorroborated(blockId, corroborated, baselineRev, peerIds);

		// Log the OUTCOME, not the attempt. Logging `synced` unconditionally reported hundreds of
		// phantom convergences per run and made a real replication defect invisible for two debugging
		// sessions.
		if (rev !== undefined) {
			this.log('cluster-fetch:synced', { blockId, rev });
		} else {
			this.log('cluster-fetch:not-restored', { blockId, localRev: baselineRev, clusterRev: corroborated.rev });
		}
		// A corroborated revision this node failed to converge onto rules nothing out, even with
		// the whole cohort answering: the reader has just been TOLD the block exists, so reporting
		// it absent would be a lie regardless of silence — that is the `claimed` verdict, and it
		// outranks whatever the silence-based mapping would have said.
		const absence: AbsenceVerdict = rev === undefined ? 'claimed' : silenceVerdict;
		// Converged means REACHED the corroborated revision, not merely advanced: a promotion that
		// landed short of it (possible in principle — restoreCorroborated only requires an advance
		// over the baseline) still leaves the served answer behind a revision the cohort attested.
		const converged = rev !== undefined && rev >= corroborated.rev;
		// The block is marked seen either way — the cohort DID answer, so its freshness was checked,
		// which is what the read-repair window tracks. A failed convergence therefore waits out the
		// window before retrying. The DOUBT it produced does not wait: `get` remembers the
		// unsettled claim (`recordAheadClaim`) and keeps stamping reads served below it while the
		// window suppresses the retry — the window damps repair effort, not honesty.
		// NOTE: that damping covers only a block this node holds at an OLDER revision. A block entirely
		// missing locally never consults the window (`get` triggers on `isMissing` before
		// `shouldReadRepair`), so a persistently failing acquisition — e.g. a two-node deployment that
		// never set `assumedClusterSize`, where the content quorum can never be met — re-fetches an
		// archive on every read of that block. Correct, and self-limiting once the cohort can agree; if
		// it ever shows as read amplification, gate the acquisition step (not the latest-query) on the
		// same window rather than widening `isMissing`.
		this.markBlocksSeen([blockId]);
		// Converged: the corroboration is itself the evidence that nothing is ahead, and it came from
		// peers that answered — the shared verdict resolves to `nothing-ahead`, and the memo retires
		// if its claimants are among those peers.
		const currency: CurrencyVerdict = converged
			? nothingAheadVerdict
			: { kind: 'unsettled-claim', rev: corroborated.rev, claimants: claimantsAtOrAbove(corroborated.rev), silent };
		return { absence, currency };
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
			// inside the callback via `saveReplicatedBlock`, which takes the block write latch —
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
			this.log('cluster-fetch:acquire-error', { blockId, rev: corroborated.rev, error: (err as Error).message });
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
	 * for a forward revision no promotion can reach used to throw out of the restore step (now
	 * `BlockStorage.restoreRevision`, driven by `StorageRepo.get`'s healing helper).
	 * It no longer does: "no committed base here" is an absence, so that read comes back as a plain
	 * unflagged `{ state: {} }` and this method simply returns `undefined` — acquisition then supplies
	 * the revision. The `unavailable` arm below still fires for the shapes that ARE a guess (a `latest`
	 * this node cannot materialize, a missing-base promotion refusal); on THIS path those are an
	 * absence too rather than a read failure, so they are logged as `promote-unavailable` and stepped
	 * over rather than short-circuiting the caller. The catch stays for any other fault, same reason.
	 */
	private async promoteCorroborated(blockId: BlockId, corroborated: ActionRev): Promise<number | undefined> {
		try {
			const entry = await this.readLocalEntry(blockId, { committed: [corroborated], rev: corroborated.rev });
			if (entry?.unavailable !== undefined) {
				this.log('cluster-fetch:promote-unavailable', { blockId, rev: corroborated.rev, error: entry.unavailable });
				return undefined;
			}
			return entry?.state?.latest?.rev;
		} catch (err) {
			this.log('cluster-fetch:promote-unavailable', { blockId, rev: corroborated.rev, error: (err as Error).message });
			return undefined;
		}
	}

	/** This node's own answer for a block, optionally driving a promotion context through the read.
	 *  Callers that care whether the answer is authoritative inspect `entry.unavailable`. */
	private async readLocalEntry(blockId: BlockId, context?: ActionContext) {
		const result = await this.storageRepo.get({ blockIds: [blockId], context });
		return result[blockId];
	}

	/** This node's own `latest.rev` for a block, optionally driving a promotion context through the read. */
	private async readLocalRev(blockId: BlockId, context?: ActionContext): Promise<number | undefined> {
		return (await this.readLocalEntry(blockId, context))?.state?.latest?.rev;
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
	 * membership — a peer minting fresh keypairs still casts a vote. A claim that arrives
	 * with a cohort commit proof is additionally VERIFIED here (`certifyClaim`,
	 * `cluster/certified-claims.ts`); when the proof holds, the claim is certified and
	 * {@link selectQuorumRev} accepts it without a second voter — the cohort's signature set
	 * is its corroboration. What a passing proof does NOT prove is that its signers are the
	 * block's responsible cohort (anyone controlling N keys can sign their own N-peer
	 * proof); anchoring the signer set to topology is the optional, observational-only
	 * {@link ProofAnchoring} layer, unwired in production today.
	 */
	private async queryClusterForLatest(peerIds: string[], blockId: BlockId, context?: ActionContext): Promise<ClusterLatestQuery> {
		// Query peers in parallel for their latest revision. Each query is DEADLINED (rejects), not
		// raced-to-undefined: a peer that blows the deadline lands in the silent set below exactly
		// like a dial failure, because a slow peer and a peer claiming "I hold nothing" must produce
		// different answers (ticket cluster-read-consult-cannot-report-unreachable).
		// NOTE: LATEST_QUERY_TIMEOUT_MS is a LAN-shaped budget. A cohort whose round trip honestly
		// exceeds it now reads as permanently silent, which is safe (the read is flagged, not
		// mis-reported) but makes every miss cost a transactor-level retry. If a WAN deployment shows
		// steady `cluster-fetch:peers-silent` against healthy peers, raise this rather than softening
		// the deadline back into an absent claim.
		const latestResults = await Promise.allSettled(
			peerIds.map(async peerIdStr => {
				const peerId = peerIdFromString(peerIdStr);
				return await withDeadline(
					this.clusterLatestCallback!(peerId, blockId, context),
					LATEST_QUERY_TIMEOUT_MS,
					`latest query to ${peerIdStr}`
				);
			})
		);

		// NOTE: self-exclusion is keyed on `localPeerId`, which is optional for the single-node/test
		// construction this class has always tolerated. Left unset, this node's own answer is counted
		// as a peer claim again. Harmless today — the self answer can only ever corroborate the
		// revision already held, so the pass declines as `local-current` — but if a future caller can
		// make self report something the reader does not hold, make `localPeerId` required instead.
		// The same unset-`localPeerId` tolerance also lets self count toward `answered` below, and
		// lets a self read that REJECTS land in `silent`: a solo repo whose own storage throws then
		// reads as an EMPTY `answered` and reports isolation ('cohort-unreachable') rather than a
		// local fault. Same fix if it ever matters — require `localPeerId`.
		// What this tolerance no longer does is let this node erase its own doubt. `answered` used
		// to be a bare count, so an unset `localPeerId` on a self-only-answering pass reached
		// "somebody answered, nothing is ahead" off this node's own answer and dropped the memo —
		// the exact erasure the marker exists to prevent. Claim PROVENANCE closes it without
		// touching the constructor: the claimant recorded is the remote peer that reported the
		// revision (never self, whose answer reads the storage being repaired, per the argument
		// above), so when that peer goes silent it is a silent claimant and the memo stands. This
		// node agreeing with itself retires nothing.
		const selfId = this.localPeerId?.toString();
		let local: CertifiedActionRev | undefined;
		const claims: RevClaim[] = [];
		const silent: string[] = [];
		// `allSettled` preserves input order, so results correlate to `peerIds` by index — a
		// rejected entry carries no payload of its own, and its peer id is what `silent` records.
		for (let i = 0; i < latestResults.length; i++) {
			const result = latestResults[i]!;
			const peerIdStr = peerIds[i]!;
			if (result.status !== 'fulfilled') {
				// Silence: the callback rejected or the deadline expired. Never a claim. Self is
				// excluded — its short-circuit reads local storage, and a local read error is not a
				// cohort peer being unreachable.
				if (peerIdStr !== selfId) silent.push(peerIdStr);
				continue;
			}
			const value = result.value;
			if (peerIdStr === selfId) {
				local = value;
				continue;
			}
			if (!value) continue; // responded, holds nothing — an absent claim, not silence
			// The proof rides along here and is verified BELOW (certifyClaim) before selection reads
			// the claim set: presence proves nothing — the peer chose what to attach — but a proof
			// that verifies certifies the claim, and a certified claim needs no second voter.
			claims.push({
				peerId: peerIdStr, rev: value.rev, actionId: value.actionId,
				...(value.proof ? { proof: value.proof } : {})
			});
		}
		if (silent.length > 0) {
			this.log('cluster-fetch:peers-silent', { blockId, silent: silent.length, consulted: peerIds.length });
		}

		// Verify every attached proof, in parallel, BEFORE selection — and penalize provable proof
		// misbehavior HERE, at verification time, independent of what selection later does with the
		// claim. Only attributable failures (isAttributableProofFailure) are penalized: a failure
		// whose signer identities were never proven — unknown/non-ed25519 signer, malformed
		// signature or proof, a legacy record, the oversized-cohort cap — could have been authored
		// by anyone in the chain, and penalizing on it would let an attacker frame a peer (the same
		// discipline as VerifyOutcome.penalize in cluster-repo.ts). A claim whose proof fails stays
		// in the claim set UNCERTIFIED: it still corroborates by distinct-peer count exactly as a
		// proof-less claim does — a peer that could fabricate a bad proof could equally have sent no
		// proof, so dropping the vote would buy nothing.
		// NOTE: cost is one verification pass per proof-carrying answer per consult, each bounded by
		// MAX_PROOF_SIGNERS (256) signature checks. In `lazy` mode consults are rate-limited by the
		// read-repair window; in `paranoid` mode every read of every block pays cohort-width
		// verifications. Fine at deployment cohort sizes (~10) — if paranoid readers ever show CPU
		// time in `certifyClaim`, cache verdicts per (blockId, rev, actionId, proof hash) rather than
		// skipping verification.
		await Promise.all(claims.map(async claim => {
			if (!claim.proof) return;
			const verdict = await certifyClaim(
				claim.proof,
				{ blockId, rev: claim.rev, actionId: claim.actionId },
				// Shared with the reconcile path, so the two cannot drift on what the members actually
				// enforced — see `proofThresholds` for why the simple-majority term is not
				// this.simpleMajorityThreshold.
				proofThresholds(this.superMajorityThreshold),
				this.proofAnchoring
			);
			if (verdict.certified) {
				claim.certified = true;
				// The verdict's signer count, never proof.peerIds read here — selection weighs a
				// single-signer certification below multi-peer corroboration (quorum-restore.ts).
				claim.certifiedSignerCount = verdict.signerCount;
				return;
			}
			this.log('cluster-fetch:proof-uncertified', {
				blockId, peerId: claim.peerId, rev: claim.rev, failure: verdict.failure
			});
			if (isAttributableProofFailure(verdict.failure)) {
				this.penalizeProofService(claim.peerId, blockId);
			}
		}));

		const nonSelfCount = peerIds.filter(id => id !== selfId).length;
		// Identities, not a count: the caller matches a memo's recorded claimants against who spoke
		// this pass. `answered` and `silent` partition the non-self cohort view, so the old
		// `nonSelfCount - silent.length` is exactly `answered.length`.
		const answered = peerIds.filter(id => id !== selfId && !silent.includes(id));
		const capacity = corroboratorCapacity(nonSelfCount, this.repairCorroborationClusterSize);
		const required = quorumSize(claims.length, this.simpleMajorityThreshold, capacity);
		const selected = selectQuorumRev(claims, this.simpleMajorityThreshold, capacity);
		if (!selected) {
			// A decline can be the certified path REFUSING to pick a side: two distinct actions each
			// carrying a verified cohort proof for the same top revision. Name that apart from the
			// routine no-quorum — the cohort (or whoever holds its keys) provably signed both sides,
			// an incident rather than a shortage of answers. Neither claimant is penalized: both
			// proofs verified, so which side is "wrong" is exactly what this node cannot know.
			const equivocation = certifiedEquivocation(claims);
			if (equivocation) {
				this.log('cluster-fetch:certified-equivocation', {
					blockId, rev: equivocation.rev, actionIds: equivocation.actionIds
				});
			}
			// The three populations are reported SEPARATELY, never rolled into one "responders" count:
			// "1 of 2 responded" and "1 holder, 1 confirmed non-holder, 0 silent" call for completely
			// different operator actions — the first says wait or fix reachability, the second says the
			// block has only one copy and no amount of waiting produces a second.
			this.log('cluster-fetch:no-quorum', {
				blockId,
				cohortPeers: nonSelfCount,
				holders: claims.length,
				absent: answered.length - claims.length,
				silent: silent.length,
				required,
				repairCorroborationClusterSize: this.repairCorroborationClusterSize
			});
			// ...and, when this decline is provably permanent rather than transient, say THAT once,
			// in words — and return the verdict, which the caller acts on EVERY pass (arming the
			// read-repair window on `cohort-too-small`; see fetchBlockFromCluster). The `no-quorum`
			// line above fires on every pass and cannot tell the two apart.
			const deadlock = this.reportRepairDeadlock({
				blockId, claims, silentCount: silent.length, cohortPeers: nonSelfCount, answered: answered.length, required, capacity
			});
			// The claims themselves must not drive restoration — but their existence is
			// evidence the caller needs: an answer served below the highest claim cannot be
			// confirmed current (see ClusterLatestQuery.uncorroboratedRev).
			// NOTE: ONE claim is enough to raise that doubt, and the claims reaching this branch
			// are unverified assertions — a certified claim converges above instead of declining
			// (the only certified shape that lands here is the equivocation decline). So a single
			// lying cohort peer can deny unpinned reads of a block by claiming a revision nobody
			// else holds — an availability lever it did not have while uncorroborated claims were
			// discarded. Deliberate for now: the alternative is the silent stale serve this marker
			// exists to end, and the same liar can already force a silent-treated absence by
			// staying quiet. If the lever is ever exercised, gate the stamp on a certified claim
			// (the verification machinery now exists) rather than on the bare assertion — at the
			// cost of re-opening the stale-serve window for the proof-less honest majority.
			const uncorroboratedRev = claims.length > 0 ? Math.max(...claims.map(c => c.rev)) : undefined;
			return {
				local, silent, answered, claims,
				...(uncorroboratedRev !== undefined ? { uncorroboratedRev } : {}),
				...(deadlock !== undefined ? { deadlock } : {})
			};
		}

		if (selected.certified) {
			// Which rule won matters when reading a repair log: a certified selection may rest on a
			// SINGLE claimant whose corroboration is the cohort's signature set, not other voters.
			this.log('cluster-fetch:certified-selected', {
				blockId, rev: selected.rev, claimants: selected.supporters.length
			});
		}

		// Best-effort: penalize peers whose claim contradicts a CORROBORATED selection — a different
		// action at the very same revision. A higher rev may be honest leadership and a lower rev is
		// just lag; neither is penalized, nor is anything contradicting a certified-only selection
		// (an unanchored proof must not be able to convict the honest cohort). Never let this throw.
		this.penalizeContradictingRevClaims(claims, selected, blockId);

		return {
			corroborated: { actionId: selected.actionId, rev: selected.rev },
			// The supporters used to be dropped on the floor here, leaving "how many peers this
			// currency judgment rests on" underivable downstream — see ClusterLatestQuery.corroboration.
			corroboration: {
				voters: selected.supporters.length,
				...(selected.certified ? { certified: true as const } : {})
			},
			local, silent, answered, claims
		};
	}

	/**
	 * Say ONCE per block, in words, when a corroboration decline is provably PERMANENT rather than a
	 * transient shortage of answers — and RETURN the verdict, computed fresh on every pass by
	 * {@link classifyRepairDeadlock} (the pure half; the say-once suppression below applies only to
	 * the log line). The caller acts on the returned reason every pass: `fetchBlockFromCluster` arms
	 * the lazy read-repair window on `cohort-too-small`, because a decline the cohort provably cannot
	 * escape teaches nothing when repeated sooner than one window. There are exactly TWO permanent
	 * shapes, and they send the operator to different places, so each gets its own `reason` and its
	 * own wording:
	 *
	 *  - `cohort-too-small` — this node's cohort has fewer peers than the quorum would demand even if
	 *    every one of them answered and agreed. The remedy is machines or an honest declared size.
	 *  - `sole-holder` — the cohort is big enough, but exactly ONE of its peers holds the block at all
	 *    and every other peer answered that it holds nothing. The remedy is another cohort peer
	 *    holding the block; machines and configuration are both irrelevant. Note the scope: this node's
	 *    own copy is excluded from the claim set, so a reader that holds the block itself still sees
	 *    `sole-holder` — the message says "cohort peer", never "machine in the deployment".
	 *
	 * **What makes `cohort-too-small` provable.** Not "this pass fell short" — a pass falls short
	 * whenever some peer simply does not hold the block *yet*. The decisive question is whether the
	 * cohort could supply the quorum AT ALL: ask what would be required if every cohort peer answered
	 * and agreed — the best case any later pass can reach without new machines — and compare it to how
	 * many peers the cohort has. Short of that best case the shortfall is not the machine count, and
	 * saying PERMANENT would send the operator to change a number that was never the problem. Twelve
	 * days of log archaeology went into re-deriving the real condition from a thousand identical
	 * `cluster-fetch:no-quorum` lines; the node knows it at the moment of each decline.
	 *
	 * **What makes `sole-holder` provable.** Note it is only reachable for a lone UNCERTIFIED holder:
	 * a lone holder whose cohort commit proof verified is selected by the certified path and converges
	 * before any decline — so the wording's "a lone holder cannot second itself" stays accurate for
	 * every claim that gets here. "That peer will hold it later" is an assumption, and for a
	 * peer that ANSWERED "I hold nothing" it is false: the only two mechanisms that would turn a
	 * non-holder into a holder — `queryClusterForLatest` (read-repair) and `createReconcileBlock`
	 * (reconcile) — consume this very decision, so they decline for exactly the same reason on that
	 * peer. Every peer answered, one holds the block, the rest hold nothing, and no later pass changes
	 * any of that. What DOES change it is a new copy: a commit that writes the block again pushes it to
	 * the current cohort. (Sibling work `replicate-owned-blocks-when-the-cohort-grows` makes that
	 * automatic; until it lands the operator has to cause the write.)
	 *
	 * **What is deliberately NOT reported.** A cohort that answers unanimously "I hold nothing" — an
	 * agreed absence is an answer, not a failed repair. A pass with any silent peer: silence cannot
	 * change the arithmetic (`cohortPeers` counts silent peers too), but it does mean this node saw less
	 * than the whole picture, and the next clean pass says the same thing at no cost. Note there is
	 * deliberately NO "the claims disagreed" exemption for `cohort-too-small`: a cohort too small to
	 * reach quorum stays too small whether its peers agree or not, so disagreement would suppress a line
	 * that is still true. Two or more disagreeing holders DO suppress `sole-holder`, because that is a
	 * cohort with two copies whose peers have not settled yet — a later pass can settle it.
	 *
	 * **Never a lever.** This only classifies and logs; it never relaxes a floor. Which is also why the
	 * `cohort-too-small` message names *two* readings of the same numbers — a deployment that genuinely
	 * runs this few machines, or a cohort view shrunk below the real deployment by a partition or by an
	 * attacker with routing influence. `corroboratorCapacity` keeps the shrunken view out of the relaxed
	 * branch, but this node cannot tell the two apart from the inside, and an operator sent to fix the
	 * wrong one is the failure this line exists to end.
	 *
	 * NOTE: the reader is still told only "this may be stale" — `BlockPossiblyStaleError` implies a
	 * retry might help, which is wrong advice for a block whose repair is deadlocked as configured.
	 * Carrying this condition into the error needs a new field on `GetBlockResult` plus a change to
	 * that error's documented contract; deliberately out of scope here (see the ticket
	 * `repair-deadlock-is-never-named`, *Not this ticket*).
	 */
	private reportRepairDeadlock(pass: {
		blockId: BlockId;
		claims: RevClaim[];
		silentCount: number;
		/** Cohort peers besides this node, from the cohort view — whether they answered or not. */
		cohortPeers: number;
		answered: number;
		/** The quorum THIS pass demanded, computed from the peers that actually claimed. */
		required: number;
		/** `corroboratorCapacity` for this pass — a function of the view and the resolved size, not of who answered. */
		capacity: number;
	}): DeadlockReason | undefined {
		const { blockId, claims, cohortPeers, answered, required, capacity } = pass;
		const reason = this.classifyRepairDeadlock(pass);
		if (reason === undefined) return undefined;
		// From here down is LOGGING only, under the once-per-episode suppression. The verdict above
		// is returned regardless: the caller arms the read-repair window off it on every qualifying
		// pass (a window that expired must re-arm), and letting the say-once flag swallow the verdict
		// would arm exactly once per episode — one quiet window, then the re-ask-forever loop back.
		const requiredEvenIfAllAnswered = quorumSize(cohortPeers, this.simpleMajorityThreshold, capacity);
		const state = this.unsettledAheadClaims.get(blockId);
		const alreadySaid = state?.deadlocksReported ?? [];
		// Suppressed per REASON, not once outright: an episode that starts as `cohort-too-small` and
		// becomes `sole-holder` — the operator added the machines that reason asked for, and the block
		// is still stuck — has a second thing to say, and a silent log there is the failure this line
		// exists to end. Neither reason repeats within an episode.
		if (alreadySaid.includes(reason)) return reason;

		this.log('cluster-fetch:repair-deadlock', {
			blockId,
			reason,
			cohortPeers,
			answered,
			claimants: claims.length,
			required,
			requiredEvenIfAllAnswered,
			repairCorroborationClusterSize: this.repairCorroborationClusterSize,
			message: reason === 'cohort-too-small'
				? cohortTooSmallMessage(cohortPeers, claims.length, requiredEvenIfAllAnswered, this.repairCorroborationClusterSize)
				: soleHolderMessage(cohortPeers)
		});
		// Hung off the existing per-block freshness entry rather than a fourth per-block map. The entry
		// survives `recordAheadClaim` clearing its `rev`, and is dropped wholesale once the block
		// converges — so each reason is said once per non-convergence episode, not once per pass.
		// NOTE: per BLOCK, though the condition is a property of the cohort, not of any block — so a node
		// in this state that reads N distinct blocks emits N lines. Deliberate: the operator wants to
		// know which blocks are stuck, and N is bounded by blocks actually read (1821 lines for a single
		// block was the defect). If a deployment in this state ever makes this the noisy line again, add
		// a node-level once-flag keyed on (cohortPeers, requiredEvenIfAllAnswered) and let the per-block
		// entry only suppress repeats.
		this.unsettledAheadClaims.set(blockId, { ...(state ?? {}), deadlocksReported: [...alreadySaid, reason] });
		return reason;
	}

	/**
	 * The PURE half of {@link reportRepairDeadlock}: classify one declining pass as provably
	 * permanent (`cohort-too-small` / `sole-holder`) or not (`undefined`), with no logging and no
	 * state. Split out so the verdict can run on EVERY pass — the caller in
	 * `fetchBlockFromCluster` arms the lazy read-repair window off `cohort-too-small` each time,
	 * and the window has to re-arm after it expires — while the log line keeps its once-per-episode
	 * suppression. Before the split the verdict was computed for the log line and thrown away,
	 * which is what left an undeclared two-machine cohort re-running the provably hopeless consult
	 * on every read (measured: 6 peer queries across three reads inside one 10 s window, versus 0
	 * with the size declared).
	 *
	 * The guards are part of the VERDICT, not merely of the logging — the arming consumer depends
	 * on both:
	 *  - a pass with ANY silent peer proves nothing (an incomplete picture — the silent peer could
	 *    recover, so re-asking can learn; and permanent claims are not made off partial views);
	 *  - a pass with ZERO claims is an agreed absence — an answer, not a deadlock.
	 */
	private classifyRepairDeadlock(pass: {
		claims: RevClaim[];
		silentCount: number;
		/** Cohort peers besides this node, from the cohort view — whether they answered or not. */
		cohortPeers: number;
		answered: number;
		/** `corroboratorCapacity` for this pass — a function of the view and the resolved size, not of who answered. */
		capacity: number;
	}): DeadlockReason | undefined {
		const { claims, silentCount, cohortPeers, answered, capacity } = pass;
		// An incomplete picture proves nothing about the deployment; the next clean pass says it.
		if (silentCount > 0) return undefined;
		// Nobody claimed anything: the cohort agrees the block is absent, which is an answer, not a
		// deadlock.
		if (claims.length === 0) return undefined;
		// The decisive test for the first shape. `requiredEvenIfAllAnswered` is the quorum this cohort
		// would face with every one of its peers answering and agreeing — the best case reachable
		// without adding machines. A cohort that can meet it is not too small.
		const requiredEvenIfAllAnswered = quorumSize(cohortPeers, this.simpleMajorityThreshold, capacity);
		const cohortTooSmall = cohortPeers < requiredEvenIfAllAnswered;
		// The second shape: exactly one cohort peer holds the block AT ALL, and — since a claim is one
		// peer's latest, so a single claim is a single distinct (rev, actionId) group with a single
		// supporter — every other cohort peer answered that it holds nothing. `answered === cohortPeers`
		// is already implied by the silence guard above; it is stated because the two counts arrive as
		// independent parameters and "everybody answered" is half of what makes this provable.
		//
		// NOTE: there is a narrow window where `sole-holder` is true of the instant but not of the
		// deployment — a commit that has landed on one cohort member and has not yet been pushed to the
		// rest presents exactly this shape. Calling it PERMANENT is defensible even there (repair
		// genuinely cannot converge until the push lands, and the once-per-episode flag clears the
		// moment the block converges, so the line does not repeat), and widening the window is what the
		// push path's own threat model decides — see
		// `tickets/blocked/repair-floor-defends-a-door-the-push-path-leaves-open`. If commit-to-push
		// latency ever grows enough that operators see `sole-holder` on blocks that heal moments later,
		// gate the line on the block having been quiet for longer than that latency rather than
		// softening the wording. (`sole-holder` never arms the read-repair window — the missing thing
		// is a COPY, which the cohort-growth push or the next commit can deliver at any moment, so
		// re-asking can genuinely learn.)
		const soleHolder = claims.length === 1 && answered === cohortPeers;
		if (!cohortTooSmall && !soleHolder) return undefined;

		// Both shapes can hold at once (an undeclared two-machine deployment whose single peer holds the
		// block is both). `cohort-too-small` is reported in preference because its remedy is the one
		// that actually works there: declaring the real size makes the floor reachable, after which the
		// lone peer's claim IS adopted — so calling it a sole-holder problem would send the operator
		// looking for a copy they do not need.
		return cohortTooSmall ? 'cohort-too-small' : 'sole-holder';
	}

	/**
	 * Report peers whose reported latest PROVABLY contradicts a CORROBORATED selection: the same
	 * revision under a different actionId. Two actions cannot both be the commit at one revision,
	 * and the pair a quorum of distinct peers agreed on is the one this node can stand behind, so
	 * the disagreeing claimant is wrong. Best-effort.
	 *
	 * A CERTIFIED selection is deliberately excluded — no claim is penalized against it. A passing
	 * proof shows the cohort it names signed the commit, never that those signers are the block's
	 * responsible cohort: anyone holding N keys can mint a proof that verifies (see caller
	 * obligation #1 in `cluster/commit-proof.ts`, and the unwired {@link ProofAnchoring} layer).
	 * Penalizing here would therefore hand one forged proof a lever it must not have — every honest
	 * peer holding the real action at that revision reported for InvalidRestoration (weight 30,
	 * above the deprioritize threshold of 20), on every consult. Losing the selection to the proof
	 * is already the accepted cost of the certified path; deprioritizing the honest cohort on top of
	 * it is not. Revisit when certification is anchored to the block's derived cohort
	 * (`feat-cluster-membership-threshold-cert-anchoring`): a gated proof makes the contradiction
	 * provable again.
	 *
	 * A claim at a HIGHER rev than the selection is deliberately NOT penalized: a peer can honestly
	 * be ahead of the sampled quorum — an in-flight commit it durably stored before the rest of the
	 * cohort, or other honest holders dropped from the sample by the 1s per-peer consult deadline —
	 * and the InvalidRestoration weight (30) sits above the deprioritize threshold (20), so a single
	 * false hit used to deprioritize an honest, up-to-date peer. Declining to RESTORE from the
	 * uncorroborated higher claim already happens in selection; the affirmative penalty on that
	 * ambiguous evidence is what this method no longer applies. Provably-bad proof SERVICE is
	 * penalized at verification time instead (the certifyClaim pass in
	 * {@link queryClusterForLatest}).
	 */
	private penalizeContradictingRevClaims(claims: RevClaim[], selected: QuorumRev, blockId: BlockId): void {
		if (!this.reputation || selected.certified) return;
		try {
			for (const c of claims) {
				// A CERTIFIED disagreeing claim is exempt: its proof verified, so the peer honestly
				// served a commit that really happened — when multi-peer corroboration outweighs its
				// single-signer proof at the same rev (quorum-restore.ts), that peer is a partition
				// casualty on the losing side of a fork, not a liar. Provably-bad proof SERVICE was
				// already penalized at verification time above.
				if (c.certified === true) continue;
				if (c.rev === selected.rev && c.actionId !== selected.actionId) {
					this.reputation.reportPeer(c.peerId, PenaltyReason.InvalidRestoration, `read-repair:${blockId}`);
				}
			}
		} catch (err) {
			this.log('cluster-fetch:penalize-error', { blockId, error: (err as Error).message });
		}
	}

	/**
	 * Best-effort penalty for a peer whose SERVED PROOF provably lies or provably does not cover the
	 * claim it was attached to (see the attributability classification in
	 * `cluster/certified-claims.ts`). Never throws — mirrors
	 * {@link penalizeContradictingRevClaims}.
	 */
	private penalizeProofService(peerId: string, blockId: BlockId): void {
		if (!this.reputation) return;
		try {
			this.reputation.reportPeer(peerId, PenaltyReason.InvalidRestoration, `read-repair:${blockId}`);
		} catch (err) {
			this.log('cluster-fetch:penalize-error', { blockId, error: (err as Error).message });
		}
	}

	async pend(request: PendRequest, options?: MessageOptions): Promise<PendResult> {
		const allBlockIds = blockIdsForTransforms(request.transforms);
		await this.verifyResponsibility(allBlockIds);
		const result = await this.pendThroughCluster(request, allBlockIds, options);
		// A pend the blocks ACCEPTED is the proof that no reservation is holding them any more — the
		// only such proof this node gets without asking a question it has no reason to ask.
		// Scope, honestly: this is NOT what re-arms the line for a later wedge. The holder comparison
		// in `noteStuckReservation` already does that on its own, and every real holder set is new,
		// since an action id is 16 random bytes minted per sync cycle (`Collection.syncInternal`). What
		// forgetting buys is that a settled episode stops occupying an LRU slot it can only use to
		// evict a live one — plus defence in depth if an action id ever does repeat.
		if (result.success) this.clearStuckReservations(allBlockIds);
		return result;
	}

	/** The cluster half of {@link pend}, after responsibility is verified: consensus, the local-verdict
	 *  arms, and the two optimistic-concurrency classifiers a rejection is run through. */
	private async pendThroughCluster(request: PendRequest, allBlockIds: BlockId[], options?: MessageOptions): Promise<PendResult> {
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
			const { localExecuted, localPendResult } = await this.coordinator.executeClusterTransaction(coordinatingBlockIds[0]!, message, options);
			this.log('coordinator-repo:pend-cluster-complete', {
				actionId: request.actionId,
				localExecuted,
				localVerdict: localPendResult === undefined ? 'none'
					: localPendResult.success ? 'success'
						: isConflictFailure(localPendResult) ? 'conflict' : 'fault'
			});
			// Only call storageRepo if local cluster didn't already execute during consensus
			if (!localExecuted) {
				const result = await this.storageRepo.pend(request, options);
				this.log('coordinator-repo:pend-fallback-result', {
					actionId: request.actionId,
					success: result.success,
					hasMissing: !!(result as any).missing?.length,
					hasPending: !!(result as any).pending?.length
				});
				return result;
			}
			// Local cluster already executed during consensus — return storage's own verdict rather
			// than fabricating a success (the peerCount <= 1 path above returns storage's real result
			// verbatim; the cluster path must never answer differently). Pend-consensus confers no
			// durability: a refusal carrying `pending` (a rival's unresolved action holds the blocks)
			// or `missing` (the requested revision is already committed) is the optimistic-concurrency
			// verdict — the same scan every member runs, not a local fault — and must reach the writer
			// as a retryable conflict so NetworkTransactor.pendPhase cancels the partial pend and the
			// writer rebases. This deliberately differs from `commit`'s divergence split below: a
			// commit that reached commit-consensus IS the authoritative commit (Theorem 9), whereas a
			// pend that reached pend-consensus may still have been stored by nobody.
			if (localPendResult !== undefined) {
				if (localPendResult.success || isConflictFailure(localPendResult)) {
					return localPendResult;
				}
				// A bare-reason refusal (no pending/missing — e.g. a local validation-hook fault)
				// stays tolerated local divergence: consensus is authoritative and the pend may well
				// have landed on the rest of the cohort.
				this.log('coordinator-repo:pend-local-fault-tolerated', {
					actionId: request.actionId,
					reason: localPendResult.reason
				});
			}
			// No verdict retained (member predates retention, restart, or TTL): the prior shape.
			return {
				success: true,
				pending: [],
				blockIds: allBlockIds
			};
		} catch (error) {
			this.log('coordinator-repo:pend-error', { actionId: request.actionId, error: (error as Error).message });
			// A lost conflict race is an optimistic-concurrency loss, not a fault: surface it as the
			// StaleFailure shape the retry machinery already understands (`Collection.sync` and the
			// multi-collection pendPhase retry it via `isConflictFailure`), exactly as a confirmed
			// stale revision is. `staleAt` stays absent deliberately — it is confirmed-only, and a
			// lost race is a rival *pend* holding the blocks, not a revision claim.
			//
			// NOTE: `error.conflicts` (peerId → winning messageHash) is dropped here — `StaleFailure`
			// has no field for it and the retry loop only needs "retryable". If a caller ever needs to
			// know WHICH transaction won (e.g. to wait on it rather than re-race it), add a typed field
			// for it; never recover it by parsing `reason`.
			//
			// NOTE: with three or more contenders the members can split so that EVERY contender is
			// told it lost the race — an all-lose round where nobody wins and each writer retries.
			// The cause is `ClusterMember.resolveRace`'s approvals-first rule, not its tie-break:
			// each member compares the rivals as IT holds them, so a member that already approved X
			// keeps X while a member that approved Y first keeps Y, and no rival reaches a promise
			// supermajority. (The hash tie-break is already symmetric — it cannot be the fix.)
			// Fine as it stands: since the torn-action fixes landed, an all-lose round costs one
			// retry cycle rather than wedging, and the contenders are separated next round by the
			// jittered backoff plus the aged retry priority carried on the re-pend
			// (`clampPriority(consecutiveFailures)` in `Collection.syncInternal`), which out-ranks
			// fresh priority-0 rivals at EQUAL approval counts — priority sits below the approval
			// count in `resolveRace`, so it does not displace a more-progressed rival. If a
			// high-contention workload ever shows syncs exhausting `maxAttempts` on repeated
			// all-lose rounds, the fix is reserve/defer at pend time (backlog
			// `feat-occ-priority-reservation`, which `resolveRace`'s own residual-fairness NOTE
			// already points at) rather than raising maxAttempts.
			if (error instanceof ConflictRaceLostError) {
				return { success: false, conflict: true, reason: error.message };
			}
			const stale = await this.classifyStaleRejection(error, request, allBlockIds)
				?? await this.classifyPendingConflictRejection(error, request, allBlockIds);
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
		const requestedRev = request.rev;
		if (!(error instanceof ValidatorRejectionError) || requestedRev === undefined) return undefined;
		let results: GetBlockResults;
		try {
			results = await this.storageRepo.get({ blockIds });
		} catch (readError) {
			this.log('coordinator-repo:pend-stale-classify-read-error', {
				actionId: request.actionId,
				error: (readError as Error).message
			});
			return undefined;
		}
		// Scan EVERY block rather than stopping at the first confirmation: several of the request's
		// blocks can be past the requested revision at different revisions, and it is the highest
		// that the loser's next request has to clear (see `highestStaleAt`). Both the reported
		// number and the reason prose name that block, so they never disagree.
		const staleAt = highestStaleAt(blockIds.map(blockId => {
			const latest = results[blockId]?.state.latest;
			if (!latest || latest.rev < requestedRev) return undefined;
			// Per-block self-exclusion (see {@link isOwnRevision}): our own durable half of a torn
			// action is not a confirmed loss. Deliberately per-block, NOT the bail-entirely
			// 'own-durable' shape of confirmCommitRivalAgainstLocal — a confirmed rival on ANOTHER
			// block still confirms, and when none is confirmed anywhere the rejection stays a throw
			// exactly as before. With the two pend-tier sites upstream fixed (StorageRepo.pend and
			// ClusterMember.validatePendOperations) this shape should not reach here; mirrored so
			// all three pend-tier checks agree.
			if (isOwnRevision(latest, requestedRev, request.actionId)) return undefined;
			return { blockId, rev: latest.rev };
		}));
		if (staleAt) {
			this.log('coordinator-repo:pend-stale-classified', {
				actionId: request.actionId,
				blockId: staleAt.blockId,
				latestRev: staleAt.rev,
				requestedRev
			});
			return {
				success: false,
				conflict: true,
				reason: `stale revision: block ${staleAt.blockId} at rev ${staleAt.rev}, requested rev ${requestedRev}`,
				// The same fact as the reason prose, but as data. This is the ONLY place a losing
				// writer can learn the revision it lost to, since this failure deliberately carries
				// no `missing`. Confirmed-local: read out of our own storage just above.
				staleAt
			};
		}
		// NOTE: conservative — when only remote members saw the newer revision (local storage still
		// behind), staleness can't be confirmed locally and the rejection stays a throw. If that
		// shows up in practice, extend confirmation with a quorum read; never trust the reject text.
		// `staleAt` is absent on this path for the same reason, and deliberately so — there is no
		// confirmed number to report, and the field's contract forbids inferring one from that text.
		return undefined;
	}

	/**
	 * Sibling of {@link classifyStaleRejection} for the OTHER optimistic-concurrency refusal shape:
	 * the promise-phase pending-conflict vote (`validatePendOperations` rejecting a pend whose
	 * blocks are held by a different unresolved pending action). That vote surfaces here as a
	 * {@link ValidatorRejectionError}, and without classification it would escape as a throw —
	 * splitting multi-tree pends mid-batch instead of taking the retry path a lost race deserves.
	 *
	 * Same confirmation discipline as the stale classifier: purely local. Re-read the affected
	 * blocks from our own storage and require some block's `state.pendings` to carry a rival
	 * actionId; the signed reject text is never consulted. A confirmed rival returns a
	 * {@link StaleFailure} with `conflict: true` and the rivals as `pending` (`ActionPending`
	 * without `transform` — the type allows it, and no consumer rebases from it). Unconfirmed —
	 * including read errors during confirmation — stays a throw, preserving fail-fast for genuine
	 * validation faults. Checked after `classifyStaleRejection` so a confirmed committed loss
	 * (which carries the sharper `staleAt`) wins when both hold.
	 */
	private async classifyPendingConflictRejection(error: unknown, request: PendRequest, blockIds: BlockId[]): Promise<StaleFailure | undefined> {
		if (!(error instanceof ValidatorRejectionError)) return undefined;
		let results: GetBlockResults;
		try {
			results = await this.storageRepo.get({ blockIds });
		} catch (readError) {
			this.log('coordinator-repo:pend-conflict-classify-read-error', {
				actionId: request.actionId,
				error: (readError as Error).message
			});
			return undefined;
		}
		const pending: ActionPending[] = [];
		for (const blockId of blockIds) {
			for (const actionId of results[blockId]?.state?.pendings ?? []) {
				if (actionId !== request.actionId) pending.push({ blockId, actionId });
			}
		}
		if (pending.length === 0) return undefined;
		// Counted as its own statement, never inside the log payload below: this call is the detection
		// mechanism, not a formatting step, and payload expressions in this repo are fair game to wrap
		// in an `enabled` gate (`Collection.advanceContext` does exactly that). A gate added there
		// later would silently stop the counter and with it `coordinator-repo:stuck-reservation`.
		// {@link reportRepairDeadlock} keeps its say-once bookkeeping outside its own log call for the
		// same reason.
		const distinctRefusedActions = this.noteStuckReservation(pending, request.actionId);
		this.log('coordinator-repo:pend-conflict-classified', {
			actionId: request.actionId,
			rivals: pending.map(p => `${p.blockId}:${p.actionId}`),
			// How many distinct actions the most-refusing of this request's holders has now turned away
			// (see {@link noteStuckReservation}). Carried on every classification, not just the stuck
			// ones, so a healthy contended deployment's real figure is readable from its own logs rather
			// than assumed — which is what calibrates STUCK_RESERVATION_DISTINCT_ACTIONS.
			distinctRefusedActions
		});
		return {
			success: false,
			conflict: true,
			pending,
			reason: `pending conflict: block(s) held by unresolved rival action(s) ${[...new Set(pending.map(p => p.actionId))].join(', ')}`
		};
	}

	/**
	 * Count one confirmed pending-conflict refusal against the holder(s) of each block it names, and say
	 * ONCE — in words, at the moment it becomes provable — when a block is wedged behind a reservation
	 * that is not going to clear.
	 *
	 * **Why this needs saying at all.** Every individual refusal here is indistinguishable from an
	 * ordinary lost race, which is a normal and healthy event, so the logs of a permanently wedged block
	 * read exactly like the logs of a busy one. Finding the difference today means noticing that the
	 * SAME rival action id keeps appearing across unrelated writers for as long as the process lives —
	 * a pattern nothing points at, and one that cost a downstream project several tickets and weeks to
	 * re-derive from raw traces. The node has the fact in hand at every refusal; this makes it sayable.
	 *
	 * **The signal, and the two things that are NOT the signal.** The discriminator is repetition
	 * against an unchanged holder — see {@link STUCK_RESERVATION_DISTINCT_ACTIONS} for why distinct
	 * refused actions is the right counter and for the measured threshold. Two cheaper-looking tests
	 * were tried and do not work: the members' in-memory reservation table
	 * (`ClusterMember.activeTransactions`) clears the moment a rival's pend reaches consensus, so a
	 * perfectly healthy rival inside its pend-to-commit window is absent from it too and absence there
	 * says nothing; and "the block already passed this pending record's revision" catches a different
	 * orphan class entirely — in the verified instance the wedged block sat at revision 1 while the
	 * orphaned record was for revision 2, still nominally promotable.
	 *
	 * **Never a control path.** This classifies and logs; it never refuses, expires, or deletes
	 * anything. Deciding when a durable pending record may be removed is precisely the hard problem
	 * backlog `debt-unpromotable-pending-records-need-a-sweep` exists for — deleting a live reservation
	 * is worse than the leak — and a counter accurate enough for a log line is not evidence enough to
	 * destroy state.
	 *
	 * Returns the highest distinct-refusal count any of this refusal's blocks has now reached, for the
	 * classification line to carry; it saturates at the threshold once an episode has been reported,
	 * since the ids are dropped at that point.
	 *
	 * NOTE: fed only by {@link classifyPendingConflictRejection}, i.e. by refusals that arrive as a
	 * cohort-wide validator rejection. A block only PART of whose cohort holds the stranded record can
	 * still reach approval super-majority, and its refusal then comes back through the retained local
	 * apply verdict (`getExecutedPendResult`) instead, which this never sees — so a partially wedged
	 * block goes unnamed. That is the weaker condition (the write does land on the healthy members),
	 * and instrumenting the second path would count a refusal that the cohort as a whole did not make.
	 * If partial strands ever turn out to be the common shape in the field, the counter belongs on the
	 * member side (`ClusterMember.validatePendOperations`), where each member sees its own votes.
	 */
	private noteStuckReservation(pending: ActionPending[], refusedActionId: ActionId): number {
		const rivalsByBlock = new Map<BlockId, ActionId[]>();
		for (const { blockId, actionId } of pending) {
			const rivals = rivalsByBlock.get(blockId);
			if (rivals) rivals.push(actionId);
			else rivalsByBlock.set(blockId, [actionId]);
		}
		let highest = 0;
		for (const [blockId, rivals] of rivalsByBlock) {
			const holders = [...new Set(rivals)].sort();
			const prior = this.stuckReservations.get(blockId);
			// A different holder set is a DIFFERENT episode — the block changed hands, which is the
			// healthy cycle — so the count starts over and the new holder gets its own chance to speak.
			const watch: StuckReservationWatch = prior !== undefined && sameHolders(prior.holders, holders)
				? prior
				: { holders, refused: new Set<ActionId>(), reported: false };
			if (watch !== prior) this.stuckReservations.set(blockId, watch);
			if (watch.reported) {
				highest = Math.max(highest, STUCK_RESERVATION_DISTINCT_ACTIONS);
				continue;
			}
			watch.refused.add(refusedActionId);
			highest = Math.max(highest, watch.refused.size);
			if (watch.refused.size < STUCK_RESERVATION_DISTINCT_ACTIONS) continue;
			this.log('coordinator-repo:stuck-reservation', {
				blockId,
				// The ids an operator needs to grep for and to cancel, kept as data beside the prose so a
				// log search finds the block and the action without parsing English.
				holdingActionIds: holders,
				distinctRefusedActions: watch.refused.size,
				message: stuckReservationMessage(holders, watch.refused.size)
			});
			watch.reported = true;
			// Said once per episode: from here the flag alone suppresses, and the ids have done their
			// work (their count is in the line above), so drop them rather than growing a set for the
			// unbounded remainder of a permanent condition.
			watch.refused.clear();
		}
		return highest;
	}

	/**
	 * Forget any stuck-reservation episode recorded for these blocks, optionally only when
	 * `holderActionId` is one of the actions that episode named.
	 *
	 * Called from the two events the message itself names as the only cures: a write the block accepted
	 * ({@link pend}), and a cancel for the holding action ({@link cancel}). Forgetting is the whole
	 * effect, and it is LRU hygiene rather than behaviour: a later wedge is named by a DIFFERENT holder,
	 * which `noteStuckReservation`'s holder comparison already treats as a new episode whether the old
	 * entry is still there or not. Both call sites therefore have no observable effect through the
	 * public surface (no spec can distinguish them — reproducing a repeated holder set would mean
	 * reusing an action id, which nothing that mints them does), and both are kept because a settled
	 * episode holding an LRU slot can only evict a live one.
	 */
	private clearStuckReservations(blockIds: BlockId[], holderActionId?: ActionId): void {
		for (const blockId of blockIds) {
			if (holderActionId !== undefined && !this.stuckReservations.peek(blockId)?.holders.includes(holderActionId)) continue;
			this.stuckReservations.delete(blockId);
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
			// One cluster transaction per block ID — but a block whose cohort is just this node
			// short-circuits to local storage, exactly as `pend` and `commit` do above. Without the
			// short-circuit a solo cohort enters `executeTransaction`, fails `minAbsoluteClusterSize`
			// (2), and throws `Cluster size 1 below minimum 2 and not validated` — so a single-peer
			// deployment could pend and commit but never cancel, unless the operator had opened the
			// `allowUnvalidatedSmallCluster` hatch. Decided per block rather than once for
			// `blockIds[0]`, because a multi-block cancel can span cohorts of different sizes.
			//
			// NOTE: `getClusterSize` is a second `findCluster` for the same key that
			// `executeClusterTransaction` is about to look up again, so a cancel over N blocks now
			// costs 2N cohort lookups instead of N. Same shape `pend` and `commit` already pay, but
			// they pay it once (they only ever consult `blockIds[0]`) where this scales with N. Fine
			// while cancels span a handful of blocks; if wide multi-block cancels ever show up hot,
			// have `executeClusterTransaction` return the cohort it already fetched (or own the
			// short-circuit itself) rather than adding a cache here.
			const results = await Promise.all(blockIds.map(async blockId => {
				const peerCount = await this.coordinator.getClusterSize(blockId);
				if (peerCount <= 1) return false;
				const { localExecuted } = await this.coordinator.executeClusterTransaction(blockId, message, options);
				return localExecuted;
			}));

			// Only call storageRepo if local cluster didn't already execute during consensus
			const anyLocalExecuted = results.some(Boolean);
			if (!anyLocalExecuted) {
				await this.storageRepo.cancel(actionRef, options);
			}
			// The remedy a stuck-reservation line names, actually taken: the record this node was
			// complaining about is gone, so forget the episode and let a LATER wedge on the same block
			// speak. Scoped to the cancelled action — a cancel for some OTHER action says nothing about
			// the reservation that is holding these blocks.
			this.clearStuckReservations(blockIds, actionRef.actionId);
		} catch (error) {
			this.log('coordinator-repo:cancel-error', { actionId: actionRef.actionId, error: (error as Error).message });
			throw error;
		}
	}

	async commit(request: CommitRequest, options?: MessageOptions): Promise<CommitResult> {
		const blockIds = request.blockIds;
		await this.verifyResponsibility(blockIds);

		const cohortPeerIds = await this.coordinator.getClusterPeerIds(blockIds[0]!);
		const peerCount = cohortPeerIds.length;
		if (peerCount <= 1) {
			// Solo cohort: consensus never runs, so no ClusterRecord exists to project a proof from —
			// the lone member self-signs a one-peer proof instead (mintSoloCommitProof), which is what
			// lets a block born on a cohort of one ever gain a second holder under the certified-push
			// default (handlePush refuses a proof-less block). Minted even when peerCount is 0 or the
			// sole peer is not self — findCluster failing (getClusterPeerIds returns []) puts the
			// DEGRADED-ROUTING case in this same branch, and self genuinely committed these bytes
			// either way; a proof's peer list is already not evidence of cohort membership by design
			// (caller obligation #1 on verifyBlockCommitProofClaim), so gating the mint on cohort
			// composition would buy no safety while opening a silent no-proof hole exactly when
			// routing is degraded. The log line is how an operator tells a real cohort of one
			// (cohortSize 1, soleIsSelf true) from a routing failure (cohortSize 0, or a sole peer
			// that is not this node).
			this.log('commit:solo-cohort', {
				blockId: blockIds[0],
				cohortSize: peerCount,
				soleIsSelf: peerCount === 1 && this.localPeerId !== undefined
					&& cohortPeerIds[0] === this.localPeerId.toString()
			});
			// Same message shape the multi-peer path produces — executeClusterTransaction stamps
			// coordinatingBlockIds at its choke point, so the solo artifact must carry it too or a
			// solo proof's message is distinguishable from every other proof's.
			const message: RepoMessage = {
				operations: [{ commit: request }],
				coordinatingBlockIds: [blockIds[0]!],
				expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
			};
			// `undefined` when no local cluster is wired (direct constructors, unit-test doubles) —
			// then the commit lands proof-less, exactly the pre-mint behavior. The cast is the named
			// ICommitProofPersister contract; a plain IRepo double ignores the extra argument.
			const proof = await this.localCluster?.mintSoloCommitProof?.(message);
			const result = await (this.storageRepo as IRepo & ICommitProofPersister).commit(request, options, proof);
			// One self-approval arms the read-repair window only where the DECLARED cohort is also one
			// — then no rival quorum can exist to be missed. At any larger declared size (including
			// an undeclared one, which resolves to the replication factor, and including degraded
			// routing where peerCount is 0) this commit proves nothing about rival quorums — see
			// commitQuorumRulesOutRivals — so the window stays unarmed and the read path's
			// solo-self-skip exit re-arms it once per consult instead (which keeps GitHub issue #8's
			// consult storm bounded at one per window).
			if (result.success && this.commitQuorumRulesOutRivals(1, peerCount)) this.markBlocksSeen(blockIds);
			return result;
		}

		const message: RepoMessage = {
			operations: [{ commit: request }],
			expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
		};

		try {
			const { record, localExecuted, localCommitResult } = await this.coordinator.executeClusterTransaction(blockIds[0]!, message, options);
			// Decided once for every success shape below (local-executed, local fallback, tolerated
			// divergence): whether this commit's quorum is freshness evidence or merely a commit.
			// NOTE: one verdict covers every block in `blockIds`, though it is measured against
			// `blockIds[0]`'s cohort alone. Consistent with the rest of this path — consensus for the
			// whole commit runs on that one cohort — so a per-block verdict would be measuring a
			// quorum that never voted. If commits ever coordinate per-block cohorts separately (see
			// `debt-sender-side-coordinating-block-binding-is-unchecked`), this must follow them.
			const armFreshness = this.commitQuorumRulesOutRivals(countApprovingCommitVotes(record), peerCount);
			if (localExecuted) {
				// Our own member applied this commit during consensus. Its retained storage verdict is
				// the one honest signal we have about durability: the member-side apply tolerates an
				// "ahead" refusal as divergence (see the NOTE in ClusterMember.applyConsensusOperation),
				// which is correct for a redelivered or lagging commit — but when the refusal's real
				// cause is a RIVAL action holding the requested revision, that tolerance turns a commit
				// no member durably stored into a fabricated success. This is the
				// signed-but-not-yet-applied window: two commits for one revision can BOTH assemble
				// consensus when every member signs the second after signing (but before applying) the
				// first, because signing drops the member's reservation. Confirm the rival against local
				// storage (never the verdict's prose) and answer the writer with a retryable conflict so
				// it re-drives at a fresh revision. Own-action or unconfirmed refusals keep the
				// prior fabricated-success shape: consensus is authoritative and this member converges
				// via replication.
				//
				// NOTE: a CONFIRMED rival is trusted over the consensus outcome here. That is right in
				// the window this closes (the cohort refused the loser too), but it inverts if the two
				// ever disagree — a local rival at the requested revision while a super-majority
				// approved OUR commit means this node is on a forked lineage, and refusing then tells a
				// writer whose write did land to re-drive it (a duplicate entry). Members holding the
				// rival reject at the promise round, so consensus and a local rival can only disagree
				// after a fork; that is partition-healing scope (docs/partition-healing.md). If forks
				// are ever observed here, weigh the retained verdict against the cohort's votes instead
				// of trusting the local re-read alone.
				if (localCommitResult !== undefined && !localCommitResult.success) {
					const rival = await this.confirmCommitRivalAgainstLocal(request);
					if (typeof rival === 'object') return rival;
					this.log('coordinator-repo:commit-local-refusal-tolerated', {
						actionId: request.actionId,
						confirmation: rival ?? 'unconfirmed',
						reason: localCommitResult.reason
					});
				}
				if (armFreshness) this.markBlocksSeen(blockIds);
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
			//
			// Deliberately NOT self-signed here (unlike the solo short-circuit above): consensus for
			// this commit ran on the cohort, so a one-peer minted proof would be a FALSE statement
			// about the committing cohort. Thread the record's REAL proof instead —
			// executeClusterTransaction resolves only after the record's promise/commit votes are
			// populated, so the projection is genuine. Passed unconditionally, threshold or not:
			// persistProofIfContentMatches retains it under the digest-match rule, and a record that
			// never reached threshold simply yields a proof no verifier accepts — the same posture
			// ClusterMember.applyConsensusOperation takes with its own projection.
			const consensusProof = buildBlockCommitProof(record);
			try {
				const result = await (this.storageRepo as IRepo & ICommitProofPersister).commit(request, options, consensusProof);
				if (result.success) {
					if (armFreshness) this.markBlocksSeen(blockIds);
					return result;
				}
				if (isMissingBaseRevisionFailure(result) && clusterReachedCommitConsensus(record)) {
					return this.tolerateLocalCommitDivergence(request, blockIds, result.reason ?? MISSING_BASE_REVISION_REASON, armFreshness);
				}
				return result;
			} catch (err) {
				if (clusterReachedCommitConsensus(record)) {
					return this.tolerateLocalCommitDivergence(request, blockIds, (err as Error).message, armFreshness);
				}
				throw err;
			}
		} catch (error) {
			this.log('coordinator-repo:commit-error', { actionId: request.actionId, error: (error as Error).message });
			// A lost commit-consensus race is an optimistic-concurrency loss, not a fault — mirror
			// `pend`'s conversion above. At the moment this is thrown, zero members approved and the
			// members hold the winner: nothing of the loser landed, so a retryable-conflict answer is
			// truthful. Returning it (rather than rethrowing) matters more here than on the pend path:
			// db-core's `commitCollection` retries a THROWN commit error verbatim up to 3 times, and by
			// the retry the members have applied the winner and cleared its reservation — the re-driven
			// commit can then assemble a consensus no member will durably store (the writer's append
			// fulfills, the entry exists on no node). A RETURNED `success:false` is instead surfaced
			// immediately as a stale loss; the writer cancels the pend, re-reads, and re-drives the
			// whole pend+commit at a fresh revision. `staleAt` stays absent for the same reason as
			// pend's: it is confirmed-only, and a lost race is a rival commit racing the same revision,
			// not a locally-confirmed revision claim.
			if (error instanceof ConflictRaceLostError) {
				return { success: false, conflict: true, reason: error.message };
			}
			// A promise-phase stale-commit reject (`ClusterMember.validateCommitRevisions` — a member
			// holds the requested revision under a different action) surfaces here as a
			// ValidatorRejectionError; classify it against local storage the way `pend` does, so the
			// writer gets a clean retryable conflict instead of three verbatim re-drives and a hard
			// failure.
			const stale = await this.classifyCommitStaleRejection(error, request);
			if (stale) return stale;
			throw error;
		}
	}

	/**
	 * Commit-shaped sibling of {@link classifyStaleRejection}: decide whether a cluster validator
	 * rejection of a COMMIT was an optimistic-concurrency loss — the requested revision is already
	 * committed under a different action — rather than a genuine validation fault. A confirmed loss
	 * returns a {@link StaleFailure} with `conflict: true` so db-core's `commitCollection` surfaces
	 * it immediately as a stale loss (no verbatim retry) and the writer re-drives at a fresh
	 * revision.
	 *
	 * Same confirmation discipline as the pend classifiers: purely local re-read; the signed reject
	 * text is never consulted. One commit-specific delta — confirmation must EXCLUDE the
	 * own-action-at-rev case: a block whose requested revision is held by THIS action is already
	 * durable, and answering `conflict` for it would make the writer rebase and re-append an
	 * already-committed action at a new revision — a duplicate entry. So:
	 *  - `latest.rev === request.rev` → compare `latest.actionId`: ours ⇒ bail (stays a throw),
	 *    a rival's ⇒ confirmed loss;
	 *  - `latest.rev > request.rev` → ask the {@link IRevisionActionReader} capability who holds
	 *    `request.rev`: ours ⇒ bail, a rival's ⇒ confirmed loss, unknown/absent/fault ⇒ unconfirmed;
	 *  - anything unconfirmed (including read errors) stays a throw — fail-fast for genuine faults.
	 */
	private async classifyCommitStaleRejection(error: unknown, request: CommitRequest): Promise<StaleFailure | undefined> {
		if (!(error instanceof ValidatorRejectionError)) return undefined;
		const rival = await this.confirmCommitRivalAgainstLocal(request);
		// 'own-durable' and unconfirmed both stay a throw here: fail-fast for genuine faults, and a
		// commit already durable under this action must never be answered `conflict` (the writer
		// would rebase and re-append it — a duplicate entry).
		return typeof rival === 'object' ? rival : undefined;
	}

	/**
	 * Shared confirmation core for the two commit-tier conversion sites ({@link classifyCommitStaleRejection}
	 * and the locally-executed refusal check in {@link commit}): decide, from LOCAL storage only, who
	 * holds the requested revision.
	 *  - a confirmed RIVAL → the {@link StaleFailure} conflict answer (with `staleAt` = highest
	 *    confirmed holder);
	 *  - our OWN action durable at the requested revision → `'own-durable'` (callers must not answer
	 *    `conflict` — the writer would rebase an already-landed action into a duplicate entry);
	 *  - anything else (behind, truncated history, read faults, capability absent) → `undefined`,
	 *    unconfirmed.
	 * The signed reject text / retained verdict prose is never consulted.
	 */
	private async confirmCommitRivalAgainstLocal(request: CommitRequest): Promise<StaleFailure | 'own-durable' | undefined> {
		const blockIds = request.blockIds;
		let results: GetBlockResults;
		try {
			results = await this.storageRepo.get({ blockIds });
		} catch (readError) {
			this.log('coordinator-repo:commit-stale-classify-read-error', {
				actionId: request.actionId,
				error: (readError as Error).message
			});
			return undefined;
		}
		const reader = this.storageRepo as IRepo & Partial<IRevisionActionReader>;
		// Scan EVERY block (same rule as the pend classifier): report the highest confirmed rival
		// revision, but bail the moment any block shows OUR action durable at the requested revision.
		const rivalStales: ({ blockId: BlockId; rev: number } | undefined)[] = [];
		for (const blockId of blockIds) {
			const latest = results[blockId]?.state?.latest;
			if (!latest || latest.rev < request.rev) continue;
			if (latest.rev === request.rev) {
				if (latest.actionId === request.actionId) {
					this.log('coordinator-repo:commit-stale-classify-own-action', {
						actionId: request.actionId, blockId, rev: request.rev
					});
					return 'own-durable';
				}
				rivalStales.push({ blockId, rev: latest.rev });
				continue;
			}
			// latest.rev > request.rev — latest can no longer name who took request.rev.
			if (typeof reader.getRevisionAction !== 'function') continue;
			let takenBy: ActionId | undefined;
			try {
				takenBy = await reader.getRevisionAction(blockId, request.rev);
			} catch (readError) {
				this.log('coordinator-repo:commit-stale-classify-revision-read-error', {
					actionId: request.actionId, blockId, rev: request.rev,
					error: (readError as Error).message
				});
				continue;
			}
			if (takenBy === request.actionId) {
				this.log('coordinator-repo:commit-stale-classify-own-action', {
					actionId: request.actionId, blockId, rev: request.rev, latestRev: latest.rev
				});
				return 'own-durable';
			}
			if (takenBy !== undefined) rivalStales.push({ blockId, rev: latest.rev });
			// takenBy undefined (truncated history): unconfirmed for this block.
		}
		const staleAt = highestStaleAt(rivalStales);
		if (!staleAt) return undefined;
		this.log('coordinator-repo:commit-stale-classified', {
			actionId: request.actionId,
			blockId: staleAt.blockId,
			latestRev: staleAt.rev,
			requestedRev: request.rev
		});
		return {
			success: false,
			conflict: true,
			reason: `stale commit: block ${staleAt.blockId} at rev ${staleAt.rev}, requested rev ${request.rev}`,
			staleAt
		};
	}

	/**
	 * Report success for a commit the cluster carried but this peer could not apply locally.
	 * Convergence comes from replication (cohort reconcile, or read-driven acquisition), not from
	 * replay here. `armFreshness` says whether the commit's quorum was strong enough
	 * ({@link commitQuorumRulesOutRivals}) for the read path to treat the blocks as
	 * freshness-checked; a divergence tolerated on a downsized quorum leaves the window unarmed —
	 * this peer is known to be behind here, the last place a self-referential freshness stamp
	 * belongs.
	 */
	private tolerateLocalCommitDivergence(request: CommitRequest, blockIds: BlockId[], detail: string, armFreshness: boolean): CommitResult {
		this.log('coordinator-repo:commit-local-failed-cluster-succeeded', { actionId: request.actionId, error: detail });
		if (armFreshness) this.markBlocksSeen(blockIds);
		return { success: true };
	}
}

/** True if a simple majority of cluster peers signed an approving commit. */
function clusterReachedCommitConsensus(record: ClusterRecord): boolean {
	const peerCount = Object.keys(record.peers).length;
	if (peerCount === 0) return false;
	return countApprovingCommitVotes(record) > peerCount / 2;
}

/** Approve-typed commit votes on a consensus record — the numerator `commitQuorumRulesOutRivals` measures against the full cohort. */
function countApprovingCommitVotes(record: ClusterRecord): number {
	return Object.values(record.commits).filter(s => s.type === 'approve').length;
}
