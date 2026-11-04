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
 * @pitfall Both `inserts` and `updates` MUST be deep cloned. A shallow copy like
 * `{ ...transform.updates }` or `{ ...transform.inserts }` shares references, causing
 * mutations in one consumer to affect others. {@link shallowCopyTransforms} is the one
 * exception, and only for values that `Tracker` alone changes.
 * @see docs/internals.md "Shallow Copy of Transforms" pitfall
 */
export function copyTransforms(transform: Transforms): Transforms {
	const inserts = transform.inserts
		? Object.fromEntries(Object.entries(transform.inserts).map(([k, v]) => [k, structuredClone(v)]))
		: {};
	const updates = transform.updates
		? Object.fromEntries(Object.entries(transform.updates).map(([k, v]) => [k, structuredClone(v)]))
		: undefined;
	return { inserts, updates, deletes: transform.deletes ? [...transform.deletes] : undefined };
}

/**
 * New outer maps and a new `deletes` over the SAME inserted blocks and update lists, for a staged-state
 * snapshot and whatever is built from it. Safe only because `Tracker` is the sole thing that changes
 * those values and copies one before it first changes it, so anything that changes staged values
 * outside `Tracker` needs {@link copyTransforms}.
 * @see docs/internals.md "Shallow Copy of Transforms" pitfall
 */
export function shallowCopyTransforms(transform: Transforms): Transforms {
	return {
		inserts: { ...transform.inserts },
		updates: transform.updates ? { ...transform.updates } : undefined,
		deletes: transform.deletes ? [...transform.deletes] : undefined,
	};
}

export function mergeTransforms(a: Transforms, b: Transforms): Transforms {
	// updates: for a block id present in both sides, concatenate a's ops then b's ops
	// (order-preserving) rather than letting b's array replace a's. inserts stay last-wins.
	const updates: { [blockId: BlockId]: BlockOperation[] } = { ...a.updates };
	for (const [id, ops] of Object.entries(b.updates ?? {})) {
		updates[id] = updates[id] ? [...updates[id], ...ops] : ops;
	}
	return {
		inserts: { ...a.inserts, ...b.inserts },
		updates,
		deletes: [...new Set([...(a.deletes ?? []), ...(b.deletes ?? [])])]
	};
}

/**
 * Fold `delta` into `target` under `Tracker`'s semantics — what `target` would hold had a tracker
 * holding it absorbed `delta` (`Tracker.absorb`): a delete removes the id's insert and updates and
 * lists it deleted; an insert replaces the id's block and takes it off the deletes; an update of a
 * block `target` inserts is applied into that block, and otherwise appended to the id's update list.
 * Changes `target`'s maps in place but never a value in them: a value the delta changes is replaced
 * by a changed copy, so a snapshot sharing `target`'s values ({@link shallowCopyTransforms}) stays as
 * captured. `delta`'s values are taken by reference and never changed, so a delta folded here can be
 * folded again elsewhere.
 *
 * `SegmentList.seal` folds the open segment's per-action deltas into one with it.
 * {@link mergeTransforms} is the other combination, for transforms that are not one tracker's: it
 * keeps an insert and a later update of it apart and never takes anything off the deletes.
 *
 * NOTE: an update of a block `target` inserts copies that block once per delta that updates it — at
 * the seal, one copy per later action of a transaction that writes a node an earlier action of it
 * created. If a long transaction ever shows it, fold a second update into the copy the first made.
 */
export function foldTransforms(target: Transforms, delta: Transforms): void {
	const inserts = target.inserts ??= {};
	const updates = target.updates ??= {};
	const deletes = target.deletes ??= [];
	for (const id of delta.deletes ?? []) {
		delete inserts[id];
		delete updates[id];
		if (!deletes.includes(id)) deletes.push(id);
	}
	for (const [id, block] of Object.entries(delta.inserts ?? {})) {
		inserts[id] = block;
		const index = deletes.indexOf(id);
		if (index >= 0) deletes.splice(index, 1);
	}
	for (const [id, ops] of Object.entries(delta.updates ?? {})) {
		if (Object.hasOwn(inserts, id)) {
			const block = structuredClone(inserts[id]!);
			applyOperations(block, ops);
			inserts[id] = block;
		} else {
			const held = updates[id];
			updates[id] = held === undefined ? ops : [...held, ...ops];
		}
	}
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
 * @pitfall Both `insert` and `updates` MUST be deep cloned - extracting without cloning shares
 * the object/array reference, causing mutations (e.g. `applyTransform` mutating `insert` in place
 * when `updates` ride along) to affect the original Transforms.
 * @see docs/internals.md "Shallow Copy of Transforms" pitfall
 *
 * NOTE: clones unconditionally, even for read-only callers (e.g. StorageRepo.pend's classify pass);
 * if large inserts ever show up in a pend/commit profile, add a non-cloning variant for those callers.
 */
export function transformForBlockId(transform: Transforms, blockId: BlockId): Transform {
	return {
		// Clone insert to prevent applyTransform's in-place mutation from reaching the original
		...(transform.inserts && blockId in transform.inserts ? { insert: structuredClone(transform.inserts[blockId]) } : {}),
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

/**
 * Concatenates a single block's transform onto the given transforms.
 *
 * Delegates to `mergeTransforms` so the two helpers cannot drift: updates for a shared
 * block id concatenate (order-preserving), deletes dedupe, inserts stay last-wins.
 */
export function concatTransform(transforms: Transforms, blockId: BlockId, transform: Transform): Transforms {
	return mergeTransforms(transforms, transformsFromTransform(transform, blockId));
}
