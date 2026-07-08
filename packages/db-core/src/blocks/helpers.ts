import type { BlockOperation, IBlock, BlockId, BlockStore, ReadPurpose } from "../index.js";
import { applyOperation } from "../transform/helpers.js";

export async function get<T extends IBlock>(store: BlockStore<T>, id: BlockId, purpose?: ReadPurpose): Promise<T> {
	const block = await store.tryGet(id, purpose);
	if (!block) throw Error(`Missing block (${id})`);
	return block;
}

export function apply<T extends IBlock>(store: BlockStore<T>, block: IBlock, op: BlockOperation) {
	applyOperation(block, op);
	store.update(block.header.id, op);
}
