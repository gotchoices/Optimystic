import type { BlockId, ActionId } from '@optimystic/db-core';
import type { StoreDurability } from './store-durability.js';
import type { StoreIdentity } from './store-identity.js';
import type { WriteGroupEntry } from './write-group.js';

/**
 * One record of the six logical block-storage stores, addressed the way `RawStoreDriver`
 * addresses it: the metadata store by block, the revisions and proofs stores by block and
 * revision, the pending, transactions and materialized stores by block and action.
 */
export type StoreKey =
	| { store: 'metadata'; blockId: BlockId }
	| { store: 'revisions' | 'proofs'; blockId: BlockId; rev: number }
	| { store: 'pending' | 'transactions' | 'materialized'; blockId: BlockId; actionId: ActionId };

/** One write of a batch. `value` absent means delete. */
export type BatchEntry = WriteGroupEntry<StoreKey>;

/**
 * The backend under a {@link WriteGroupDriver}: reads, listings, and ONE write, `commit`, that
 * applies a whole batch at once. The driver holds every write in memory and serves it from there
 * until a `flush()` hands the group here, so a backend never sees a single put or delete, and the
 * atomicity `promote` needs is the batch's (a promote is two entries of one batch).
 *
 * Reads here are consulted only after the driver's overlay missed; they must reflect every batch
 * whose `commit` has resolved.
 */
export interface BatchBackend {
	/** What a committed batch survives (see `RawStoreDriver.durability`). */
	readonly durability: StoreDurability;
	get(key: StoreKey): Promise<Uint8Array | undefined>;
	/** Ascending `[rev, value]` for every present rev in `[lo, hi]`, both inclusive, fully drained. */
	rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]>;
	/** Every present pending action id for the block, fully drained. */
	listPendingActionIds(blockId: BlockId): Promise<ActionId[]>;
	/**
	 * Apply every entry, in order, atomically and as durably as {@link durability} says, before
	 * resolving. Rejecting is a storage fault: the driver then refuses every later write and flush
	 * (rule 5 of the flush contract on `RawStoreDriver.flush`).
	 */
	commit(entries: readonly BatchEntry[]): Promise<void>;
	/** Optional, with the contract of `RawStoreDriver.storeIdentity`. Omit rather than stub. */
	storeIdentity?(): StoreIdentity;
	/** Optional — every block id with metadata, as `RawStoreDriver.listBlockIds`. Omit rather than stub. */
	listBlockIds?(): AsyncIterable<BlockId>;
	/** Optional — best cheap byte estimate. Omit rather than stub. */
	approximateBytesUsed?(): Promise<number>;
	/** Optional — release what the backend holds open. The driver flushes before calling it. */
	close?(): Promise<void>;
}

/**
 * One string per {@link StoreKey}, equal exactly when the keys name the same record. The driver's
 * overlay is keyed by it.
 *
 * The block id is length-prefixed so that no block id can run into the part after it: a header
 * block's id is its collection's name, and an action id is chosen by whoever originates a write,
 * so neither is free of any particular character. The store names are fixed literals with no
 * `/`, which is all the rest of the shape relies on.
 */
export function canonicalStoreKey(key: StoreKey): string {
	const block = `${key.blockId.length}:${key.blockId}`;
	switch (key.store) {
		case 'metadata':
			return `metadata/${block}`;
		case 'revisions':
		case 'proofs':
			return `${key.store}/${block}/${key.rev}`;
		case 'pending':
		case 'transactions':
		case 'materialized':
			return `${key.store}/${block}/${key.actionId}`;
	}
}
