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
 * The signed payload is **target- and arbitrator-set-bound** (v3):
 * `utf8(`v3:${disputeId}:${vote}:${computedHash}:${targetHash}:${setHash}`)`, where
 *  - `targetHash = hashString(`${messageHash}|${invalidatedActionId}|${sortedBlockIds.join(',')}`)`
 *    commits the vote to the *specific* transaction being reversed (#2), and
 *  - `setHash = hashString(sortedArbitratorSet.join(','))` commits it to the *legitimately-selected
 *    arbitrator set* (#1) carried on {@link DisputeResolutionProof.arbitratorSet}.
 *
 * A verifier recomputes both digests from the proof plus the apply-path target, so a genuine vote can
 * neither be replayed against an unrelated transaction nor presented under a swapped cohort. v1/v2
 * (un-set-bound) votes are rejected, not accepted-by-default; the {@link version} marker is required.
 */
export type ArbitrationVoteProof = {
	/** Wire-format version of the signed payload. Only `'v3'` is accepted; absent/unrecognized → rejected. */
	readonly version: 'v3';
	/** Peer id of the arbitrator; its embedded Ed25519 public key verifies {@link signature}. */
	readonly arbitratorPeerId: string;
	/** The arbitrator's verdict. */
	readonly vote: 'agree-with-challenger' | 'agree-with-majority' | 'inconclusive';
	/** The operations hash the arbitrator computed (part of the signed payload). */
	readonly computedHash: string;
	/** Base64url-encoded Ed25519 signature over `v3:${disputeId}:${vote}:${computedHash}:${targetHash}:${setHash}`. */
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
 * against its arbitrator's embedded key, each vote target-bound, drawn from the legitimately-selected
 * {@link arbitratorSet}, and counted at most once per arbitrator).
 *
 * **Unforgeability.** Votes are bound to the reversed transaction (`targetHash`, #2), counted at most
 * once per arbitrator (#3), and bound to the legitimately-selected arbitrator set (#1):
 * {@link arbitratorSet} carries the K peer-ids the challenger selected, every counted vote must be a
 * member of it, and {@link arbitratorSetSignature} — the challenger's Ed25519 signature (verified
 * against {@link challengerPeerId}) over `(disputeId, target, arbitratorSet)` — binds the set to the
 * originator so a third-party relay cannot swap in its own sybils. A verifying member additionally
 * re-derives the eligible set from its own topology when it can (an injected recompute capability),
 * closing even a fully-malicious challenger; when it cannot (late-joiner / churned DHT view) it accepts
 * on the challenger-bound set + membership + dedup and *logs* the residual topology-anchoring gap rather
 * than silently accepting — a gap closed in full by the cohort-topic membership-cert trust-anchor chain
 * (`tickets/plan/cohort-topic-membership-cert-trust-anchoring.md`). Net: a compromised peer can withhold
 * an invalidation but cannot forge one.
 */
export type DisputeResolutionProof = {
	/** Identifies the dispute these votes resolved. */
	readonly disputeId: string;
	/** messageHash of the original (now-invalid) committed transaction. */
	readonly messageHash: string;
	/** Resolution outcome; only `challenger-wins` authorizes an invalidation. */
	readonly outcome: 'challenger-wins' | 'majority-wins' | 'inconclusive';
	/**
	 * Peer-id of the challenger (dissent coordinator) that selected the arbitrator set and produced
	 * {@link arbitratorSetSignature}; its embedded Ed25519 key verifies that signature.
	 */
	readonly challengerPeerId: string;
	/**
	 * The legitimately-selected arbitrator set — the K peer-ids the challenger computed via `sampleArbitrators`
	 * (verifiable dispersed sampling: the peers nearest K pseudo-random ring coordinates derived from
	 * `hash(blockId ‖ round ‖ epoch ‖ i)`, spread across the whole keyspace rather than drawn from the disputed
	 * block's neighborhood). Every counted vote's `arbitratorPeerId` must be a member; the set is bound to the
	 * originator by {@link arbitratorSetSignature} and, when feasible, re-derived from the verifying member's topology.
	 */
	readonly arbitratorSet: ReadonlyArray<string>;
	/**
	 * The challenger's base64url Ed25519 signature (verified against {@link challengerPeerId}'s embedded
	 * key) over `utf8(`v3set:${disputeId}:${targetHash}:${setHash}`)` — binds `(disputeId, target,
	 * arbitratorSet)` to the originator so a relay cannot substitute its own cohort. Tampering with
	 * {@link arbitratorSet} (e.g. adding sybils) invalidates this signature.
	 */
	readonly arbitratorSetSignature: string;
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
