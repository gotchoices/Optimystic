import type { CollectionId } from '@optimystic/db-core';
import { armUnrefTimer, unrefDelay } from '@optimystic/db-core';
import type { Database, MaintainedTableSchema, SchemaChangeEvent } from '@quereus/quereus';
import { MisuseError, isMaintainedTable } from '@quereus/quereus';
import type { QualifiedTableName } from '../schema/table-identity.js';
import { qualifiedTableName } from '../schema/table-identity.js';
import type { ExternalChangeFollower, ExternalChangeKind } from './external-change.js';
import type { TransactionBridge } from './txn-bridge.js';
import { createLogger } from '../logger.js';

const log = createLogger('materialized-views');

/** The first wait before a failed rebuild is tried again; each further failure of the view doubles it. */
const RETRY_FIRST_MS = 1_000;
/** The longest wait between two tries of a view that keeps failing to rebuild. */
const RETRY_MAX_MS = 60_000;
/**
 * How often to look again while Quereus has an explicit transaction open that no Optimystic connection
 * joined, so the bridge cannot say when it ends. Rare: a followed table has been initialized, and any
 * statement touching it joins its connection to every later transaction.
 */
const UNJOINED_TRANSACTION_POLL_MS = 1_000;

/** What the follower asks of one followed table; the vtab supplies it ({@link MaterializedViewFollower.followTable}). */
export interface FollowedTable {
	/** Bring every tree of the table up to date with what other writers committed, as a live read would. */
	pull(): Promise<void>;
	/** Whether this machine hears of another machine's commit to the table without reading the table. */
	toldOfRemoteCommits(): boolean;
}

/** What the follower reads off the transaction bridge. */
type FollowerBridge = Pick<TransactionBridge, 'isTransactionActive' | 'whenTransactionIdle' | 'tablesOf'>;

interface ViewName {
	readonly schemaName: string;
	readonly name: string;
}

/** A view whose last rebuild failed: how long its next retry waits, and the message last logged for it. */
interface Failure {
	delayMs: number;
	message: string;
}

/** The rebuild the follower is running, set around its `refresh materialized view`. */
interface Rebuilding {
	readonly key: string;
	/** Set from the view's `materialized_view_refreshed` event: whether the rebuild ran inside an explicit transaction. */
	insideTransaction: boolean;
}

/**
 * Keeps every materialized view over an Optimystic table in step with rows that reach the table
 * without a statement of this `Database` — another machine's commit, or a queued offline transaction
 * that failed and left this machine's view (docs/internals.md §Reactive Watch Bridge, GitHub #58).
 * Quereus maintains a view row by row only for its own statements' writes; this rebuilds each view
 * that reads a changed table (`refresh materialized view`), outside the callback that reported the
 * change, with every change reported while a rebuild is pending folded into it. One per `Database`.
 *
 * Three signals feed it, each synchronous, recording into a set and scheduling the run:
 * - **adopted** ({@link onExternalCommits}): a handle of one of the table's trees adopted other
 *   writers' commits in a refresh. Marks the table dirty.
 * - **hint** ({@link noteExternalChange} with `'hint'`): this node's storage applied a commit to the
 *   table, or its network watch woke. Fires for this machine's own commits too, so the run pulls the
 *   table first, which turns another writer's commit into an adopted signal and an own one into nothing.
 * - **changed** ({@link noteExternalChange} with `'changed'`): rows left or entered this machine's view
 *   with no log entry to adopt (the offline queue removed a failed transaction). Marks the table dirty.
 *
 * Every signal is dropped when no materialized view reads the table. The run ({@link follow}) repeats
 * until nothing is pending: under the exec lock, wait out any explicit transaction and pull every
 * pending table; then rebuild each view that reads a dirty table, in dependency order. A rebuild that
 * fails waits and retries, 1 s doubling to 60 s per view; see {@link settled} for what that means to a
 * waiter.
 */
export class MaterializedViewFollower implements ExternalChangeFollower {
	/** The tables a vtab registered ({@link followTable}), by lowercased `schema.table` — the form a view's `sourceTables` names them in. */
	private readonly tables = new Map<string, { readonly name: QualifiedTableName; readonly source: FollowedTable }>();
	/** Tables a hint arrived for, to be pulled. */
	private readonly hinted = new Set<string>();
	/** Tables whose rows changed in this machine's view; every view reading one is owed a rebuild. */
	private readonly dirty = new Set<string>();
	/** Views owed a rebuild, by lowercased `schema.name`. */
	private readonly owed = new Map<string, ViewName>();
	/** Views owed a rebuild that are waiting out a failure's delay; {@link armRetryTimer} moves them back to {@link owed}. */
	private readonly deferred = new Map<string, { readonly view: ViewName; readonly retryAt: number }>();
	/** Views whose last rebuild failed; cleared by a success, or when the view is gone. */
	private readonly failures = new Map<string, Failure>();
	/** `view|table` pairs already warned about by {@link warnIfUntold}. */
	private readonly warned = new Set<string>();
	private run: Promise<void> | undefined;
	private cancelRetryTimer: (() => void) | undefined;
	private rebuilding: Rebuilding | undefined;
	/** Set by {@link dispose}, or when the `Database` is found closed; nothing is scheduled after it. */
	private halted = false;
	private readonly haltedPromise: Promise<void>;
	private resolveHalted!: () => void;
	private readonly unsubscribeSchema: () => void;

	constructor(private readonly db: Database, private readonly bridge: FollowerBridge) {
		this.haltedPromise = new Promise<void>(resolve => { this.resolveHalted = resolve; });
		this.unsubscribeSchema = db.schemaManager.getChangeNotifier().addListener(event => this.onSchemaChange(event));
	}

	/**
	 * Follow `table` for the views that read it: called by the vtab on each full initialization, and
	 * replacing an earlier registration. Warns once for each existing view over the table if this machine
	 * is not told of other machines' commits to it.
	 */
	followTable(table: QualifiedTableName, source: FollowedTable): void {
		const key = tableKey(table);
		this.tables.set(key, { name: { ...table }, source });
		for (const view of this.db.schemaManager.getAllMaintainedTables()) {
			if (view.derivation.sourceTables.includes(key)) this.warnIfUntold(view);
		}
	}

	/** Stop following `table` (DROP TABLE, or a refused CREATE). Its pending signals are dropped. */
	unfollowTable(table: QualifiedTableName): void {
		const key = tableKey(table);
		this.tables.delete(key);
		this.hinted.delete(key);
		this.dirty.delete(key);
	}

	/**
	 * The adopted signal: a handle of `collectionId` adopted commits it did not write
	 * (`CollectionInitOptions.onExternalCommits`, bound to its collection id by `CollectionFactory`).
	 * Runs inside the collection's await-free adopt step, under its latch, so it only records.
	 */
	readonly onExternalCommits = (collectionId: CollectionId, _rev: number): void => {
		this.guarded('adopted', () => {
			for (const table of this.bridge.tablesOf(collectionId)?.values() ?? []) {
				this.markDirty(tableKey(table));
			}
		});
	};

	/** The hint and changed signals (see the class comment); reached through `announceExternalChange`. */
	noteExternalChange(table: QualifiedTableName, kind: ExternalChangeKind): void {
		this.guarded(kind, () => {
			const key = tableKey(table);
			if (kind === 'changed') {
				this.markDirty(key);
			} else if (this.tables.has(key) && this.viewsRead(key)) {
				this.hinted.add(key);
				this.schedule();
			}
		});
	}

	/**
	 * Resolves once the follower has nothing it can do now: no signal waiting, no pull or rebuild
	 * running, and no rebuild owed except those waiting to retry after a failure (logged when it
	 * happened), so one view that keeps failing does not hold every waiter. Waits for an open explicit
	 * transaction to end first, since nothing is rebuilt inside one: never await it from inside a
	 * transaction or a statement.
	 */
	async settled(): Promise<void> {
		while (!this.halted) {
			if (this.run !== undefined) {
				await this.run;
				continue;
			}
			if (!this.hasWork()) return;
			this.schedule();
		}
	}

	/** Stop following: nothing further is pulled or rebuilt, and a run in flight stops at its next step. */
	async dispose(): Promise<void> {
		this.halt();
		this.unsubscribeSchema();
		await this.run;
	}

	/** Mark `key` dirty, when some view reads it. */
	private markDirty(key: string): void {
		if (!this.viewsRead(key)) return;
		this.dirty.add(key);
		this.schedule();
	}

	/**
	 * Whether any materialized view reads the table `key`, directly or through a plain view.
	 * NOTE: reads the whole catalog per signal; if catalogs grow large, keep the set of read tables and
	 * invalidate it on `materialized_view_added` / `_removed` and on table renames.
	 */
	private viewsRead(key: string): boolean {
		return this.db.schemaManager.getAllMaintainedTables().some(view => view.derivation.sourceTables.includes(key));
	}

	private hasWork(): boolean {
		return this.hinted.size > 0 || this.dirty.size > 0 || this.owed.size > 0;
	}

	/** Start a run unless one is in flight; one in flight picks up what was recorded at its next step. */
	private schedule(): void {
		if (this.halted || this.run !== undefined) return;
		this.run = this.follow().finally(() => {
			this.run = undefined;
			// A signal recorded after the run's last look found nothing pending would otherwise wait for the next signal.
			if (this.hasWork()) this.schedule();
		});
	}

	/** The run: never rejects, and never starts inside the step that scheduled it. */
	private async follow(): Promise<void> {
		// A signal can arrive inside a collection's await-free adopt step; nothing below may run inside it.
		await Promise.resolve();
		try {
			while (!this.halted && this.hasWork()) {
				if (!await this.pullOutsideTransaction()) {
					await this.transactionEnded();
					continue;
				}
				this.expandDirty();
				await this.rebuildOwed();
			}
		} catch (error) {
			if (error instanceof MisuseError) {
				// Only a closed Database answers this follower's own calls with a misuse error.
				log('follower:database-closed: following stops: %s', error.message);
				this.halt();
				return;
			}
			log('WARN: follower:run-failed retryMs=%d: %s', RETRY_FIRST_MS, messageOf(error));
			// Held in flight, so the run that follows does not meet the same failure at once.
			await Promise.race([unrefDelay(RETRY_FIRST_MS), this.haltedPromise]);
		}
	}

	/**
	 * Steps 1 and 2. Under the exec lock (`ingestExternalRowWrite`, which ingests nothing for an empty
	 * result), so no statement runs beside a pull and the transaction state read is not mid-statement:
	 * when an explicit transaction is open, answer false and pull nothing; otherwise pull every hinted
	 * and dirty table. A pull that adopts other writers' commits raises the adopted signal, marking its
	 * table dirty. Dirty tables are pulled too, so every tree of the table is current before the rebuild
	 * and a tree that lagged does not report the same commits again on its next read, owing a second one.
	 */
	private async pullOutsideTransaction(): Promise<boolean> {
		let outside = true;
		await this.db.ingestExternalRowWrite(async () => {
			if (this.explicitTransactionOpen()) {
				outside = false;
				return [];
			}
			const keys = new Set([...this.hinted, ...this.dirty]);
			this.hinted.clear();
			for (const key of keys) {
				if (this.halted) break;
				await this.pull(key);
			}
			return [];
		});
		return outside;
	}

	/** Pull one table; a failure is logged, and the next read of the table pulls again. */
	private async pull(key: string): Promise<void> {
		const table = this.tables.get(key);
		if (table === undefined) return;
		try {
			await table.source.pull();
		} catch (error) {
			log('WARN: follower:pull-failed table=%s: %s', qualifiedTableName(table.name), messageOf(error));
		}
	}

	/** Every view reading a dirty table is owed a rebuild, unless it is waiting out a failure, whose retry reads the latest rows anyway. */
	private expandDirty(): void {
		if (this.dirty.size === 0) return;
		const tables = new Set(this.dirty);
		this.dirty.clear();
		for (const view of this.db.schemaManager.getAllMaintainedTables()) {
			const key = viewKey(view);
			if (this.deferred.has(key) || !view.derivation.sourceTables.some(source => tables.has(source))) continue;
			this.owed.set(key, { schemaName: view.schemaName, name: view.name });
		}
	}

	/**
	 * Step 3. Rebuild every owed view, a view that reads another owed view after it. A view that reads
	 * only an owed view is not owed itself: a rebuild sends its diff on to the live views over it. Stops
	 * at a rebuild that ran inside a transaction, which leaves the view owed for the run to retry once the
	 * transaction has ended.
	 */
	private async rebuildOwed(): Promise<void> {
		for (const view of this.rebuildOrder()) {
			if (this.halted) return;
			if (await this.rebuild(view) === 'inside-transaction') return;
		}
	}

	/** The owed views that still exist, ordered so a view comes after every owed view it reads; a view gone is forgotten. */
	private rebuildOrder(): MaintainedTableSchema[] {
		const pending: MaintainedTableSchema[] = [];
		for (const [key, name] of this.owed) {
			const view = this.db.schemaManager.getMaintainedTable(name.schemaName, name.name);
			if (view === undefined) {
				this.forgetView(key);
			} else {
				pending.push(view);
			}
		}
		const ordered: MaintainedTableSchema[] = [];
		while (pending.length > 0) {
			// A view is ready once no view still pending is one it reads. Views cannot read each other in a
			// cycle; were one ever found, the rest are taken in their recorded order rather than looping.
			const at = pending.findIndex(view => !pending.some(other => other !== view && view.derivation.sourceTables.includes(viewKey(other))));
			const [next] = pending.splice(at < 0 ? 0 : at, 1);
			ordered.push(next!);
		}
		return ordered;
	}

	/**
	 * Rebuild one view (`refresh materialized view`, which re-reads its sources through the vtab and sends
	 * its diff to the view's watchers and live dependents). Queued behind whatever statement holds the exec
	 * lock. Step 4: when it ran inside an explicit transaction — a `begin` queued ahead of it — or threw while
	 * one is open, the view stays owed: a rollback would undo it, and a commit leaves the next rebuild
	 * nothing to change. Step 5: any other failure defers the view.
	 */
	private async rebuild(view: MaintainedTableSchema): Promise<'done' | 'inside-transaction'> {
		const key = viewKey(view);
		const rebuilding: Rebuilding = { key, insideTransaction: false };
		this.rebuilding = rebuilding;
		try {
			await this.db.exec(`refresh materialized view ${quoteIdentifier(view.schemaName)}.${quoteIdentifier(view.name)}`);
		} catch (error) {
			if (error instanceof MisuseError) throw error;
			// NOTE: accepted tradeoff — read after the refresh released the exec lock, so a refusal caused by a
			// transaction that ended in between (`ddl_transaction_policy = 'strict'` refuses a refresh inside one)
			// reads as a plain failure: one log line and a 1 s retry, which then succeeds. Revisit if Quereus
			// ever says structurally that a refusal was the policy's.
			if (this.explicitTransactionOpen()) return 'inside-transaction';
			this.deferAfterFailure(key, view, error);
			return 'done';
		} finally {
			this.rebuilding = undefined;
		}
		if (rebuilding.insideTransaction) return 'inside-transaction';
		this.owed.delete(key);
		this.failures.delete(key);
		return 'done';
	}

	/** Move a view whose rebuild failed out of {@link owed} until its delay has passed; log a message once per view. */
	private deferAfterFailure(key: string, view: ViewName, error: unknown): void {
		const message = messageOf(error);
		const prior = this.failures.get(key);
		const delayMs = prior === undefined ? RETRY_FIRST_MS : Math.min(prior.delayMs * 2, RETRY_MAX_MS);
		if (prior?.message !== message) {
			log('WARN: follower:rebuild-failed view=%s.%s retryMs=%d: %s (retrying with backoff; this message is not repeated for the view)',
				view.schemaName, view.name, delayMs, message);
		}
		this.failures.set(key, { delayMs, message });
		this.owed.delete(key);
		this.deferred.set(key, { view: { schemaName: view.schemaName, name: view.name }, retryAt: Date.now() + delayMs });
		this.armRetryTimer();
	}

	/** Arm one timer for the earliest deferred retry; when it fires, every view due is owed again. */
	private armRetryTimer(): void {
		this.cancelRetryTimer?.();
		this.cancelRetryTimer = undefined;
		if (this.halted || this.deferred.size === 0) return;
		const earliest = Math.min(...[...this.deferred.values()].map(entry => entry.retryAt));
		this.cancelRetryTimer = armUnrefTimer(() => {
			this.cancelRetryTimer = undefined;
			const now = Date.now();
			for (const [key, entry] of this.deferred) {
				if (entry.retryAt > now) continue;
				this.deferred.delete(key);
				this.owed.set(key, entry.view);
			}
			this.armRetryTimer();
			this.schedule();
		}, Math.max(0, earliest - Date.now()));
	}

	/**
	 * A view owed a rebuild was removed: a drop, or the first half of a rename, which adds it again under
	 * the new name. Its source tables are marked dirty again, so whatever view reads them next is owed.
	 */
	private returnDebt(view: MaintainedTableSchema): void {
		const key = viewKey(view);
		if (!this.owed.has(key) && !this.deferred.has(key)) return;
		this.forgetView(key);
		for (const source of view.derivation.sourceTables) {
			if (this.tables.has(source)) this.dirty.add(source);
		}
		this.schedule();
	}

	private forgetView(key: string): void {
		this.owed.delete(key);
		this.deferred.delete(key);
		this.failures.delete(key);
	}

	/**
	 * Resolves when the explicit transaction {@link pullOutsideTransaction} found open has ended, or the
	 * follower halted. The bridge says when, since every Optimystic connection joins every transaction;
	 * the run then takes the exec lock, so it looks again only after the ending statement has finished.
	 */
	private async transactionEnded(): Promise<void> {
		const ended = this.bridge.isTransactionActive()
			? this.bridge.whenTransactionIdle()
			: unrefDelay(UNJOINED_TRANSACTION_POLL_MS);
		await Promise.race([ended, this.haltedPromise]);
	}

	private explicitTransactionOpen(): boolean {
		return !this.db.getAutocommit() && !this.db._isImplicitTransaction();
	}

	private onSchemaChange(event: SchemaChangeEvent): void {
		this.guarded(event.type, () => {
			if (event.type === 'materialized_view_refreshed') {
				// Synchronous, inside the refresh: the one moment whose transaction state is the refresh's own.
				// Never cleared by a later event: an application's refresh of the same view queued beside this
				// one can only add a rebuild that changes nothing, never hide one a rollback undid.
				if (this.rebuilding?.key === eventViewKey(event) && this.explicitTransactionOpen()) {
					this.rebuilding.insideTransaction = true;
				}
			} else if (event.type === 'materialized_view_added' && isMaintainedTable(event.newObject)) {
				this.warnIfUntold(event.newObject);
			} else if (event.type === 'materialized_view_removed' && isMaintainedTable(event.oldObject)) {
				this.returnDebt(event.oldObject);
			}
		});
	}

	/**
	 * Warn once per view and table when the view reads a followed table this machine is not told of other
	 * machines' commits to: such a commit reaches the view only when something here reads the table.
	 */
	private warnIfUntold(view: MaintainedTableSchema): void {
		for (const source of view.derivation.sourceTables) {
			const table = this.tables.get(source);
			if (table === undefined || table.source.toldOfRemoteCommits()) continue;
			const pair = `${viewKey(view)}|${source}`;
			if (this.warned.has(pair)) continue;
			this.warned.add(pair);
			log('WARN: materialized view %s.%s reads %s, whose commits from other machines reach this machine only when it reads that table, '
				+ 'so the view can answer behind until then; tag the table "optimystic.network_watch" = true to be told of them',
				view.schemaName, view.name, qualifiedTableName(table.name));
		}
	}

	private halt(): void {
		if (this.halted) return;
		this.halted = true;
		this.cancelRetryTimer?.();
		this.cancelRetryTimer = undefined;
		this.resolveHalted();
	}

	/** Run `work` from a callback that must not be interrupted: a throw is logged, never raised. */
	private guarded(what: string, work: () => void): void {
		if (this.halted) return;
		try {
			work();
		} catch (error) {
			log('WARN: follower:signal-failed signal=%s: %s', what, messageOf(error));
		}
	}
}

/** A table as a view's `sourceTables` names it: lowercased `schema.table`. */
function tableKey(table: QualifiedTableName): string {
	return `${table.schemaName}.${table.tableName}`.toLowerCase();
}

function viewKey(view: ViewName): string {
	return `${view.schemaName}.${view.name}`.toLowerCase();
}

function eventViewKey(event: { schemaName: string; objectName: string }): string {
	return `${event.schemaName}.${event.objectName}`.toLowerCase();
}

function quoteIdentifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
