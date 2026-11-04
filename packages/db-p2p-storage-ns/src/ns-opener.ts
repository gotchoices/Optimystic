import { ConnectionMutex } from './connection-mutex.js';
import { applySchema, runTransaction, DEFAULT_DB_NAME, DEFAULT_DB_VERSION, type OptimysticNSDBHandle, type SqliteDb, type SqliteParam, type SqliteRow, type SqliteStatement, type SqliteTransaction, type SqliteTransactionOptions } from './db.js';

/**
 * Minimal subset of a `@nativescript-community/sqlite` 4.x database we depend on.
 * Re-declared locally so this module's *types* don't pull in the plugin's
 * declarations (the plugin is a peer dependency that may not be installed
 * at typecheck time on non-NativeScript consumers). Exported for the test
 * driver, not from `index.ts`.
 */
export interface NSPluginDb {
	/** Settles when the open does; a failed open rejects it. */
	readonly ready: Promise<void>;
	execute(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown>;
	get(sql: string, params?: ReadonlyArray<unknown>): Promise<Record<string, unknown> | null | undefined>;
	select(sql: string, params?: ReadonlyArray<unknown>): Promise<Array<Record<string, unknown>>>;
	close(): Promise<void>;
}

export interface NSPluginModule {
	/** Returns the handle at once; the open itself runs on the database's native thread. */
	openOrCreate(path: string): NSPluginDb;
}

/**
 * Opens (creating if needed) the Optimystic SQLite database at `name`, applies
 * WAL pragmas, and runs the migration to `version`. A bare `name` goes in the
 * app's databases folder on Android and its documents folder on iOS, and needs
 * no foreground activity; a full path is used as given.
 *
 * The returned `SqliteDb` handle is safe to share across `SqliteRawStorage`,
 * `SqliteKVStore`, and `loadOrCreateNSPeerKey`: the wrapper serializes every
 * mutating operation through a per-connection FIFO mutex (`NSPluginDbWrapper`
 * says why).
 */
export async function openOptimysticNSDb(
	name: string = DEFAULT_DB_NAME,
	version: number = DEFAULT_DB_VERSION,
): Promise<OptimysticNSDBHandle> {
	const plugin = (await import('@nativescript-community/sqlite' as string)) as unknown as NSPluginModule;
	return openOverPlugin(plugin, name, version);
}

/** `openOptimysticNSDb` once the plugin is loaded. */
export async function openOverPlugin(plugin: NSPluginModule, name: string, version: number): Promise<OptimysticNSDBHandle> {
	const raw = plugin.openOrCreate(name);
	await raw.ready;
	const wrapped = wrapNSPluginDb(raw);
	// NOTE: a failed schema leaves this connection open; if a host ever retries the open in a loop, close it here.
	await applySchema(wrapped, version);
	return wrapped;
}

/**
 * Wraps a `@nativescript-community/sqlite` database to satisfy the
 * internal `SqliteDb` interface used by the storage classes. Exported only
 * for callers that already hold an open NS-plugin handle and want to skip
 * the opener (rare — typically users just call `openOptimysticNSDb`). The
 * plugin returns a handle before its open has finished, so await `ready` first.
 *
 * NOTE: the serialization mutex lives on the wrapper, not the raw handle. Wrap
 * a given raw connection exactly once — two wrappers over one handle each hold
 * their own mutex and would not serialize against each other, reintroducing the
 * cross-rollback this fix closes.
 */
export function wrapNSPluginDb(raw: NSPluginDb): SqliteDb {
	return new NSPluginDbWrapper(raw);
}

/**
 * `SqliteDb` over a plugin handle.
 *
 * The plugin runs every call on the database's one native thread, in the order
 * made. That orders single calls but does not keep a sequence of calls together,
 * and every awaited statement yields the JavaScript thread, so other callers run
 * between a transaction body's statements. So the connection mutex stays: two
 * bodies would otherwise each send `BEGIN`, the second would fail, and its
 * `ROLLBACK` would discard the first's open writes; and a plain write between
 * another body's `BEGIN` and `COMMIT` would land inside that transaction and
 * share its fate.
 *
 * The plugin's own `db.transaction` is not used, and would not remove the mutex:
 * it joins a second concurrent `transaction` call into the first, so one body's
 * failure would roll the other back. It would also have to take the place of
 * `runTransaction`, whose `PRAGMA synchronous = FULL` must run outside the
 * transaction (SQLite refuses to change it inside one) and be restored after a
 * rollback. Because the wrapper sends `BEGIN IMMEDIATE` and `COMMIT` as ordinary
 * `execute` calls, the plugin does not know a transaction is open, and runs every
 * request in arrival order.
 */
class NSPluginDbWrapper implements SqliteDb {
	private readonly mutex = new ConnectionMutex();

	constructor(private readonly raw: NSPluginDb) {}

	async exec(sql: string): Promise<void> {
		// The plugin's execute accepts a single statement; split semicolon-
		// separated DDL so callers can pass the full schema in one go.
		const statements = sql
			.split(';')
			.map(s => s.trim())
			.filter(s => s.length > 0);
		await this.mutex.serialize(async () => {
			for (const statement of statements) {
				await this.raw.execute(statement);
			}
		});
	}

	prepare(sql: string): SqliteStatement {
		// Outside-transaction statement: writes go through the mutex.
		return new NSPluginStatement(this.raw, sql, this.mutex);
	}

	async transaction<T>(fn: (tx: SqliteTransaction) => Promise<T>, options?: SqliteTransactionOptions): Promise<T> {
		return this.mutex.serialize(() => runTransaction(
			{ execute: async (sql) => { await this.raw.execute(sql); } },
			// Statements bound to the open transaction bypass the mutex — we
			// already hold the slot; re-locking would deadlock.
			{ prepare: (sql: string) => new NSPluginStatement(this.raw, sql) },
			fn,
			options,
		));
	}

	async close(): Promise<void> {
		await this.raw.close();
	}
}

class NSPluginStatement implements SqliteStatement {
	/**
	 * @param mutex When present, `run` is serialized on the connection mutex
	 *   (outside-transaction writes). When absent, `run` executes directly on the
	 *   raw connection — used for statements bound to an already-open transaction
	 *   that already holds the mutex slot.
	 */
	constructor(
		private readonly raw: NSPluginDb,
		private readonly sql: string,
		private readonly mutex?: ConnectionMutex,
	) {}

	async run(...params: SqliteParam[]): Promise<void> {
		if (this.mutex) {
			await this.mutex.serialize(() => this.raw.execute(this.sql, params));
		} else {
			await this.raw.execute(this.sql, params);
		}
	}

	async get(...params: SqliteParam[]): Promise<SqliteRow | undefined> {
		// NOTE: reads run directly on the connection, unserialized, to preserve read
		// concurrency: a read does not wait for a whole transaction body, only for the
		// statements queued ahead of it on the plugin's native thread. So a read issued
		// while a write transaction is open on this same connection lands between that
		// body's statements and observes its UNCOMMITTED rows (read-your-connection
		// semantics). Fine today: the one transaction writer of the block tables is
		// `SqliteBatchBackend.commit`, and every row it is writing is held by the
		// `WriteGroupDriver` overlay above it until the batch is durable. A point read of
		// such a row is answered by the overlay and never reaches this connection; a
		// listing does reach it, and may see the batch's uncommitted rows, but merges the
		// overlay over them, so it answers the same whether the transaction has committed
		// or not (and a rolled-back batch latches the store). The key-value store and the
		// identity helper write other tables, by autocommit statements, and the sync's
		// `durability_mark` row is read by nobody. If a reader of a batch's rows ever
		// bypasses the overlay, serialize reads too.
		const row = await this.raw.get(this.sql, params);
		if (row === null || row === undefined) return undefined;
		return row as SqliteRow;
	}

	async all(...params: SqliteParam[]): Promise<SqliteRow[]> {
		// NOTE: unserialized read — see the note on `get` above re: uncommitted reads.
		// NOTE: on NativeScript 8's JNI bridge a result over 512 KiB arrives through a fresh
		// direct ByteBuffer, which holds a JNI global reference until it is collected, and
		// Android allows 51,200 of those. This storage reaches that size with one block near
		// or over 512 KiB per read (`get`, like this method) or `listBlockIds` over a large
		// table. Fine now; if a node on NativeScript 8 ever reads thousands of such results
		// between garbage collections, read them in smaller pieces.
		const rows = await this.raw.select(this.sql, params);
		return rows as SqliteRow[];
	}
}
