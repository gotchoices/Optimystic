import { StoreFailedError } from '@optimystic/db-p2p';
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

/**
 * Tracks whether a store wrote since its last flush, and latches the store failed when a sync fails
 * (rule 5 of the flush contract on `RawStoreDriver.flush`). Shared by the stores that write by
 * autocommit statements and flush with one `syncSqliteDb` (`SqliteKVStore`, `SqlitePieceStore`).
 */
export class PendingSqliteSync {
	/** Set once a write has resolved, cleared by the flush that syncs it. */
	private dirty = false;
	private fault: { cause: unknown } | undefined;

	constructor(private readonly db: SqliteDb) {}

	/** Throws `StoreFailedError` once a sync has failed. Writes call it first. */
	throwIfFailed(): void {
		if (this.fault) throw new StoreFailedError(this.fault.cause);
	}

	/** A write resolved; the next flush must sync. */
	noteWrite(): void {
		this.dirty = true;
	}

	/** One synced commit when a write resolved since the last flush, otherwise nothing; a failure latches and throws `StoreFailedError`. */
	async flush(): Promise<void> {
		this.throwIfFailed();
		if (!this.dirty) return;
		// Cleared before the sync, so a write resolving while the sync runs is covered by the next
		// flush whether or not this sync's commit happened to come after it.
		this.dirty = false;
		try {
			await syncSqliteDb(this.db);
		} catch (err) {
			this.fault ??= { cause: err };
			throw new StoreFailedError(this.fault.cause);
		}
	}
}
