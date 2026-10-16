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

import { createLogger } from './logger.js';

const log = createLogger('db');

/** SQL parameter value — covers everything `IRawStorage` and `IKVStore` write. */
export type SqliteParam = string | number | Uint8Array | null;

/** A single row returned from a SQL query, keyed by column name. */
export type SqliteRow = Record<string, SqliteParam>;

/**
 * A prepared statement bound to a single SQL string.
 *
 * Both `node:sqlite` and `@nativescript-community/sqlite` cache parsed SQL
 * internally, so re-binding a prepared statement is cheaper than re-parsing a
 * raw `execute`. The storage classes prepare each query once per instance.
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
 * Statements that execute directly on an already-OPEN transaction.
 *
 * Handed to the `transaction(fn)` callback. Its prepared statements run on the
 * raw connection *inside* the mutex slot the transaction already holds, so they
 * must NOT re-acquire the connection mutex — doing so would deadlock (the
 * transaction body holds the only slot). This is the explicit-context seam the
 * fix threads through instead of a shared `inTransaction` flag, which cannot
 * tell an inner statement (bypass the lock) from a concurrent external write
 * (block on it).
 */
export interface SqliteTransaction {
	/** Prepare a statement bound to the open transaction; bypasses the mutex. */
	prepare(sql: string): SqliteStatement;
}

/** Options of {@link SqliteDb.transaction}. */
export interface SqliteTransactionOptions {
	/**
	 * Commit under `PRAGMA synchronous = FULL`, which in write-ahead-log mode syncs the log file at
	 * this commit. The log is one append-only file, so that sync covers every frame before it: every
	 * earlier `NORMAL` commit on this database, whichever store or helper made it. The pragma is set
	 * inside the mutex slot the transaction holds and restored to `NORMAL` after the commit, or after
	 * the rollback, so no other write on the connection pays for the sync by accident. Default false.
	 */
	readonly synced?: boolean;
}

/**
 * Minimal SQLite driver surface used by this package.
 *
 * Wraps either the NativeScript plugin (in production) or a Node SQLite
 * driver (in tests). Async on every method so the NS plugin's I/O can be
 * Promised — even where the underlying call is synchronous.
 *
 * A single connection is shared across the storage classes, so every mutating
 * operation (`exec`, statement `run`, and `transaction` bodies) is serialized on
 * a per-connection FIFO mutex. Reads (`get`/`all`) are intentionally left
 * unserialized to preserve read concurrency.
 */
export interface SqliteDb {
	/** Execute one or more semicolon-separated statements; no result rows. Mutex-guarded. */
	exec(sql: string): Promise<void>;
	/** Prepare a parameterized statement for repeated execution (writes are mutex-guarded). */
	prepare(sql: string): SqliteStatement;
	/**
	 * Run `fn` inside `BEGIN IMMEDIATE ... COMMIT` (rolls back on throw), holding
	 * the connection mutex for the whole body. `fn` receives a `SqliteTransaction`
	 * whose statements run directly on the open transaction without re-locking.
	 * With `options.synced` the commit also syncs the write-ahead log, which makes
	 * this transaction and every earlier commit on the database survive a power
	 * cut (see {@link SqliteTransactionOptions.synced}); without it the commit
	 * survives a crash of this process only, until a later synced commit.
	 *
	 * NOTE: `fn` must issue its writes through the provided `tx`, never through a
	 * class-level statement from `db.prepare(...)` (those re-acquire the mutex and
	 * deadlock behind the slot this transaction holds), and must not call
	 * `db.transaction(...)` again — nested calls deadlock for the same reason. No
	 * current caller does either; guard here if that ever changes.
	 */
	transaction<T>(fn: (tx: SqliteTransaction) => Promise<T>, options?: SqliteTransactionOptions): Promise<T>;
	/** Release the underlying handle. */
	close(): Promise<void>;
}

/** The raw connection surface {@link runTransaction} drives: one statement at a time, no rows back. */
export interface TransactionConnection {
	execute(sql: string): Promise<void> | void;
}

/**
 * The transaction protocol both `SqliteDb` implementations run inside their mutex slot: with
 * `synced`, `PRAGMA synchronous = FULL` first; then `BEGIN IMMEDIATE`, the body, and `COMMIT`, or
 * `ROLLBACK` when the body or the commit throws; then, synced, `PRAGMA synchronous = NORMAL`
 * whichever way the transaction ended, so the connection's default is restored before the slot is
 * released. `BEGIN IMMEDIATE` takes the write lock up front rather than deferring it to the first
 * write, so contention surfaces here and not mid-body.
 *
 * A failure of the restore after a failed body is logged rather than thrown, so the body's error,
 * the one that matters, is the one the caller sees; after a committed body it is thrown, since the
 * connection would otherwise sync every later commit unasked.
 */
export async function runTransaction<T>(
	conn: TransactionConnection,
	tx: SqliteTransaction,
	fn: (tx: SqliteTransaction) => Promise<T>,
	options?: SqliteTransactionOptions,
): Promise<T> {
	const synced = options?.synced === true;
	if (synced) await conn.execute('PRAGMA synchronous = FULL');
	let result: T;
	try {
		result = await commitOrRollBack(conn, tx, fn);
	} catch (err) {
		if (synced) {
			try {
				await conn.execute('PRAGMA synchronous = NORMAL');
			} catch (restoreErr) {
				log('restoring synchronous = NORMAL failed after a failed transaction: %o', restoreErr);
			}
		}
		throw err;
	}
	if (synced) await conn.execute('PRAGMA synchronous = NORMAL');
	return result;
}

async function commitOrRollBack<T>(conn: TransactionConnection, tx: SqliteTransaction, fn: (tx: SqliteTransaction) => Promise<T>): Promise<T> {
	await conn.execute('BEGIN IMMEDIATE');
	try {
		const result = await fn(tx);
		await conn.execute('COMMIT');
		return result;
	} catch (err) {
		try {
			await conn.execute('ROLLBACK');
		} catch (rollbackErr) {
			// The original error is the one to surface; the rollback's is only logged.
			log('rollback failed after a failed transaction: %o', rollbackErr);
		}
		throw err;
	}
}

export const DEFAULT_DB_NAME = 'optimystic.sqlite';
export const DEFAULT_DB_VERSION = 1;

/**
 * Schema for the NativeScript storage backend.
 *
 * Mirrors the IndexedDB object stores 1:1. The six block-storage stores keep
 * their original columns and keys, but their value columns are now BLOB: the
 * shared `KvRawStorage` kernel (over `WriteGroupDriver` over `SqliteBatchBackend`)
 * owns all JSON / UTF-8 (de)serialization, so the backend only ever binds/reads
 * the kernel's raw `Uint8Array` values. SQLite stores a `Uint8Array` as a BLOB
 * and returns it as a `Uint8Array`, so bytes round-trip exactly (a TEXT column
 * would risk UTF-8 coercion corrupting non-ASCII JSON bytes). Keys stay TEXT/INTEGER.
 * - `metadata` → per-block `BlockMetadata` bytes keyed by `block_id`.
 * - `revisions` → revision lookup keyed by `(block_id, rev)`; `action_id` column
 *   holds the kernel's encoded `ActionId` bytes (BLOB).
 * - `pending` → uncommitted transform bytes keyed by `(block_id, action_id)`.
 * - `transactions` → committed transform bytes keyed by `(block_id, action_id)`.
 * - `proofs` → `BlockCommitProof` bytes keyed by `(block_id, rev)` — the same key
 *   shape as `revisions`, deliberately NOT the action keyspace (an action id is
 *   caller-chosen, so no reserved id could be relied on).
 * - `materialized` → materialized block bytes keyed by `(block_id, action_id)`.
 * - `kv` → generic string keyspace shared by `IKVStore` (`s_val`) and the
 *   identity helper (`b_val`). NOT kernel-backed; unchanged. The two columns
 *   avoid a base64 round-trip for the libp2p private key.
 * - `durability_mark` → one row, bumped by `syncSqliteDb` (`sqlite-sync.ts`) so a
 *   sync that has no rows of its own to write still has a frame to commit.
 *
 * NOTE: this package's SQL is uppercase throughout, predating the lowercase rule in
 * AGENTS.md, and new statements have kept to it rather than mix cases within one file;
 * convert the package in one pass rather than statement by statement.
 *
 * NOTE: value columns changed TEXT→BLOB with the kernel refactor, but every
 * statement is `CREATE TABLE IF NOT EXISTS` — so a database file created by a
 * pre-refactor build keeps its old TEXT-column schema, and its rows hold JSON
 * *strings* the kernel now reads back and `TextDecoder.decode`s (garbling /
 * throwing). There is no migration. Safe today because this backend is
 * NativeScript-only with no shipped production data; if a build ever ships to
 * devices that later upgrade, add a `user_version` bump that drops+recreates
 * these six tables (or a real migration) before assuming BLOB rows.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (
	block_id TEXT PRIMARY KEY,
	value    BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS revisions (
	block_id  TEXT    NOT NULL,
	rev       INTEGER NOT NULL,
	action_id BLOB    NOT NULL,
	PRIMARY KEY (block_id, rev)
);

CREATE TABLE IF NOT EXISTS pending (
	block_id  TEXT NOT NULL,
	action_id TEXT NOT NULL,
	value     BLOB NOT NULL,
	PRIMARY KEY (block_id, action_id)
);

CREATE TABLE IF NOT EXISTS transactions (
	block_id  TEXT NOT NULL,
	action_id TEXT NOT NULL,
	value     BLOB NOT NULL,
	PRIMARY KEY (block_id, action_id)
);

CREATE TABLE IF NOT EXISTS proofs (
	block_id TEXT    NOT NULL,
	rev      INTEGER NOT NULL,
	value    BLOB    NOT NULL,
	PRIMARY KEY (block_id, rev)
);

CREATE TABLE IF NOT EXISTS materialized (
	block_id  TEXT NOT NULL,
	action_id TEXT NOT NULL,
	value     BLOB NOT NULL,
	PRIMARY KEY (block_id, action_id)
);

CREATE TABLE IF NOT EXISTS kv (
	key    TEXT PRIMARY KEY,
	s_val  TEXT,
	b_val  BLOB
);

CREATE TABLE IF NOT EXISTS durability_mark (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	n  INTEGER NOT NULL
);
`;

// Assignment-form pragmas return no rows, so they go through exec()/execute().
const PRAGMAS_SQL = `
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = OFF;
`;

/**
 * Apply pragmas, run the schema DDL, and stamp `user_version` so future
 * migrations can branch on it. Idempotent — safe to call on every open.
 */
export async function applySchema(db: SqliteDb, version: number = DEFAULT_DB_VERSION): Promise<void> {
	// `PRAGMA journal_mode = WAL` returns the resulting mode as a row. The NS
	// Android plugin maps exec()→execSQL, which rejects row-returning statements
	// ("Queries can be performed using ... query or rawQuery methods only"), so
	// this pragma must run through a query method. prepare().get() does that on
	// every driver (NS plugin → get()/rawQuery; node:sqlite/better-sqlite3 → get()).
	await db.prepare('PRAGMA journal_mode = WAL').get();
	await db.exec(PRAGMAS_SQL);
	await db.exec(SCHEMA_SQL);
	await db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * Public handle returned by `openOptimysticNSDb`. Consumers pass it to
 * `SqliteRawStorage`, `SqliteKVStore`, and `loadOrCreateNSPeerKey`.
 */
export type OptimysticNSDBHandle = SqliteDb;
