import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ConnectionMutex } from '../src/connection-mutex.js';
import { applySchema, runTransaction, type SqliteDb, type SqliteParam, type SqliteRow, type SqliteStatement, type SqliteTransaction, type SqliteTransactionOptions } from '../src/db.js';

/** What a test may observe of the driver. */
export interface TestDbOptions {
	/**
	 * Called with every statement the wrapper executes outside a prepared statement: each `exec`
	 * body, and each transaction's pragmas, `BEGIN IMMEDIATE`, `COMMIT` and `ROLLBACK`.
	 */
	readonly onExec?: (sql: string) => void;
}

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

	constructor(private readonly db: DatabaseSync, private readonly options: TestDbOptions = {}) {}

	async exec(sql: string): Promise<void> {
		await this.mutex.serialize(() => this.execute(sql));
	}

	prepare(sql: string): SqliteStatement {
		// Outside-transaction statement: writes go through the mutex.
		return new NodeSqliteStatement(() => this.prepared(sql), this.mutex);
	}

	async transaction<T>(fn: (tx: SqliteTransaction) => Promise<T>, options?: SqliteTransactionOptions): Promise<T> {
		return this.mutex.serialize(() => runTransaction(
			{ execute: sql => this.execute(sql) },
			// Statements bound to the open transaction bypass the mutex — we
			// already hold the slot; re-locking would deadlock.
			{ prepare: (sql: string) => new NodeSqliteStatement(() => this.prepared(sql)) },
			fn,
			options,
		));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.cache.clear();
		this.db.close();
	}

	private execute(sql: string): void {
		this.options.onExec?.(sql);
		this.db.exec(sql);
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

/**
 * Open a fresh in-memory `SqliteDb` with the Optimystic schema applied.
 * Each call yields an isolated database — there is no shared file or shared
 * connection across calls.
 */
export async function openTestDb(options: TestDbOptions = {}): Promise<SqliteDb> {
	const raw = new DatabaseSync(':memory:');
	const db = new NodeSqliteWrapper(raw, options);
	await applySchema(db);
	return db;
}

/**
 * Open a `SqliteDb` backed by the file at `path` (created if absent) with the
 * Optimystic schema applied, for tests that close and reopen the same database.
 */
export async function openTestFileDb(path: string, options: TestDbOptions = {}): Promise<SqliteDb> {
	const raw = new DatabaseSync(path);
	const db = new NodeSqliteWrapper(raw, options);
	await applySchema(db);
	return db;
}
