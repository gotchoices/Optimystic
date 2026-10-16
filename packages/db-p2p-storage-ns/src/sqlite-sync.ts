import type { SqliteDb, SqliteTransaction } from './db.js';

const BUMP_MARK_SQL = 'INSERT INTO durability_mark (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1';

/**
 * Bump the one `durability_mark` row inside an open transaction, so that the transaction has a
 * frame to commit whatever else it wrote. The row's count means nothing; a sync needs a change to
 * commit, because a transaction that changed nothing writes no frame and syncs nothing.
 */
export async function bumpDurabilityMark(tx: SqliteTransaction): Promise<void> {
	await tx.prepare(BUMP_MARK_SQL).run();
}

/**
 * Sync the database: one synced transaction (`SqliteTransactionOptions.synced`) that bumps the
 * `durability_mark` row. Its commit syncs the write-ahead log, which is one append-only file, so
 * every earlier commit on this database — the block store's, the key-value store's and the identity
 * helper's, all on one connection — survives a power cut once this resolves. Every sync in the
 * package goes through this helper or through a synced transaction that writes rows of its own
 * (`SqliteBatchBackend`).
 */
export async function syncSqliteDb(db: SqliteDb): Promise<void> {
	await db.transaction(bumpDurabilityMark, { synced: true });
}
