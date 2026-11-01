import { ConnectionMutex } from './connection-mutex.js';
import { applySchema, runTransaction, DEFAULT_DB_NAME, DEFAULT_DB_VERSION, type OptimysticNSDBHandle, type SqliteDb, type SqliteParam, type SqliteRow, type SqliteStatement, type SqliteTransaction, type SqliteTransactionOptions } from './db.js';

/**
 * Minimal subset of `@nativescript-community/sqlite`'s `Db` we depend on.
 * Re-declared locally so this module's *types* don't pull in the plugin's
 * declarations (the plugin is a peer dependency that may not be installed
 * at typecheck time on non-NativeScript consumers).
 */
interface NSPluginDb {
	execute(sql: string, params?: ReadonlyArray<unknown>): unknown;
	get(sql: string, params?: ReadonlyArray<unknown>): Promise<Record<string, unknown> | null | undefined> | Record<string, unknown> | null | undefined;
	select(sql: string, params?: ReadonlyArray<unknown>): Promise<Array<Record<string, unknown>>> | Array<Record<string, unknown>>;
	close(): void | Promise<void>;
}

interface NSPluginModule {
	openOrCreate(path: string): NSPluginDb | Promise<NSPluginDb>;
}

/**
 * Opens (creating if needed) the Optimystic SQLite database at `name` under
 * the NativeScript app's documents directory, applies WAL pragmas, and runs
 * the migration to `version`.
 *
 * The returned `SqliteDb` handle is safe to share across `SqliteRawStorage`,
 * `SqliteKVStore`, and `loadOrCreateNSPeerKey`. Because SQLite allows at most
 * one open transaction per connection, the wrapper serializes every mutating
 * operation — `exec`, statement `run`, and whole `transaction` bodies — through
 * a per-connection FIFO mutex. Without it, two concurrent `transaction` bodies
 * would each `BEGIN` on the shared connection; the second would nest and its
 * rollback would silently discard the first's still-open writes. Reads
 * (`get`/`all`) stay off the mutex to preserve read concurrency.
 *
 * `path` may be passed in as the full filesystem path if the caller wants
 * to control file placement; otherwise the plugin's documents-directory
 * default is used.
 */
export async function openOptimysticNSDb(
	name: string = DEFAULT_DB_NAME,
	version: number = DEFAULT_DB_VERSION,
): Promise<OptimysticNSDBHandle> {
	const plugin = (await import('@nativescript-community/sqlite' as string)) as unknown as NSPluginModule;
	const raw = await plugin.openOrCreate(name);
	const wrapped = wrapNSPluginDb(raw);
	await applySchema(wrapped, version);
	return wrapped;
}

/**
 * Wraps a `@nativescript-community/sqlite` `Db` instance to satisfy the
 * internal `SqliteDb` interface used by the storage classes. Exported only
 * for callers that already hold an open NS-plugin handle and want to skip
 * the opener (rare — typically users just call `openOptimysticNSDb`).
 *
 * NOTE: the serialization mutex lives on the wrapper, not the raw handle. Wrap
 * a given raw connection exactly once — two wrappers over one handle each hold
 * their own mutex and would not serialize against each other, reintroducing the
 * cross-rollback this fix closes.
 */
export function wrapNSPluginDb(raw: NSPluginDb): SqliteDb {
	return new NSPluginDbWrapper(raw);
}

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
		// concurrency. A read issued while a write transaction is open on this same
		// connection observes that transaction's UNCOMMITTED rows (read-your-connection
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
		const rows = await this.raw.select(this.sql, params);
		return rows as SqliteRow[];
	}
}
