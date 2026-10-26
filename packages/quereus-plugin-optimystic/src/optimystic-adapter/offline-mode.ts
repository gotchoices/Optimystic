import type { Database } from '@quereus/quereus';
import { QuereusError, StatusCode } from '@quereus/quereus';
import { EntryNotDiscardableError, OfflineQueue, QueueDisposedError, UnknownEntryError, alwaysReachable } from '@optimystic/db-core';
import type {
	ActionRefusedError, BlockId, Collection, CollectionId, EntryId, EntryStatus, ICohortReachability, OfflineQueueOptions,
	OfflineQueueState, QueuedEntry, TransactionDurability,
} from '@optimystic/db-core';
import type { TransactionBridge } from './txn-bridge.js';
import type { OfflineConfig } from './offline-config.js';
import type { OfflineModeState, QueuedTransaction, QueuedTransactionStatus, TransactionOutcome } from './offline-status.js';
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
}

type StatusListener = (status: QueuedTransactionStatus) => void;
type StateListener = (state: OfflineModeState) => void;
/** Called with a transaction's terminal outcome, or `undefined` when the controller was disposed first. */
type SettleWaiter = (outcome: TransactionOutcome | undefined) => void;

/** A retained terminal status and when it was emitted, for the retention window. */
interface RetainedOutcome {
	readonly at: number;
	readonly status: TransactionOutcome;
}

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
 */
export class OfflineMode {
	private readonly queue: OfflineQueue;
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
	private readonly networkCommitTimeoutMs: number;
	/** Each table's policy and reachability gate, keyed by its `schema.table` rendering, as its vtab
	 * published them; a table absent here takes `'queue'` and is always reachable. */
	private readonly tables = new Map<string, PublishedTable>();
	/** Who waits for each transaction to settle ({@link whenSettled}), keyed by transaction id. */
	private readonly settleWaiters = new Map<string, SettleWaiter[]>();
	private disposed = false;

	constructor(private readonly bridge: TransactionBridge, private readonly db: Database, config: OfflineConfig = {}) {
		const options: OfflineQueueOptions = { reachability: this.reachability };
		if (config.expireAfterMs !== undefined) options.expireAfterMs = config.expireAfterMs;
		if (config.recheck !== undefined) options.recheck = { ...config.recheck };
		this.queue = new OfflineQueue(options);
		this.outcomeRetentionMs = config.outcomeRetentionMs ?? DEFAULT_OUTCOME_RETENTION_MS;
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

	/** Transactions begun from now on get network acknowledgement. Entries already queued keep draining. */
	exit(): void {
		if (!this.entered) return;
		this.entered = false;
		log('offline:exited');
		this.publishState();
	}

	isEntered(): boolean {
		return this.entered;
	}

	hasQueuedEntries(): boolean {
		return this.queue.queueState().depth > 0;
	}

	/** Resolves when the queue is empty; rejects with `QueueDisposedError` on `dispose`. */
	whenDrained(): Promise<void> {
		return this.queue.whenDrained();
	}

	/**
	 * Stop draining (`OfflineQueue.dispose`): entries left queued stay sealed in their collections. A
	 * network-acknowledged commit still waiting behind the queue then throws `QueueDisposedError`
	 * ({@link awaitNetworkAcknowledgement}); one whose submission was in flight and committed during
	 * the disposal is answered with that outcome instead. Idempotent.
	 */
	async dispose(): Promise<void> {
		await this.queue.dispose();
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
	 * ({@link cohortReachable}).
	 */
	setTablePolicy(table: QualifiedTableName, policy: OfflineTablePolicy, reachability: ICohortReachability): void {
		this.tables.set(qualifiedTableName(table), { policy, reachability });
	}

	/** Forget `table`'s policy and gate: it was dropped, or its CREATE was refused. */
	withdrawTablePolicy(table: QualifiedTableName): void {
		this.tables.delete(qualifiedTableName(table));
	}

	/** The policy of the table named `schema.table` ({@link qualifiedTableName}); `'queue'` for a table
	 * no vtab published one for. */
	tablePolicy(name: string): OfflineTablePolicy {
		return this.tables.get(name)?.policy ?? 'queue';
	}

	// ── reads in offline mode ──────────────────────────────────────────────────────────────────

	/**
	 * Whether a live read of the table named `name` may be served from this machine's own view when
	 * its refresh cannot reach the cohort (docs/offline-sync.md §Reads in offline mode): only while the
	 * mode is entered, and only for a `'queue'` table. Outside the mode, and for a `'network'` table, a
	 * read keeps failing loudly.
	 */
	degradesLiveReads(name: string): boolean {
		return this.entered && this.tablePolicy(name) === 'queue';
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
	 * `readsServedLocally` on the queue state is the last report's value, published when it changes.
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
	 */
	private readonly reachability: ICohortReachability = {
		reachable: async blockIds => {
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

	/**
	 * Refuse `operation`, a change to how `table`'s rows are stored, while any queued transaction wrote
	 * one of the table's collections — its main tree or an index tree, as the bridge recorded them
	 * (`TransactionBridge.collectionsOf`). Called by each such DDL hook before it writes anything.
	 * @throws QueuedEntriesBlockSchemaChangeError naming those transactions (queued ones in queue order,
	 * then any whose removal is still in progress).
	 */
	assertNoQueuedEntries(table: QualifiedTableName, operation: StorageShapeChange): void {
		const collections = new Set(this.bridge.collectionsOf(table));
		if (collections.size === 0) return;
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
		const blocking = [...new Set([...listed, ...stillSealed])];
		if (blocking.length === 0) return;
		const name = qualifiedTableName(table);
		log('offline:schema-change-refused table=%s operation=%s transactions=%o', name, operation, blocking);
		throw new QueuedEntriesBlockSchemaChangeError(name, operation, blocking);
	}

	/**
	 * Seal each collection's open segment under `transactionId` and queue the entry, emitting its
	 * `queued` status synchronously (so the commit it is in can be attributed). `undefined` when no
	 * collection had anything staged: nothing queued, nothing reported, as a commit that wrote nothing.
	 */
	enqueue(collections: readonly Collection<any>[], transactionId: string): QueuedTransaction | undefined {
		const entry = this.queue.enqueue(collections, { id: transactionId, timestamp: this.now() });
		return entry === undefined ? undefined : this.listed(entry);
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
		};
	}

	/** The queued transactions, in queue order, each with its current status. */
	entries(): QueuedTransaction[] {
		return this.queue.entries().map(entry => this.listed(entry));
	}

	/** A queued transaction's current status, else its retained terminal outcome, else `undefined`. */
	status(transactionId: string): QueuedTransactionStatus | undefined {
		const live = this.queue.status(transactionId);
		if (live !== undefined) return this.translateListed(live);
		this.pruneOutcomes();
		return this.retainedOutcomes.get(transactionId)?.status;
	}

	/**
	 * Withdraw a never-sent transaction: it fails with reason `discarded` and its rows leave this
	 * machine's view. Throws `EntryNotDiscardableError` once it has been sent (it may already be
	 * saved) or while it is being submitted, and `UnknownEntryError` for an id not queued.
	 */
	discard(transactionId: string): void {
		this.queue.discard(transactionId);
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

	/** Forget one retained outcome. */
	acknowledge(transactionId: string): void {
		this.retainedOutcomes.delete(transactionId);
	}

	// ── translation ────────────────────────────────────────────────────────────────────────────

	private onQueueStatus(status: EntryStatus): void {
		const translated = this.translate(status);
		if (translated.kind === 'committed' || translated.kind === 'failed') this.retain(translated);
		notifyListeners(this.statusListeners, translated,
			error => log('offline:status-listener-threw transaction=%s kind=%s: %o', translated.transactionId, translated.kind, error));
		if (status.kind === 'failed') this.announceChanged(status.entryId, status.changedCollections);
		if (translated.kind === 'committed' || translated.kind === 'failed') this.settle(translated);
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

	/** Every status the queue emits, in SQL terms. Reached only from the queue's own emission: the
	 * `committed` arm reports the commit's durability to the bridge, once per drained commit. */
	private translate(status: EntryStatus): QueuedTransactionStatus {
		switch (status.kind) {
			case 'queued':
			case 'submitting':
				return this.translateListed(status);
			case 'committed':
				return this.committed(status.entryId, status.durability);
			case 'partially-committed':
				return {
					kind: 'partially-committed',
					transactionId: status.entryId,
					committedTables: this.tablesOf(status.committedCollections),
					pendingTables: this.tablesOf(status.pendingCollections),
					cause: status.cause,
				};
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
			case 'queued':
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
				};
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
	private committed(transactionId: string, durability: TransactionDurability): QueuedTransactionStatus {
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
			status: this.translateListed(entry.status),
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

	private retain(status: TransactionOutcome): void {
		this.pruneOutcomes();
		this.retainedOutcomes.set(status.transactionId, { at: this.now(), status });
	}

	// NOTE: walks every retained outcome on each access and each new outcome; fine while a machine
	// settles a few thousand transactions per retention window. If `outcomes()` ever shows up as slow,
	// stop at the first outcome inside the window (the map is in emission order) or arm a timer.
	private pruneOutcomes(): void {
		const cutoff = this.now() - this.outcomeRetentionMs;
		for (const [transactionId, outcome] of this.retainedOutcomes) {
			if (outcome.at <= cutoff) this.retainedOutcomes.delete(transactionId);
		}
	}

	private publishState(): void {
		notifyListeners(this.stateListeners, this.queueState(), error => log('offline:state-listener-threw: %o', error));
	}
}
