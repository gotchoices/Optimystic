/**
 * Internal SQLite shim and Optimystic schema for the NativeScript storage backend.
 *
 * The storage classes (`SqliteRawStorage`, `SqliteKVStore`) and the identity
 * helper (`loadOrCreateNSPeerKey`) only depend on the `SqliteDb` interface
 * defined here — never on `@nativescript-community/sqlite` directly. That lets
 * the suite run under Node mocha against a `node:sqlite` or `better-sqlite3`
 * driver, matching the pattern `db-p2p-storage-web` uses with `fake-indexeddb`.
 *
 * The wrapper is **package-private**: only `openOptimysticNSDb` is exported to
 * consumers; the `SqliteDb` interface is an internal seam for tests.
 */

/** SQL parameter value — covers everything `IRawStorage` and `IKVStore` write. */
export type SqliteParam = string | number | Uint8Array | null;

/** A single row returned from a SQL query, keyed by column name. */
export type SqliteRow = Record<string, SqliteParam>;

/**
 * A prepared statement bound to a single SQL string.
 *
 * Both `node:sqlite` and `@nativescript-community/sqlite` cache parsed SQL
 * internally, so re-binding a prepared statement is cheaper than re-parsing a
 * raw `execSQL`. The storage classes prepare each query once per instance.
 */
export interface SqliteStatement {
	/** Execute with the given bind parameters, ignoring any returned rows. */
	run(...params: SqliteParam[]): Promise<void>;
	/** Execute and return the first row, or `undefined` if none. */
	get(...params: SqliteParam[]): Promise<SqliteRow | undefined>;
	/** Execute and return all rows (already drained — safe to await between yields). */
	all(...params: SqliteParam[]): Promise<SqliteRow[]>;
}

/**
 * Minimal SQLite driver surface used by this package.
 *
 * Wraps either the NativeScript plugin (in production) or a Node SQLite
 * driver (in tests). Async on every method so the NS plugin's I/O can be
 * Promised — even where the underlying call is synchronous.
 */
export interface SqliteDb {
	/** Execute one or more semicolon-separated statements; no result rows. */
	exec(sql: string): Promise<void>;
	/** Prepare a parameterized statement for repeated execution. */
	prepare(sql: string): SqliteStatement;
	/** Run `fn` inside `BEGIN ... COMMIT` (rolls back on throw). */
	transaction<T>(fn: () => Promise<T>): Promise<T>;
	/** Release the underlying handle. */
	close(): Promise<void>;
}

export const DEFAULT_DB_NAME = 'optimystic.sqlite';
export const DEFAULT_DB_VERSION = 1;

/**
 * Schema for the NativeScript storage backend.
 *
 * Mirrors the IndexedDB object stores 1:1:
 * - `metadata` → per-block `BlockMetadata` (JSON).
 * - `revisions` → revision lookup keyed by `(block_id, rev)`.
 * - `pending` → uncommitted transforms keyed by `(block_id, action_id)`.
 * - `transactions` → committed transforms keyed by `(block_id, action_id)`.
 * - `materialized` → materialized blocks keyed by `(block_id, action_id)`.
 * - `kv` → generic string keyspace shared by `IKVStore` (`s_val`) and the
 *   identity helper (`b_val`). The two columns avoid a base64 round-trip
 *   for the libp2p private key.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (
	block_id TEXT PRIMARY KEY,
	value    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
	block_id  TEXT    NOT NULL,
	rev       INTEGER NOT NULL,
	action_id TEXT    NOT NULL,
	PRIMARY KEY (block_id, rev)
);

CREATE TABLE IF NOT EXISTS pending (
	block_id  TEXT NOT NULL,
	action_id TEXT NOT NULL,
	value     TEXT NOT NULL,
	PRIMARY KEY (block_id, action_id)
);

CREATE TABLE IF NOT EXISTS transactions (
	block_id  TEXT NOT NULL,
	action_id TEXT NOT NULL,
	value     TEXT NOT NULL,
	PRIMARY KEY (block_id, action_id)
);

CREATE TABLE IF NOT EXISTS materialized (
	block_id  TEXT NOT NULL,
	action_id TEXT NOT NULL,
	value     TEXT NOT NULL,
	PRIMARY KEY (block_id, action_id)
);

CREATE TABLE IF NOT EXISTS kv (
	key    TEXT PRIMARY KEY,
	s_val  TEXT,
	b_val  BLOB
);
`;

const PRAGMAS_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;
`;

/**
 * Apply pragmas, run the schema DDL, and stamp `user_version` so future
 * migrations can branch on it. Idempotent — safe to call on every open.
 */
export async function applySchema(db: SqliteDb, version: number = DEFAULT_DB_VERSION): Promise<void> {
	await db.exec(PRAGMAS_SQL);
	await db.exec(SCHEMA_SQL);
	await db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Public handle returned by `openOptimysticNSDb`. Consumers pass it to
 * `SqliteRawStorage`, `SqliteKVStore`, and `loadOrCreateNSPeerKey`.
 */
export type OptimysticNSDBHandle = SqliteDb;
