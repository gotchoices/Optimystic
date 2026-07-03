import type { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, BlockSource as IBlockSource } from "../index.js";
import { applyOperation, emptyTransforms, blockIdsForTransforms, ensured } from "../index.js";

/** A block store that collects transformations, without applying them to the underlying source.
 * Transformations are also applied to the retrieved blocks, making it seem like the source has been modified.
 */
export class Tracker<T extends IBlock> implements IBlockStore<T> {
	constructor(
		private readonly source: IBlockSource<T>,
		/** The collected set of transformations to be applied. Treat as immutable */
		public transforms = emptyTransforms(),
	) { }

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
		const block = await this.source.tryGet(id);
		if (block) {
			const ops = this.transforms.updates?.[id] ?? [];
			ops.forEach(op => applyOperation(block!, op));
		}
		return block;
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
		}
	}

	delete(blockId: BlockId) {
		if (this.transforms.inserts) delete this.transforms.inserts[blockId];
		if (this.transforms.updates) delete this.transforms.updates[blockId];
		const deletes = this.transforms.deletes ??= [];
		deletes.push(blockId);
	}

	reset(newTransform = emptyTransforms()) {
		const oldTransform = this.transforms;
		this.transforms = newTransform;
		return oldTransform;
	}

	transformedBlockIds(): BlockId[] {
		return blockIdsForTransforms(this.transforms);
	}

	conflicts(blockIds: Set<BlockId>) {
		return this.transformedBlockIds().filter(id => blockIds.has(id));
	}
}
