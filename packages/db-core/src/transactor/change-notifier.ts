import type { BlockId, CollectionId } from '../index.js';
import type { ActionId } from '../collection/action.js';

/** A commit landed on this node mutating one collection's blocks. */
export type CollectionChangeEvent = {
	/** Header/collection id of the affected collection (block.header.collectionId). */
	readonly collectionId: CollectionId;
	/** Blocks within that collection mutated by this commit. */
	readonly blockIds: readonly BlockId[];
	readonly actionId: ActionId;
	readonly rev: number;
};

export type CollectionChangeListener = (event: CollectionChangeEvent) => void;

export interface IBlockChangeNotifier {
	/**
	 * Subscribe to commits that mutate the given collection. Returns an
	 * idempotent unsubscribe. Listeners are invoked AFTER the commit's critical
	 * section (locks released), synchronously in commit order; a throwing
	 * listener must not break the commit or other listeners (log + continue).
	 */
	onCollectionChange(collectionId: CollectionId, listener: CollectionChangeListener): () => void;
}

export function isBlockChangeNotifier(x: unknown): x is IBlockChangeNotifier {
	return !!x && typeof (x as IBlockChangeNotifier).onCollectionChange === 'function';
}
