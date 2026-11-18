import type { PieceId } from '@optimystic/db-core';
import { identityForHandle, type IPieceStore, type StoreDurability, type StoreIdentity } from '@optimystic/db-p2p';
import type { SqliteDb, SqliteStatement } from './db.js';
import { createLogger } from './logger.js';
import { PendingSqliteSync } from './sqlite-sync.js';
import { SQLITE_HANDLE_SCHEME } from './sqlite-storage.js';

const log = createLogger('storage:pieces');

/**
 * Ids per `list` page. A page of ids of about 60 characters stays far below the 512 KiB result
 * size that crosses NativeScript 8's JNI bridge through a scarce global reference (the `NOTE:` on
 * `NSPluginStatement.all` in `ns-opener.ts`).
 */
export const PIECE_LIST_PAGE = 1000;

/**
 * `bytes` itself when it spans its whole `ArrayBuffer`, otherwise a copy that does. `node:sqlite`
 * binds a sub-view correctly, so the suite cannot tell; this is a precaution for the plugin's
 * native binding of a typed array on a device, which this suite never runs, and which would store
 * bytes that are not the piece if it sent the view's whole buffer. The builder normally hands whole
 * buffers, so the copy is rare.
 */
function wholeBufferBytes(bytes: Uint8Array): Uint8Array {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/**
 * The NativeScript {@link IPieceStore}: one `pieces` table in the database `openOptimysticNSDb`
 * opens, sharing the handle with `SqliteRawStorage`, `SqliteKVStore` and the identity helper. Not a
 * `RawStoreDriver` store and not part of `SqliteBatchBackend`'s write group: a piece is raw bytes
 * written by one autocommit statement, and needs no cross-key atomicity (docs/blobs.md §The local
 * store).
 *
 * Each write survives a crash of this process once it resolves, and the write-ahead log keeps the
 * writes in order. `flush()` makes them survive a power cut with one synced commit, when anything
 * was written since the last flush, exactly as `SqliteKVStore.flush` does; a failed sync latches the
 * store, after which every `put`, `delete` and `flush` throws `StoreFailedError` while reads keep
 * working.
 *
 * There is no `close`: the handle is shared, and the host closes it after the node has stopped and
 * the block store has closed. The store holds nothing in memory to release.
 */
export class SqlitePieceStore implements IPieceStore {
	readonly durability: StoreDurability = 'power-loss';

	private readonly identity: StoreIdentity;
	private readonly sync: PendingSqliteSync;
	private readonly stmts: {
		has: SqliteStatement;
		get: SqliteStatement;
		put: SqliteStatement;
		putEmpty: SqliteStatement;
		delete: SqliteStatement;
		listPage: SqliteStatement;
		bytesUsed: SqliteStatement;
	};

	constructor(db: SqliteDb) {
		this.identity = identityForHandle(SQLITE_HANDLE_SCHEME, db);
		this.sync = new PendingSqliteSync(db);
		this.stmts = {
			has: db.prepare('SELECT 1 AS present FROM pieces WHERE id = ?'),
			get: db.prepare('SELECT bytes FROM pieces WHERE id = ?'),
			// A present id writes nothing, the interface's rule, in one statement with no read first.
			// `ON CONFLICT(id) DO NOTHING` rather than `INSERT OR IGNORE`, which would also swallow a
			// NOT NULL failure and so lose a piece whose bytes were bound as NULL without a word.
			put: db.prepare('INSERT INTO pieces (id, bytes) VALUES (?, ?) ON CONFLICT(id) DO NOTHING'),
			putEmpty: db.prepare('INSERT INTO pieces (id, bytes) VALUES (?, zeroblob(0)) ON CONFLICT(id) DO NOTHING'),
			delete: db.prepare('DELETE FROM pieces WHERE id = ?'),
			// Keyset paging: one index seek per page wherever the page starts.
			listPage: db.prepare('SELECT id FROM pieces WHERE id > ? ORDER BY id LIMIT ?'),
			// SQLite answers `length()` of a BLOB from the record header, without reading the content.
			bytesUsed: db.prepare('SELECT coalesce(sum(length(bytes)), 0) AS used FROM pieces'),
		};
	}

	/** The identity `SqliteBatchBackend` reports over this handle, so `blockStoreCountsPieces` counts the pieces once. */
	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	async has(id: PieceId): Promise<boolean> {
		return (await this.stmts.has.get(id)) !== undefined;
	}

	async get(id: PieceId): Promise<Uint8Array | undefined> {
		const row = await this.stmts.get.get(id);
		if (!row) return undefined;
		// The driver returns a fresh array per row, which no one else holds.
		const bytes = row.bytes;
		// The column is NOT NULL, so a NULL here is a driver's spelling of an empty BLOB: SQLite's C
		// API answers a zero-length BLOB with a null pointer, which a binding may pass on as null.
		// `node:sqlite` returns an empty array; the plugin on a device is unverified.
		if (bytes === null) return new Uint8Array(0);
		if (!(bytes instanceof Uint8Array)) throw new TypeError(`Piece ${id} is stored as ${typeof bytes}, not bytes`);
		return bytes;
	}

	async put(id: PieceId, bytes: Uint8Array): Promise<void> {
		this.sync.throwIfFailed();
		// A zero-length piece is written as `zeroblob(0)`, never bound: `node:sqlite` binds an empty
		// array whose `buffer` has been read as NULL, and how the plugin binds one on a device is
		// unverified.
		if (bytes.byteLength === 0) await this.stmts.putEmpty.run(id);
		else await this.stmts.put.run(id, wholeBufferBytes(bytes));
		this.sync.noteWrite();
	}

	async delete(id: PieceId): Promise<void> {
		this.sync.throwIfFailed();
		await this.stmts.delete.run(id);
		this.sync.noteWrite();
	}

	/**
	 * Pages of {@link PIECE_LIST_PAGE} ids, each drained before yielding, the next keyed after the
	 * last id of the previous one. A node can hold hundreds of thousands of pieces, which is why it
	 * pages rather than drain the table as `SqliteBatchBackend.listBlockIds` does.
	 */
	async *list(): AsyncIterable<PieceId> {
		let after = '';
		for (;;) {
			const rows = await this.stmts.listPage.all(after, PIECE_LIST_PAGE);
			for (const row of rows) yield row.id as PieceId;
			if (rows.length < PIECE_LIST_PAGE) return;
			after = rows[rows.length - 1]!.id as string;
		}
	}

	async bytesUsed(): Promise<number> {
		try {
			const row = await this.stmts.bytesUsed.get();
			return (row?.used as number | undefined) ?? 0;
		} catch (err) {
			log('summing piece bytes failed: %o', err);
			return 0;
		}
	}

	/** One synced commit when this store wrote since its last flush, otherwise nothing. */
	flush(): Promise<void> {
		return this.sync.flush();
	}
}
