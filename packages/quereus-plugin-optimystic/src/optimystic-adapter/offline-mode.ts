import { OfflineQueue } from '@optimystic/db-core';
import type {
	ActionRefusedError, Collection, CollectionId, EntryId, EntryStatus, OfflineQueueOptions, OfflineQueueState, QueuedEntry,
	TransactionDurability,
} from '@optimystic/db-core';
import type { TransactionBridge } from './txn-bridge.js';
import type { OfflineModeState, QueuedTransaction, QueuedTransactionStatus, TransactionOutcome } from './offline-status.js';
import { addListener, notifyListeners } from './listeners.js';
import { createLogger } from '../logger.js';

const log = createLogger('offline-mode');

/** How long a terminal outcome stays answerable through `status` and `outcomes` by default. */
export const DEFAULT_OUTCOME_RETENTION_MS = 7 * 24 * 3600_000;

/** The `offline` block of the plugin's registration config (README § Offline mode). */
export interface OfflineConfig {
	/** Fail a queued transaction that stays unsettled this long, with reason `expired`. Default: no limit. */
	expireAfterMs?: number;
	/** How long a terminal outcome stays in `outcomes()` / `status()`. Default seven days. */
	outcomeRetentionMs?: number;
	/** The drain's re-check timer while the cohort is unreachable or after a transient failure
	 * (`OfflineQueueOptions.recheck`): exponential from `baseMs` to `maxMs`. Advanced; tests shorten it. */
	recheck?: { baseMs?: number; maxMs?: number };
}

const offlineKeys: ReadonlySet<string> = new Set(['expireAfterMs', 'outcomeRetentionMs', 'recheck']);
const recheckKeys: ReadonlySet<string> = new Set(['baseMs', 'maxMs']);

/**
 * Read `config.offline` as `register` received it, refusing anything it does not understand: a
 * misspelt key is an error here rather than a silently different configuration later (`journal` and
 * `allowSoloCommit` arrive with later stages and are refused until then).
 */
export function parseOfflineConfig(declared: unknown): OfflineConfig {
	if (declared === undefined) return {};
	const offline = plainObject(declared, 'offline');
	refuseUnknownKeys(offline, 'offline', offlineKeys);
	const config: OfflineConfig = {};
	const expireAfterMs = positiveMs(offline.expireAfterMs, 'offline.expireAfterMs');
	if (expireAfterMs !== undefined) config.expireAfterMs = expireAfterMs;
	const outcomeRetentionMs = positiveMs(offline.outcomeRetentionMs, 'offline.outcomeRetentionMs');
	if (outcomeRetentionMs !== undefined) config.outcomeRetentionMs = outcomeRetentionMs;
	if (offline.recheck !== undefined) {
		const recheck = plainObject(offline.recheck, 'offline.recheck');
		refuseUnknownKeys(recheck, 'offline.recheck', recheckKeys);
		config.recheck = {};
		const baseMs = positiveMs(recheck.baseMs, 'offline.recheck.baseMs');
		if (baseMs !== undefined) config.recheck.baseMs = baseMs;
		const maxMs = positiveMs(recheck.maxMs, 'offline.recheck.maxMs');
		if (maxMs !== undefined) config.recheck.maxMs = maxMs;
	}
	return config;
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${name} must be an object; got ${Array.isArray(value) ? 'an array' : typeof value}`);
	}
	return value as Record<string, unknown>;
}

function refuseUnknownKeys(object: Record<string, unknown>, name: string, known: ReadonlySet<string>): void {
	for (const key of Object.keys(object)) {
		if (!known.has(key)) {
			throw new Error(`${name}.${key} is not a registration option; ${name} takes ${[...known].join(', ')}`
				+ (name === 'offline' ? " ('journal' and 'allowSoloCommit' arrive with later stages)" : ''));
		}
	}
}

function positiveMs(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number of milliseconds; got ${typeof value} ${String(value)}`);
	}
	return value;
}

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

type StatusListener = (status: QueuedTransactionStatus) => void;
type StateListener = (state: OfflineModeState) => void;

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
 * None of the bridge's single-writer state is read or written here: the drain owns the sealed
 * segments and the queue, the open SQL transaction owns the open segment, and the collection latch
 * serialises their in-memory steps (docs/offline-sync.md §The single-writer bridge).
 */
export class OfflineMode {
	private readonly queue: OfflineQueue;
	private readonly outcomeRetentionMs: number;
	private readonly now = Date.now;
	private entered = false;
	/** Set by the read degrade of docs/offline-sync.md §Reads in offline mode once it lands. */
	private readonly readsServedLocally = false;
	/** The queue's last published state, re-published with the mode on every change of either. */
	private lastQueueState: OfflineQueueState;
	private readonly statusListeners = new Set<StatusListener>();
	private readonly stateListeners = new Set<StateListener>();
	/** Terminal statuses since they were emitted, oldest first, pruned lazily (no timer). */
	private readonly retainedOutcomes = new Map<string, RetainedOutcome>();

	constructor(private readonly bridge: TransactionBridge, config: OfflineConfig = {}) {
		const options: OfflineQueueOptions = {};
		if (config.expireAfterMs !== undefined) options.expireAfterMs = config.expireAfterMs;
		if (config.recheck !== undefined) options.recheck = { ...config.recheck };
		this.queue = new OfflineQueue(options);
		this.outcomeRetentionMs = config.outcomeRetentionMs ?? DEFAULT_OUTCOME_RETENTION_MS;
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

	/** Stop draining (`OfflineQueue.dispose`): entries left queued stay sealed in their collections. */
	dispose(): Promise<void> {
		return this.queue.dispose();
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

	/** The qualified names of the tables `ids` back, each once, in order of first appearance; a
	 * collection the bridge knows no table for is dropped, as a durability report drops it. */
	private tablesOf(ids: readonly CollectionId[]): string[] {
		const tables = new Set<string>();
		for (const id of ids) {
			for (const table of this.bridge.tablesOf(id) ?? []) tables.add(table);
		}
		return [...tables];
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
