import type { IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";
import type { BlockCommitProof } from "../cluster/commit-proof.js";

/** Interface for block-level storage operations */
export interface IBlockStorage {
    /** Gets the latest revision information for this block */
    getLatest(): Promise<ActionRev | undefined>;

    /**
     * Gets a materialized block at the given revision.
     * Returns undefined when the block has no materialized content yet — either
     * no metadata exists, or metadata exists (seeded by a pending transaction)
     * but no revision has been committed. Throws only when a specific `rev` was
     * requested but cannot be located.
     */
    getBlock(rev?: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined>;

    /** Gets an action by ID */
    getTransaction(actionId: ActionId): Promise<Transform | undefined>;

    /** The commit proof stored for a revision, if one was retained (see IRawStorage.getBlockProof). */
    getBlockProof(rev: number): Promise<BlockCommitProof | undefined>;

    /** Persists the commit proof for a revision (see IRawStorage.saveBlockProof). */
    saveBlockProof(rev: number, proof: BlockCommitProof): Promise<void>;

    /** Gets a pending action by ID */
    getPendingTransaction(actionId: ActionId): Promise<Transform | undefined>;

    /** Lists all pending action IDs */
    listPendingTransactions(): AsyncIterable<ActionId>;

    /** Saves a pending action */
    savePendingTransaction(actionId: ActionId, transform: Transform): Promise<void>;

    /** Deletes a pending action */
    deletePendingTransaction(actionId: ActionId): Promise<void>;

    /** Lists revisions in ascending or descending order between startRev and endRev (inclusive) */
    listRevisions(startRev: number, endRev: number): AsyncIterable<ActionRev>;

    /** Saves a materialized block */
    saveMaterializedBlock(actionId: ActionId, block: IBlock | undefined): Promise<void>;

    /**
     * Delete the materialized copy at `prior` if it is now redundant under the checkpoint
     * retention policy (not the tip, not its range floor, not a checkpoint rev). The forward
     * transform for `prior.rev` is retained, so the rev stays reconstructible by replay.
     * No-op if `prior.rev` must be retained or has no materialization (e.g. a tombstone rev).
     * Must be called under the per-block commit latch (serialized against concurrent commit).
     */
    pruneSupersededMaterialization(prior: ActionRev): Promise<void>;

    /** Saves a revision */
    saveRevision(rev: number, actionId: ActionId): Promise<void>;

    /**
     * Promotes a pending action to committed, MOVING the record from the pending namespace to the
     * committed one in a single atomic step.
     *
     * **Invariant P** — a block never holds a pending record and a committed record for the same
     * action id at the same time. This method maintains it on the commit path; every OTHER writer of
     * a committed transform for a block ({@link saveReplica}, {@link saveDeletion}, and any forward
     * path added later) must maintain it too, by deleting that action's pending record when it
     * writes the committed one. A pending record left beside a committed one can never be promoted,
     * and is reported as a phantom conflicting action by `StorageRepo.pend` on every later write to
     * the block.
     */
    promotePendingTransaction(actionId: ActionId): Promise<void>;

    /** Sets the latest revision information */
    setLatest(latest: ActionRev): Promise<void>;

    /**
     * Persist a replica of a block received out-of-band (churn re-replication).
     *
     * Seeds metadata if absent, writes `rev → actionId`, the action transform, and the
     * materialized block, merges `[rev, rev+1]` into `ranges`, and advances `latest`
     * monotonically. When `source` is provided its `rev`/`actionId` are used; otherwise
     * it falls back to `rev = 1` and a deterministic `actionId` derived from the block
     * (so retries stay idempotent — never random).
     *
     * Maintains **Invariant P** (see {@link promotePendingTransaction}): writing the committed
     * transform for `actionId` also deletes that action's pending record on this block, so a node
     * that pended the action but diverged before committing it does not keep an unpromotable record.
     * Only on the write path — the monotonic no-op below deletes nothing.
     *
     * No-op (still durable) when an equal-or-newer revision is already present: `latest`
     * is never downgraded. Idempotent for a fixed `(rev, actionId)`. Returns the
     * effective latest `ActionRev`.
     *
     * `proof` is persisted for `source.rev` and MUST already be verified by the caller against
     * these exact bytes (`verifyBlockCommitProofContent` — the digest check is what binds a proof
     * to the block content). An unverified proof passed here would be re-served onward as evidence
     * this node never checked. The monotonic no-op persists nothing, proof included.
     */
    saveReplica(block: IBlock, source?: ActionRev, proof?: BlockCommitProof): Promise<ActionRev>;

    /**
     * Writes a forward TOMBSTONE revision that reverses a block creation: persists `rev → actionId`,
     * a `{ delete: true }` transform, and NO materialized block, then merges `[rev, rev+1]` into
     * `ranges` and advances `latest` monotonically. The reverse-apply path treats the absent
     * materialization as a deletion, so a `getBlock()` after a tombstone reads back as *absent*
     * (`undefined`) while a historical `getBlock(creationRev)` still materializes the created content.
     *
     * Maintains **Invariant P** (see {@link promotePendingTransaction}) on the write path, exactly as
     * {@link saveReplica} does: the tombstone's `actionId` loses its pending record on this block.
     *
     * Idempotent for a fixed `(rev, actionId)`; never downgrades `latest` (a no-op — still durable —
     * when an equal-or-newer revision is already present). Returns the effective latest `ActionRev`.
     */
    saveDeletion(source: ActionRev): Promise<ActionRev>;

    /**
     * Reconciles `metadata.latest` with the highest contiguous fully-promoted revision in
     * the revisions table. Intended for post-crash recovery of the Crash-D3 gap, where
     * `promotePendingTransaction` succeeded but `setLatest` did not: the revision and
     * committed-log entry are durable, but `meta.latest` still points at the prior rev
     * (or is undefined), and retry-commit is rejected because the pending record is gone.
     *
     * Stops at the first rev whose action is not yet in the committed log, preserving the
     * Crash-D2 invariant that retry-commit — not recovery — owns advancement past a half-
     * promoted state.
     *
     * Idempotent and monotonic (latest only advances forward).
     */
    recover(): Promise<{ reconciled: boolean; latest?: ActionRev }>;
}
