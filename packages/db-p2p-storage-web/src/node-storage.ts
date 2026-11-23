import { assertOneMeasuredLocation, type OpenNodeStorage } from '@optimystic/db-p2p';
import type { OptimysticWebDBHandle } from './db.js';
import { IndexedDBRawStorage, type IndexedDBRawStorageOptions } from './indexeddb-storage.js';
import { IndexedDBKVStore, type IndexedDBKVStoreOptions } from './indexeddb-kv-store.js';
import { IndexedDBPieceStore, type IndexedDBPieceStoreOptions } from './indexeddb-piece-store.js';

/** Everything the three stores over one handle take: the write group's and journal backend's options, and the strict-durability flag. */
export type IndexedDBNodeStorageOptions = IndexedDBRawStorageOptions & IndexedDBKVStoreOptions & IndexedDBPieceStoreOptions;

/**
 * All of a node's storage over one open IndexedDB database: the blocks, the node-local records that
 * must survive a restart, and the blob pieces, as the one value `NodeOptions.storage` takes. The
 * three share the handle `openOptimysticWebDb` returned — IndexedDB permits concurrent transactions
 * across disjoint object stores — so they report one store identity and the block store's byte count,
 * the origin's estimate, already measures the pieces.
 *
 * The key-value store keeps its default `'optimystic:txn:'` key prefix, which is what keeps its rows
 * in the shared `kv` object store clear of the identity helper's.
 *
 * **`close()` leaves the handle alone.** The host opened it, may be sharing it with
 * `loadOrCreateBrowserPeerKey`, and closes it afterwards — the node closes nothing it was handed, so
 * the host calls `close()` after `stop()` and `db.close()` after that. Two calls over one handle are
 * harmless: each store commits its own transactions, and the piece store holds nothing of its own.
 */
export function indexedDbNodeStorage(db: OptimysticWebDBHandle, options: IndexedDBNodeStorageOptions = {}): OpenNodeStorage {
	const blocks = new IndexedDBRawStorage(db, options);
	// The default prefix, named by leaving it out, with the options behind it.
	const kv = new IndexedDBKVStore(db, undefined, options);
	const pieces = new IndexedDBPieceStore(db, options);
	assertOneMeasuredLocation({ blocks, kv, pieces }, 'this IndexedDB handle');
	return {
		blocks,
		kv,
		pieces,
		/**
		 * Closes the two stores that hold writes in memory, each of which commits what it still holds
		 * and disarms its timers. There is nothing to call on the piece store: every put is its own
		 * transaction, durable once it resolves, so it has neither a `close` nor a flush with work to
		 * do. The block store goes last for one rule across the four packages, where for files it is
		 * required. A rejected close still closes the store under it.
		 */
		close: async () => {
			try {
				await kv.close();
			} finally {
				await blocks.close();
			}
		},
	};
}
