import type { ActionId, ActionRev, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata, IRawStorage } from '@optimystic/db-p2p';
import type { SqliteDb, SqliteStatement } from './db.js';
import { createLogger } from './logger.js';

const log = createLogger('storage:sqlite');

/**
 * SQLite-backed `IRawStorage` implementation for NativeScript peers.
 *
 * Every CRUD operation goes through a prepared statement bound once in the
 * constructor. `listRevisions` and `listPendingTransactions` issue
 * `SELECT … ORDER BY` queries bounded by `block_id` (and `rev` for revisions)
 * and drain the results into an array before yielding — matching the
 * `IndexedDBRawStorage` pattern, where holding a cursor live across consumer
 * awaits would invalidate the underlying transaction.
 *
 * `promotePendingTransaction` runs as a single `BEGIN; INSERT…; DELETE…; COMMIT;`
 * via `SqliteDb.transaction(fn)`, so the move is atomic across crashes —
 * unlike the MMKV adapter, which has to maintain a separate pending-index row.
 */
export class SqliteRawStorage implements IRawStorage {
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
			getTransaction: db.prepare('SELECT value FROM transactions WHERE block_id = ? AND action_id = ?'),
			saveTransaction: db.prepare('INSERT OR REPLACE INTO transactions (block_id, action_id, value) VALUES (?, ?, ?)'),
			getMaterialized: db.prepare('SELECT value FROM materialized WHERE block_id = ? AND action_id = ?'),
			saveMaterialized: db.prepare('INSERT OR REPLACE INTO materialized (block_id, action_id, value) VALUES (?, ?, ?)'),
			deleteMaterialized: db.prepare('DELETE FROM materialized WHERE block_id = ? AND action_id = ?'),
			pageCount: db.prepare('PRAGMA page_count'),
			pageSize: db.prepare('PRAGMA page_size'),
		};
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		const row = await this.stmts.getMetadata.get(blockId);
		if (!row) return undefined;
		return JSON.parse(row.value as string) as BlockMetadata;
	}

	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		await this.stmts.saveMetadata.run(blockId, JSON.stringify(metadata));
	}

	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		const row = await this.stmts.getRevision.get(blockId, rev);
		return row ? (row.action_id as ActionId) : undefined;
	}

	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		await this.stmts.saveRevision.run(blockId, rev, actionId);
	}

	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		const ascending = startRev <= endRev;
		const lo = ascending ? startRev : endRev;
		const hi = ascending ? endRev : startRev;
		const stmt = ascending ? this.stmts.listRevisionsAsc : this.stmts.listRevisionsDesc;
		const rows = await stmt.all(blockId, lo, hi);
		for (const row of rows) {
			yield { rev: row.rev as number, actionId: row.action_id as ActionId };
		}
	}

	async getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const row = await this.stmts.getPending.get(blockId, actionId);
		if (!row) return undefined;
		return JSON.parse(row.value as string) as Transform;
	}

	async savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.stmts.savePending.run(blockId, actionId, JSON.stringify(transform));
	}

	async deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.stmts.deletePending.run(blockId, actionId);
	}

	async *listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		const rows = await this.stmts.listPending.all(blockId);
		for (const row of rows) {
			yield row.action_id as ActionId;
		}
	}

	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		const row = await this.stmts.getTransaction.get(blockId, actionId);
		if (!row) return undefined;
		return JSON.parse(row.value as string) as Transform;
	}

	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		await this.stmts.saveTransaction.run(blockId, actionId, JSON.stringify(transform));
	}

	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		const row = await this.stmts.getMaterialized.get(blockId, actionId);
		if (!row) return undefined;
		return JSON.parse(row.value as string) as IBlock;
	}

	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		if (block) {
			await this.stmts.saveMaterialized.run(blockId, actionId, JSON.stringify(block));
		} else {
			await this.stmts.deleteMaterialized.run(blockId, actionId);
		}
	}

	async getApproximateBytesUsed(): Promise<number> {
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

	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		await this.db.transaction(async () => {
			const row = await this.stmts.getPending.get(blockId, actionId);
			if (!row) {
				throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
			}
			await this.stmts.saveTransaction.run(blockId, actionId, row.value as string);
			await this.stmts.deletePending.run(blockId, actionId);
		});
	}
}
