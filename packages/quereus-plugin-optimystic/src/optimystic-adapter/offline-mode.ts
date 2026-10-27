import type { Database, QualifiedName } from '@quereus/quereus';
import { QuereusError, StatusCode } from '@quereus/quereus';
import { EntryNotDiscardableError, OfflineQueue, QueueDisposedError, UnknownEntryError, alwaysReachable } from '@optimystic/db-core';
import type {
	ActionRefusedError, BlockId, Collection, CollectionId, EntryId, EntryStatus, ICohortReachability, JournalSettledStatus,
	OfflineQueueOptions, OfflineQueueState, QueuedEntry, TransactionDurability,
} from '@optimystic/db-core';
import type { TransactionBridge } from './txn-bridge.js';
import { DEFAULT_JOURNAL_LABEL, type ParsedOfflineConfig } from './offline-config.js';
import { OfflineJournal, type RetainedOutcome } from './offline-journal.js';
import { OfflineRestore, type DeferredRecord } from './offline-restore.js';
import type { OfflineModeState, QueuedTransaction, QueuedTransactionStatus, TransactionOutcome } from './offline-status.js';
import { followOutlooks, judgeTransaction, outlookContradicted, refusedCheck, renderKey } from './commit-outlook.js';
import type {
	CollectionDescription, CommitOutlook, DeferredTransaction, EarlierEntry, EntryFacts, FollowedEntry, OutlookSchema, QueueAhead, QueuedJudgement, StagedWrites, TableOutlookSource,
} from './commit-outlook.js';
import { guardRefusalIn } from './guard-refusal.js';
import { addListener, notifyListeners } from './listeners.js';
import { announceExternalChange } from './external-change.js';
import { NetworkCommitBoundMs } from './network-commit-bound.js';
import { qualifiedTableName, type QualifiedTableName } from '../schema/table-identity.js';
import { createLogger } from '../logger.js';

const log = createLogger('offline-mode');

/** How long a terminal outcome stays answerable through `status` and `outcomes` by default. */
export const DEFAULT_OUTCOME_RETENTION_MS = 7 * 24 * 3600_000;

/** Thrown by `plugin.offline.enter()` while the mode cannot be entered: session mode is configured
 * (docs/offline-sync.md §Session mode), which the mode refuses until a later stage designs
 * re-execution at drain. */
export class OfflineModeRefusedError extends Error {
	constructor(readonly reason: 'session-mode') {
		super('offline mode cannot be entered while session mode is configured (TransactionBridge.configureTransactionMode): a queued session transaction would be stale by the time it drains');
		this.name = 'OfflineModeRefusedError';
	}
}

/** Thrown by `TransactionBridge.configureTransactionMode` while session mode cannot be configured:
 * offline mode is entered, or locally acknowledged transactions are still queued. The two modes
 * cannot be combined in either order. */
export class SessionModeRefusedError extends Error {
	constructor(readonly reason: 'offline-mode' | 'queued-entries') {
		super(reason === 'offline-mode'
			? 'session mode cannot be configured while offline mode is entered (plugin.offline.exit() first)'
			: 'session mode cannot be configured while locally acknowledged transactions are queued (await plugin.offline.whenDrained() first)');
		this.name = 'SessionModeRefusedError';
	}
}

/**
 * Thrown out of a network-acknowledged commit that waited behind queued offline transactions longer
 * than `offline.networkCommitTimeoutMs` (docs/offline-sync.md §Network acknowledgement behind a
 * non-empty queue). {@link sent} says what became of the transaction:
 *
 * - `false`: it was never sent, so it has been withdrawn. It failed with reason `discarded`, its rows
 *   are gone from this machine's view, and nothing of it is saved.
 * - `true`: it has been sent and may already be saved, so it could not be withdrawn. It stays queued
 *   as a locally acknowledged transaction; follow it under {@link transactionId} through
 *   `plugin.offline.onStatus` or `plugin.offline.status(transactionId)`.
 *
 * Carries `StatusCode.BUSY`, as `ConcurrentModificationError` does: the commit was not refused, the
 * network did not answer in time.
 */
export class OfflineCommitTimeoutError extends QuereusError {
	constructor(readonly transactionId: string, readonly sent: boolean, readonly timeoutMs: number, cause?: Error) {
		super(sent
			? `transaction ${transactionId} was not acknowledged by the network within ${timeoutMs} ms; it has been sent and may already be saved, so it stays queued (follow it through plugin.offline.status)`
			: `transaction ${transactionId} was not acknowledged by the network within ${timeoutMs} ms; it was never sent and has been withdrawn`,
		StatusCode.BUSY, cause);
		this.name = 'OfflineCommitTimeoutError';
		Object.setPrototypeOf(this, OfflineCommitTimeoutError.prototype);
	}
}

/** The statements that change how a table's rows are stored (docs/offline-sync.md §Schema changes).
 * `'create table'` is one only when it re-declares, with other columns or another primary key, a
 * collection a live table already backs. */
export type StorageShapeChange = 'create table' | 'create index' | 'drop index' | 'add column' | 'drop column' | 'drop table';

/**
 * Thrown by a statement that would change how {@link table}'s rows are stored while transactions that
 * wrote it are still queued (docs/offline-sync.md §Schema changes): an index built now would index
 * rows the network does not hold yet, and a queued transaction carries no write for an index added
 * after it. Nothing was written; the same statement succeeds once the transactions settle
 * (`plugin.offline.whenDrained()`). {@link transactionIds} lists the queued ones in queue order — one
 * being submitted, or in doubt, counts like any other — then any failed one whose removal is still
 * dropping its rows from this machine's view.
 *
 * Carries `StatusCode.BUSY`: the statement was not judged wrong, it has to wait.
 */
export class QueuedEntriesBlockSchemaChangeError extends QuereusError {
	constructor(readonly table: string, readonly operation: StorageShapeChange, readonly transactionIds: readonly string[]) {
		super(`cannot ${operation} while ${transactionIds.length === 1 ? 'a queued offline transaction' : `${transactionIds.length} queued offline transactions`} that wrote ${table} ${transactionIds.length === 1 ? 'is' : 'are'} unsettled (${transactionIds.join(', ')}): it changes how ${table}'s rows are stored, and those rows have not reached the network yet. It succeeds once they settle (plugin.offline.whenDrained())`,
		StatusCode.BUSY);
		this.name = 'QueuedEntriesBlockSchemaChangeError';
		Object.setPrototypeOf(this, QueuedEntriesBlockSchemaChangeError.prototype);
	}
}

/**
 * Which acknowledgement a transaction writing a table may get in offline mode, from the table's
 * `optimystic.offline` tag (docs/offline-sync.md §Per-table policy): `'queue'`, the mode's (the
 * default), or `'network'`, network acknowledgement whatever the mode.
 */
export type OfflineTablePolicy = 'queue' | 'network';

/** What a table's vtab tells the controller about how the table behaves offline. */
interface PublishedTable {
	readonly policy: OfflineTablePolicy;
	/** The reachability gate of the table's transactor (`CollectionFactory.getCohortReachability`). */
	readonly reachability: ICohortReachability;
	/** Which of the table's trees a collection is, for judging a transaction's checks ({@link OfflineMode.openTransactionOutlook}). */
	readonly outlook: TableOutlookSource;
}

/** The one thing the restore after a restart needs from the module: a declared table's collections,
 * initialized (`OptimysticModule.collectionsOfTable`). Attached by `register` once the module exists. */
export interface TableCollectionsResolver {
	collectionsOfTable(db: Database, table: QualifiedTableName): Promise<readonly Collection<any>[] | undefined>;
}

type StatusListener = (status: QueuedTransactionStatus) => void;
type StateListener = (state: OfflineModeState) => void;
type FailedEntryStatus = Extract<EntryStatus, { kind: 'failed' }>;

/** A queued transaction's judgement, held from its first `queued` status until it settles. */
type HeldJudgement = QueuedJudgement & {
	/** A transaction its outlook lists in `dependsOn` has failed since the outlook was last computed,
	 * so a failure of this one through that failure is one the outlook allowed for. */
	readonly dependencyFailed: boolean;
};
/** Called with a transaction's terminal outcome, or `undefined` when the controller was disposed first. */
type SettleWaiter = (outcome: TransactionOutcome | undefined) => void;

/**
 * Everything an application sees under `plugin.offline` (docs/offline-sync.md §Application
 * interface): the mode flag, one `OfflineQueue` per `Database`, and the translation of the queue's
 * collection-level events into table-level statuses under the transaction's `StampId()`.
 *
 * The queue holds the sealed segments of every locally acknowledged commit and drains them in order
 * (docs/offline-sync.md §Draining); the bridge seals a `'local'` transaction's dirty trees into one
 * entry at commit (`TransactionBridge.commitTransaction`) and reads the mode here when a transaction
 * begins. The drain loop starts on the first entry, so an idle queue costs nothing.
 *
 * A `failed` transaction's rows leave this machine's view, which no Quereus commit announces, so the
 * controller announces every table behind the status's `changedCollections` to the `Database`'s
 * watchers once the status has been delivered (docs/offline-sync.md §Removing an entry). A
 * `committed` one changes no row this machine sees and announces nothing.
 *
 * None of the bridge's single-writer state is read or written here: the drain owns the sealed
 * segments and the queue, the open SQL transaction owns the open segment, and the collection latch
 * serialises their in-memory steps (docs/offline-sync.md §The single-writer bridge).
 *
 * With `offline.journal` configured the queue writes through an {@link OfflineJournal} over that
 * store (docs/offline-sync.md §Persistence): a commit resolves only once its entry record is flushed,
 * each send is preceded by its drive record, and each terminal outcome is written before it is
 * reported — and deleted again when it is acknowledged or ages out of the retention window. After a
 * restart {@link restore} (run by `plugin.hydrate`) puts the journaled transactions back through
 * {@link OfflineRestore}; the ones it cannot put back yet are listed here as `queued` with
 * `waitingFor: 'restore'` and count as queued everywhere the queue's entries do
 * (docs/offline-sync.md §Restore after a restart).
 */
export class OfflineMode {
	private readonly queue: OfflineQueue;
	private readonly journal: OfflineJournal | undefined;
	/** The restore over the journal; absent without one. */
	private readonly restorer: OfflineRestore | undefined;
	private tableResolver: TableCollectionsResolver | undefined;
	private readonly outcomeRetentionMs: number;
	private readonly now = Date.now;
	private entered = false;
	/** Whether the last live read reported through {@link noteLiveRefresh} was served from this
	 * machine's own view because the cohort could not be reached. */
	private readsServedLocally = false;
	/** The queue's last published state, re-published with the mode on every change of either. */
	private lastQueueState: OfflineQueueState;
	private readonly statusListeners = new Set<StatusListener>();
	private readonly stateListeners = new Set<StateListener>();
	/** Terminal statuses since they were emitted, oldest first, pruned lazily (no timer). */
	private readonly retainedOutcomes = new Map<string, RetainedOutcome>();
	/** The outcome {@link journalOutcome} translated for the journal, held from then until the queue
	 * emits the same status ({@link onQueueStatus}), which takes it rather than translating again. */
	private readonly journaledOutcomes = new Map<string, RetainedOutcome>();
	private readonly networkCommitTimeoutMs: number;
	/** Each table's policy and reachability gate, keyed by its `schema.table` rendering, as its vtab
	 * published them; a table absent here takes `'queue'` and is always reachable. */
	private readonly tables = new Map<string, PublishedTable>();
	/** The same renderings keyed lowercased, which is how Quereus names a table in a write description
	 * (`QualifiedName`), for {@link schema}'s `table`. */
	private readonly tablesByLowerName = new Map<string, string>();
	/** Who waits for each transaction to settle ({@link whenSettled}), keyed by transaction id. */
	private readonly settleWaiters = new Map<string, SettleWaiter[]>();
	/** Each queued transaction's judgement, made when the queue first reported it `queued`
	 * ({@link judgeQueued}), kept current as the queue changes ({@link followQueue}) and held until it
	 * settles. The judgement is not journaled, its inputs are — the segments and {@link entryFacts} — so
	 * a restart judges a restored transaction again, as it was judged, when the restore puts it back. */
	private readonly judgements = new Map<string, HeldJudgement>();
	/** What each queued transaction's statements' write descriptions said about its elements, handed in
	 * ahead of the `queued` status that judges it — by {@link enqueue} ahead of the enqueue, where the
	 * journal also writes them into the entry record, and by the restore ahead of `queue.restore`, read
	 * back from that record — and held, like its judgement, until it settles. A transaction restored from
	 * a record written before the facts were journaled has none; the judgement then reads the tags alone. */
	private readonly entryFacts = new Map<string, EntryFacts>();
	/** Assured transactions that failed anyway ({@link reportAssuredFailure}), published on the state. */
	private assuredFailures = 0;
	/** The unsubscribe of each distinct gate a table published that has `onChange` ({@link subscribeToGate});
	 * one per transactor, since the factory hands out one gate per transactor key. */
	private readonly gateWakes = new Map<ICohortReachability, () => void>();
	/** Set by {@link dispose} before anything else, so a wake already on its way is ignored. */
	private wakesReleased = false;
	private disposed = false;

	constructor(private readonly bridge: TransactionBridge, private readonly db: Database, config: ParsedOfflineConfig = {}) {
		this.journal = config.journal === undefined ? undefined : new OfflineJournal(config.journal, config.journalLabel ?? DEFAULT_JOURNAL_LABEL, {
			tablesOf: id => this.bridge.tablesOf(id),
			outcomeOf: status => this.journalOutcome(status),
			factsOf: transactionId => this.entryFacts.get(transactionId),
		});
		// The gates' wakes reach the queue through `onGateChange`, never as `wakeOn`: a wake must also
		// start a restore pass, which nothing else asks for while the queue is empty.
		const options: OfflineQueueOptions = { reachability: this.reachability };
		if (config.allowSoloCommit !== undefined) options.allowSoloCommit = config.allowSoloCommit;
		if (this.journal !== undefined) options.journal = this.journal;
		if (config.expireAfterMs !== undefined) options.expireAfterMs = config.expireAfterMs;
		if (config.recheck !== undefined) options.recheck = { ...config.recheck };
		this.queue = new OfflineQueue(options);
		this.outcomeRetentionMs = config.outcomeRetentionMs ?? DEFAULT_OUTCOME_RETENTION_MS;
		this.restorer = this.journal === undefined ? undefined : new OfflineRestore({
			queue: this.queue,
			journal: this.journal,
			outcomeRetentionMs: this.outcomeRetentionMs,
			now: () => this.now(),
			transactionOpen: () => this.bridge.isTransactionActive(),
			collectionsOfTable: table => this.requireTableResolver().collectionsOfTable(this.db, table),
			retainOutcome: outcome => this.retainRead(outcome),
			emitSettled: status => this.onQueueStatus(status),
			factsRestored: (transactionId, facts) => { this.entryFacts.set(transactionId, facts); },
			restoreRolledBack: transactionId => this.forgetUnqueuedFacts(transactionId),
		});
		this.networkCommitTimeoutMs = config.networkCommitTimeoutMs ?? NetworkCommitBoundMs;
		this.lastQueueState = this.queue.queueState();
		this.queue.onStatus(status => this.onQueueStatus(status));
		this.queue.onQueueState(state => {
			this.lastQueueState = state;
			this.publishState();
		});
	}

	/**
	 * The refusal callback every collection of this `Database` reports through
	 * (`CollectionInitOptions.onSealedRefused`), forwarded to the queue; stable for the factory to
	 * hand to every tree it opens. A refusal for an entry this queue does not hold is ignored by the
	 * queue (`offline:refusal-for-unknown-entry`).
	 */
	readonly onSealedRefused = (entryId: EntryId, error: ActionRefusedError): void => {
		this.queue.onSealedRefused(entryId, error);
	};

	/**
	 * Transactions begun from now on get local acknowledgement: their commit resolves once the
	 * transaction is queued on this machine. Changes nothing about an open transaction or the drain.
	 * @throws OfflineModeRefusedError while session mode is configured.
	 */
	enter(): void {
		if (this.bridge.isTransactionModeEnabled()) throw new OfflineModeRefusedError('session-mode');
		if (this.entered) return;
		this.entered = true;
		log('offline:entered');
		this.publishState();
	}

	/** Transactions begun from now on get network acknowledgement. Entries already queued keep draining.
	 * Clears `readsServedLocally`: outside the mode no read is served locally, and a read that fails
	 * reports nothing, so the flag would otherwise outlive the mode until a refresh succeeded. */
	exit(): void {
		if (!this.entered) return;
		this.entered = false;
		this.readsServedLocally = false;
		log('offline:exited');
		this.publishState();
	}

	isEntered(): boolean {
		return this.entered;
	}

	/** Whether anything is queued: a queue entry, or a journaled transaction the restore has read and
	 * not yet put back (counted so a network-acknowledged commit waits behind it, and session mode is
	 * refused, as behind a queued entry). */
	hasQueuedEntries(): boolean {
		return this.queue.queueState().depth > 0 || (this.restorer?.holdsRecords() ?? false);
	}

	/** Resolves when the queue is empty and no journaled transaction is left to put back; rejects with
	 * `QueueDisposedError` on `dispose`. A deferred transaction keeps it pending until a later pass puts
	 * it back and it drains, or it is discarded. */
	async whenDrained(): Promise<void> {
		for (;;) {
			await this.queue.whenDrained();
			if (this.restorer === undefined || this.restorer.settled()) return;
			await this.restorer.whenChanged();
		}
	}

	/**
	 * Stop draining (`OfflineQueue.dispose`): entries left queued stay sealed in their collections. A
	 * network-acknowledged commit still waiting behind the queue then throws `QueueDisposedError`
	 * ({@link awaitNetworkAcknowledgement}); one whose submission was in flight and committed during
	 * the disposal is answered with that outcome instead. A restore pass in progress finishes the
	 * record it is on and stops. Idempotent.
	 */
	async dispose(): Promise<void> {
		this.releaseGateWakes();
		// The restore is told first, so it goes no further than its current record; the queue's disposal
		// then ends a `queue.restore` it is waiting on, and the pass is awaited last.
		const restoreStopped = this.restorer?.dispose();
		await this.queue.dispose();
		await restoreStopped;
		this.disposed = true;
		for (const waiters of this.settleWaiters.values()) {
			for (const waiter of waiters) waiter(undefined);
		}
		this.settleWaiters.clear();
	}

	/**
	 * Record `table`'s policy, read from its `optimystic.offline` tag by its vtab at initialization and
	 * again on every tag change, and the reachability gate of its transactor. The bridge reads the
	 * policy when a transaction writing the table commits ({@link tablePolicy}); a transaction already
	 * queued keeps the acknowledgement it got. The gate is what the queue asks before submitting an
	 * entry that wrote the table, and what a live read of it asks before refreshing in offline mode
	 * ({@link cohortReachable}); its wakes wake the drain ({@link subscribeToGate}). `outlook` says
	 * which of the table's trees a collection is, asked whenever a transaction that wrote it is judged;
	 * it reads the table's live schema, so a tag change needs no new publication.
	 */
	setTablePolicy(table: QualifiedTableName, policy: OfflineTablePolicy, reachability: ICohortReachability, outlook: TableOutlookSource): void {
		const name = qualifiedTableName(table);
		this.tables.set(name, { policy, reachability, outlook });
		this.tablesByLowerName.set(name.toLowerCase(), name);
		this.subscribeToGate(reachability);
	}

	/** Forget `table`'s policy, gate and outlook source: it was dropped, or its CREATE was refused. The
	 * gate's wake subscription stays: a wake for a gate no table uses costs one gate check. */
	withdrawTablePolicy(table: QualifiedTableName): void {
		const name = qualifiedTableName(table);
		this.tables.delete(name);
		this.tablesByLowerName.delete(name.toLowerCase());
	}

	/** The policy of the table named `schema.table` ({@link qualifiedTableName}); `'queue'` for a table
	 * no vtab published one for. */
	tablePolicy(name: string): OfflineTablePolicy {
		return this.tables.get(name)?.policy ?? 'queue';
	}

	// ── restore after a restart ────────────────────────────────────────────────────────────────

	/** Attach the module that resolves a table's collections for the restore. Once, by `register`. */
	attachTableResolver(resolver: TableCollectionsResolver): void {
		if (this.tableResolver !== undefined) throw new Error('a table resolver is already attached to this offline-mode controller');
		this.tableResolver = resolver;
	}

	private requireTableResolver(): TableCollectionsResolver {
		if (this.tableResolver === undefined) throw new Error('offline restore: no table resolver is attached; register() attaches the module before any statement runs');
		return this.tableResolver;
	}

	/**
	 * Put the journaled transactions back in the queue (docs/offline-sync.md §Restore after a
	 * restart). `plugin.hydrate` runs it after rebuilding the catalog, so the application's first
	 * statement after `hydrate` sees its queued transactions; a host that does not call `hydrate` calls
	 * it. Idempotent, and callable at any time: a record already put back is skipped, one deferred is
	 * tried again. A `queued` status is emitted for each transaction put back, before this resolves.
	 * Without a journal there is nothing to put back, and this is a no-op.
	 *
	 * @throws Error while a transaction is open on this `Database` (the open segment belongs to it;
	 * run it between transactions); `OfflineJournalError` for a record written by a newer build, after
	 * putting back every record before it; whatever a table's initialization threw, other than the
	 * `BlockUnavailableError` that defers the record.
	 */
	async restore(): Promise<void> {
		if (this.restorer === undefined) return;
		await this.restorer.run();
	}

	/**
	 * `table` became readable — its vtab finished a full initialization, or a live refresh of it
	 * reached the cohort. When a deferred transaction wrote it, a restore pass is scheduled off the
	 * statement's path: once no transaction is open on the bridge, never awaited by the read. A pass
	 * that cannot run (a transaction began meanwhile) is logged and left to the next trigger.
	 */
	tableReadable(table: QualifiedTableName): void {
		const restorer = this.restorer;
		if (restorer === undefined || !restorer.wantsRetryFor(qualifiedTableName(table))) return;
		this.bridge.whenTransactionIdle()
			.then(() => restorer.run())
			.catch(error => log('offline:restore-pass-failed table=%s: %o', qualifiedTableName(table), error));
	}

	// ── reads in offline mode ──────────────────────────────────────────────────────────────────

	/**
	 * Whether a live read of the table named `name` may be served from this machine's own view when
	 * its refresh cannot reach the cohort (docs/offline-sync.md §Reads in offline mode): only while the
	 * mode is entered, only for a `'queue'` table, and not while a journaled transaction that wrote the
	 * table is deferred — this machine's view lacks rows the application was told are committed, so the
	 * read fails as it would without the mode until the cohort is reached, which puts them back.
	 */
	degradesLiveReads(name: string): boolean {
		return this.entered && this.tablePolicy(name) === 'queue' && !(this.restorer?.isDeferredTable(name) ?? false);
	}

	/**
	 * Whether the gate of the table named `name` says its cohort can be reached now, asked with
	 * `blockIds` (`gateBlockIds` of the tree a live read is about to refresh) — the gate the queue asks
	 * for the same table. A gate that throws is logged and read as reachable: the refresh then runs,
	 * and its own failure decides whether the read is served locally.
	 */
	async cohortReachable(name: string, blockIds: readonly BlockId[]): Promise<boolean> {
		const gate = this.tables.get(name)?.reachability ?? alwaysReachable;
		try {
			return await gate.reachable(blockIds);
		} catch (error) {
			log('offline:reachability-threw table=%s: %o; refreshing anyway', name, error);
			return true;
		}
	}

	/**
	 * Record how a live read's refresh went: `true` when the read was served from this machine's own
	 * view because the cohort could not be reached, `false` when the refresh reached it.
	 * `readsServedLocally` on the queue state is the last report's value, published when it changes;
	 * {@link exit} clears it.
	 */
	noteLiveRefresh(servedLocally: boolean): void {
		if (this.readsServedLocally === servedLocally) return;
		this.readsServedLocally = servedLocally;
		this.publishState();
	}

	/**
	 * The gate the queue asks before it submits its head entry, with the header and known log tail ids
	 * of each collection the entry still has to commit (docs/offline-sync.md §When to submit): the gate
	 * of every table behind those collections must answer reachable. An entry is one transactor's, so
	 * in practice that is one gate, the one a live read of the same tables asks. A collection no table
	 * published a gate for adds none, and with none at all the cohort is reachable.
	 *
	 * While a journaled transaction is deferred the answer is `false`, and a restore pass is started:
	 * nothing queued after the restart is submitted ahead of an older transaction still on disk, and
	 * the queue's re-check timer is also the restore's retry timer. Such an entry reports
	 * `waitingFor: 'cohort'`, the closest existing value; the reason is in the pass's log line. The
	 * pass is started, not awaited: the queue asks the gate inside a drain iteration, and the pass waits
	 * for the drain to park between iterations.
	 */
	private readonly reachability: ICohortReachability = {
		reachable: async blockIds => {
			if (this.restorer?.hasDeferred()) {
				// NOTE: one pass per re-check while anything is deferred — three listings of the journal and
				// one initialization attempt of the deferred table, at most once per `recheck.maxMs` (60 s by
				// default). If a record deferred for days ever shows up in profiles, back the pass off on its
				// own timer instead of riding the queue's.
				this.restorer.run().catch(error => log('offline:restore-pass-failed from=gate: %o', error));
				return false;
			}
			const gates = new Set<ICohortReachability>();
			for (const id of blockIds) {
				for (const name of this.bridge.tablesOf(id)?.keys() ?? []) {
					const published = this.tables.get(name);
					if (published !== undefined) gates.add(published.reachability);
				}
			}
			for (const gate of gates) {
				if (!await gate.reachable(blockIds)) return false;
			}
			return true;
		},
	};

	/** Hear `gate`'s wakes ({@link onGateChange}), once per distinct gate; a gate without `onChange`
	 * wakes nothing, and after {@link dispose} nothing is subscribed. */
	private subscribeToGate(gate: ICohortReachability): void {
		if (this.wakesReleased || this.gateWakes.has(gate) || gate.onChange === undefined) return;
		this.gateWakes.set(gate, gate.onChange(this.onGateChange));
	}

	/**
	 * A gate says the cohort may have become reachable: a machine connected or was identified. When a
	 * journaled transaction is deferred, a restore pass is started once no transaction is open — this is
	 * what retries a deferred record while the queue is empty, since no drain iteration then asks the
	 * gate. Then the queue is woken, which also resets its re-check backoff, so an entry waiting on the
	 * cohort is submitted now rather than at its next re-check.
	 */
	private readonly onGateChange = (): void => {
		if (this.wakesReleased) return;
		const restorer = this.restorer;
		if (restorer?.hasDeferred()) {
			// NOTE: one pass per wake while anything is deferred (wakes requested while a pass runs join
			// the one pending), and the node's gate debounces its wakes until its events go quiet. If a
			// node whose connections churn ever shows passes in profiles, rate-limit them here.
			// Re-checked once idle: a dispose begun meanwhile has disposed the restorer, whose `run` would
			// only reject with QueueDisposedError.
			this.bridge.whenTransactionIdle()
				.then(() => this.wakesReleased ? undefined : restorer.run())
				.catch(error => log('offline:restore-pass-failed from=wake: %o', error));
		}
		this.queue.wake();
	};

	private releaseGateWakes(): void {
		this.wakesReleased = true;
		for (const unsubscribe of this.gateWakes.values()) unsubscribe();
		this.gateWakes.clear();
	}

	/**
	 * Refuse `operation`, a change to how `table`'s rows are stored, while any queued transaction wrote
	 * one of the table's collections — its main tree or an index tree, as the bridge recorded them
	 * (`TransactionBridge.collectionsOf`). Called by each such DDL hook before it writes anything.
	 * @throws QueuedEntriesBlockSchemaChangeError naming those transactions (queued ones in queue order,
	 * then any whose removal is still in progress).
	 */
	assertNoQueuedEntries(table: QualifiedTableName, operation: StorageShapeChange): void {
		const name = qualifiedTableName(table);
		// A journaled transaction not yet put back carries rows an index built now would miss.
		const deferred = this.restorer?.records().filter(record => record.tables.includes(name)).map(record => record.transactionId) ?? [];
		const collections = new Set(this.bridge.collectionsOf(table));
		if (collections.size === 0 && deferred.length === 0) return;
		const listed = this.queue.entries()
			.filter(entry => entry.collections.some(id => collections.has(id)))
			.map(entry => entry.id);
		// A failed entry leaves the queue at once, while its removal is still dropping its segments; until
		// the drops finish its rows are still in this machine's view, so a segment still sealed counts too.
		// NOTE: the registry holds one instance per collection id, the last registered; with two tables
		// declared over one URI this reads the other table's instance and can miss a removal still in
		// progress. Only that window is affected (the queue arm above is per entry); revisit if two
		// tables over one URI become a supported shape.
		const registry = this.bridge.getCollectionRegistry();
		const stillSealed = [...collections].flatMap(id => registry.get(id)?.sealedEntries() ?? []);
		const blocking = [...new Set([...listed, ...deferred, ...stillSealed])];
		if (blocking.length === 0) return;
		log('offline:schema-change-refused table=%s operation=%s transactions=%o', name, operation, blocking);
		throw new QueuedEntriesBlockSchemaChangeError(name, operation, blocking);
	}

	/**
	 * Seal each collection's open segment under `transactionId` and queue the entry, emitting its
	 * `queued` status before resolving (so the commit it is in can be attributed). `undefined` when no
	 * collection had anything staged: nothing queued, nothing reported, as a commit that wrote nothing.
	 * Rejects, with every segment unsealed again and nothing queued, when the queue's journal refuses
	 * the entry record (docs/offline-sync.md §Write ordering). `facts` is what the transaction's
	 * statements' write descriptions said about its elements (`TransactionBridge.openWriteFacts`),
	 * held for its judgement — which runs inside the enqueue, on the `queued` status — until it settles.
	 */
	async enqueue(collections: readonly Collection<any>[], transactionId: string, facts: EntryFacts): Promise<QueuedTransaction | undefined> {
		this.entryFacts.set(transactionId, facts);
		let entry: QueuedEntry | undefined;
		try {
			entry = await this.queue.enqueue(collections, { id: transactionId, timestamp: this.now() });
		} finally {
			// Nothing queued — nothing staged, or the journal refused — leaves nothing to hold facts for.
			if (entry === undefined) this.entryFacts.delete(transactionId);
		}
		return entry === undefined ? undefined : this.listed(entry);
	}

	/** Drop the facts handed in for a transaction a restore did not put back; kept if the queue lists it,
	 * whose facts are dropped when it settles. */
	private forgetUnqueuedFacts(transactionId: string): void {
		if (this.queue.status(transactionId) === undefined) this.entryFacts.delete(transactionId);
	}

	/** Follow every queued transaction's statuses (docs/offline-sync.md §Following transactions).
	 * A listener that throws is logged and the next still runs. Returns an idempotent unsubscribe. */
	onStatus(listener: StatusListener): () => void {
		return addListener(this.statusListeners, listener);
	}

	/** Published whenever the queue's state or the mode changes. Same discipline as {@link onStatus}. */
	onQueueState(listener: StateListener): () => void {
		return addListener(this.stateListeners, listener);
	}

	queueState(): OfflineModeState {
		return {
			...this.lastQueueState,
			mode: this.entered ? 'offline' : 'online',
			readsServedLocally: this.readsServedLocally,
			assuredFailures: this.assuredFailures,
		};
	}

	/** The queued transactions, in queue order, each with its current status, then the journaled ones
	 * the restore has not put back yet, each `queued` with `waitingFor: 'restore'`. */
	entries(): QueuedTransaction[] {
		const queued = this.queue.entries().map(entry => this.listed(entry));
		const deferred = this.restorer?.records()
			.filter(record => this.queue.status(record.transactionId) === undefined)
			.map(record => this.listedDeferred(record)) ?? [];
		return [...queued, ...deferred];
	}

	/** A queued transaction's current status (a deferred one's included), else its retained terminal
	 * outcome, else `undefined`. */
	status(transactionId: string): QueuedTransactionStatus | undefined {
		const live = this.queue.status(transactionId);
		if (live !== undefined) return this.translateListed(live);
		const deferred = this.restorer?.find(transactionId);
		if (deferred !== undefined) return this.deferredStatus(deferred);
		this.pruneOutcomes();
		return this.retainedOutcomes.get(transactionId)?.status;
	}

	/**
	 * Withdraw a never-sent transaction: it fails with reason `discarded` and its rows leave this
	 * machine's view. A journaled transaction the restore has not put back is withdrawn the same way
	 * (its records are deleted; nothing of it was staged, so no table is announced). Throws
	 * `EntryNotDiscardableError` once it has been sent (it may already be saved) or while it is being
	 * submitted, and `UnknownEntryError` for an id not queued.
	 */
	discard(transactionId: string): void {
		try {
			this.queue.discard(transactionId);
		} catch (error) {
			if (!(error instanceof UnknownEntryError) || this.restorer?.discard(transactionId) !== true) throw error;
		}
	}

	/**
	 * Wait for a network-acknowledged transaction the bridge has just queued behind earlier ones to
	 * settle (docs/offline-sync.md §Network acknowledgement behind a non-empty queue), at most
	 * `networkCommitTimeoutMs`. Its statuses are reported like any queued transaction's, and a
	 * `committed` one reaches `onCommitDurability` listeners through the drain's report.
	 *
	 * @returns the transaction's terminal outcome.
	 * @throws OfflineCommitTimeoutError once the bound has passed: `sent: false` after the transaction
	 * has been withdrawn (it failed with reason `discarded`, and its rows are gone), `sent: true` when it
	 * may already be saved and stays queued.
	 * @throws QueueDisposedError when {@link dispose} ran before it settled; it stays sealed, as every
	 * queued transaction does.
	 */
	async awaitNetworkAcknowledgement(transactionId: string): Promise<TransactionOutcome> {
		const settled = this.whenSettled(transactionId);
		const answer = await this.settledWithin(settled, this.networkCommitTimeoutMs);
		const outcome = answer === 'timed-out' ? await this.networkCommitTimedOut(transactionId, settled) : answer;
		if (outcome === undefined) throw new QueueDisposedError();
		return outcome;
	}

	/**
	 * The bound passed with `transactionId` unsettled: withdraw it when it was never sent, and throw
	 * saying which it was. Answers instead only when the transaction left the queue as the clock ran
	 * out (its removal still dropping its segments): its outcome, or `undefined` for a disposal.
	 */
	private async networkCommitTimedOut(transactionId: string, settled: Promise<TransactionOutcome | undefined>): Promise<TransactionOutcome | undefined> {
		const collections = this.queue.entries().find(entry => entry.id === transactionId)?.collections ?? [];
		try {
			this.queue.discard(transactionId);
		} catch (error) {
			if (error instanceof UnknownEntryError) return settled;
			if (!(error instanceof EntryNotDiscardableError)) throw error;
			log('offline:network-commit-timeout transaction=%s sent=true because=%s timeoutMs=%d: it stays queued',
				transactionId, error.because, this.networkCommitTimeoutMs);
			// The commit throws, so Quereus fires no watcher for the rows this machine now shows.
			this.announceChanged(transactionId, collections);
			throw new OfflineCommitTimeoutError(transactionId, true, this.networkCommitTimeoutMs, error);
		}
		log('offline:network-commit-timeout transaction=%s sent=false timeoutMs=%d: withdrawn', transactionId, this.networkCommitTimeoutMs);
		// Its `failed` status arrives once the drops that take its rows out of this machine's view are done.
		if (await settled === undefined) return undefined;
		throw new OfflineCommitTimeoutError(transactionId, false, this.networkCommitTimeoutMs);
	}

	/** What `settled` answers, or `'timed-out'` once `ms` have passed first. */
	private async settledWithin(settled: Promise<TransactionOutcome | undefined>, ms: number): Promise<TransactionOutcome | undefined | 'timed-out'> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<'timed-out'>(resolve => { timer = setTimeout(() => resolve('timed-out'), ms); });
		try {
			return await Promise.race([settled, expired]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Resolves with `transactionId`'s terminal outcome once the queue settles it — from the translation
	 * that reports it to {@link onStatus} listeners, after them — or with `undefined` when
	 * {@link dispose} runs first. A transaction already settled answers its retained outcome. Never
	 * rejects, so a waiter that stops listening leaves nothing unhandled.
	 * @throws UnknownEntryError for an id neither queued nor retained.
	 */
	private whenSettled(transactionId: string): Promise<TransactionOutcome | undefined> {
		if (this.queue.status(transactionId) === undefined) {
			const retained = this.status(transactionId);
			if (retained?.kind === 'committed' || retained?.kind === 'failed') return Promise.resolve(retained);
			throw new UnknownEntryError(transactionId);
		}
		if (this.disposed) return Promise.resolve(undefined);
		return new Promise(resolve => {
			const waiters = this.settleWaiters.get(transactionId);
			if (waiters === undefined) {
				this.settleWaiters.set(transactionId, [resolve]);
			} else {
				waiters.push(resolve);
			}
		});
	}

	private settle(outcome: TransactionOutcome): void {
		const waiters = this.settleWaiters.get(outcome.transactionId);
		if (waiters === undefined) return;
		this.settleWaiters.delete(outcome.transactionId);
		for (const waiter of waiters) waiter(outcome);
	}

	/** The terminal outcomes retained since they were emitted and not yet acknowledged, oldest first. */
	outcomes(): TransactionOutcome[] {
		this.pruneOutcomes();
		return [...this.retainedOutcomes.values()].map(outcome => outcome.status);
	}

	/** Forget one retained outcome, and delete its journal record. */
	acknowledge(transactionId: string): void {
		this.retainedOutcomes.delete(transactionId);
		this.deleteOutcomeRecord(transactionId);
	}

	// ── the outlook ────────────────────────────────────────────────────────────────────────────

	/**
	 * The outlook the open transaction would get were it committed now (docs/offline-sync.md §Using
	 * the outlook before committing): its open segments, in every collection it staged into, judged as
	 * one entry sealed behind everything queued now — every queued transaction and every deferred one
	 * counts as earlier. Judged exactly as a queued transaction is ({@link judgeQueued}), from memory
	 * alone, so it is synchronous. With nothing queued — outside offline mode, typically — it answers
	 * whether the commit can lose a race at all. `CommitOutlook()` asks it once a transaction is open.
	 */
	openTransactionOutlook(): CommitOutlook {
		const collections = this.bridge.stagedCollections().filter(collection => collection.openActions().length > 0);
		const writes: StagedWrites = new Map(collections.map(collection => [collection.id, collection.openActions()]));
		return this.judge(writes, collections.map(collection => collection.id), this.queueAhead(this.queue.entries(), Infinity), this.bridge.openWriteFacts()).outlook;
	}

	/** {@link judgeQueued}, isolated: it runs ahead of the status's translation and delivery, and a
	 * defect in the judgement (a description or a decoder that throws) must not keep the `queued`
	 * status from the application. The status then carries no outlook, and the entry's next `queued`
	 * status judges it again. */
	private tryJudgeQueued(entryId: string): void {
		try {
			this.judgeQueued(entryId);
		} catch (error) {
			log('offline:outlook-unjudged transaction=%s: the judgement threw: %o', entryId, error);
		}
	}

	/**
	 * Judge the queued transaction `entryId` when the queue first reports it `queued` — inside the
	 * enqueue, before its commit resolves, or inside the restore that put it back — and hold the
	 * judgement until it settles: its segments, against the entries ahead of it in queue order and the
	 * journaled transactions numbered below it that are still deferred. Its own judgement is not made
	 * again, so a tag changed later changes nothing here; its dependencies follow the queue
	 * ({@link followQueue}).
	 */
	private judgeQueued(entryId: string): void {
		const entries = this.queue.entries();
		const position = entries.findIndex(entry => entry.id === entryId);
		const entry = entries[position];
		if (entry === undefined) {
			log('offline:outlook-unjudged transaction=%s: the queue reported it queued without listing it', entryId);
			return;
		}
		const collections = this.heldCollections(entry);
		const ahead = this.queueAhead(entries.slice(0, position), entry.seq);
		const judgement = this.judge(this.sealedWrites(entryId, collections), collections, ahead, this.entryFacts.get(entryId));
		this.judgements.set(entryId, { ...judgement, dependencyFailed: false });
	}

	private judge(writes: StagedWrites, collections: readonly CollectionId[], ahead: QueueAhead, facts: EntryFacts | undefined): QueuedJudgement {
		return judgeTransaction({ writes, tables: this.tablesOf(collections), facts }, this.schema, ahead);
	}

	/** `entries`, each with the segments it still holds and their tables, its outlook's kind and its
	 * facts, beside the deferred journaled transactions numbered below `seq`. */
	private queueAhead(entries: readonly QueuedEntry[], seq: number): QueueAhead {
		const earlier = entries.map((entry): EarlierEntry => {
			const collections = this.heldCollections(entry);
			return {
				transactionId: entry.id,
				seq: entry.seq,
				writes: this.sealedWrites(entry.id, collections),
				tables: this.tablesOf(collections),
				assured: this.judgements.get(entry.id)?.outlook.kind === 'assured',
				facts: this.entryFacts.get(entry.id),
			};
		});
		return { earlier, deferred: this.deferredBelow(seq) };
	}

	/** The journaled transactions numbered below `seq` the restore still defers — a record a pass has
	 * put back is in the queue, and not among them. */
	private deferredBelow(seq: number): DeferredTransaction[] {
		return this.restorer?.records()
			.filter(record => record.seq < seq && this.queue.status(record.transactionId) === undefined)
			.map((record): DeferredTransaction => ({ transactionId: record.transactionId, seq: record.seq, tables: record.tables })) ?? [];
	}

	/**
	 * Bring every queued transaction's outlook up to date with the queue as it is now
	 * ({@link followOutlooks}), after a status that changed what is queued, and deliver
	 * `outlook-changed` for each whose `kind` changed — once every held outlook is current, so a
	 * listener reading `status` or `entries` meanwhile sees them all. A narrower `dependsOn` alone is
	 * held and not announced.
	 *
	 * Deferred while a transaction that left the queue has not yet had its terminal status (its
	 * judgement is still held): a failed one may still be dropping its segments, and a transaction
	 * those drops will refuse must not be recomputed without it first. That status runs the pass.
	 *
	 * A change to `'exposed'` needs a dependency that appeared after the transaction was judged — a
	 * journaled transaction put back ahead of one committed before the restore had read it, which the
	 * host contract (restore before committing) rules out. It is delivered like any change and logged
	 * as `offline:outlook-regressed`: an outlook the queue now contradicts is never kept.
	 *
	 * Isolated as the judgement is ({@link tryJudgeQueued}): it runs inside the queue's status
	 * delivery, so a throw is logged and leaves every outlook as it was.
	 *
	 * NOTE: one pass per settle, each over every queued transaction — and each segment it reads is
	 * found by scanning its collection's sealed list — so draining N transactions costs N passes,
	 * quadratic in the queue length: the shape of the replay after every head commit, whose `NOTE:` at
	 * the `replay` step of `Collection.openHeadCommit` names its remedy. If the pass ever shows up in a
	 * long drain, recompute only the transactions behind the settled one that list it in `dependsOn`.
	 */
	private followQueue(): void {
		let changed: { transactionId: string; outlook: CommitOutlook }[];
		try {
			const entries = this.queue.entries();
			const queued = new Set(entries.map(entry => entry.id));
			if ([...this.judgements.keys()].some(transactionId => !queued.has(transactionId))) return;
			changed = this.holdFollowed(followOutlooks(entries.map(entry => this.followedEntry(entry)), this.deferredBelow(Infinity)));
		} catch (error) {
			log('offline:outlook-unfollowed: the recomputation threw: %o', error);
			return;
		}
		for (const { transactionId, outlook } of changed) {
			const status: QueuedTransactionStatus = { kind: 'outlook-changed', transactionId, outlook };
			notifyListeners(this.statusListeners, status,
				error => log('offline:status-listener-threw transaction=%s kind=%s: %o', transactionId, status.kind, error));
		}
	}

	/** Hold each recomputed judgement, answering the transactions whose outlook changed `kind`. */
	private holdFollowed(followed: ReadonlyMap<string, QueuedJudgement>): { transactionId: string; outlook: CommitOutlook }[] {
		const changed: { transactionId: string; outlook: CommitOutlook }[] = [];
		for (const [transactionId, judgement] of followed) {
			const held = this.judgements.get(transactionId);
			if (held === undefined) continue;
			// Recomputed only while no removal is in progress, so it survived every failure it depended on.
			this.judgements.set(transactionId, { ...judgement, dependencyFailed: false });
			if (held.outlook.kind === judgement.outlook.kind) continue;
			if (judgement.outlook.kind === 'exposed') {
				log('offline:outlook-regressed transaction=%s dependsOn=%o', transactionId,
					judgement.outlook.dependsOn.map(dependency => dependency.transactionId));
			}
			changed.push({ transactionId, outlook: judgement.outlook });
		}
		return changed;
	}

	/** `entry` as {@link followOutlooks} reads it: the segments it still holds, read as for its
	 * judgement, its facts, and whether a replay has refused one of them. */
	private followedEntry(entry: QueuedEntry): FollowedEntry {
		const collections = this.heldCollections(entry);
		const registry = this.bridge.getCollectionRegistry();
		return {
			transactionId: entry.id,
			seq: entry.seq,
			writes: this.sealedWrites(entry.id, collections),
			tables: this.tablesOf(collections),
			committedCollections: entry.committedCollections ?? [],
			facts: this.entryFacts.get(entry.id),
			judgement: this.judgements.get(entry.id),
			refused: collections.some(id => registry.get(id)?.sealedRefusal(entry.id) !== undefined),
		};
	}

	/** Whether `status` changes what the transactions still queued depend on: one left the queue or
	 * committed part of itself, or one just judged — a restore putting it back — has others behind it. */
	private changesTheQueue(status: EntryStatus, firstQueued: boolean): boolean {
		switch (status.kind) {
			case 'committed':
			case 'failed':
			case 'partially-committed':
				return true;
			case 'queued': {
				if (!firstQueued) return false;
				const entries = this.queue.entries();
				const position = entries.findIndex(entry => entry.id === status.entryId);
				return position >= 0 && position < entries.length - 1;
			}
			case 'submitting':
				return false;
		}
	}

	/**
	 * Weigh a failed transaction's outlook against its failure: when the outlook said the failure could
	 * not happen ({@link outlookContradicted}), report it ({@link reportAssuredFailure}). Then note on
	 * every transaction that listed it in `dependsOn` that a dependency failed. Reads the judgement
	 * before the status drops it.
	 */
	private weighFailure(status: FailedEntryStatus): void {
		const held = this.judgements.get(status.entryId);
		const failure = { reason: status.reason, causedBy: status.causedBy, dependencyFailed: held?.dependencyFailed ?? false };
		if (outlookContradicted(held?.outlook, failure)) this.reportAssuredFailure(status);
		for (const [transactionId, dependent] of this.judgements) {
			if (dependent.outlook.dependsOn.some(dependency => dependency.transactionId === status.entryId)) {
				this.judgements.set(transactionId, { ...dependent, dependencyFailed: true });
			}
		}
	}

	/** Log a transaction reported assured that failed anyway, naming the check that refused, and count
	 * it in `assuredFailures` (docs/offline-sync.md §Conservative by construction). */
	private reportAssuredFailure(status: FailedEntryStatus): void {
		this.assuredFailures++;
		const [refusal, table, key] = this.refusalFields(status.error);
		log('offline:assured-entry-failed transaction=%s reason=%s refusal=%s table=%s key=%s causedBy=%s',
			status.entryId, status.reason, refusal, table, key, status.causedBy ?? 'none');
		this.publishState();
	}

	/** The class, table and rendered key of the guard refusal in `error`'s cause chain, for a log
	 * line. A description that throws is logged and leaves the table as the collection id. */
	private refusalFields(error: Error): [refusal: string, table: string, key: string] {
		const refusal = guardRefusalIn(error);
		if (refusal === undefined) return ['none', 'unknown', renderKey(undefined)];
		try {
			const { table, key } = refusedCheck(refusal, this.describeCollection(refusal.collectionId));
			return [refusal.name, table, renderKey(key)];
		} catch (describeError) {
			log('offline:refusal-undescribed collection=%s: %o', refusal.collectionId, describeError);
			return [refusal.name, refusal.collectionId, renderKey(undefined)];
		}
	}

	/** The collections `entry` still holds a segment in: every one it sealed, less those a partial
	 * commit has committed (their segments are consumed). */
	private heldCollections(entry: QueuedEntry): CollectionId[] {
		const committed = new Set(entry.committedCollections ?? []);
		return entry.collections.filter(id => !committed.has(id));
	}

	/** Each collection's segment of `entryId`, read from the instance the bridge registered for it;
	 * `undefined` where that instance holds none, which the judgement reads as unreadable.
	 * NOTE: the registry holds one instance per collection id, so with two tables declared over one URI
	 * this can read the other table's instance — the caveat {@link assertNoQueuedEntries} records. */
	private sealedWrites(entryId: string, collections: readonly CollectionId[]): StagedWrites {
		const registry = this.bridge.getCollectionRegistry();
		return new Map(collections.map(id => [id, registry.get(id)?.sealedActions(entryId)]));
	}

	/** The judgement's view of the schema, over the tables that published an outlook source. */
	private readonly schema: OutlookSchema = {
		describe: collectionId => this.describeCollection(collectionId),
		table: name => this.publishedTable(name),
	};

	/** The first description a table behind `collectionId` publishes for it; else the name of the first
	 * table the bridge recorded for it, when there is one. */
	private describeCollection(collectionId: CollectionId): CollectionDescription {
		const tables = this.bridge.tablesOf(collectionId);
		for (const name of tables?.keys() ?? []) {
			const description = this.tables.get(name)?.outlook.describe(collectionId);
			if (description !== undefined) return description;
		}
		return { kind: 'unknown', table: tables === undefined ? undefined : [...tables.keys()][0] };
	}

	/** The published table Quereus names (lowercased), with its main tree's keys once it is initialized. */
	private publishedTable(name: QualifiedName): ReturnType<OutlookSchema['table']> {
		const rendered = this.tablesByLowerName.get(`${name.schema}.${name.table}`.toLowerCase());
		if (rendered === undefined) return undefined;
		const tree = this.tables.get(rendered)?.outlook.mainTree();
		return tree === undefined ? { name: rendered } : { name: rendered, tree };
	}

	// ── translation ────────────────────────────────────────────────────────────────────────────

	private onQueueStatus(status: EntryStatus): void {
		const firstQueued = status.kind === 'queued' && !this.judgements.has(status.entryId);
		if (firstQueued) this.tryJudgeQueued(status.entryId);
		const outcome = status.kind === 'committed' || status.kind === 'failed' ? this.outcomeOf(status) : undefined;
		const translated = outcome?.status ?? this.translate(status);
		if (status.kind === 'failed') this.weighFailure(status);
		if (outcome !== undefined) {
			// With the judgement, its facts: a later transaction that depended on them was judged while they
			// were held, and its own judgement is frozen (docs/offline-sync.md §The outlook).
			this.judgements.delete(status.entryId);
			this.entryFacts.delete(status.entryId);
			this.retain(outcome);
		}
		notifyListeners(this.statusListeners, translated,
			error => log('offline:status-listener-threw transaction=%s kind=%s: %o', translated.transactionId, translated.kind, error));
		if (status.kind === 'failed') this.announceChanged(status.entryId, status.changedCollections);
		if (this.changesTheQueue(status, firstQueued)) this.followQueue();
		if (outcome !== undefined) this.settle(outcome.status);
	}

	/**
	 * The outcome the journal records for a terminal status, called by its `settled` just before the
	 * queue emits the same status. Translating it reports a committed transaction's durability
	 * ({@link committed}), so the translation is kept for {@link outcomeOf} rather than made twice: the
	 * report then comes one call earlier than without a journal, still before the status is delivered.
	 */
	private journalOutcome(status: JournalSettledStatus): RetainedOutcome {
		const outcome: RetainedOutcome = { at: this.now(), status: this.translateOutcome(status) };
		this.journaledOutcomes.set(status.entryId, outcome);
		return outcome;
	}

	/** A terminal status's outcome: the one {@link journalOutcome} translated, else translated now. */
	private outcomeOf(status: JournalSettledStatus): RetainedOutcome {
		const journaled = this.journaledOutcomes.get(status.entryId);
		if (journaled === undefined) return { at: this.now(), status: this.translateOutcome(status) };
		this.journaledOutcomes.delete(status.entryId);
		return journaled;
	}

	/**
	 * Tell the `Database`'s watchers about each table behind `changedCollections`, whose rows changed
	 * in this machine's view with no Quereus commit saying so: the removal of `transactionId` took them
	 * out (the collections it still held a segment in), or a network-acknowledged commit that timed
	 * out after it was sent left them in while throwing. Each table once per call; a cascade announces
	 * again for every entry it fails, which costs a watcher one re-query each. Fire-and-forget, never
	 * thrown into the drain or the commit.
	 */
	private announceChanged(transactionId: string, changedCollections: readonly CollectionId[]): void {
		for (const [name, table] of this.tablesBehind(changedCollections)) {
			announceExternalChange(this.db, table,
				error => log('offline:announce-failed transaction=%s table=%s: %o', transactionId, name, error));
		}
	}

	/** Every status the queue emits, in SQL terms; {@link onQueueStatus} takes a terminal one through
	 * {@link outcomeOf} instead, so it is translated once. */
	private translate(status: EntryStatus): QueuedTransactionStatus {
		switch (status.kind) {
			case 'queued':
			case 'submitting':
				return this.translateListed(status);
			case 'partially-committed':
				return {
					kind: 'partially-committed',
					transactionId: status.entryId,
					committedTables: this.tablesOf(status.committedCollections),
					pendingTables: this.tablesOf(status.pendingCollections),
					cause: status.cause,
				};
			case 'committed':
			case 'failed':
				return this.translateOutcome(status);
		}
	}

	/** A terminal status in SQL terms. Reached once per settled entry, from {@link journalOutcome} or
	 * {@link outcomeOf}: the `committed` arm reports the commit's durability to the bridge. */
	private translateOutcome(status: JournalSettledStatus): TransactionOutcome {
		switch (status.kind) {
			case 'committed':
				return this.committed(status.entryId, status.durability);
			case 'failed':
				return {
					kind: 'failed',
					transactionId: status.entryId,
					reason: status.reason,
					error: this.mapError(status.error),
					...(status.causedBy === undefined ? {} : { causedBy: status.causedBy }),
					changedTables: this.tablesOf(status.changedCollections),
					...(status.committedCollections === undefined ? {} : { committedTables: this.tablesOf(status.committedCollections) }),
				};
		}
	}

	/** The two statuses a queued entry is listed with. Side-effect free, so `status` and `entries` can
	 * use it; a terminal status here is a defect, since the queue lists no settled entry. */
	private translateListed(status: EntryStatus): QueuedTransactionStatus {
		switch (status.kind) {
			case 'queued': {
				// Absent only for an entry a restore has registered and is still putting back: it is judged
				// when the restore admits it and the queue reports it `queued`.
				const outlook = this.judgements.get(status.entryId)?.outlook;
				return {
					kind: 'queued',
					transactionId: status.entryId,
					seq: status.seq,
					tables: this.tablesOf(status.collections),
					queuedAt: status.queuedAt,
					attempts: status.attempts,
					inDoubt: status.inDoubt,
					waitingFor: status.waitingFor,
					...(status.lastError === undefined ? {} : { lastError: status.lastError }),
					...(status.committedCollections === undefined ? {} : { committedTables: this.tablesOf(status.committedCollections) }),
					persisted: this.journal !== undefined,
					...(outlook === undefined ? {} : { outlook }),
				};
			}
			case 'submitting':
				return { kind: 'submitting', transactionId: status.entryId, attempt: status.attempt };
			default:
				throw new Error(`offline mode: the queue listed entry ${status.entryId} with terminal status ${status.kind}`);
		}
	}

	/**
	 * A drained commit is reported exactly as an online commit is: the bridge builds the report,
	 * follows the commit and calls every `onCommitDurability` listener before this status exists
	 * (docs/offline-sync.md §Durability reports and the full-replication event). The report is always
	 * demanded, listeners or not, because `outcomes()` retains it.
	 */
	private committed(transactionId: string, durability: TransactionDurability): TransactionOutcome {
		const report = this.bridge.reportCommitDurability(transactionId, durability, true);
		return Object.freeze({ kind: 'committed' as const, ...report });
	}

	private listed(entry: QueuedEntry): QueuedTransaction {
		return {
			transactionId: entry.id,
			seq: entry.seq,
			queuedAt: entry.queuedAt,
			tables: this.tablesOf(entry.collections),
			...(entry.committedCollections === undefined ? {} : { committedTables: this.tablesOf(entry.committedCollections) }),
			persisted: this.journal !== undefined,
			status: this.translateListed(entry.status),
		};
	}

	/** A journaled transaction not yet put back, as {@link entries} lists it: from its record alone. */
	private listedDeferred(record: DeferredRecord): QueuedTransaction {
		return {
			transactionId: record.transactionId,
			seq: record.seq,
			queuedAt: record.queuedAt,
			tables: record.tables,
			persisted: true,
			status: this.deferredStatus(record),
		};
	}

	private deferredStatus(record: DeferredRecord): QueuedTransactionStatus {
		return {
			kind: 'queued',
			transactionId: record.transactionId,
			seq: record.seq,
			tables: record.tables,
			queuedAt: record.queuedAt,
			attempts: record.attempts,
			inDoubt: record.inDoubt,
			waitingFor: 'restore',
			persisted: true,
		};
	}

	/** The qualified names of the tables `ids` back, each once, in order of first appearance. */
	private tablesOf(ids: readonly CollectionId[]): string[] {
		return [...this.tablesBehind(ids).keys()];
	}

	/** The tables `ids` back, each once, keyed by `schema.table` in order of first appearance; a
	 * collection the bridge knows no table for is dropped, as a durability report drops it. */
	private tablesBehind(ids: readonly CollectionId[]): Map<string, Readonly<QualifiedTableName>> {
		const tables = new Map<string, Readonly<QualifiedTableName>>();
		for (const id of ids) {
			for (const [name, table] of this.bridge.tablesOf(id) ?? []) {
				if (!tables.has(name)) tables.set(name, table);
			}
		}
		return tables;
	}

	/** The error an online commit would have thrown for the same refusal; anything the bridge does
	 * not map passes through unchanged. */
	private mapError(error: Error): Error {
		const mapped = this.bridge.mapCommitRefusal(error);
		return mapped instanceof Error ? mapped : error;
	}

	// ── retained outcomes ──────────────────────────────────────────────────────────────────────

	private retain(outcome: RetainedOutcome): void {
		this.pruneOutcomes();
		this.retainedOutcomes.set(outcome.status.transactionId, outcome);
	}

	/** An outcome read back from its journal record by the restore: retained unless this process has
	 * settled the same transaction since, whose outcome is the fresher. */
	private retainRead(outcome: RetainedOutcome): void {
		if (!this.retainedOutcomes.has(outcome.status.transactionId)) this.retainedOutcomes.set(outcome.status.transactionId, outcome);
	}

	// NOTE: walks every retained outcome on each access and each new outcome; fine while a machine
	// settles a few thousand transactions per retention window. If `outcomes()` ever shows up as slow,
	// stop at the first outcome inside the window (the map is in emission order) or arm a timer.
	private pruneOutcomes(): void {
		const cutoff = this.now() - this.outcomeRetentionMs;
		for (const [transactionId, outcome] of this.retainedOutcomes) {
			if (outcome.at > cutoff) continue;
			this.retainedOutcomes.delete(transactionId);
			this.deleteOutcomeRecord(transactionId);
		}
	}

	/** Delete a transaction's outcome record from the journal, if there is one. Fire-and-forget and
	 * logged on failure: it runs on read paths (`status`, `outcomes`) that must not throw for it, and a
	 * record left behind is only an outcome a restart lists once more. */
	private deleteOutcomeRecord(transactionId: string): void {
		this.journal?.deleteOutcome(transactionId).catch(error =>
			log('offline:journal-outcome-delete-failed transaction=%s: %o', transactionId, error));
	}

	private publishState(): void {
		notifyListeners(this.stateListeners, this.queueState(), error => log('offline:state-listener-threw: %o', error));
	}
}
