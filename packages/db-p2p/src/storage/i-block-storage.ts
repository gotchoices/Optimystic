import type { IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";

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

    /** Saves a revision */
    saveRevision(rev: number, actionId: ActionId): Promise<void>;

    /** Promotes a pending action to committed */
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
     * No-op (still durable) when an equal-or-newer revision is already present: `latest`
     * is never downgraded. Idempotent for a fixed `(rev, actionId)`. Returns the
     * effective latest `ActionRev`.
     */
    saveReplica(block: IBlock, source?: ActionRev): Promise<ActionRev>;

    /**
     * Writes a forward TOMBSTONE revision that reverses a block creation: persists `rev → actionId`,
     * a `{ delete: true }` transform, and NO materialized block, then merges `[rev, rev+1]` into
     * `ranges` and advances `latest` monotonically. The reverse-apply path treats the absent
     * materialization as a deletion, so a `getBlock()` after a tombstone reads back as *absent*
     * (`undefined`) while a historical `getBlock(creationRev)` still materializes the created content.
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
