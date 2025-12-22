import type { BlockId, ActionId, ActionRev, Transform, IBlock } from "@optimystic/db-core";
import type { BlockMetadata } from "./struct.js";

export interface IRawStorage {
	// Metadata operations
	getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined>;
	saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void>;

	// Revision operations
	getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined>;
	saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void>;
	/** List revisions in ascending or descending order, depending on startRev and endRev - startRev and endRev are inclusive */
	listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev>;

	// Action operations
	getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
	savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;
	deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
	listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId>;

	getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined>;
	saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void>;

	// Block materialization operations
	getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined>;
	saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void>;

	// Promote a pending action to a committed action
	promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void>;
}
