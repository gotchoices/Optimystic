import type { IBlock, Transform, ActionId, ActionRev } from "@optimystic/db-core";

/** Interface for block-level storage operations */
export interface IBlockStorage {
    /** Gets the latest revision information for this block */
    getLatest(): Promise<ActionRev | undefined>;

    /** Gets a materialized block at the given revision */
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
}
