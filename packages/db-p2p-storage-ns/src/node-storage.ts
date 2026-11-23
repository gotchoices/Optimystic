import { blockStoreCountsPieces, type OpenNodeStorage } from '@optimystic/db-p2p';
import type { OptimysticNSDBHandle } from './db.js';
import { SqliteRawStorage, type SqliteRawStorageOptions } from './sqlite-storage.js';
import { SqliteKVStore } from './sqlite-kv-store.js';
import { SqlitePieceStore } from './sqlite-piece-store.js';

/** The block store's options (the write group's `idleFlushMs` and friends); the other two stores take none. */
export type SqliteNodeStorageOptions = SqliteRawStorageOptions;

/**
 * All of a node's storage over one open SQLite database: the blocks, the node-local records that
 * must survive a restart, and the blob pieces, as the one value `NodeOptions.storage` takes. The
 * three share the handle `openOptimysticNSDb` returned, so they report one store identity and the
 * block store's byte count — the whole database file — already measures the pieces.
 *
 * The key-value store keeps its default `'optimystic:txn:'` key prefix, which is what keeps its rows
 * in the shared `kv` table clear of the identity helper's.
 *
 * **`close()` leaves the handle alone.** The host opened it, may be sharing it with
 * `loadOrCreateNSPeerKey` or with Quereus, and closes it afterwards — the node closes nothing it was
 * handed, so the host calls `close()` after `stop()` and `db.close()` after that. Two calls over one
 * handle are harmless: each store writes through the one connection, and the piece store holds
 * nothing of its own.
 */
export function sqliteNodeStorage(db: OptimysticNSDBHandle, options: SqliteNodeStorageOptions = {}): OpenNodeStorage {
	const blocks = new SqliteRawStorage(db, options);
	const kv = new SqliteKVStore(db);
	const pieces = new SqlitePieceStore(db);
	assertOneLocation(blocks, pieces);
	return {
		blocks,
		kv,
		pieces,
		/**
		 * Flushes the two stores that write by autocommit statement — a flush is the whole of what
		 * closing either would mean, and neither has a `close` — and then closes the block store,
		 * which flushes what its write group still holds, syncs it and disarms its timers. The block
		 * store goes last for one rule across the four packages, where for files it is required. A
		 * rejected close still closes the stores under it.
		 */
		close: async () => {
			try {
				await pieces.flush();
			} finally {
				try {
					await kv.flush();
				} finally {
					await blocks.close();
				}
			}
		},
	};
}

/**
 * Both stores were built over one handle, so they must report one store identity — which is what
 * tells the node's storage monitor that the block store's byte count already measures the pieces
 * (`blockStoreCountsPieces`). Asserted here so that a later edit which opened a second handle inside
 * this factory could not silently make every node over it report itself fuller than it is. One
 * comparison of two strings per open.
 */
function assertOneLocation(blocks: SqliteRawStorage, pieces: SqlitePieceStore): void {
	if (!blockStoreCountsPieces(blocks, pieces)) {
		throw new Error(`The stores opened over this SQLite handle report two locations (blocks ${blocks.getStoreIdentity()}, pieces ${pieces.storeIdentity()}), so a node over them would count its blob pieces twice`);
	}
}
