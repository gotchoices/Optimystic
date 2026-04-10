import type { BlockType } from "../blocks/index.js";
import type { ITransactor } from "../transactor/index.js";
import type { CollectionId, ICollection } from "./struct.js";

export interface CollectionTypeDescriptor {
	/** The block type used for this collection's header block (e.g. "DIH", "TRE") */
	blockType: BlockType;
	/** Human-readable name (e.g. "Diary", "Tree") */
	name: string;
	/** Optional factory to open a collection with default settings.
	 *  Not all types support this (e.g. Tree requires keyFromEntry/compare). */
	open?: (transactor: ITransactor, id: CollectionId) => Promise<ICollection<any>>;
}

const collectionTypes = new Map<BlockType, CollectionTypeDescriptor>();

/** Register a collection type by its header block type. Throws if already registered. */
export function registerCollectionType(descriptor: CollectionTypeDescriptor): void {
	if (collectionTypes.has(descriptor.blockType)) {
		throw new Error(
			`Collection type ${descriptor.blockType} (${descriptor.name}) already registered`
			+ ` (${collectionTypes.get(descriptor.blockType)!.name})`
		);
	}
	collectionTypes.set(descriptor.blockType, descriptor);
}

/** Look up a collection type descriptor by its header block type. */
export function getCollectionType(blockType: BlockType): CollectionTypeDescriptor | undefined {
	return collectionTypes.get(blockType);
}

/** Returns all registered collection type descriptors. */
export function getCollectionTypes(): ReadonlyMap<BlockType, CollectionTypeDescriptor> {
	return collectionTypes;
}
