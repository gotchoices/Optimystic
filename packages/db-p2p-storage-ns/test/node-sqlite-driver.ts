import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ConnectionMutex } from '../src/connection-mutex.js';
import { applySchema, type SqliteDb, type SqliteParam, type SqliteRow, type SqliteStatement, type SqliteTransaction } from '../src/db.js';

/**
 * Test-only `SqliteDb` driver backed by Node's built-in `node:sqlite`
 * (Node 22+ — default-enabled on Node 23+). Production code uses
 * `openOptimysticNSDb`; this driver lets the same storage classes run
 * under Mocha without spinning up a NativeScript host.
 *
 * `node:sqlite` is fully synchronous; the async wrapper just Promise-wraps
 * each call so the storage classes' `await`s resolve uniformly.
 */
class NodeSqliteWrapper implements SqliteDb {
	private readonly cache = new Map<string, StatementSync>();
	private readonly mutex = new ConnectionMutex();
	private closed = false;

	constructor(private readonly db: DatabaseSync) {}

	async exec(sql: string): Promise<void> {
		await this.mutex.serialize(() => this.db.exec(sql));
	}

	prepare(sql: string): SqliteStatement {
		// Outside-transaction statement: writes go through the mutex.
		return new NodeSqliteStatement(() => this.prepared(sql), this.mutex);
	}

	async transaction<T>(fn: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
		return this.mutex.serialize(async () => {
			this.db.exec('BEGIN IMMEDIATE');
			try {
				// Statements bound to the open transaction bypass the mutex — we
				// already hold the slot; re-locking would deadlock.
				const tx: SqliteTransaction = {
					prepare: (sql: string) => new NodeSqliteStatement(() => this.prepared(sql)),
				};
				const result = await fn(tx);
				this.db.exec('COMMIT');
				return result;
			} catch (err) {
				try {
					this.db.exec('ROLLBACK');
				} catch {
					// Swallow rollback errors so the original cause propagates.
				}
				throw err;
			}
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.cache.clear();
		this.db.close();
	}

	private prepared(sql: string): StatementSync {
		let stmt = this.cache.get(sql);
		if (!stmt) {
			stmt = this.db.prepare(sql);
			this.cache.set(sql, stmt);
		}
		return stmt;
	}
}

class NodeSqliteStatement implements SqliteStatement {
	/**
	 * @param mutex When present, `run` is serialized on the connection mutex
	 *   (outside-transaction writes). When absent, `run` executes directly — used
	 *   for statements bound to an already-open transaction holding the slot.
	 */
	constructor(
		private readonly resolve: () => StatementSync,
		private readonly mutex?: ConnectionMutex,
	) {}

	async run(...params: SqliteParam[]): Promise<void> {
		const exec = () => { this.resolve().run(...(params as unknown as Parameters<StatementSync['run']>)); };
		if (this.mutex) {
			await this.mutex.serialize(exec);
		} else {
			exec();
		}
	}

	async get(...params: SqliteParam[]): Promise<SqliteRow | undefined> {
		// Unserialized read — mirrors production ns-opener (read concurrency preserved).
		const row = this.resolve().get(...(params as unknown as Parameters<StatementSync['get']>));
		if (!row) return undefined;
		return row as unknown as SqliteRow;
	}

	async all(...params: SqliteParam[]): Promise<SqliteRow[]> {
		// Unserialized read — mirrors production ns-opener.
		const rows = this.resolve().all(...(params as unknown as Parameters<StatementSync['all']>));
		return rows as unknown as SqliteRow[];
	}
}

let counter = 0;

/**
 * Open a fresh in-memory `SqliteDb` with the Optimystic schema applied.
 * Each call yields an isolated database — there is no shared file or shared
 * connection across calls.
 */
export async function openTestDb(): Promise<SqliteDb> {
	const raw = new DatabaseSync(':memory:');
	const db = new NodeSqliteWrapper(raw);
	await applySchema(db);
	void ++counter;
	return db;
}

/**
 * Open a fresh `SqliteDb` backed by a real file (under `:memory:` by default
 * but with `setReadOnly:false`), useful for tests that need to close and
 * reopen the same database. Returns the path so callers can reopen.
 */
export async function openTestFileDb(path: string): Promise<SqliteDb> {
	const raw = new DatabaseSync(path);
	const db = new NodeSqliteWrapper(raw);
	await applySchema(db);
	return db;
}
