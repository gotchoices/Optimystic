import type { BlockType, IBlock, BlockId, BlockHeader, BlockOperation } from "./index.js";

/** Why a block was read, used to filter the optimistic-concurrency conflict (read) set.
 *
 * - `value` — the transaction's result depends on this block's CONTENT (a leaf/entry, a log
 *   entry, or an interior node whose keys/counts were used as data). Always retained.
 * - `navigation` — an interior structural block (a B-tree branch) walked through ONLY to reach
 *   a separately-captured `value` read further down the same descent. May be dropped from the
 *   conflict set, because any concurrent restructuring that would change the queried result also
 *   bumps the revision of a `value` block that stays in the set (the target leaf). See
 *   docs/correctness.md Theorem 5.
 *
 * Defaults to `value` EVERYWHERE a read is captured, so an unclassified read is always retained
 * (fail-safe): a forgotten tag can only cause an extra false-positive rejection, never a missed
 * conflict. Only the B-tree point-lookup descent opts specific interior reads into `navigation`. */
export type ReadPurpose = 'value' | 'navigation';

export type BlockSource<T extends IBlock> = {
	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
	/** Fetch a block by id. `purpose` classifies WHY the block is being read for OCC read-set
	 *  filtering (see {@link ReadPurpose}); it defaults to `value`, so existing callers that omit
	 *  it capture a retained read exactly as before. */
	tryGet(id: BlockId, purpose?: ReadPurpose): Promise<T | undefined>;
	generateId(): BlockId;
};

export type BlockStore<T extends IBlock> = BlockSource<T> & {
	insert(block: T): void;
	update(blockId: BlockId, op: BlockOperation): void;
	delete(blockId: BlockId): void;
};
