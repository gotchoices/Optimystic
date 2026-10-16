import type { ActionId, BlockId } from '@optimystic/db-core';
import {
	KvRawStorage,
	StoreFailedError,
	SyncDeadlines,
	WriteGroupDriver,
	identityForHandle,
	type BatchBackend,
	type BatchEntry,
	type CommittedBatch,
	type SetTimer,
	type SinkCommitOptions,
	type StoreDurability,
	type StoreIdentity,
	type StoreKey,
	type SyncCover,
	type WriteGroupOptions,
} from '@optimystic/db-p2p';
import type { SqliteDb, SqliteParam, SqliteStatement, SqliteTransaction } from './db.js';
import { createLogger } from './logger.js';
import { bumpDurabilityMark } from './sqlite-sync.js';

const log = createLogger('storage:sqlite');

type Store = StoreKey['store'];

/** How a logical store is laid out: its table is named after it, with these key columns and this value column. */
interface TableLayout {
	readonly keyColumns: readonly string[];
	readonly valueColumn: string;
}

const LAYOUTS: Record<Store, TableLayout> = {
	metadata: { keyColumns: ['block_id'], valueColumn: 'value' },
	revisions: { keyColumns: ['block_id', 'rev'], valueColumn: 'action_id' },
	proofs: { keyColumns: ['block_id', 'rev'], valueColumn: 'value' },
	pending: { keyColumns: ['block_id', 'action_id'], valueColumn: 'value' },
	transactions: { keyColumns: ['block_id', 'action_id'], valueColumn: 'value' },
	materialized: { keyColumns: ['block_id', 'action_id'], valueColumn: 'value' },
};

const STORES = Object.keys(LAYOUTS) as Store[];

const whereKey = (store: Store): string => LAYOUTS[store].keyColumns.map(column => `${column} = ?`).join(' AND ');

const sqlByStore = (build: (store: Store) => string): Record<Store, string> =>
	Object.fromEntries(STORES.map(store => [store, build(store)])) as Record<Store, string>;

const GET_SQL = sqlByStore(store => `SELECT ${LAYOUTS[store].valueColumn} FROM ${store} WHERE ${whereKey(store)}`);
const PUT_SQL = sqlByStore(store => {
	const columns = [...LAYOUTS[store].keyColumns, LAYOUTS[store].valueColumn];
	return `INSERT OR REPLACE INTO ${store} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
});
const DELETE_SQL = sqlByStore(store => `DELETE FROM ${store} WHERE ${whereKey(store)}`);

/** The key's bind parameters, in the order of its store's key columns. */
function keyParams(key: StoreKey): SqliteParam[] {
	switch (key.store) {
		case 'metadata':
			return [key.blockId];
		case 'revisions':
		case 'proofs':
			return [key.blockId, key.rev];
		case 'pending':
		case 'transactions':
		case 'materialized':
			return [key.blockId, key.actionId];
	}
}

/** What a {@link SqliteBatchBackend} is built with: the test-only `setTimer` that arms its deadline timer. */
export interface SqliteBatchBackendOptions {
	readonly setTimer?: SetTimer;
}

/**
 * SQLite {@link BatchBackend}: the six logical block-storage stores mapped to the six relational
 * tables (`metadata`, `revisions`, `pending`, `transactions`, `proofs`, `materialized`) with their
 * original columns and keys, every batch applied as ONE SQLite transaction. The reads are the
 * former per-write driver's statements unchanged, so the on-disk format did not change with the
 * move to batches.
 *
 * `KvRawStorage` owns all JSON serialization, so this backend only ever reads/writes `Uint8Array`
 * values: the value columns are BLOB and SQLite binds a `Uint8Array` as a BLOB and returns it as a
 * `Uint8Array`, so no codec lives here (a TEXT column would risk UTF-8 coercion corrupting non-ASCII
 * JSON bytes).
 *
 * ### Why a committed batch survives a power cut, and in order
 *
 * `applySchema` (`db.ts`) opens every database in write-ahead-log (WAL) mode under
 * `synchronous = NORMAL`. A commit appends the batch's frames to the one WAL file, each frame
 * checksummed over the frames before it, and recovery stops at the first bad frame; before every
 * checkpoint SQLite syncs the WAL, so the database file never holds later content ahead of earlier
 * content. What a power cut leaves is therefore a prefix of the committed transactions, in commit
 * order — rule 3 of the flush contract on `RawStoreDriver.flush` — and a batch is one transaction,
 * so it survives whole or not at all. A commit under `synchronous = FULL`
 * (`SqliteTransactionOptions.synced`) syncs the WAL at that commit, and the WAL being one
 * append-only file, that sync covers every earlier commit on the database, the key-value store's
 * and the identity helper's included, since all three share one connection. So the sync of a batch
 * is one `FULL` commit — this batch's own when it must be synced at once, a later batch's, or the
 * `durability_mark` bump the deadline timer commits — which is what `durability: 'power-loss'`
 * states.
 *
 * ### How a commit decides
 *
 * The deadlines, the timer and the backpressure test are the rules of `SyncDeadlines` from
 * `@optimystic/db-p2p`, shared with the file backend. `commit` takes the batch's deadline as it is
 * called and decides whether the transaction is synced BEFORE taking the connection mutex, since
 * the pragma is set as the transaction starts; the bookkeeping — `defer` of a deferred batch,
 * `take` of the cover a synced one settles — runs INSIDE the transaction body, under the mutex, so
 * it is ordered against every other commit and sync: a cover taken there is exactly the batches
 * whose transactions committed earlier, every one of which this `FULL` commit syncs. A deadline
 * that passes between the decision and the mutex only delays that commit's backpressure to the
 * timer, which is due anyway.
 *
 * A read sees a batch as soon as its transaction commits, before it is synced, which `BatchBackend`
 * allows; the overlay above serves the batch until it is durable. The handle is shared with
 * `SqliteKVStore` and `loadOrCreateNSPeerKey`, so `close()` never closes it. Every write of a batch
 * goes through `tx.prepare`, never a class-level statement, which would re-take the mutex the
 * transaction holds and deadlock (see `SqliteDb.transaction`).
 */
export class SqliteBatchBackend implements BatchBackend {
	readonly durability: StoreDurability = 'power-loss';

	// NOTE: identity is the HANDLE object, so two handles opened over the same SQLite FILE read
	// as two identities. Resolving that would mean naming the underlying database file, which
	// `SqliteDb` does not expose. The package opener (`ns-opener.ts`) hands out one handle per
	// file in practice, so this is the reachable case, not the complete one.
	private readonly identity: StoreIdentity;

	/** One point read per store. Reads run off the mutex, so a class-level statement is right here. */
	private readonly reads: Record<Store, SqliteStatement>;
	private readonly stmts: {
		listRevisions: SqliteStatement;
		listPending: SqliteStatement;
		listBlockIds: SqliteStatement;
		pageCount: SqliteStatement;
		pageSize: SqliteStatement;
	};

	/**
	 * Batches committed and not yet synced, in order, each with the `durable` the next sync settles;
	 * the earliest deadline among them, with a timer armed for it; and the `window-overrun` episode.
	 * A batch's payload is nothing: its transaction has already applied it.
	 */
	private readonly deadlines: SyncDeadlines<undefined>;
	private fault: { cause: unknown } | undefined;

	constructor(private readonly db: SqliteDb, options: SqliteBatchBackendOptions = {}) {
		this.identity = identityForHandle('sqlite-handle', db);
		this.reads = Object.fromEntries(STORES.map(store => [store, db.prepare(GET_SQL[store])])) as Record<Store, SqliteStatement>;
		this.stmts = {
			listRevisions: db.prepare('SELECT rev, action_id FROM revisions WHERE block_id = ? AND rev BETWEEN ? AND ? ORDER BY rev ASC'),
			listPending: db.prepare('SELECT action_id FROM pending WHERE block_id = ? ORDER BY action_id ASC'),
			// metadata.block_id is the PRIMARY KEY, so each row is a distinct block id —
			// no dedup needed. NOTE: drains the whole metadata table up front; if a peer
			// ever holds millions of blocks and this SELECT becomes a startup-latency
			// problem, page it (LIMIT/OFFSET or keyset) — fine at current scale.
			listBlockIds: db.prepare('SELECT block_id FROM metadata'),
			pageCount: db.prepare('PRAGMA page_count'),
			pageSize: db.prepare('PRAGMA page_size'),
		};
		this.deadlines = new SyncDeadlines({
			onDue: firedAt => this.syncInBackground(firedAt),
			setTimer: options.setTimer,
			log,
			subject: this.identity,
		});
	}

	/** True once a transaction or a sync failed; every later `commit` and `sync` then throws {@link StoreFailedError}. */
	get failed(): boolean {
		return this.fault !== undefined;
	}

	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	// --- reads ---

	async get(key: StoreKey): Promise<Uint8Array | undefined> {
		const row = await this.reads[key.store].get(...keyParams(key));
		return row ? (row[LAYOUTS[key.store].valueColumn] as Uint8Array) : undefined;
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]> {
		const rows = await this.stmts.listRevisions.all(blockId, lo, hi);
		return rows.map(row => [row.rev as number, row.action_id as Uint8Array]);
	}

	async listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		const rows = await this.stmts.listPending.all(blockId);
		return rows.map(row => row.action_id as ActionId);
	}

	async *listBlockIds(): AsyncIterable<BlockId> {
		// Drained by `.all(...)` before yielding, so no cursor straddles the consumer's awaits.
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

	// --- the write group's sink ---

	/**
	 * Apply the batch as one transaction and resolve with its `durable`. `WriteGroupSink.commit`'s
	 * contract: with `syncWithinMs` 0, or a deadline already passed (`SyncDeadlines.mustSyncNow`),
	 * the transaction commits under `synchronous = FULL`, which syncs this batch and every one held,
	 * and `durable` is already settled; otherwise it commits under `NORMAL` and `durable` settles at
	 * the next sync, which the timer makes by the earliest deadline held. A rejection has latched the
	 * backend.
	 */
	commit(entries: readonly BatchEntry[], { syncWithinMs }: SinkCommitOptions): Promise<CommittedBatch> {
		if (!(syncWithinMs >= 0) || !Number.isFinite(syncWithinMs)) {
			return Promise.reject(new RangeError(`syncWithinMs must be a finite number of milliseconds at or above 0, got ${syncWithinMs}`));
		}
		if (this.fault) return Promise.reject(new StoreFailedError(this.fault.cause));
		const deadline = this.deadlines.deadlineFor(syncWithinMs);
		return this.deadlines.mustSyncNow(deadline) ? this.commitSynced(entries) : this.commitDeferred(entries, deadline);
	}

	/** Hasten: one synced commit covering every batch held when it runs; with nothing held, nothing is synced. `WriteGroupSink.sync`'s contract. */
	sync(): Promise<void> {
		return this.syncHeld();
	}

	/**
	 * The handle is shared, so it is not closed here: only the deadline timer must not outlive the
	 * backend. `WriteGroupDriver.close` flushes strictly first, which took and settled everything
	 * held and so disarmed the timer; a caller that did not flush gets the same here. After a latch
	 * nothing is held, since the latch took and rejected it.
	 */
	async close(): Promise<void> {
		if (this.fault) return;
		await this.syncHeld();
	}

	private async commitDeferred(entries: readonly BatchEntry[], deadline: number | undefined): Promise<CommittedBatch> {
		try {
			return await this.db.transaction(async (tx) => {
				this.throwIfFailed();
				await this.applyEntries(tx, entries);
				// Deferred under the mutex, so the next sync's cover, also taken under it, includes this
				// batch only once its transaction has committed.
				return { durable: this.deadlines.defer(undefined, deadline) };
			});
		} catch (err) {
			throw this.latch(err);
		}
	}

	private async commitSynced(entries: readonly BatchEntry[]): Promise<CommittedBatch> {
		await this.syncHeld(undefined, tx => this.applyEntries(tx, entries));
		return { durable: Promise.resolve() };
	}

	/**
	 * The sync step: one synced transaction whose body runs `write`, if given, then takes the cover
	 * of every batch held — under the mutex, so the cover is exactly the batches whose transactions
	 * committed before this one — and, when there is a cover to settle and nothing of its own was
	 * written, bumps `durability_mark` so the commit has a frame to sync. The cover settles once the
	 * commit has resolved. A failure anywhere latches the backend and rejects every covered
	 * `durable`, so no flush waits for a sync the store will not make.
	 *
	 * `owedSince` is the moment the timer fired, when the timer's task runs this: `SyncDeadlines.take`
	 * counts the sync's lateness from it rather than from a deadline the timer's own slop missed.
	 */
	private async syncHeld(owedSince?: number, write?: (tx: SqliteTransaction) => Promise<number>): Promise<void> {
		// Assigned inside the body, so a failure after the take still reaches the cover it took.
		let cover: SyncCover<undefined> | undefined;
		try {
			await this.db.transaction(async (tx) => {
				this.throwIfFailed();
				const written = write ? await write(tx) : 0;
				cover = this.deadlines.take(owedSince);
				if (written === 0 && cover.items.length > 0) await bumpDurabilityMark(tx);
			}, { synced: true });
		} catch (err) {
			const failure = this.latch(err);
			cover?.fail(failure.cause);
			throw failure;
		}
		cover?.settle();
	}

	/** The timer fired: run the sync step. Its failure has latched the backend, so it is only logged here. */
	private syncInBackground(firedAt: number): void {
		this.syncHeld(firedAt).catch((err: unknown) => {
			log('deferred sync of %s failed; the store refuses every later write: %o', this.identity, err);
		});
	}

	/**
	 * Every entry in order — a put as `INSERT OR REPLACE`, a delete as `DELETE` — each statement
	 * prepared once per batch against the open transaction. Returns how many were applied.
	 */
	private async applyEntries(tx: SqliteTransaction, entries: readonly BatchEntry[]): Promise<number> {
		const prepared = new Map<string, SqliteStatement>();
		const statement = (sql: string): SqliteStatement => {
			let stmt = prepared.get(sql);
			if (!stmt) {
				stmt = tx.prepare(sql);
				prepared.set(sql, stmt);
			}
			return stmt;
		};
		for (const { key, value } of entries) {
			if (value === undefined) await statement(DELETE_SQL[key.store]).run(...keyParams(key));
			else await statement(PUT_SQL[key.store]).run(...keyParams(key), value);
		}
		return entries.length;
	}

	private throwIfFailed(): void {
		if (this.fault) throw new StoreFailedError(this.fault.cause);
	}

	/**
	 * Latch the backend failed on its first fault and reject every batch waiting for a sync that will
	 * now never be made, so no caller waits on a `durable` for ever. Returns the error to throw,
	 * carrying the fault underneath — never a `StoreFailedError` wrapping another.
	 */
	private latch(err: unknown): StoreFailedError {
		const cause = err instanceof StoreFailedError ? err.cause : err;
		this.fault ??= { cause };
		this.deadlines.failAll(cause);
		return new StoreFailedError(this.fault.cause);
	}
}

/** The write group's options (`WriteGroupOptions`); the test-only `setTimer` arms both the group's idle flush and the backend's deadline timer. */
export type SqliteRawStorageOptions = WriteGroupOptions;

/**
 * SQLite-backed {@link IRawStorage} for NativeScript peers: the shared {@link KvRawStorage} kernel
 * over a {@link WriteGroupDriver} over a {@link SqliteBatchBackend}. Every write resolves into the
 * driver's in-memory overlay; `flush()` hands the group to the backend as one batch, which applies
 * it as one SQLite transaction, synced before the flush resolves or within the window the flush
 * allows. The public name/constructor (`new SqliteRawStorage(db)`) is unchanged so existing imports
 * keep resolving.
 *
 * `listBlockIds`/`getApproximateBytesUsed`/`getStoreIdentity`/`close` are re-declared here as
 * always-present (the backend always implements the first three, so the driver and kernel always
 * wire them, and the driver always has a `close`) — the base declares them optional, but every NS
 * consumer relies on them. `close()` flushes what is still held, syncs it, and disarms the timers;
 * it does not close the shared handle, which the host closes afterwards.
 */
export class SqliteRawStorage extends KvRawStorage {
	declare listBlockIds: () => AsyncIterable<BlockId>;
	declare getApproximateBytesUsed: () => Promise<number>;
	declare getStoreIdentity: () => StoreIdentity;
	declare close: () => Promise<void>;

	constructor(db: SqliteDb, options: SqliteRawStorageOptions = {}) {
		super(new WriteGroupDriver(new SqliteBatchBackend(db, options), options));
	}
}
