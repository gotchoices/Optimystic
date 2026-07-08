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

	/**
	 * Approximate bytes currently stored by this backend.
	 *
	 * Used by `StorageMonitor` to feed real used-space figures into ring selection.
	 * Implementations should return their best cheap estimate (e.g. on-disk size for
	 * filesystem backends, tracked footprint for in-memory backends). The result is
	 * advisory — `StorageMonitor` treats a missing implementation as 0.
	 */
	getApproximateBytesUsed?(): Promise<number>;

	/**
	 * Enumerate the block ids that currently have durable state in this backend
	 * (one id per block that has committed/replicated metadata). Used at node
	 * startup to seed the resilience monitors' owned-block tracked set from blocks
	 * already on disk from a previous run, so churn-spread / rebalance protection
	 * covers them without waiting for each to be touched again.
	 *
	 * Streamed (AsyncIterable) so a large store does not force the whole id list
	 * into memory at once. Order is unspecified. Optional: a backend that omits it
	 * (or an in-memory backend with nothing durable across a restart) simply yields
	 * no seed — the monitors still populate over time via the live change feed.
	 */
	listBlockIds?(): AsyncIterable<BlockId>;
}
