import type { PieceId } from '@optimystic/db-core';
import { identityForHandle, type IPieceStore, type StoreDurability, type StoreIdentity } from '@optimystic/db-p2p';
import type { OptimysticWebDBHandle } from './db.js';
import { resolveStrictDurability, transactionDurability, type IndexedDBDurabilityOptions } from './durability.js';
import { IDB_HANDLE_SCHEME } from './indexeddb-storage.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:pieces');

/** Ids per `list` page: each page is one `getAllKeys` under its own transaction. */
export const PIECE_LIST_PAGE = 1000;

export type IndexedDBPieceStoreOptions = IndexedDBDurabilityOptions;

/**
 * `bytes` itself when it spans its whole `ArrayBuffer`, otherwise a copy that does. Structured
 * clone of a typed array stores its whole buffer, so a piece handed as a view into a larger buffer
 * would store the larger buffer and read back as a view into it. The builder normally hands whole
 * buffers, so the copy is rare.
 */
function wholeBufferBytes(bytes: Uint8Array): Uint8Array {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/**
 * The browser {@link IPieceStore}: one `pieces` object store in the database `openOptimysticWebDb`
 * opens, sharing the handle with `IndexedDBRawStorage`, `IndexedDBKVStore` and the identity helper.
 * Not a `RawStoreDriver` store and not part of the journal: a piece is raw bytes, stored by
 * structured clone, and needs no cross-key atomicity (docs/blobs.md §The local store).
 *
 * Each put is its own transaction, strict where the browser honours `durability`: the presence
 * check and the write share it, and it completes only once the browser has put it on the disk, so a
 * put that has resolved is durable and `flush()` has nothing to do. One transaction per piece
 * rather than one across a blob, so a long stream never holds a transaction open, which IndexedDB
 * would commit while the builder awaits its source between pieces. Two alternatives were rejected:
 * relaxed puts with a strict flush, since IndexedDB promises nothing about which relaxed
 * transactions survive a power cut and a later strict one would not cover them (the reason
 * `IndexedDBJournalStore` journals); and holding puts in memory until the flush, which would keep a
 * whole blob in memory.
 *
 * There is no `close`: the handle is shared, and the host closes it after the node has stopped and
 * the block store has closed. The store holds nothing in memory to release.
 */
export class IndexedDBPieceStore implements IPieceStore {
	/** `'power-loss'` where puts are strict transactions, else `'process-crash'`; fixed at construction. */
	readonly durability: StoreDurability;

	private readonly identity: StoreIdentity;
	private readonly strict: boolean;

	constructor(private readonly db: OptimysticWebDBHandle, options: IndexedDBPieceStoreOptions = {}) {
		this.strict = resolveStrictDurability(options);
		this.durability = this.strict ? 'power-loss' : 'process-crash';
		this.identity = identityForHandle(IDB_HANDLE_SCHEME, db);
	}

	/** The identity `IndexedDBJournalStore` reports over this handle, so `blockStoreCountsPieces` counts the pieces once. */
	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	async has(id: PieceId): Promise<boolean> {
		return (await this.db.getKey('pieces', id)) !== undefined;
	}

	/** Structured clone returns a fresh array per read, which no one else holds. */
	async get(id: PieceId): Promise<Uint8Array | undefined> {
		return this.db.get('pieces', id);
	}

	async put(id: PieceId, bytes: Uint8Array): Promise<void> {
		const tx = this.db.transaction('pieces', 'readwrite', { durability: transactionDurability(this.strict) });
		const write = async (): Promise<void> => {
			if (await tx.store.getKey(id) === undefined) await tx.store.put(wholeBufferBytes(bytes), id);
		};
		// Observing `tx.done` beside the requests means a failed request (a quota refusal included)
		// rejects this call rather than escaping as an unobserved rejection.
		await Promise.all([write(), tx.done]);
	}

	/**
	 * At the browser's default durability: a lost delete leaves an orphan piece the next sweep
	 * removes, which is not worth a disk sync per deleted piece.
	 */
	async delete(id: PieceId): Promise<void> {
		await this.db.delete('pieces', id);
	}

	/**
	 * Pages of {@link PIECE_LIST_PAGE} ids, each an already-materialized array read under its own
	 * implicit transaction, the next starting after the last id of the previous one. So no cursor is
	 * held across the consumer's awaits (the rule `listBlockIds` keeps), and no page loads every id.
	 */
	async *list(): AsyncIterable<PieceId> {
		let after: IDBKeyRange | undefined;
		for (;;) {
			const ids = await this.db.getAllKeys('pieces', after, PIECE_LIST_PAGE);
			for (const id of ids) yield id;
			if (ids.length < PIECE_LIST_PAGE) return;
			after = IDBKeyRange.lowerBound(ids[ids.length - 1]!, true);
		}
	}

	// NOTE: reads every stored byte. It runs only off the documented configuration: when this store
	// shares the block store's handle, `blockStoreCountsPieces` sees one identity and never calls it,
	// since the block store's figure (`navigator.storage.estimate()`) already covers the origin. Over
	// another handle or database the figure is counted twice, the origin estimate including it, which
	// errs toward "fuller" as the `NOTE:` on `blockStoreCountsPieces` accepts. If this ever shows in
	// a profile, keep each piece's size under a second key range and sum that instead.
	async bytesUsed(): Promise<number> {
		try {
			const tx = this.db.transaction('pieces', 'readonly');
			const sum = async (): Promise<number> => {
				let used = 0;
				let cursor = await tx.store.openCursor();
				while (cursor) {
					used += cursor.value.byteLength;
					cursor = await cursor.continue();
				}
				return used;
			};
			const [used] = await Promise.all([sum(), tx.done]);
			return used;
		} catch (err) {
			log('summing piece bytes failed: %o', err);
			return 0;
		}
	}

	/** Every put that resolved is already on the disk where the browser honours strict transactions; nothing is held to sync. */
	async flush(): Promise<void> {}
}
