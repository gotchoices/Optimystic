import type { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, BlockSource as IBlockSource } from "../index.js";
import { applyOperation, applyOperations, emptyTransforms, blockIdsForTransforms, ensured } from "../index.js";

/** A block store that collects transformations, without applying them to the underlying source.
 * Transformations are also applied to the retrieved blocks, making it seem like the source has been modified.
 */
export class Tracker<T extends IBlock> implements IBlockStore<T> {
	/** Per-id memo of the materialized (source block + all `updates[id]` ops) result, so a
	 * repeated read of a hot op-carrying block is O(block size) instead of O(block size + ops).
	 * Kept fresh incrementally on {@link update}, dropped on {@link insert}/{@link delete}/{@link reset},
	 * and invalidated when the source's generation for the id advances (external cache mutation).
	 * Only populated for sources that expose `getGeneration` — without a drift signal we cannot
	 * detect source changes, so those fall back to always-replay. `gen` is the source generation of
	 * the base block content the memo was built from. */
	private materialized = new Map<BlockId, { block: T; gen: number }>();

	constructor(
		private readonly source: IBlockSource<T>,
		/** The collected set of transformations to be applied. Treat as immutable */
		public transforms = emptyTransforms(),
	) { }

	/** The source's generation for an id, or undefined if the source cannot report drift. */
	private sourceGeneration(id: BlockId): number | undefined {
		const src = this.source as { getGeneration?: (id: BlockId) => number };
		return typeof src.getGeneration === 'function' ? src.getGeneration(id) : undefined;
	}

	async tryGet(id: BlockId): Promise<T | undefined> {
		// NOTE: precedence here is insert > delete > source+updates. In a well-formed transform an id is
		// never in both `inserts` and `deletes` (insert/delete each clear the other), so order is moot. It
		// only diverges from the canonical `applyTransform` (delete-last-wins, see struct.ts / helpers.ts:132)
		// in the malformed insert+delete state reachable via the phantom-delete bug (double-delete then
		// reinsert). Likewise the insert path intentionally skips `updates[id]` — inserted blocks bake ops
		// in-place via update(); a stale pre-insert `updates[id]` is discarded here but would be re-applied
		// on commit. Both are read-vs-commit inconsistencies confined to malformed states; fix the source
		// bug (phantom delete / stale updates) rather than papering over it here.
		if (this.transforms.inserts && Object.hasOwn(this.transforms.inserts, id)) {
			return structuredClone(this.transforms.inserts[id]) as T;
		}
		if (this.transforms.deletes?.includes(id)) {
			return undefined;
		}
		const gen = this.sourceGeneration(id);
		const memo = this.materialized.get(id);
		if (memo && (gen === undefined || memo.gen === gen)) {
			return structuredClone(memo.block);           // O(block size), no replay
		}
		const block = await this.source.tryGet(id);
		if (block) {
			const ops = this.transforms.updates?.[id] ?? [];
			if (ops.length > 0) {
				applyOperations(block, ops);
				// Memoize only when the source can report drift, and stamp with the generation read
				// AFTER the load — the source may bump during tryGet (a cache miss-load), and stamping
				// with the pre-load generation would force a needless reload on the very next read.
				const freshGen = this.sourceGeneration(id);
				if (freshGen !== undefined) {
					this.materialized.set(id, { block, gen: freshGen });
				}
				return structuredClone(block);              // clone so callers can't mutate the memo
			}
		}
		return block;                                    // no-ops path unchanged (source already cloned)
	}

	generateId(): BlockId {
		return this.source.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.source.createBlockHeader(type, newId);
	}

	insert(block: T) {
		const inserts = this.transforms.inserts ??= {};
		inserts[block.header.id] = structuredClone(block);
		// Served from `inserts` now, not source+updates — the materialized memo no longer applies.
		this.materialized.delete(block.header.id);
		const deletes = this.transforms.deletes;
		const deleteIndex = deletes?.indexOf(block.header.id) ?? -1;
		if (deleteIndex >= 0) {
			deletes!.splice(deleteIndex, 1);
		}
	}

	update(blockId: BlockId, op: BlockOperation) {
		const inserted = this.transforms.inserts?.[blockId];
		if (inserted) {
			applyOperation(inserted, op);
		} else {
			const updates = this.transforms.updates ??= {};
			ensured(updates, blockId, () => []).push(structuredClone(op));
			// The memo already equals (base source content + prior ops); applying just the new op
			// keeps it equal to the full ops list — O(1), no full replay. Leave `gen` untouched: it
			// still records the base-content generation, so a later external source change still
			// forces a reload. (Refreshing gen here would mask stale base content.)
			const memo = this.materialized.get(blockId);
			if (memo) {
				applyOperation(memo.block, op);
			}
		}
	}

	delete(blockId: BlockId) {
		if (this.transforms.inserts) delete this.transforms.inserts[blockId];
		if (this.transforms.updates) delete this.transforms.updates[blockId];
		this.materialized.delete(blockId);
		const deletes = this.transforms.deletes ??= [];
		deletes.push(blockId);
	}

	reset(newTransform = emptyTransforms()) {
		const oldTransform = this.transforms;
		this.transforms = newTransform;
		this.materialized.clear();
		return oldTransform;
	}

	transformedBlockIds(): BlockId[] {
		return blockIdsForTransforms(this.transforms);
	}

	conflicts(blockIds: Set<BlockId>) {
		return this.transformedBlockIds().filter(id => blockIds.has(id));
	}
}
