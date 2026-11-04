import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DEFAULT_DB_VERSION, type SqliteDb } from '../src/db.js';
import { openOverPlugin, type NSPluginDb, type NSPluginModule } from '../src/ns-opener.js';

/** What a test may observe of the plugin stand-in. */
export interface TestDbOptions {
	/**
	 * Called, as it runs, with every `execute` made without bind parameters: each statement of an
	 * `exec`, and each transaction's pragmas, `BEGIN IMMEDIATE`, `COMMIT` and `ROLLBACK`. Statement
	 * `run` always passes an array, which is how the two are told apart. A throw rejects that call.
	 */
	readonly onExec?: (sql: string) => void;
}

type BindParams = Parameters<StatementSync['run']>;

const bindParams = (params: ReadonlyArray<unknown> = []): BindParams => params as unknown as BindParams;

/**
 * Stand-in for a database of `@nativescript-community/sqlite` 4.x over Node's built-in `node:sqlite`
 * (Node 22+, default-enabled on Node 23+), so the suite runs the production wrapper, connection mutex
 * and transaction protocol without a NativeScript host. As on the plugin's one native thread per
 * database, every call runs later, strictly in the order made, and other callers run in between.
 */
class NodeSqlitePluginDb implements NSPluginDb {
	readonly ready = Promise.resolve();
	private readonly statements = new Map<string, StatementSync>();
	private closed = false;

	constructor(private readonly db: DatabaseSync, private readonly options: TestDbOptions) {}

	execute(sql: string, params?: ReadonlyArray<unknown>): Promise<unknown> {
		return this.later(() => {
			if (params) return this.prepared(sql).run(...bindParams(params));
			this.options.onExec?.(sql);
			this.db.exec(sql);
			return undefined;
		});
	}

	get(sql: string, params?: ReadonlyArray<unknown>): Promise<Record<string, unknown> | null> {
		return this.later(() => (this.prepared(sql).get(...bindParams(params)) as Record<string, unknown> | undefined) ?? null);
	}

	select(sql: string, params?: ReadonlyArray<unknown>): Promise<Array<Record<string, unknown>>> {
		return this.later(() => this.prepared(sql).all(...bindParams(params)) as Array<Record<string, unknown>>);
	}

	/** Runs after everything already queued; a call made after it finds the database closed. */
	close(): Promise<void> {
		return this.later(() => {
			if (this.closed) return;
			this.closed = true;
			this.statements.clear();
			this.db.close();
		});
	}

	/** `setImmediate` runs its callbacks in the order queued, which is what orders the calls. */
	private later<T>(work: () => T): Promise<T> {
		return new Promise((resolve, reject) => {
			setImmediate(() => {
				try {
					resolve(work());
				} catch (err) {
					reject(err);
				}
			});
		});
	}

	private prepared(sql: string): StatementSync {
		let stmt = this.statements.get(sql);
		if (!stmt) {
			stmt = this.db.prepare(sql);
			this.statements.set(sql, stmt);
		}
		return stmt;
	}
}

const standInPlugin = (options: TestDbOptions): NSPluginModule => ({
	openOrCreate: path => new NodeSqlitePluginDb(new DatabaseSync(path), options),
});

/**
 * Open a fresh in-memory `SqliteDb` with the Optimystic schema applied.
 * Each call yields an isolated database — there is no shared file or shared
 * connection across calls.
 */
export function openTestDb(options: TestDbOptions = {}): Promise<SqliteDb> {
	return openOverPlugin(standInPlugin(options), ':memory:', DEFAULT_DB_VERSION);
}

/**
 * Open a `SqliteDb` backed by the file at `path` (created if absent) with the
 * Optimystic schema applied, for tests that close and reopen the same database.
 */
export function openTestFileDb(path: string, options: TestDbOptions = {}): Promise<SqliteDb> {
	return openOverPlugin(standInPlugin(options), path, DEFAULT_DB_VERSION);
}
