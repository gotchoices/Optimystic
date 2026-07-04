import { ConnectionMutex } from './connection-mutex.js';
import { applySchema, DEFAULT_DB_NAME, DEFAULT_DB_VERSION, type OptimysticNSDBHandle, type SqliteDb, type SqliteParam, type SqliteRow, type SqliteStatement, type SqliteTransaction } from './db.js';

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

	async transaction<T>(fn: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
		return this.mutex.serialize(async () => {
			// BEGIN IMMEDIATE takes the write lock up front rather than deferring
			// it to the first write, so contention surfaces here and not mid-body.
			await this.raw.execute('BEGIN IMMEDIATE');
			try {
				// Statements bound to the open transaction bypass the mutex — we
				// already hold the slot; re-locking would deadlock.
				const tx: SqliteTransaction = {
					prepare: (sql: string) => new NSPluginStatement(this.raw, sql),
				};
				const result = await fn(tx);
				await this.raw.execute('COMMIT');
				return result;
			} catch (err) {
				try {
					await this.raw.execute('ROLLBACK');
				} catch {
					// Swallow rollback failures so we surface the original error.
				}
				throw err;
			}
		});
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
		// semantics). Fine today: the only transaction writer is same-block promote
		// under the commit latch, and cross-block reads are independent. If a future
		// caller reads a block on this connection while another op's transaction on the
		// same rows is mid-flight, it may see uncommitted state — serialize reads too if
		// that ever matters.
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
