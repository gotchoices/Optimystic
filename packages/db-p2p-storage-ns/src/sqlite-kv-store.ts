import { StoreFailedError, type IKVStore } from '@optimystic/db-p2p';
import type { SqliteDb, SqliteStatement } from './db.js';
import { syncSqliteDb } from './sqlite-sync.js';

/**
 * SQLite-backed `IKVStore` adapter for NativeScript peers.
 *
 * Stored keys are namespaced with `prefix` so the `kv` table can be shared
 * with the identity helper (which uses the `b_val` column) without collisions.
 * `list(prefix)` issues a bounded `SELECT key FROM kv WHERE key >= ? AND key < ?`
 * — never `SELECT * FROM kv` + JS-side filter — so listing latency stays
 * bounded as the table grows.
 *
 * Only the `s_val` column is read or written here; the `b_val` column is
 * reserved for binary identity material.
 *
 * Writes are autocommit statements: each is visible, and survives a crash of this process, once it
 * resolves, and the write-ahead log keeps them in order. `flush()` makes them survive a power cut:
 * when anything was written since the last flush it runs `syncSqliteDb`, one synced commit that
 * syncs the shared log and with it every earlier write on the connection; otherwise it resolves at
 * once. A failed sync latches the store, after which every write and flush throws
 * `StoreFailedError` (rule 5 of the flush contract on `RawStoreDriver.flush`); reads keep working.
 */
export class SqliteKVStore implements IKVStore {
	private readonly stmts: {
		get: SqliteStatement;
		set: SqliteStatement;
		delete: SqliteStatement;
		list: SqliteStatement;
	};
	private readonly prefix: string;
	/** Set once a write has resolved, cleared by the flush that syncs it. */
	private dirty = false;
	private fault: { cause: unknown } | undefined;

	constructor(private readonly db: SqliteDb, prefix: string = 'optimystic:txn:') {
		this.prefix = prefix;
		this.stmts = {
			get: db.prepare('SELECT s_val FROM kv WHERE key = ?'),
			set: db.prepare('INSERT INTO kv (key, s_val, b_val) VALUES (?, ?, NULL) ON CONFLICT(key) DO UPDATE SET s_val = excluded.s_val'),
			delete: db.prepare('DELETE FROM kv WHERE key = ?'),
			list: db.prepare('SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key ASC'),
		};
	}

	async get(key: string): Promise<string | undefined> {
		const row = await this.stmts.get.get(this.prefix + key);
		if (!row) return undefined;
		const value = row.s_val;
		return typeof value === 'string' ? value : undefined;
	}

	async set(key: string, value: string): Promise<void> {
		this.throwIfFailed();
		await this.stmts.set.run(this.prefix + key, value);
		this.dirty = true;
	}

	async delete(key: string): Promise<void> {
		this.throwIfFailed();
		await this.stmts.delete.run(this.prefix + key);
		this.dirty = true;
	}

	async list(prefix: string): Promise<string[]> {
		const fullPrefix = this.prefix + prefix;
		// SQLite TEXT columns compare with BINARY collation by default — byte-by-byte
		// over the UTF-8 encoding. U+10FFFF (`\u{10FFFF}`) is the highest Unicode
		// code point, encoded as `F4 8F BF BF`; since the only valid UTF-8 leading
		// bytes go up to 0xF4, any string starting with `fullPrefix` sorts strictly
		// below `fullPrefix + '\u{10FFFF}'`, so the bound is exact for all valid keys.
		const upper = fullPrefix + '\u{10FFFF}';
		const rows = await this.stmts.list.all(fullPrefix, upper);
		return rows.map(row => (row.key as string).slice(this.prefix.length));
	}

	/** `IKVStore.flush`: one synced commit when this store wrote since its last flush, otherwise nothing. */
	async flush(): Promise<void> {
		this.throwIfFailed();
		if (!this.dirty) return;
		// Cleared before the sync, so a write resolving while the sync runs is covered by the next
		// flush whether or not this sync's commit happened to come after it.
		this.dirty = false;
		try {
			await syncSqliteDb(this.db);
		} catch (err) {
			this.fault ??= { cause: err };
			throw new StoreFailedError(this.fault.cause);
		}
	}

	private throwIfFailed(): void {
		if (this.fault) throw new StoreFailedError(this.fault.cause);
	}
}
