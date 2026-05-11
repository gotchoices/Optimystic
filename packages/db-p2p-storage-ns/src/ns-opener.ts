import { applySchema, DEFAULT_DB_NAME, DEFAULT_DB_VERSION, type OptimysticNSDBHandle, type SqliteDb, type SqliteParam, type SqliteRow, type SqliteStatement } from './db.js';

/**
 * Minimal subset of `@nativescript-community/sqlite`'s `Db` we depend on.
 * Re-declared locally so this module's *types* don't pull in the plugin's
 * declarations (the plugin is a peer dependency that may not be installed
 * at typecheck time on non-NativeScript consumers).
 */
interface NSPluginDb {
	execSQL(sql: string, params?: ReadonlyArray<unknown>): unknown;
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
 * `SqliteKVStore`, and `loadOrCreateNSPeerKey` — SQLite serializes writes
 * inside the connection, and our reads/writes are short-lived enough that
 * single-connection contention is a non-issue for a client peer.
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
	constructor(private readonly raw: NSPluginDb) {}

	async exec(sql: string): Promise<void> {
		// The plugin's execSQL accepts a single statement; split semicolon-
		// separated DDL so callers can pass the full schema in one go.
		const statements = sql
			.split(';')
			.map(s => s.trim())
			.filter(s => s.length > 0);
		for (const statement of statements) {
			await this.raw.execSQL(statement);
		}
	}

	prepare(sql: string): SqliteStatement {
		return new NSPluginStatement(this.raw, sql);
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		await this.raw.execSQL('BEGIN');
		try {
			const result = await fn();
			await this.raw.execSQL('COMMIT');
			return result;
		} catch (err) {
			try {
				await this.raw.execSQL('ROLLBACK');
			} catch {
				// Swallow rollback failures so we surface the original error.
			}
			throw err;
		}
	}

	async close(): Promise<void> {
		await this.raw.close();
	}
}

class NSPluginStatement implements SqliteStatement {
	constructor(private readonly raw: NSPluginDb, private readonly sql: string) {}

	async run(...params: SqliteParam[]): Promise<void> {
		await this.raw.execSQL(this.sql, params);
	}

	async get(...params: SqliteParam[]): Promise<SqliteRow | undefined> {
		const row = await this.raw.get(this.sql, params);
		if (row === null || row === undefined) return undefined;
		return row as SqliteRow;
	}

	async all(...params: SqliteParam[]): Promise<SqliteRow[]> {
		const rows = await this.raw.select(this.sql, params);
		return rows as SqliteRow[];
	}
}
