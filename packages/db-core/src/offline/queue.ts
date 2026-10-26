import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
import type { BlockId } from '../blocks/structs.js';
import type { Collection } from '../collection/collection.js';
import type { EntryId } from '../collection/segments.js';
import { ActionRefusedError, SealedSegmentsError } from '../collection/struct.js';
import type { CollectionId, InFlightAttempt, SyncOptions } from '../collection/struct.js';
import type { ITransactor } from '../transactor/transactor.js';
import { TransactionCoordinator } from '../transaction/coordinator.js';
import { classifyCommitFailure, refusalReason } from '../transaction/commit-failure-class.js';
import { recordCollectionDurability, transactionDurability } from '../transaction/durability.js';
import type { TransactionDurability } from '../transaction/durability.js';
import type { CoordinatorPartialCommitError } from '../transaction/errors.js';
import type { RandFn } from '../utility/backoff.js';
import { createLogger } from '../logger.js';
import { alwaysReachable } from './reachability.js';
import type { ICohortReachability } from './reachability.js';
import {
	EntryDiscardedError,
	EntryExpiredError,
	EntryNotDiscardableError,
	QueueDisposedError,
	UnknownEntryError,
} from './status.js';
import type { EntryStatus, EntryWaitingFor, OfflineQueueState, QueuedEntry, QueuedFailureReason } from './status.js';
import { committedField, currentStatus, queuedStatus, queuedStatusChanged, snapshot } from './entry.js';
import type { Entry } from './entry.js';
import { DrainWaker } from './wake.js';

const log = createLogger('offline');

/** The re-check timer's defaults while the cohort is unreachable or after a transient failure. */
const DefaultRecheckBaseMs = 1_000;
const DefaultRecheckMaxMs = 60_000;

export type OfflineQueueOptions = {
	/** The gate of docs/offline-sync.md §When to submit. Default: always reachable. */
	reachability?: ICohortReachability;
	/** An external wake signal (db-p2p's connection events in stage 6): subscribe the queue's
	 * {@link OfflineQueue.wake} and return the unsubscribe, which {@link OfflineQueue.dispose} calls. */
	wakeOn?: (wake: () => void) => () => void;
	/** Fail an entry that stays unsettled this long, with reason `expired`. Default: no limit. An
	 * entry in doubt is never expired; it expires once its doubt resolves without committing. */
	expireAfterMs?: number;
	/** The re-check timer while the cohort is unreachable or after a transient failure: exponential
	 * from `baseMs` to `maxMs`, jittered (`jitteredBackoffMs`). Defaults 1 s / 60 s. */
	recheck?: { baseMs?: number; maxMs?: number; rand?: RandFn };
	/** Retry bounds handed to each submission (`Collection.commitHead` / `TransactionCoordinator.commitEntry`). */
	submit?: Pick<SyncOptions, 'maxAttempts' | 'deadlineMs' | 'baseBackoffMs' | 'maxBackoffMs' | 'maxStalledAttempts'>;
	/** Write-ahead hook: called with the attempt(s) about to be sent, before they are sent, and
	 * awaited; a throw keeps the entry queued, nothing sent (the journal's seam, stage 5). */
	recordAttempt?: (entryId: EntryId, attempts: ReadonlyMap<CollectionId, InFlightAttempt>) => Promise<void>;
	/** Clock, for tests. Default `Date.now`. */
	now?: () => number;
};

/** A refusal `onSealedRefused` reported and the drain has not yet acted on. */
type PendingRefusal = { readonly error: ActionRefusedError; readonly causedBy: EntryId | undefined };

type Deferred<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

/** The write-ahead hook threw: nothing was sent, so the entry is kept queued and re-driven after the
 * backoff. Private to the queue — the hook's own error travels as `cause`. */
class RecordAttemptFailed extends Error {
	constructor(readonly cause: unknown) {
		super('the write-ahead hook threw before the attempt was sent');
		this.name = 'RecordAttemptFailed';
	}
}

/** A fresh entry or action id: 16 random bytes, base64url — the shape a sync's action id has. */
function mintId(): string {
	return uint8ArrayToString(randomBytes(16), 'base64url');
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What `entry` wrote across every submission: the collections earlier partial commits committed,
 * beside what the last submission answered (`undefined` when it answered nothing new). */
function entryDurability(entry: Entry, written: TransactionDurability | undefined): TransactionDurability {
	const collections = new Map(entry.committed);
	for (const [collectionId, durability] of written?.collections ?? []) {
		recordCollectionDurability(collections, collectionId, durability);
	}
	return transactionDurability(collections);
}

/**
 * The offline-sync queue (docs/offline-sync.md §Draining): an in-memory list of locally committed
 * entries, each the sealed segments one local commit left in the collections it wrote, drained one
 * at a time in queue order once the cohort can be reached.
 *
 * **One drain loop per queue, serialised.** At most one submission is on the network at a time, and
 * the loop is the only thing that removes entries' segments from the collections apart from
 * {@link discard}, whose removal runs on the same removal chain. Each iteration: apply the refusals
 * {@link onSealedRefused} has collected; expire what has outlived `expireAfterMs`; wait for a wake
 * when the queue is empty; fail the head when a collection already records its refusal; ask the
 * reachability gate; submit the head — `Collection.commitHead` for an entry over one collection,
 * `TransactionCoordinator.commitEntry` over several — and apply the outcome by its class
 * (`classifyCommitFailure`). The gate and the transient failures share one re-check timer, whose
 * step a wake or a committed entry resets.
 *
 * **A partly committed entry is finished, not rolled back** (docs/offline-sync.md §Partial commits):
 * the committed collections' segments are consumed, the entry stays at the head in doubt, and each
 * later submission drives only the collections still holding its segment, under the same action id.
 *
 * **Removing an entry cascades** (docs/offline-sync.md §Removing an entry): a failed entry's
 * segments are dropped from its collections, each drop replays what remains, a later entry the
 * replay refuses is reported through {@link onSealedRefused} and failed in turn with `causedBy`
 * set, until nothing is pending. The callback runs under the collection latch, so it only records
 * and wakes; the loop acts.
 *
 * Everything an application sees goes through {@link onStatus} and {@link onQueueState}; a listener
 * that throws is logged and never breaks the drain.
 */
export class OfflineQueue {
	private readonly list: Entry[] = [];
	private readonly byId = new Map<EntryId, Entry>();
	private nextSeq = 1;
	private readonly reachability: ICohortReachability;
	private readonly waker: DrainWaker;
	private readonly submitOptions: OfflineQueueOptions['submit'];
	private readonly expireAfterMs: number | undefined;
	private readonly recordAttemptHook: OfflineQueueOptions['recordAttempt'];
	private readonly now: () => number;
	private readonly unsubscribeWake: (() => void) | undefined;

	private readonly statusListeners = new Set<(status: EntryStatus) => void>();
	private readonly stateListeners = new Set<(state: OfflineQueueState) => void>();
	private lastState: OfflineQueueState | undefined;
	private unclassifiedFailures = 0;

	private readonly pendingRefusals = new Map<EntryId, PendingRefusal>();
	/** The entry whose segments are being dropped, while they are: the attribution of the refusals
	 * those drops report (see {@link causeOf}). */
	private removing: Entry | undefined;
	/** Every removal — the loop's and {@link discard}'s — runs on this chain, one at a time, so two
	 * never interleave their drops and {@link causeOf} always names one removal. Never rejects: a
	 * removal's throw reaches whoever awaited that removal, or {@link noteDefect} for a discard. */
	private removals: Promise<void> = Promise.resolve();
	/** Removals chained and not yet finished — a `discard`'s runs off the loop's path, and
	 * `whenDrained` answers at once only when none is. */
	private pendingRemovals = 0;

	private inFlight: { readonly entry: Entry; readonly controller: AbortController } | undefined;
	private loop: Promise<void> | undefined;
	/** The loop is parked on an empty queue (so `whenDrained` can answer at once). */
	private waitingForWork = false;
	private readonly drainedWaiters: Deferred<void>[] = [];
	private disposed = false;
	private disposal: Promise<void> | undefined;
	/** The error that stopped the drain (`SealedSegmentsError` out of a submission, a removal that
	 * threw): `whenDrained` rejects with it and `enqueue` refuses. */
	private defect: unknown;

	constructor(private readonly transactor: ITransactor, options: OfflineQueueOptions = {}) {
		this.reachability = options.reachability ?? alwaysReachable;
		this.waker = new DrainWaker(
			{ baseMs: options.recheck?.baseMs ?? DefaultRecheckBaseMs, capMs: options.recheck?.maxMs ?? DefaultRecheckMaxMs },
			options.recheck?.rand);
		this.submitOptions = options.submit;
		this.expireAfterMs = options.expireAfterMs;
		this.recordAttemptHook = options.recordAttempt;
		this.now = options.now ?? Date.now;
		this.unsubscribeWake = options.wakeOn?.(() => this.wake());
	}

	/**
	 * Seal each collection's open segment under a new entry and queue it. `undefined` when no
	 * collection had anything staged — nothing to queue, nothing sealed (`Collection.sealPending`
	 * answers `false` and changes nothing for an empty open segment, so a sibling with nothing staged
	 * is simply not part of the entry). Emits `queued` SYNCHRONOUSLY before returning, so a caller
	 * can attribute it to the commit it is in. Starts the drain on the first call.
	 *
	 * Synchronous and latch-free like `sealPending`: the caller brackets it (no act or commit of these
	 * collections is in flight).
	 *
	 * @throws QueueDisposedError after {@link dispose}; the drain's defect, as `cause`, once the
	 * drain has stopped on one (nothing queued then would ever drain). */
	enqueue(collections: readonly Collection<any>[], init?: { id?: EntryId; timestamp?: number }): QueuedEntry | undefined {
		if (this.disposed) throw new QueueDisposedError();
		if (this.defect !== undefined) throw new Error('the offline queue stopped on a defect; see cause', { cause: this.defect });
		const id = init?.id ?? mintId();
		if (this.byId.has(id)) throw new Error(`entry ${id} is already queued`);
		const sealed = collections.filter(collection => collection.sealPending(id));
		if (sealed.length === 0) return undefined;
		const queuedAt = init?.timestamp ?? this.now();
		const entry: Entry = {
			id,
			seq: this.nextSeq++,
			queuedAt,
			expiresAt: this.expireAfterMs === undefined ? undefined : queuedAt + this.expireAfterMs,
			collections: sealed,
			actionId: mintId(),
			attempts: 0,
			inDoubt: false,
			retained: new Map(),
			committed: new Map(),
			phase: 'queued',
			waitingFor: this.list.length > 0 ? 'earlier-entry' : undefined,
			lastError: undefined,
			lastQueued: undefined,
			expiryDeferredLogged: false,
		};
		this.list.push(entry);
		this.byId.set(id, entry);
		this.emitQueued(entry);
		this.publishState();
		if (this.loop === undefined) {
			this.loop = this.drain();
		} else {
			this.wake();
		}
		return snapshot(entry);
	}

	/**
	 * The collection callback: pass as `CollectionInitOptions.onSealedRefused` of every collection
	 * whose entries this queue drains. Runs synchronously under the collection latch, so it calls no
	 * latched method (`dropSealed`, `update`, `commitHead`): it records the refusal and wakes the
	 * loop, which acts on it (step one of each iteration). A refusal for an entry this queue does not
	 * hold — another queue's, or one already removed — is ignored; for the entry being submitted it
	 * is noted and left to that submission, whose cycle re-checks the recorded refusal and throws it.
	 */
	readonly onSealedRefused = (entryId: EntryId, error: ActionRefusedError): void => {
		const entry = this.byId.get(entryId);
		if (entry === undefined) {
			log('offline:refusal-for-unknown-entry entry=%s error=%s', entryId, error.message);
			return;
		}
		// The first refusal reported for an entry is the one it fails with; a second collection's
		// refusal of the same entry adds nothing the application can act on separately.
		if (this.pendingRefusals.has(entryId)) return;
		this.pendingRefusals.set(entryId, { error, causedBy: this.causeOf(entry) });
		this.wake();
	};

	/** The queued entries, in queue order. */
	entries(): readonly QueuedEntry[] {
		return this.list.map(entry => snapshot(entry));
	}

	/** The current status of a queued entry, or `undefined` for an id not queued — never queued, or
	 * already committed or failed (a settled entry leaves the queue with its terminal status event). */
	status(entryId: EntryId): EntryStatus | undefined {
		const entry = this.byId.get(entryId);
		return entry === undefined ? undefined : currentStatus(entry);
	}

	/**
	 * Withdraw a never-sent entry: it fails with reason `discarded` and cascades like any failure
	 * (docs/offline-sync.md §Removing an entry). Removed from the queue at once, so the drain cannot
	 * pick it up; its segments are dropped on the removal chain and `failed` is emitted when the drops
	 * are done.
	 *
	 * @throws EntryNotDiscardableError for an entry that is in doubt (sent at least once — the
	 * application cannot withdraw a change it cannot rule out having saved) or being submitted;
	 * UnknownEntryError for an id not queued. */
	discard(entryId: EntryId): void {
		const entry = this.byId.get(entryId);
		if (entry === undefined) throw new UnknownEntryError(entryId);
		if (this.inFlight?.entry === entry) throw new EntryNotDiscardableError(entryId, 'submitting');
		if (entry.inDoubt) throw new EntryNotDiscardableError(entryId, 'in-doubt');
		this.claimRemoval(entry);
		this.chainRemoval(entry, 'discarded', new EntryDiscardedError(entryId), undefined)
			.catch(err => this.noteDefect(err));
		this.wake();
	}

	onStatus(listener: (status: EntryStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => { this.statusListeners.delete(listener); };
	}

	onQueueState(listener: (state: OfflineQueueState) => void): () => void {
		this.stateListeners.add(listener);
		return () => { this.stateListeners.delete(listener); };
	}

	queueState(): OfflineQueueState {
		const head = this.list[0];
		const waitingFor = head?.waitingFor;
		return {
			depth: this.list.length,
			oldestQueuedAt: head?.queuedAt,
			draining: this.inFlight !== undefined,
			waitingFor: waitingFor === 'cohort' || waitingFor === 'backoff' ? waitingFor : undefined,
			unclassifiedFailures: this.unclassifiedFailures,
		};
	}

	/** Kick the drain: a new local commit ({@link enqueue} calls it), a connection event, a test. A
	 * wake that finds the loop busy is kept for its next wait, and a wake resets the re-check backoff. */
	wake(): void {
		this.waker.wake();
	}

	/** Resolves when the queue is empty and every removal has finished; rejects with
	 * {@link QueueDisposedError} on {@link dispose}, and with the drain's defect once it has stopped
	 * on one. */
	whenDrained(): Promise<void> {
		if (this.disposed) return Promise.reject(new QueueDisposedError());
		if (this.defect !== undefined) return Promise.reject(this.defect);
		const idle = this.loop === undefined || (this.waitingForWork && this.pendingRemovals === 0);
		if (this.list.length === 0 && idle) return Promise.resolve();
		return new Promise<void>((resolve, reject) => { this.drainedWaiters.push({ resolve, reject }); });
	}

	/**
	 * Stop draining. Unsubscribes the wake signal, clears the timer, aborts the submission in flight
	 * (its cycle stops after its current network `await`) and resolves once the loop has applied that
	 * submission's outcome locally — a committed outcome is still emitted, a failure is recorded on the
	 * entry as usual, and no further entry is submitted. Entries left queued stay sealed in their
	 * collections (they are the application's; nothing is dropped). `whenDrained` rejects with
	 * {@link QueueDisposedError}; a later `enqueue` throws it. Idempotent.
	 */
	dispose(): Promise<void> {
		this.disposal ??= this.disposeOnce();
		return this.disposal;
	}

	private async disposeOnce(): Promise<void> {
		this.disposed = true;
		this.unsubscribeWake?.();
		this.inFlight?.controller.abort(new QueueDisposedError());
		this.wake();
		await this.loop;
		await this.settledRemovals();
		const error = new QueueDisposedError();
		for (const waiter of this.drainedWaiters.splice(0)) waiter.reject(error);
		this.publishState();
	}

	// ── the drain ──────────────────────────────────────────────────────────────────────────────

	private async drain(): Promise<void> {
		try {
			while (!this.disposed) {
				if (this.defect !== undefined) throw this.defect;
				await this.processPendingRefusals();
				if (this.disposed) break;
				await this.expireDue();
				if (this.disposed) break;
				const head = this.list[0];
				if (head === undefined) {
					this.settleDrained();
					this.publishState();
					this.waitingForWork = true;
					try {
						await this.waker.untilWoken();
					} finally {
						this.waitingForWork = false;
					}
					continue;
				}
				const refusal = this.recordedRefusal(head);
				if (refusal !== undefined) {
					// A refresh found it before the drain did: reported at once, nothing sent.
					await this.failAndCascade(head, refusalReason(refusal), refusal, this.pendingRefusals.get(head.id)?.causedBy);
					continue;
				}
				if (!await this.gateOpen(head)) {
					this.setQueued(head, 'cohort');
					await this.waker.untilWokenOrTimer();
					continue;
				}
				// `discard` may have taken the head, or `dispose` may have run, while the gate was asked;
				// a new iteration re-reads the one and ends on the other.
				if (this.disposed || this.list[0] !== head) continue;
				const retryLater = await this.submit(head);
				if (retryLater) {
					await this.waker.untilWokenOrTimer();
				}
			}
		} catch (err) {
			this.stopOnDefect(err);
		}
	}

	/** Step one of every iteration: fail each entry a replay has refused since the last one, in
	 * queue order, each failure through the removal chain and so able to report more. */
	private async processPendingRefusals(): Promise<void> {
		for (;;) {
			await this.settledRemovals();
			const next = this.nextPendingRefusal();
			if (next === undefined) return;
			const { entry, refusal } = next;
			await this.fail(entry, refusalReason(refusal.error), refusal.error, refusal.causedBy);
		}
	}

	/** The pending refusal whose entry is earliest in queue order, dropping any for an entry no
	 * longer queued. The submitting entry's is never met here: the loop runs this step only between
	 * submissions, and its submission throws the refusal itself. */
	private nextPendingRefusal(): { entry: Entry; refusal: PendingRefusal } | undefined {
		for (const entryId of [...this.pendingRefusals.keys()]) {
			if (!this.byId.has(entryId)) this.pendingRefusals.delete(entryId);
		}
		for (const entry of this.list) {
			const refusal = this.pendingRefusals.get(entry.id);
			if (refusal !== undefined) return { entry, refusal };
		}
		return undefined;
	}

	/** Step two: expire what has outlived its `expiresAt`, in queue order, head or not. An entry in
	 * doubt is kept and logged (`offline:expiry-deferred`): a possibly-landed write is never dropped
	 * on a clock; it expires once its doubt resolves without committing. Stops when the queue is
	 * disposed mid-step, since disposal leaves every entry as it is.
	 * NOTE: checked once per iteration, and a non-empty queue always has a timer or a submission
	 * pending, so an expiry is applied at most one re-check delay (`recheck.maxMs`, 60 s by default)
	 * late; if an application ever needs it on the minute, arm a timer at the earliest `expiresAt`. */
	private async expireDue(): Promise<void> {
		const now = this.now();
		for (const entry of [...this.list]) {
			if (this.disposed) return;
			if (entry.expiresAt === undefined || entry.expiresAt > now || !this.byId.has(entry.id)) continue;
			if (entry.inDoubt) {
				if (!entry.expiryDeferredLogged) {
					entry.expiryDeferredLogged = true;
					log('offline:expiry-deferred entry=%s action=%s expiresAt=%d: in doubt, kept until its outcome is known',
						entry.id, entry.actionId, entry.expiresAt);
				}
				continue;
			}
			await this.failAndCascade(entry, 'expired', new EntryExpiredError(entry.id, entry.queuedAt, entry.expiresAt));
		}
	}

	/** The refusal a collection has recorded for `entry`'s segment, if any has. */
	private recordedRefusal(entry: Entry): ActionRefusedError | undefined {
		for (const collection of entry.collections) {
			const refusal = collection.sealedRefusal(entry.id);
			if (refusal !== undefined) return refusal;
		}
		return undefined;
	}

	/** The collections in which `entry` is still a sealed segment: every collection it wrote, until a
	 * partial commit consumes some. */
	private remainingCollections(entry: Entry): Collection<any>[] {
		return entry.collections.filter(collection => collection.sealedEntries().includes(entry.id));
	}

	/** The gate, asked with each of the head's remaining collections' header id and known log tail id.
	 * A gate that throws is logged and read as closed: the next re-check asks again. */
	private async gateOpen(entry: Entry): Promise<boolean> {
		const blockIds: BlockId[] = [];
		for (const collection of this.remainingCollections(entry)) {
			blockIds.push(collection.id);
			const tailId = collection.knownLogTailId();
			if (tailId !== undefined) blockIds.push(tailId);
		}
		try {
			return await this.reachability.reachable(blockIds);
		} catch (err) {
			log('offline:reachability-threw entry=%s error=%s', entry.id, describe(err));
			return false;
		}
	}

	// ── submitting ─────────────────────────────────────────────────────────────────────────────

	/** Submit the head once and apply the outcome. Answers whether the loop should wait out the
	 * re-check timer before its next iteration (a transient failure) rather than go straight on (the
	 * entry committed or failed). */
	private async submit(entry: Entry): Promise<boolean> {
		const remaining = this.remainingCollections(entry);
		if (remaining.length === 0) {
			throw new Error(`offline queue: entry ${entry.id} holds no sealed segment in any collection it wrote`);
		}
		entry.attempts++;
		entry.phase = 'submitting';
		const controller = new AbortController();
		this.inFlight = { entry, controller };
		this.emit({ kind: 'submitting', entryId: entry.id, attempt: entry.attempts });
		this.publishState();
		let outcome: { durability: TransactionDurability } | { error: unknown };
		try {
			outcome = { durability: await this.send(entry, remaining, controller.signal) };
		} catch (error) {
			outcome = { error };
		} finally {
			this.inFlight = undefined;
		}
		if ('durability' in outcome) {
			this.committed(entry, outcome.durability);
			return false;
		}
		return this.applyFailure(entry, outcome.error);
	}

	/** One submission: `commitHead` for an entry over one collection, the coordinator's per-entry
	 * slice over several, each under the entry's action id and local commit time, resuming from the
	 * attempts retained under that id. */
	private async send(entry: Entry, remaining: readonly Collection<any>[], signal: AbortSignal): Promise<TransactionDurability> {
		const submit: SyncOptions = { ...this.submitOptions, signal };
		const recordAttempt = (attempts: ReadonlyMap<CollectionId, InFlightAttempt>) => this.recordAttempts(entry, attempts);
		if (remaining.length === 1) {
			const collection = remaining[0]!;
			const resume = entry.retained.get(collection.id);
			const written = await collection.commitHead(entry.id, {
				...submit,
				actionId: entry.actionId,
				timestamp: entry.queuedAt,
				recordAttempt: attempt => recordAttempt(new Map([[collection.id, attempt]])),
				...(resume === undefined ? {} : { resume }),
			});
			return transactionDurability(new Map([[collection.id, written]]));
		}
		const coordinator = new TransactionCoordinator(this.transactor,
			new Map(remaining.map(collection => [collection.id, collection])), { pendValidation: 'none' });
		const resume = new Map([...entry.retained].filter(([collectionId]) => remaining.some(collection => collection.id === collectionId)));
		return coordinator.commitEntry({
			entryId: entry.id,
			actionId: entry.actionId,
			timestamp: entry.queuedAt,
			collectionIds: remaining.map(collection => collection.id),
			recordAttempt,
			...(resume.size === 0 ? {} : { resume }),
		}, submit);
	}

	/** The queue's write-ahead wrapper: the one moment before a send the queue is told about. The
	 * hook runs first; a throw out of it aborts the cycle with nothing sent (both drivers promise
	 * that), so an attempt it refused is neither retained nor a reason for doubt — the entry stays
	 * discardable, and `resume` on the next drive names only attempts that may have landed. */
	private async recordAttempts(entry: Entry, attempts: ReadonlyMap<CollectionId, InFlightAttempt>): Promise<void> {
		try {
			await this.recordAttemptHook?.(entry.id, attempts);
		} catch (err) {
			log('offline:record-attempt-failed entry=%s action=%s error=%s', entry.id, entry.actionId, describe(err));
			throw new RecordAttemptFailed(err);
		}
		// NOTE: in doubt is STICKY — set here, once the first attempt of the entry is about to be sent,
		// and cleared only by a terminal outcome or by `torn-not-saved`. A cycle's own refreshes
		// resolve its earlier attempts (each refresh finds a landed own entry, and an attempt at an
		// unchanged revision finishes an earlier one as the same action), so the last cycle's
		// classification speaks for the cycle; but a coordinator lagging its cohort can still hide a
		// minority-held tail, and the sticky rule is what keeps that from ever discarding a
		// possibly-landed entry. While in doubt the entry is neither discardable nor expirable, and is
		// re-driven only under its action id with its retained attempts as `resume`.
		entry.inDoubt = true;
		for (const [collectionId, attempt] of attempts) {
			entry.retained.set(collectionId, attempt);
		}
	}

	/** Settle `entry` committed, reporting every collection it wrote: `written`, the last submission's
	 * answer, beside what earlier partial commits committed. */
	private committed(entry: Entry, written?: TransactionDurability): void {
		this.claimRemoval(entry);
		this.pendingRefusals.delete(entry.id);
		entry.retained.clear();
		entry.inDoubt = false;
		this.emit({ kind: 'committed', entryId: entry.id, durability: entryDurability(entry, written) });
		this.waker.resetBackoff();
		this.publishState();
	}

	/**
	 * Apply a failed submission by its class (docs/offline-sync.md §Classifying an attempt's outcome):
	 *
	 * | class | transition |
	 * |---|---|
	 * | the write-ahead hook threw | `queued`, `backoff` — nothing was sent |
	 * | `ActionRefusedError` thrown directly (the head's recorded refusal) | `failed`, `refusalReason` |
	 * | `cohort-unreachable` | `queued`, `cohort`; the timer re-checks the gate |
	 * | `contention`, `expired`, `in-doubt`, `unknown` | `queued`, `backoff`; `unknown` is also logged and counted |
	 * | `guard-refused`, `rejected`, `too-large` | `failed`, with the class's reason |
	 * | `torn-not-saved` | `queued`, `backoff`; doubt cleared (unless part of the entry is committed), a fresh action id, retained attempts cleared |
	 * | `partial` | `partially-committed`, then `queued`, `backoff`, in doubt, under the same id unless its cause is `torn-not-saved` ({@link partiallyCommitted}) |
	 *
	 * `SealedSegmentsError` out of a submission means the head alignment invariant broke — a queue
	 * defect — and is thrown out of the loop, which stops the drain.
	 *
	 * **One action id for the entry's whole life, with one exception.** Storage treats a re-send of
	 * the same action at the same revision as finishing it and at a new revision as a new write, so
	 * re-driving under the same id is always safe and keeps the member-side slot hold the write earned
	 * by losing. The exception is `torn-not-saved`: a re-drive under that id would find its own
	 * stranded log entry on every refresh, re-send it, and be told again that a rival built past it —
	 * a loop. A fresh id lets the next refresh treat the stranded entry as a stranger's and move on,
	 * which is exactly the proof `final: true` gives. A refused pend does NOT mint a fresh id here: it
	 * proves nothing about the cycle's earlier attempts under the same id.
	 *
	 * @returns whether the entry stays queued (wait out the timer) rather than having settled. */
	private async applyFailure(entry: Entry, error: unknown): Promise<boolean> {
		if (error instanceof SealedSegmentsError) throw error;
		if (error instanceof RecordAttemptFailed) {
			this.setQueued(entry, 'backoff', error.cause);
			return true;
		}
		if (error instanceof QueueDisposedError && this.disposed) {
			// The queue's own abort of the submission in flight: not a failure of the write, so not
			// its `lastError` either.
			this.setQueued(entry, undefined);
			return true;
		}
		if (error instanceof ActionRefusedError) {
			await this.failAndCascade(entry, refusalReason(error), error, this.pendingRefusals.get(entry.id)?.causedBy);
			return false;
		}
		const outcome = classifyCommitFailure(error);
		switch (outcome.kind) {
			case 'cohort-unreachable': {
				this.setQueued(entry, 'cohort', error);
				return true;
			}
			case 'contention':
			case 'expired':
			case 'in-doubt': {
				this.setQueued(entry, 'backoff', error);
				return true;
			}
			case 'torn-not-saved': {
				// The torn attempt is provably not saved, but a partial commit's half is: an entry with a
				// committed part stays in doubt, so it is never discarded or expired.
				entry.inDoubt = entry.committed.size > 0;
				this.renewIdentity(entry);
				this.setQueued(entry, 'backoff', error);
				return true;
			}
			case 'partial': {
				return this.partiallyCommitted(entry, outcome.error);
			}
			case 'unknown': {
				this.unclassifiedFailures++;
				log('offline:unclassified-failure entry=%s action=%s error=%s', entry.id, entry.actionId, describe(error));
				this.setQueued(entry, 'backoff', error);
				return true;
			}
			case 'guard-refused': {
				await this.failAndCascade(entry, outcome.refusal, outcome.error, this.pendingRefusals.get(entry.id)?.causedBy);
				return false;
			}
			case 'rejected': {
				await this.failAndCascade(entry, 'rejected', outcome.error);
				return false;
			}
			case 'too-large': {
				await this.failAndCascade(entry, 'too-large', outcome.error);
				return false;
			}
		}
	}

	/**
	 * A submission committed part of the entry (docs/offline-sync.md §Partial commits). The committed
	 * collections' segments are already consumed and their attempts resolved, so they are recorded on
	 * the entry and leave `retained`; the rest are still sealed and first, their attempts retained, and
	 * the next submission drives exactly them, under the same action id (a fresh one when the rest
	 * failed `torn-not-saved`). The entry is in doubt from here to its terminal outcome, so it is
	 * neither discarded nor expired. `partially-committed` is emitted in place of the `queued` status
	 * this transition would otherwise report.
	 *
	 * @returns whether the entry stays queued: `false` only when no collection still holds its segment
	 * (the failure came after every collection was saved), which settles it committed. */
	private partiallyCommitted(entry: Entry, error: CoordinatorPartialCommitError): boolean {
		for (const [collectionId, durability] of error.durability.collections) {
			recordCollectionDurability(entry.committed, collectionId, durability);
			entry.retained.delete(collectionId);
		}
		entry.inDoubt = true;
		const pending = this.remainingCollections(entry).map(collection => collection.id);
		if (pending.length === 0) {
			this.committed(entry);
			return false;
		}
		// The coordinator reports any failure after a saved participant as a partial commit, so the
		// rest may have failed `torn-not-saved`; re-driving it under the same id would only meet that
		// stranded entry again.
		if (classifyCommitFailure(error.reason).kind === 'torn-not-saved') this.renewIdentity(entry);
		const committedCollections = [...entry.committed.keys()];
		log('offline:partially-committed entry=%s action=%s committed=%o pending=%o reason=%s',
			entry.id, entry.actionId, committedCollections, pending, describe(error.reason));
		entry.phase = 'queued';
		entry.waitingFor = 'backoff';
		entry.lastError = error;
		entry.lastQueued = queuedStatus(entry);
		this.emit({
			kind: 'partially-committed',
			entryId: entry.id,
			committedCollections,
			pendingCollections: pending,
			cause: error.reason instanceof Error ? error.reason : error,
		});
		this.publishState();
		return true;
	}

	/** After a `torn-not-saved` outcome: nothing sent under the entry's action id is saved or will
	 * land, so the next submission goes under a fresh one with nothing to resume. A partly committed
	 * entry's committed half keeps the old id; only the remainder commits under the new one. */
	private renewIdentity(entry: Entry): void {
		entry.actionId = mintId();
		entry.retained.clear();
	}

	// ── removing ───────────────────────────────────────────────────────────────────────────────

	/** Fail `entry` and then act on every refusal its removal reported, in queue order, until none is
	 * pending (docs/offline-sync.md §Removing an entry). */
	private async failAndCascade(entry: Entry, reason: QueuedFailureReason, error: Error, causedBy?: EntryId): Promise<void> {
		await this.fail(entry, reason, error, causedBy);
		await this.processPendingRefusals();
	}

	/** Fail one entry: removed from the queue at once, its segments dropped on the removal chain.
	 * Nothing happens for an entry a `discard` has already claimed. */
	private async fail(entry: Entry, reason: QueuedFailureReason, error: Error, causedBy: EntryId | undefined): Promise<void> {
		if (!this.claimRemoval(entry)) return;
		await this.chainRemoval(entry, reason, error, causedBy);
	}

	/** Take `entry` out of the queue (the synchronous half of every removal, a commit's included), so
	 * the drain cannot pick it again. Answers `false` when it was already taken. */
	private claimRemoval(entry: Entry): boolean {
		if (!this.byId.delete(entry.id)) return false;
		const index = this.list.indexOf(entry);
		if (index >= 0) this.list.splice(index, 1);
		const head = this.list[0];
		if (head !== undefined && head.waitingFor === 'earlier-entry') head.waitingFor = undefined;
		return true;
	}

	/** Queue `entry`'s drops behind every removal already chained; the returned promise is that
	 * removal's own, so its throw reaches the caller while the chain itself never rejects. */
	private chainRemoval(entry: Entry, reason: QueuedFailureReason, error: Error, causedBy: EntryId | undefined): Promise<void> {
		this.pendingRemovals++;
		const removal = this.removals.then(() => this.remove(entry, reason, error, causedBy));
		const settled = (): void => { this.pendingRemovals--; };
		this.removals = removal.then(settled, settled);
		return removal;
	}

	/** The asynchronous half of a failure: drop the entry's segment from every collection that still
	 * holds one (a collection the entry had no segment in, or whose segment a partial commit consumed,
	 * is skipped), then emit `failed` naming those collections, and the ones a partial commit
	 * committed whatever triggered the failure. Each drop replays and may report refusals of later
	 * entries through {@link onSealedRefused}, which {@link causeOf} attributes while `removing` names
	 * this entry. */
	private async remove(entry: Entry, reason: QueuedFailureReason, error: Error, causedBy: EntryId | undefined): Promise<void> {
		this.pendingRefusals.delete(entry.id);
		const changedCollections: CollectionId[] = [];
		this.removing = entry;
		try {
			for (const collection of entry.collections) {
				if (!collection.sealedEntries().includes(entry.id)) continue;
				changedCollections.push(collection.id);
				await collection.dropSealed(entry.id);
			}
		} finally {
			this.removing = undefined;
		}
		if (entry.committed.size > 0) {
			log('offline:partially-committed-entry-failed entry=%s action=%s committed=%o dropped=%o reason=%s: the network holds part of the transaction',
				entry.id, entry.actionId, [...entry.committed.keys()], changedCollections, reason);
		}
		this.emit({
			kind: 'failed',
			entryId: entry.id,
			reason,
			error,
			changedCollections,
			...(causedBy === undefined ? {} : { causedBy }),
			...committedField(entry),
		});
		this.publishState();
	}

	/**
	 * Which earlier entry a refusal of `entry` is attributed to: the nearest one, in queue order, that
	 * is being removed right now or already has a refusal pending; `undefined` when there is none (a
	 * rival's commit refused the entry directly, found by a reader's refresh).
	 *
	 * Nearest rather than the entry being dropped, because one replay refuses every later segment
	 * that no longer applies at once: dropping E1 re-stages E2 (refused) and then E3 over state
	 * without E2, so E3's refusal is reported during E1's drop even though it is E2's image E3 built on.
	 * Naming the nearest failing entry gives the chain E3 ← E2 ← E1 an application can follow, where
	 * the literal "the entry whose drop ran the replay" would flatten it to E3 ← E1, E2 ← E1.
	 */
	private causeOf(entry: Entry): EntryId | undefined {
		let cause: Entry | undefined;
		for (const earlier of this.list) {
			if (earlier.seq >= entry.seq) break;
			if (this.pendingRefusals.has(earlier.id)) cause = earlier;
		}
		const removing = this.removing;
		if (removing !== undefined && removing.seq < entry.seq && (cause === undefined || removing.seq > cause.seq)) {
			cause = removing;
		}
		return cause?.id;
	}

	/** The removal chain, once every removal chained so far — including ones chained while waiting —
	 * has finished. */
	private async settledRemovals(): Promise<void> {
		let chain: Promise<void>;
		do {
			chain = this.removals;
			await chain;
		} while (chain !== this.removals);
	}

	// ── stopping ───────────────────────────────────────────────────────────────────────────────

	private settleDrained(): void {
		for (const waiter of this.drainedWaiters.splice(0)) waiter.resolve();
	}

	/** The drain has met a defect: stop it, reject every `whenDrained`, and leave every entry as it
	 * is. Segments stay sealed in their collections, so nothing the application committed is lost.
	 * NOTE: a removal that threw is read as a defect too, though `dropSealed`'s replay reads blocks
	 * through the collection's source and so can throw for a read that could not be served (a cache
	 * miss while the cohort is unreachable). Fine while every replay runs over blocks the staging
	 * read into the cache; if `offline:drain-stopped` is ever seen with such an error, a removal
	 * needs to be retried on the re-check timer rather than stop the drain. */
	private stopOnDefect(error: unknown): void {
		this.defect = error;
		log('offline:drain-stopped error=%s', describe(error));
		for (const waiter of this.drainedWaiters.splice(0)) waiter.reject(error);
		this.publishState();
	}

	/** A removal off the loop's path (a `discard`) threw: the loop meets it on its next iteration. */
	private noteDefect(error: unknown): void {
		this.defect ??= error;
		this.wake();
	}

	// ── reporting ──────────────────────────────────────────────────────────────────────────────

	/** Back to `queued` after a gate check or a failed submission; emitted only when something an
	 * application can see changed since the last `queued` status. */
	private setQueued(entry: Entry, waitingFor: EntryWaitingFor | undefined, lastError?: unknown): void {
		entry.phase = 'queued';
		entry.waitingFor = waitingFor;
		if (lastError !== undefined) entry.lastError = lastError;
		if (!queuedStatusChanged(entry.lastQueued, queuedStatus(entry))) return;
		this.emitQueued(entry);
		this.publishState();
	}

	private emitQueued(entry: Entry): void {
		const status = queuedStatus(entry);
		entry.lastQueued = status;
		this.emit(status);
	}

	private emit(status: EntryStatus): void {
		for (const listener of this.statusListeners) {
			try {
				listener(status);
			} catch (err) {
				log('offline:listener-threw listener=status entry=%s kind=%s error=%s', status.entryId, status.kind, describe(err));
			}
		}
	}

	/** Publish the queue-wide state when it differs from the last one published. */
	private publishState(): void {
		const state = this.queueState();
		const last = this.lastState;
		if (last !== undefined
			&& last.depth === state.depth
			&& last.oldestQueuedAt === state.oldestQueuedAt
			&& last.draining === state.draining
			&& last.waitingFor === state.waitingFor
			&& last.unclassifiedFailures === state.unclassifiedFailures) {
			return;
		}
		this.lastState = state;
		for (const listener of this.stateListeners) {
			try {
				listener(state);
			} catch (err) {
				log('offline:listener-threw listener=state error=%s', describe(err));
			}
		}
	}
}
