import type { BlockId, ActionId } from '@optimystic/db-core';
import type { StoreDurability } from './store-durability.js';
import type { StoreIdentity } from './store-identity.js';
import type { WriteGroupEntry, WriteGroupSink } from './write-group.js';
import type { StoredValue } from './raw-store-codec.js';

/**
 * One record of the seven logical block-storage stores, addressed the way `RawStoreDriver`
 * addresses it: the metadata store by block, the revisions and proofs stores by block and
 * revision, the pending, transactions and materialized stores by block and action, and the commit
 * proofs store by the proof's message hash alone — the one store not scoped to a block.
 */
export type StoreKey =
	| { store: 'metadata'; blockId: BlockId }
	| { store: 'revisions' | 'proofs'; blockId: BlockId; rev: number }
	| { store: 'pending' | 'transactions' | 'materialized'; blockId: BlockId; actionId: ActionId }
	| { store: 'commitProofs'; messageHash: string };

/** One write of a batch, its value always bytes whatever the driver above holds. `value` absent means delete. */
export type BatchEntry = WriteGroupEntry<StoreKey>;

/**
 * The backend under a {@link WriteGroupDriver}: reads, listings, and the write group's sink — ONE
 * batched write, `commit`, that applies a whole batch at once, and `sync`, which hastens the batches
 * whose sync `commit` was allowed to defer (the contract of both is on `WriteGroupSink`). The driver
 * holds every write in memory and serves it from there until a `flush()` hands the group here, so a
 * backend never sees a single put or delete, and the atomicity `promote` needs is the batch's (a
 * promote is two entries of one batch). {@link BatchBackend.deleteBlock} is the one write that is
 * NOT a batch entry, for the reason stated at its site. A `commit` resolves once the batch is applied and survives a
 * crash of this process; with `syncWithinMs` 0 it also syncs this and every earlier batch before
 * resolving, and returns an already-settled `durable`. A backend that cannot defer treats every
 * value as 0. Rejecting is a storage fault: the driver then refuses every later write and flush
 * (rule 5 of the flush contract on `RawStoreDriver.flush`).
 *
 * Reads return `R`, the representation of the `WriteGroupDriver<R>` above: bytes by default, or
 * the text the stored bytes decode to for an engine that hands values back as text. Writes are
 * bytes whatever `R` is — the driver converts each value when it hands a group here — so what a
 * backend persists, and a journal record's values, never depend on the representation above.
 *
 * Reads here are consulted only after the driver's overlay missed. They must reflect every batch
 * whose `durable` has resolved, and MAY reflect a batch earlier: the overlay serves a batch until it
 * is durable, so the only keys that reach these reads are ones whose newest write is durable, and a
 * listing the driver merges may see a batch here and in the overlay at once.
 */
export interface BatchBackend<R extends StoredValue = Uint8Array> extends WriteGroupSink<StoreKey> {
	/** What a committed batch survives (see `RawStoreDriver.durability`). */
	readonly durability: StoreDurability;
	get(key: StoreKey): Promise<R | undefined>;
	/** Ascending `[rev, value]` for every present rev in `[lo, hi]`, both inclusive, fully drained. */
	rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, R][]>;
	/** Every present pending action id for the block, fully drained. */
	listPendingActionIds(blockId: BlockId): Promise<ActionId[]>;
	/**
	 * Remove every record this backend holds for `blockId` — the one operation that takes bytes back
	 * off a node, for a block it has stopped being responsible for. Not part of the write group: it is
	 * the backend's own write, because no composition above can enumerate a block's revisions (
	 * `rangeRevisions` is a bounded `[lo, hi]` scan, and the top revision is only knowable from the
	 * metadata this operation is itself removing), while every backend has a cheap native answer for
	 * "everything under this block".
	 *
	 * **The six block-scoped stores, and only those:** metadata, revisions, pending, transactions,
	 * materialized, proofs. The seventh, **commit proofs, is deliberately left alone** — it is keyed
	 * by a consensus message's hash alone, one entry per message however many blocks that message
	 * covered, so an entry may still certify revisions of blocks this node keeps, and the key shape
	 * admits no per-block delete (see `RawStoreDriver.getCommitProof`). Nor may it touch what shares
	 * the backend's database or directory with those six: the key-value store's namespaces
	 * (`NODE_KV_NAMESPACES`), the piece store, and the journal.
	 *
	 * **Not atomic across stores, but ORDERED.** The metadata record goes first and its removal is
	 * durable — as far as {@link durability} allows — before any content store is touched. So a crash
	 * in the middle leaves content with no metadata: bytes nothing serves and no listing reports,
	 * which a later call finishes removing. It must never leave the reverse, metadata naming a
	 * `latest` whose revision record is gone, which reads as a block this node holds and then throws
	 * inside materialization. The content stores' removal need NOT be durable when this resolves.
	 *
	 * **Idempotent.** On a block whose metadata is already gone it still removes whatever content is
	 * there; on a block with nothing at all it resolves quietly. That is what lets a sweep re-run it
	 * for the same block id after a restart.
	 *
	 * The caller holds the block's write latch (Invariant 2 of `packages/db-p2p/docs/storage.md`), so
	 * no write to the block can interleave with it.
	 */
	deleteBlock(blockId: BlockId): Promise<void>;
	/** Optional, with the contract of `RawStoreDriver.storeIdentity`. Omit rather than stub. */
	storeIdentity?(): StoreIdentity;
	/** Optional — every block id with metadata, as `RawStoreDriver.listBlockIds`. Omit rather than stub. */
	listBlockIds?(): AsyncIterable<BlockId>;
	/** Optional — best cheap byte estimate. Omit rather than stub. */
	approximateBytesUsed?(): Promise<number>;
	/** Optional — the location's free bytes, under the contract stated on `IRawStorage.getApproximateBytesFree` (`packages/db-p2p/src/storage/i-raw-storage.ts`): it REJECTS on a failed read, never answering 0. Omit rather than stub. */
	approximateBytesFree?(): Promise<number>;
	/** Optional — release what the backend holds open. The driver flushes before calling it. */
	close?(): Promise<void>;
}

/**
 * One string per {@link StoreKey}, equal exactly when the keys name the same record. The driver's
 * overlay is keyed by it.
 *
 * Every string starts with its store's name and a `/`; the store names are fixed literals with no
 * `/`, so no two stores' strings can meet. Within a store, the block id is length-prefixed so that
 * no block id can run into the part after it: a header block's id is its collection's name, and an
 * action id is chosen by whoever originates a write, so neither is free of any particular
 * character. A commit proof's message hash is the whole rest of its string, so it needs no prefix.
 */
export function canonicalStoreKey(key: StoreKey): string {
	if (key.store === 'commitProofs') return `commitProofs/${key.messageHash}`;
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
