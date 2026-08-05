import type { BlockId, CollectionHeaderBlock } from "../../index.js";
import { registerBlockType } from "../../blocks/block-types.js";
import { registerCollectionType } from "../../collection/collection-type-registry.js";
import { nameof } from "../../utility/nameof.js";

export const TreeHeaderBlockType = registerBlockType("TRE", "TreeHeaderBlock");

registerCollectionType({
	blockType: TreeHeaderBlockType,
	name: "Tree",
});

export type TreeCollectionHeaderBlock = CollectionHeaderBlock & {
	rootId: BlockId;
};

export const rootId$ = nameof<TreeCollectionHeaderBlock>("rootId");

/** Represents a unit of change to a tree collection. */
export type TreeReplaceAction<TKey, TEntry> = [
	// The key to replace
	key: TKey,
	// The new entry to replace the old entry with (if not provided, the key is deleted)
	entry?: TEntry,
][];

