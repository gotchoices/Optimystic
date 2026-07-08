import type { BlockId, ActionId } from "@optimystic/db-core";

/**
 * Bytes-valued, per-logical-store driver surface. Each backend implements the
 * five block-storage stores (metadata, revisions, pending, transactions,
 * materialized) over its native mechanism (LevelDB tag-ranges, five SQLite
 * tables, five IndexedDB object stores, five filesystem subdirectories, five
 * in-memory maps). `KvRawStorage` layers all JSON serialization and call
 * orchestration on top — drivers never (de)serialize values and never see the
 * `BlockMetadata`/`Transform`/`IBlock` types. Drivers speak only
 * `Uint8Array`/`BlockId`/`ActionId`/`number`.
 *
 * ### Iteration semantics (drain-before-yield)
 *
 * `rangeRevisions` and `listPendingActionIds` return an `AsyncIterable`, but a
 * driver MUST drain its native cursor/iterator into memory BEFORE yielding to
 * the consumer. A live LevelDB iterator, IndexedDB transaction, or SQLite
 * cursor must not straddle the consumer's `await`s: IndexedDB auto-commits an
 * idle transaction, SQLite would hold its mutex slot, and LevelDB pins native
 * resources. The kernel encodes this as a contract (not a shared implementation)
 * because the drain is backend-specific. The conformance suite exercises it by
 * interleaving other awaits between yielded items.
 *
 * ### Promote atomicity
 *
 * `promote` is the ONLY cross-key atomic operation the kernel requires. Every
 * other write is a single put/delete. Each backend satisfies `promote` with its
 * native atomic mechanism (LevelDB batch, SQLite transaction, IndexedDB
 * readwrite transaction, filesystem rename); the kernel never assumes an
 * atomicity a backend cannot deliver.
 */
export interface RawStoreDriver {
	// metadata store — keyed by blockId
	getMetadata(blockId: BlockId): Promise<Uint8Array | undefined>;
	putMetadata(blockId: BlockId, value: Uint8Array): Promise<void>;

	// revisions store — keyed by (blockId, rev), ORDERED BY rev
	getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined>;
	putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void>;
	/**
	 * Yield `[rev, value]` for every present rev in `[lo, hi]` (both inclusive),
	 * ascending when `reverse` is false, descending when `reverse` is true. The
	 * driver MUST drain any native cursor into memory before yielding — see the
	 * "drain-before-yield" contract above.
	 */
	rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]>;

	// pending store — keyed by (blockId, actionId)
	getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;
	deletePending(blockId: BlockId, actionId: ActionId): Promise<void>;
	/** Yield each present pending actionId for the block. MUST drain before yielding (see above). */
	listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId>;

	// transactions store — keyed by (blockId, actionId)
	getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;

	// materialized store — keyed by (blockId, actionId)
	getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined>;
	putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void>;
	deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void>;

	/**
	 * Atomically move `pending(blockId, actionId)` → `transactions(blockId, actionId)`:
	 * write the transactions entry and remove the pending entry as one indivisible
	 * step (batch / DB transaction / rename). A crash must leave exactly one of the
	 * two states, never both/neither. Throw
	 * `Pending action <actionId> not found for block <blockId>` when no pending
	 * entry exists. This is the ONLY cross-key atomic operation the kernel requires.
	 */
	promote(blockId: BlockId, actionId: ActionId): Promise<void>;

	/** Optional — enumerate block ids with durable metadata (startup seed). Passed through by the kernel. */
	listBlockIds?(): AsyncIterable<BlockId>;
	/** Optional — best cheap byte estimate. Passed through by the kernel. */
	approximateBytesUsed?(): Promise<number>;
	/** Optional — release the underlying handle. */
	close?(): Promise<void>;
}
