import { assertOneMeasuredLocation, type OpenNodeStorage } from '@optimystic/db-p2p';
import type { LevelDBLike } from './leveldb-like.js';
import { LevelDBRawStorage, type LevelDBRawStorageOptions } from './leveldb-storage.js';
import { LevelDBKVStore, type LevelDBKVStoreOptions } from './leveldb-kv-store.js';
import { LevelDBPieceStore } from './leveldb-piece-store.js';

/** Everything the stores over one handle take: the write group's and journal backend's options, and the block store's read-cache settings. */
export type LevelDBNodeStorageOptions = LevelDBRawStorageOptions & LevelDBKVStoreOptions;

/**
 * All of a node's storage over one open LevelDB database: the blocks, the node-local records that
 * must survive a restart, and the blob pieces, as the one value `NodeOptions.storage` takes. The
 * three share the handle `openOptimysticRNDb` returned, one keyspace partitioned by a leading tag
 * byte, so they report one store identity and the block store's byte count — the whole database —
 * already measures the pieces.
 *
 * The key-value store keeps its default `'optimystic:txn:'` key prefix. Its keys carry their own tag
 * byte, so the prefix cannot collide with the identity helper's whatever it is; the default is kept
 * so that a store opened by this factory reads what one opened by hand wrote.
 *
 * **One call per handle.** The block store's read cache claims the handle in its cache pool, so a
 * second call over the same handle while the first is open throws (`two caches over one backing
 * store never converge`) rather than quietly giving a node a view that cannot see the other's
 * writes. Close the first before opening another, including when a node over the handle stops and
 * starts again in the same process.
 *
 * **`close()` leaves the handle alone.** The host opened it, may be sharing it with
 * `loadOrCreateRNPeerKey`, and closes it afterwards — the node closes nothing it was handed, so the
 * host calls `close()` after `stop()` and `db.close()` after that.
 */
export function levelDbNodeStorage(db: LevelDBLike, options: LevelDBNodeStorageOptions = {}): OpenNodeStorage {
	const blocks = new LevelDBRawStorage(db, options);
	// The default prefix, named by leaving it out, with the options behind it.
	const kv = new LevelDBKVStore(db, undefined, options);
	const pieces = new LevelDBPieceStore(db);
	assertOneMeasuredLocation({ blocks, kv, pieces }, 'this LevelDB handle');
	return {
		blocks,
		kv,
		pieces,
		/**
		 * Closes the two stores that hold writes in memory: the key-value store commits what it still
		 * holds and disarms its timer, and the block store does the same after dropping its read cache
		 * and releasing the cache pool's claim on the handle — which is what lets a later call over
		 * this handle succeed. There is nothing to call on the piece store: each put is written and
		 * synced as it is made, so it has neither a `close` nor a flush with work to do. The block
		 * store goes last for one rule across the four packages, where for files it is required. A
		 * rejected close still closes the store under it.
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
