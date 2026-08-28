import type { CollectionId, BlockId, IBlock, ActionId, Transform, Transforms } from "../index.js";
import type { ActionContext, ActionRev } from "../collection/action.js";
import type { Transaction } from "../transaction/transaction.js";
import type { DisputeResolutionProof } from "../log/struct.js";
import type { PeerId } from "./types.js";

export type ActionBlocks = {
	blockIds: BlockId[];
	actionId: ActionId;
};

export type ActionTransforms = {
	actionId: ActionId;
	rev?: number;
	transforms: Transforms;
};

export type ActionTransform = {
	actionId: ActionId;
	rev?: number;
	transform: Transform;
};

export type ActionPending = {
	blockId: BlockId;
	actionId: ActionId;
	transform?: Transform;
};

export type PendRequest = ActionTransforms & {
	/** What to do if there are any pending actions.
	 * 'c' is continue normally,
	 * 'f' is fail, returning the pending ActionIds,
	 * 'r' is return, which fails but returns the pending ActionIds and their transforms */
	policy: 'c' | 'f' | 'r';
	/** For multi-collection transactions: the full transaction for replay/validation */
	transaction?: Transaction;
	/** For multi-collection transactions: hash of ALL operations across all blocks */
	operationsHash?: string;
	/** For multi-collection transactions: supercluster nominees for consensus */
	superclusterNominees?: PeerId[];
	/**
	 * Aged, advisory retry priority for the *single-collection* pend path (default 0 when absent).
	 * The multi-collection path instead carries priority on {@link PendRequest.transaction}
	 * ({@link Transaction.priority}); this top-level field is the carrier for a `Collection.sync`
	 * pend, which has no `transaction`. A cluster member reads whichever is present as the first
	 * `resolveRace` tiebreak. FAIRNESS-ONLY: it rides inside the signed cluster `message` (so it is
	 * integrity-protected in transit) but MUST NOT affect the operations hash, stale-read checks, or
	 * validity — a stale pend is still rejected regardless of priority.
	 */
	priority?: number;
};

export type BlockActionStatus = ActionBlocks & {
	statuses: ('pending' | 'committed' | 'checkpointed' | 'aborted' | 'committed-invalidated')[];
};

export type PendSuccess = {
	success: true;
	/** List of already pending actions that were found on blocks touched by this pend */
	pending: ActionPending[];
	/** The affected blocks */
	blockIds: BlockId[];
};

export type StaleFailure = {
	success: false;
	/** The reason for the failure */
	reason?: string;
	/** List of actions that have already been committed and are newer than our known revision */
	missing?: ActionTransforms[];
	/** List of actions that are pending on the blocks touched by this pend */
	pending?: ActionPending[];
	/**
	 * Explicit retryability. True when this failure is an optimistic-concurrency loss — the
	 * requested revision was taken, or a rival pend holds the blocks — so a re-read, rebase and
	 * re-pend can win. Set it only when the producer genuinely classified the failure; leave it
	 * absent otherwise, and consumers fall back to inferring from `missing`/`pending`.
	 * Read it through `isConflictFailure` rather than testing it directly.
	 */
	conflict?: boolean;
	/**
	 * The block that already occupies (or is past) the requested revision, and the revision the
	 * responder holds for it.
	 *
	 * CONFIRMED-ONLY: set this only when the producer read the revision out of its own storage.
	 * A producer that merely suspects staleness — or that learned of it from another peer's
	 * free-form reject text — must leave it absent. Absent means "no confirmed number", never
	 * "not stale".
	 *
	 * DIAGNOSTIC, NOT A RETRYABILITY SIGNAL: `conflict` (read via `isConflictFailure`) remains the
	 * single source of truth for "can a re-read and re-pend win?". Never branch retry decisions on
	 * the presence of this field.
	 */
	staleAt?: { blockId: BlockId; rev: number };
};

export type PendResult = PendSuccess | StaleFailure;

/** What one block will materialize to at the committing revision, declared by the client that
 *  authored the transforms. */
export type BlockContentDigest = {
	/** base64url SHA-256 of canonicalJson(block) - see canonicalBlockHash. */
	digest: string;
	/** Committed revision of the base the digest was computed from. ABSENT when the block's
	 *  transform carries an insert, which makes the result base-independent and therefore
	 *  checkable by every member regardless of how far behind it is. */
	baseRev?: number;
};

/** Per-block content declarations riding on a commit. Optional per id: a block the client cannot
 *  digest without a network read is simply omitted, and falls back to corroboration downstream. */
export type BlockContentDigests = Record<BlockId, BlockContentDigest>;

export type CommitRequest = ActionBlocks & {
	/** The header block of the collection, if this is a new collection (commit first) */
	headerId?: BlockId;
	/** The tail block of the log (commit next) */
	tailId: BlockId;
	/** The new revision for the committed action */
	rev: number;
	/** Per-block content declarations for the committing action — see {@link BlockContentDigests}.
	 *  Rides inside the consensus message, so the generic cluster message hash folds it into every
	 *  cohort signature with no change to the hash helpers. Action-wide here; the transactor narrows
	 *  it to each per-coordinator batch's own block ids before sending (`RepoCommitRequest`). */
	blockDigests?: BlockContentDigests;
};

/**
 * Originates a compensating invalidation through the same critical-cluster consensus as any
 * transaction: it takes a revision slot and serializes against concurrent commits. Each member
 * applies it deterministically — verifying {@link resolution} as an invalidation certificate, then
 * writing the per-block compensating revisions and appending the durable invalidation log entry.
 *
 * Carries everything a member needs to apply the reversal without trusting the originator: the
 * target action, the blocks it wrote, the owning collection's log, and the signed proof.
 */
export type InvalidateRequest = {
	/** actionId of the committed action being reversed. */
	invalidatedActionId: ActionId;
	/** rev of the invalidated entry — pins which block revisions to roll back. */
	invalidatedRev: number;
	/** Blocks the invalidated action wrote (its commit's blockIds). */
	blockIds: BlockId[];
	/** The collection (log) the invalidated action belongs to — where the compensating entry lands. */
	collectionId: CollectionId;
	/** The invalidation certificate (challenger-wins + signed 2/3 decisive arbitrator votes). */
	resolution: DisputeResolutionProof;
};

export type CommitResult = CommitSuccess | StaleFailure;

export type CommitSuccess = {
	success: true;
	/** If present, the identified collection acts as the coordinator for the multi-collection transaction */
	coordinatorId?: CollectionId;
};

export type BlockActionState = {
	/** The latest action that has been committed */
	latest?: ActionRev;
	/** If present, the specified actions are pending */
	pendings?: ActionId[];
};

export type BlockGets = {
	blockIds: BlockId[];
	context?: ActionContext;	// Latest if this is omitted
};

/** Why a repo could not establish whether a block exists. Present ONLY when the repo
 *  knows its own answer is a guess; an absent field is an authoritative answer. */
export type BlockUnavailableReason =
	/** Records for this block exist here but it cannot be reconstructed locally — a
	 *  revision was received with no base to apply it to, or its history is truncated. */
	| 'unmaterializable'
	/** Nothing is held locally; PART of the cohort answered and part could not be asked.
	 *  A silent peer could be the sole holder, so the absence is a guess — but other
	 *  coordinators are reachable, so asking one of them can still settle it. Also the
	 *  fallback when the consult could not run at all (the cohort lookup itself failed):
	 *  a routing failure says nothing about how many cohort members were reachable. */
	| 'peers-unreachable'
	/** Nothing is held locally and NO cohort member outside the answering node could be
	 *  asked at all. Distinct from `peers-unreachable` in exactly the way that matters to
	 *  a caller: there is no better-connected coordinator to re-ask, so the answer will
	 *  not improve until that node's connectivity does. Its local view is all there is. */
	| 'cohort-unreachable'
	/** Nothing is held locally, but a cohort peer positively CLAIMED a revision of this
	 *  block, and the answering node could neither corroborate that claim to a quorum nor
	 *  acquire the content. The block is known to exist somewhere; reporting it absent
	 *  would be a lie regardless of whether anyone was silent. */
	| 'claimed-elsewhere';

export type GetBlockResult = {
	/** The retrieved block - undefined if the block was deleted	 */
	block?: IBlock;
	/** The latest and pending states of the repo that retrieved the block */
	state: BlockActionState;
	/** The revision the returned `block` actually IS — the `(rev, actionId)` of the highest
	 *  committed revision of THIS block at or below the caller's {@link BlockGets.context}`.rev`.
	 *  Differs from `state.latest` only for a revision-pinned read of a block that has committed
	 *  further since the pin; for an unpinned read the two agree.
	 *
	 *  This — not `state.latest` — is what a read observed, so it is what a read dependency must
	 *  record (recording `latest` would claim the reader saw content it never read, and the
	 *  validator's stale-read check would wrongly pass), and it is the only correct label for the
	 *  content when it is passed on (a block-repair archive, a replica push). `state.latest` keeps
	 *  its own meaning: the newest revision the answering repo holds for the block.
	 *
	 *  The revision and its action id are ONE field, deliberately: a site that must label content
	 *  it is holding needs both, and two independently-optional fields could disagree — which is
	 *  exactly the mislabel this exists to make unrepresentable (old bytes served under a newer
	 *  revision's number and action id, which a receiver keyed by action id then writes over its
	 *  own good copy; see `serveBlockArchive`).
	 *
	 *  Optional: a producer that does not know what it materialized leaves it absent rather than
	 *  guessing, and consumers fall back to `state.latest` (read dependencies record
	 *  `state.latest?.rev ?? 0`; a labelling site refuses to label a pinned read). */
	materialized?: ActionRev;
	/** Set when this repo could not determine whether the block exists — its answer is a
	 *  guess, not an authoritative absent. Every producer that omits it (including
	 *  TestTransactor) keeps meaning "authoritative". */
	unavailable?: BlockUnavailableReason;
	/** Set when this repo served committed content it could NOT confirm is current: its
	 *  freshness consult did not converge AND a cohort peer claimed a strictly higher
	 *  revision than the one served, within the view the caller asked for (unpinned, or
	 *  pinned at or above the claim). Carries that claimed revision. The claim did not
	 *  drive a successful repair — it failed the read-repair corroboration quorum, or was
	 *  corroborated but the content could not be acquired — so it is evidence of DOUBT,
	 *  never a revision to adopt. Distinct from `unavailable`, which is about EXISTENCE:
	 *  the content here is real, it may just be behind. Absent = confirmed, so every
	 *  producer that omits it keeps its meaning. */
	unconfirmedAheadRev?: number;
};

/**
 * Thrown by a block read when the responsible repo could not determine whether the
 * block exists. Distinct from "the block is absent" (undefined) and from a transport
 * failure — this node's data is genuinely indeterminate and the caller must not treat
 * it as empty. Not a StaleFailure: `Collection.sync` does not retry it.
 */
export class BlockUnavailableError extends Error {
	constructor(readonly blockId: BlockId, readonly reason: BlockUnavailableReason) {
		super(`Block ${blockId} is unavailable (${reason}): the repo could not determine whether it exists`);
		this.name = 'BlockUnavailableError';
	}
}

/**
 * Thrown by an unpinned ("give me latest") block read whose surviving answer carries
 * {@link GetBlockResult.unconfirmedAheadRev}: every reachable coordinator served content
 * it could not confirm is current, while a cohort peer claimed a strictly higher revision
 * nothing could corroborate or refute. Sibling of {@link BlockUnavailableError} — that one
 * is about EXISTENCE (blockless answer, could not find out), this one about CURRENCY (real
 * content, possibly behind). Not a StaleFailure: `Collection.sync` does not retry it.
 */
export class BlockPossiblyStaleError extends Error {
	constructor(readonly blockId: BlockId, readonly claimedRev: number) {
		super(`Block ${blockId} may be stale: a cohort peer claimed rev ${claimedRev} that no reachable coordinator could confirm or refute`);
		this.name = 'BlockPossiblyStaleError';
	}
}

export type GetBlockResults = Record<BlockId, GetBlockResult>;

/**
 * Result of validating a transaction in a PendRequest.
 */
export type PendValidationResult = {
	/** Whether validation passed */
	valid: boolean;
	/** Reason for validation failure (if valid=false) */
	reason?: string;
};

/**
 * Hook for validating transactions in PendRequests.
 *
 * This hook is called by the storage layer when receiving a PendRequest
 * that includes a transaction and operationsHash. If validation fails,
 * the pend operation is rejected.
 *
 * If the hook is not provided, validation is skipped (storage-only nodes).
 */
export type PendValidationHook = (
	transaction: Transaction,
	operationsHash: string
) => Promise<PendValidationResult>;

// Backward compatibility aliases (deprecated - use Action* names)
/** @deprecated Use ActionBlocks instead */
export type TrxBlocks = ActionBlocks;
/** @deprecated Use ActionTransforms instead */
export type TrxTransforms = ActionTransforms;
/** @deprecated Use ActionTransform instead */
export type TrxTransform = ActionTransform;
/** @deprecated Use ActionPending instead */
export type TrxPending = ActionPending;
