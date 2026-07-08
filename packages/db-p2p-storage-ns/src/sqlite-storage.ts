import type { ActionId, BlockId } from '@optimystic/db-core';
import { KvRawStorage, type RawStoreDriver } from '@optimystic/db-p2p';
import type { SqliteDb, SqliteStatement } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:sqlite');

/**
 * SQLite {@link RawStoreDriver}: the five logical block-storage stores mapped to
 * the five relational tables (`metadata`, `revisions`, `pending`, `transactions`,
 * `materialized`) with their original columns and keys. This is a code refactor,
 * not a storage-format change at the SQL level.
 *
 * `KvRawStorage` now owns all JSON serialization, so this driver only ever
 * reads/writes `Uint8Array` values: the value columns are BLOB and SQLite binds
 * a `Uint8Array` as a BLOB and returns it as a `Uint8Array`, so no codec lives
 * here (a TEXT column would risk UTF-8 coercion corrupting non-ASCII JSON bytes).
 * Everything SQLite-specific stays: each CRUD op goes through a prepared
 * statement bound once in the constructor; range/list queries drain their rows
 * (`.all(...)`) before yielding so no cursor straddles a consumer's `await`; and
 * `promote` runs as a single `db.transaction(fn)` — `BEGIN IMMEDIATE; INSERT…;
 * DELETE…; COMMIT;` — whose three statements are re-prepared against the OPEN
 * transaction so they run on the held mutex slot without re-locking (which would
 * deadlock — see `st-nativescript-sqlite-transaction-mutex`).
 */
export class SqliteStoreDriver implements RawStoreDriver {
	private readonly stmts: {
		getMetadata: SqliteStatement;
		saveMetadata: SqliteStatement;
		getRevision: SqliteStatement;
		saveRevision: SqliteStatement;
		listRevisionsAsc: SqliteStatement;
		listRevisionsDesc: SqliteStatement;
		getPending: SqliteStatement;
		savePending: SqliteStatement;
		deletePending: SqliteStatement;
		listPending: SqliteStatement;
		listBlockIds: SqliteStatement;
		getTransaction: SqliteStatement;
		saveTransaction: SqliteStatement;
		getMaterialized: SqliteStatement;
		saveMaterialized: SqliteStatement;
		deleteMaterialized: SqliteStatement;
		pageCount: SqliteStatement;
		pageSize: SqliteStatement;
	};

	constructor(private readonly db: SqliteDb) {
		this.stmts = {
			getMetadata: db.prepare('SELECT value FROM metadata WHERE block_id = ?'),
			saveMetadata: db.prepare('INSERT OR REPLACE INTO metadata (block_id, value) VALUES (?, ?)'),
			getRevision: db.prepare('SELECT action_id FROM revisions WHERE block_id = ? AND rev = ?'),
			saveRevision: db.prepare('INSERT OR REPLACE INTO revisions (block_id, rev, action_id) VALUES (?, ?, ?)'),
			listRevisionsAsc: db.prepare('SELECT rev, action_id FROM revisions WHERE block_id = ? AND rev BETWEEN ? AND ? ORDER BY rev ASC'),
			listRevisionsDesc: db.prepare('SELECT rev, action_id FROM revisions WHERE block_id = ? AND rev BETWEEN ? AND ? ORDER BY rev DESC'),
			getPending: db.prepare('SELECT value FROM pending WHERE block_id = ? AND action_id = ?'),
			savePending: db.prepare('INSERT OR REPLACE INTO pending (block_id, action_id, value) VALUES (?, ?, ?)'),
			deletePending: db.prepare('DELETE FROM pending WHERE block_id = ? AND action_id = ?'),
			listPending: db.prepare('SELECT action_id FROM pending WHERE block_id = ? ORDER BY action_id ASC'),
			// metadata.block_id is the PRIMARY KEY, so each row is a distinct block id —
			// no dedup needed. NOTE: drains the whole metadata table up front; if a peer
			// ever holds millions of blocks and this SELECT becomes a startup-latency
			// problem, page it (LIMIT/OFFSET or keyset) — fine at current scale.
			listBlockIds: db.prepare('SELECT block_id FROM metadata'),
			getTransaction: db.prepare('SELECT value FROM transactions WHERE block_id = ? AND action_id = ?'),
			saveTransaction: db.prepare('INSERT OR REPLACE INTO transactions (block_id, action_id, value) VALUES (?, ?, ?)'),
			getMaterialized: db.prepare('SELECT value FROM materialized WHERE block_id = ? AND action_id = ?'),
			saveMaterialized: db.prepare('INSERT OR REPLACE INTO materialized (block_id, action_id, value) VALUES (?, ?, ?)'),
			deleteMaterialized: db.prepare('DELETE FROM materialized WHERE block_id = ? AND action_id = ?'),
			pageCount: db.prepare('PRAGMA page_count'),
			pageSize: db.prepare('PRAGMA page_size'),
		};
	}

	// --- metadata ---

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		const row = await this.stmts.getMetadata.get(blockId);
		return row ? (row.value as Uint8Array) : undefined;
	}

	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		await this.stmts.saveMetadata.run(blockId, value);
	}

	// --- revisions ---

	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		const row = await this.stmts.getRevision.get(blockId, rev);
		return row ? (row.action_id as Uint8Array) : undefined;
	}

	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		await this.stmts.saveRevision.run(blockId, rev, value);
	}

	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		// `.all(...)` materializes every row before we yield, so no SQLite cursor
		// straddles the consumer's awaits (the kernel's drain-before-yield contract).
		const stmt = reverse ? this.stmts.listRevisionsDesc : this.stmts.listRevisionsAsc;
		const rows = await stmt.all(blockId, lo, hi);
		for (const row of rows) {
			yield [row.rev as number, row.action_id as Uint8Array];
		}
	}

	// --- pending ---

	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const row = await this.stmts.getPending.get(blockId, actionId);
		return row ? (row.value as Uint8Array) : undefined;
	}

	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.stmts.savePending.run(blockId, actionId, value);
	}

	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.stmts.deletePending.run(blockId, actionId);
	}

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		// Drained by `.all(...)` before yielding — same rationale as rangeRevisions.
		const rows = await this.stmts.listPending.all(blockId);
		for (const row of rows) {
			yield row.action_id as ActionId;
		}
	}

	// --- transactions ---

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const row = await this.stmts.getTransaction.get(blockId, actionId);
		return row ? (row.value as Uint8Array) : undefined;
	}

	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.stmts.saveTransaction.run(blockId, actionId, value);
	}

	// --- materialized ---

	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		const row = await this.stmts.getMaterialized.get(blockId, actionId);
		return row ? (row.value as Uint8Array) : undefined;
	}

	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		await this.stmts.saveMaterialized.run(blockId, actionId, value);
	}

	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.stmts.deleteMaterialized.run(blockId, actionId);
	}

	// --- promote (the only cross-key atomic op) ---

	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.transaction(async (tx) => {
			// Prepare against the open transaction so these three statements run on
			// the held mutex slot without re-locking the connection (which would
			// deadlock). Re-preparing is cheap — the driver caches by SQL text.
			const getPending = tx.prepare('SELECT value FROM pending WHERE block_id = ? AND action_id = ?');
			const saveTransaction = tx.prepare('INSERT OR REPLACE INTO transactions (block_id, action_id, value) VALUES (?, ?, ?)');
			const deletePending = tx.prepare('DELETE FROM pending WHERE block_id = ? AND action_id = ?');
			const row = await getPending.get(blockId, actionId);
			if (!row) {
				throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
			}
			await saveTransaction.run(blockId, actionId, row.value as Uint8Array);
			await deletePending.run(blockId, actionId);
		});
	}

	// --- optional passthroughs ---

	async *listBlockIds(): AsyncIterable<BlockId> {
		const rows = await this.stmts.listBlockIds.all();
		for (const row of rows) {
			yield row.block_id as BlockId;
		}
	}

	async approximateBytesUsed(): Promise<number> {
		try {
			const pageCountRow = await this.stmts.pageCount.get();
			const pageSizeRow = await this.stmts.pageSize.get();
			const pages = (pageCountRow?.page_count as number | undefined) ?? 0;
			const size = (pageSizeRow?.page_size as number | undefined) ?? 0;
			return pages * size;
		} catch (err) {
			log('PRAGMA page_count/page_size failed: %o', err);
			return 0;
		}
	}
}

/**
 * SQLite-backed {@link IRawStorage} for NativeScript peers, now a thin shell over
 * the shared {@link KvRawStorage} kernel driven by a {@link SqliteStoreDriver}.
 * The public name/constructor (`new SqliteRawStorage(db)`) is unchanged so
 * existing imports keep resolving; the kernel supplies the `IRawStorage` surface
 * and the driver supplies SQLite behavior.
 *
 * `listBlockIds`/`getApproximateBytesUsed` are re-declared here as always-present
 * (the SQLite driver always implements them, so the kernel constructor always
 * wires them) — the base declares them optional, but every NS consumer relies on
 * them.
 */
export class SqliteRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;

	constructor(db: SqliteDb) {
		super(new SqliteStoreDriver(db));
	}
}
