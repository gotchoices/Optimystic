import type { BlockId, CollectionId, ActionContext, ActionId, ActionRev, ReadDependency } from "../index.js";

/** A log entry - an action, a checkpoint, or an invalidation */
export type LogEntry<TAction> = {
	/** Linux timestamp of the entry */
	readonly timestamp: number;
	/** Revision number - monotonically increasing from the prior entry's rev.  Starts at 1. */
	readonly rev: number;
	readonly action?: ActionEntry<TAction>;
	readonly checkpoint?: CheckpointEntry;
	/** A compensating entry that reverses a previously-committed action proven invalid by dispute. */
	readonly invalidation?: InvalidationEntry;
};

/** An action entry represents a unit of work that is atomic */
export type ActionEntry<TAction> = {
	/** Generated unique identifier for the action */
	readonly actionId: ActionId;
	/** Actions to be applied */
	readonly actions: TAction[];
	/** Block ids affected by the action - includes the log related blocks */
	blockIds: BlockId[]; // NOTE: this is updated after being generated to include the log-related block transforms
	/** Other collection ids affected by the action - this action is conditional on successful commit in all of these collections */
	readonly collectionIds?: CollectionId[];
	/**
	 * The `(blockId, revision)` reads this transaction observed during execution — the same
	 * read set the {@link Transaction} carried in its PEND request (see `Transaction.reads`).
	 *
	 * Persisted so a later invalidation cascade can discover this action's read-dependents:
	 * a committed action is a read-dependent of an invalidated one iff its read set contains a
	 * `(blockId, revision)` that the invalidated action produced.
	 *
	 * **Format / back-compat:** added by the invalidation-cascade work (ActionEntry v2). An entry
	 * written before this field existed (or by a path that does not carry a `Transaction`, e.g. the
	 * low-level `Collection.sync` direct-commit) has `reads === undefined` — treated by the cascade
	 * as an *unknown dependency* (conservatively re-evaluated, never silently assumed independent).
	 * `reads === []` is distinct: a transaction that genuinely read nothing.
	 */
	readonly reads?: ReadDependency[];
};

/**
 * One arbitrator's signed verdict — the minimal subset of a dispute vote needed to re-verify
 * it independently. The Ed25519 public key that verifies {@link signature} is embedded in
 * {@link arbitratorPeerId} (a libp2p Ed25519 peer id).
 *
 * The signed payload is **target-bound** (v2): `utf8(`v2:${disputeId}:${vote}:${computedHash}:${targetHash}`)`,
 * where `targetHash = hashString(`${messageHash}|${invalidatedActionId}|${sortedBlockIds.join(',')}`)`
 * commits the vote to the *specific* transaction being reversed. A verifier recomputes `targetHash`
 * from the {@link DisputeResolutionProof.messageHash} plus the apply-path target, so a genuine proof
 * cannot be replayed against an unrelated transaction. v1 (unbound) votes are rejected, not
 * accepted-by-default; the {@link version} marker is required and the follow-up arbitrator-set ticket
 * bumps it additively (`invalidation-cert-arbitrator-set-binding`).
 */
export type ArbitrationVoteProof = {
	/** Wire-format version of the signed payload. Only `'v2'` is accepted; absent/unrecognized → rejected. */
	readonly version: 'v2';
	/** Peer id of the arbitrator; its embedded Ed25519 public key verifies {@link signature}. */
	readonly arbitratorPeerId: string;
	/** The arbitrator's verdict. */
	readonly vote: 'agree-with-challenger' | 'agree-with-majority' | 'inconclusive';
	/** The operations hash the arbitrator computed (part of the signed payload). */
	readonly computedHash: string;
	/** Base64url-encoded Ed25519 signature over `v2:${disputeId}:${vote}:${computedHash}:${targetHash}`. */
	readonly signature: string;
};

/**
 * The authoritative, independently-verifiable subset of a dispute resolution that proves a
 * committed transaction invalid. Carried inside an {@link InvalidationEntry}.
 *
 * Defined in db-core (the log layer) deliberately: the log must not import db-p2p, so the dispute
 * layer's richer `DisputeResolution` maps *onto* this proof rather than this proof importing it.
 * A member treats the proof as a reversal certificate — `outcome === 'challenger-wins'` with a
 * 2/3 super-majority of decisive votes agreeing with the challenger (each signature verifiable
 * against its arbitrator's embedded key, each vote target-bound and counted at most once per
 * arbitrator).
 *
 * **Unforgeability (partial).** The {@link messageHash} plus the apply-path target now bind the votes
 * to the specific reversed transaction (no cross-target replay), and per-arbitrator dedup prevents one
 * vote manufacturing a majority. A compromised peer still cannot forge a reversal for a *different*
 * transaction. The remaining gap — binding the votes to the *legitimately-selected arbitrator set* (so
 * a peer that can mint Ed25519 keypairs cannot stuff a synthetic cohort) — is closed by the follow-up
 * ticket `invalidation-cert-arbitrator-set-binding`; until it lands, "cannot forge" is not yet absolute.
 */
export type DisputeResolutionProof = {
	/** Identifies the dispute these votes resolved. */
	readonly disputeId: string;
	/** messageHash of the original (now-invalid) committed transaction. */
	readonly messageHash: string;
	/** Resolution outcome; only `challenger-wins` authorizes an invalidation. */
	readonly outcome: 'challenger-wins' | 'majority-wins' | 'inconclusive';
	/** Signed arbitrator votes. */
	readonly votes: ReadonlyArray<ArbitrationVoteProof>;
};

/** Per-block compensating result an invalidation produced. */
export type RevertedBlock = {
	/** Block whose tip was reverted. */
	readonly blockId: BlockId;
	/** Revision the block was at before this invalidation (the tip that was reverted). */
	readonly fromRev: number;
	/** Content hash of the new revision restoring the as-if-`T_inv`-absent content. */
	readonly restoredContentHash: string;
};

/** A compensating entry that reverses a previously-committed action proven invalid by dispute. */
export type InvalidationEntry = {
	/** actionId of the committed {@link ActionEntry} being reversed. */
	readonly invalidatedActionId: ActionId;
	/** rev of the invalidated entry — pins which block revisions to roll back. */
	readonly invalidatedRev: number;
	/** Authoritative proof: a challenger-wins resolution carrying the signed arbitrator votes. */
	readonly resolution: DisputeResolutionProof;
	/** Per-block compensating result this entry produced (new monotonic revision restoring pre-`T_inv` content). */
	readonly reverted: ReadonlyArray<RevertedBlock>;
	/** When this invalidation is a cascade step, the root invalidation that triggered it (unused this ticket; see cascade ticket). */
	readonly cascadeRoot?: ActionId;
};

/** A checkpoint entry restates the currently uncheckpointed actions */
export type CheckpointEntry = {
	/** The current set of pending action/revs
	 * - actions implicitly increase the set of pending Ids
	 * - this restates the entire current set
	 * - missing from the set are the implicitly checkpointed ones */
	readonly pendings: ActionRev[];
};

export const LogDataBlockType = "LGD";
export const LogHeaderBlockType = "LGH";

export type GetFromResult<TAction> = {
	context: ActionContext | undefined;
	entries: ActionEntry<TAction>[];
};
