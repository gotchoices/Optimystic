import type { BlockId, BlockOperation, BlockOperations, BlockStore, IBlock, Transform, Transforms } from "../index.js";

/**
 * Mutates the given block with a copy of the given operation.
 *
 * @warning **MUTATES IN PLACE** - Callers must clone the block first if the original needs preservation.
 * Storage implementations must clone on get/save to prevent cross-revision contamination.
 * @see docs/internals.md for mutation contracts
 */
export function applyOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation) {
	if (Array.isArray(inserted)) {
		(block as unknown as any)[entity].splice(index, deleteCount, ...structuredClone(inserted));
	} else {
		(block as unknown as any)[entity] = structuredClone(inserted);
	}
}

/**
 * Mutates the given block with the given set of operations.
 *
 * @warning **MUTATES IN PLACE** - Callers must clone the block first if the original needs preservation.
 * @see docs/internals.md for mutation contracts
 */
export function applyOperations(block: IBlock, operations: BlockOperations) {
	for (const op of operations) {
		applyOperation(block, op);
	}
}

/** Returns a copy of the block with the given operation applied */
export function withOperation(block: IBlock, [entity, index, deleteCount, inserted]: BlockOperation) {
	if (Array.isArray(inserted)) {
		const source = (block as any)[entity];
		return { ...block, [entity]: [...source.slice(0, index), ...structuredClone(inserted), ...source.slice(index + deleteCount)] };
	} else {
		return { ...block, [entity]: structuredClone(inserted) };
	}
}

/** The set of distinct block ids affected by the transform */
export function blockIdsForTransforms(transforms: Transforms | undefined) {
	if (!transforms) return [];
	const insertIds = Object.keys(transforms.inserts ?? {});
	const updateIds = Object.keys(transforms.updates ?? {});
	const deleteIds = transforms.deletes ?? [];
	return [...new Set([...insertIds, ...updateIds, ...deleteIds])];
}

/** Returns an empty transform */
export function emptyTransforms(): Transforms {
	return { inserts: {}, updates: {}, deletes: [] };
}

/**
 * Creates a deep copy of a Transforms object.
 *
 * @pitfall Updates arrays MUST be deep cloned - a shallow copy like `{ ...transform.updates }`
 * shares array references, causing mutations in one consumer to affect others.
 * @see docs/internals.md "Shallow Copy of Transforms" pitfall
 */
export function copyTransforms(transform: Transforms): Transforms {
	// Deep clone updates arrays to prevent shared references
	const updates = transform.updates
		? Object.fromEntries(Object.entries(transform.updates).map(([k, v]) => [k, structuredClone(v)]))
		: undefined;
	return { inserts: { ...transform.inserts }, updates, deletes: transform.deletes ? [...transform.deletes] : undefined };
}

export function mergeTransforms(a: Transforms, b: Transforms): Transforms {
	return {
		inserts: { ...a.inserts, ...b.inserts },
		updates: { ...a.updates, ...b.updates },
		deletes: [...(a.deletes ?? []), ...(b.deletes ?? [])]
	};
}

export function isTransformsEmpty(transform: Transforms): boolean {
	return Object.keys(transform.inserts ?? {}).length === 0
		&& Object.keys(transform.updates ?? {}).length === 0
		&& (transform.deletes?.length ?? 0) === 0;
}

export function concatTransforms(...transforms: Transforms[]): Transforms {
	return transforms.reduce((acc, m) => mergeTransforms(acc, m), emptyTransforms());
}


/**
 * Extracts the transform for a specific block from a Transforms object.
 *
 * @pitfall Updates array MUST be deep cloned - extracting without cloning shares
 * the array reference, causing mutations to affect the original Transforms.
 * @see docs/internals.md "Shallow Copy of Transforms" pitfall
 */
export function transformForBlockId(transform: Transforms, blockId: BlockId): Transform {
	return {
		...(transform.inserts && blockId in transform.inserts ? { insert: transform.inserts[blockId] } : {}),
		// Clone updates array to prevent shared references
		...(transform.updates && blockId in transform.updates ? { updates: structuredClone(transform.updates[blockId]) } : {}),
		...(transform.deletes?.includes(blockId) ? { delete: true } : {})
	};
}

export function transformsFromTransform(transform: Transform, blockId: BlockId): Transforms {
	return {
		inserts: transform.insert ? { [blockId]: transform.insert } : {},
		updates: transform.updates ? { [blockId]: transform.updates } : {},
		deletes: transform.delete ? [blockId] : []
	};
}

export function applyTransformToStore<T extends IBlock>(transform: Transforms, store: BlockStore<T>) {
	for (const blockId of transform.deletes ?? []) {
		store.delete(blockId);
	}
	for (const [, block] of Object.entries(transform.inserts ?? {})) {
		store.insert(block as T);
	}
	for (const [blockId, operations] of Object.entries(transform.updates ?? {})) {
		for (const op of operations) {
			store.update(blockId, op);
		}
	}
}

/** Applies a transform to the given block */
export function applyTransform(block: IBlock | undefined, transform: Transform): IBlock | undefined {
	if (transform.insert) {
		block = transform.insert;
	}
	if (block && transform.updates) {
		applyOperations(block, transform.updates);
	}
	if (transform.delete) {
		return undefined;
	}
	return block;
}

/** Concatenates a transform to the given transforms */
export function concatTransform(transforms: Transforms, blockId: BlockId, transform: Transform): Transforms {
	return {
		inserts: { ...transforms.inserts, ...(transform.insert ? { [blockId]: transform.insert } : {}) },
		updates: { ...transforms.updates, ...(transform.updates ? { [blockId]: transform.updates } : {}) },
		deletes: [...(transforms.deletes ?? []), ...(transform.delete ? [blockId] : [])]
	};
}
