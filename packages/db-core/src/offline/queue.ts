import { randomBytes } from '@noble/hashes/utils.js';
import { toString as uint8ArrayToString } from 'uint8arrays/to-string';
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
import { alwaysReachable, gateBlockIds } from './reachability.js';
import type { ICohortReachability } from './reachability.js';
import {
	EntryDiscardedError,
	EntryExpiredError,
	EntryNotDiscardableError,
	QueueDisposedError,
	UnknownEntryError,
} from './status.js';
import type { EntryStatus, EntryWaitingFor, OfflineQueueState, QueuedEntry, QueuedFailureReason } from './status.js';
import type { IOfflineJournal, JournalDriveState, JournalEntryRecord, JournalSettledStatus } from './journal.js';
import { committedField, currentStatus, driveState, queuedStatus, queuedStatusChanged, snapshot } from './entry.js';
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
	/** Let an entry be committed by a lone node that knows it is not alone. Unless this is `true`,
	 * every submission sets `SyncOptions.refuseSoloCommit`, so a coordinator whose cohort is only
	 * itself refuses the entry while it knows of absent members, awaits a bootstrap peer or cannot
	 * route the write, and the entry waits for its cohort (`waitingFor: 'cohort'`) rather than settling
	 * `committed` on a write only this machine holds (docs/offline-sync.md §When to submit: the
	 * reachability gate). A node that is genuinely alone commits either way. Default `false`. */
	allowSoloCommit?: boolean;
	/** The durable journal (docs/offline-sync.md §Persistence), called at every moment the design's
	 * write ordering names: before `queued` is emitted, before each send, after a partial commit and
	 * an identity renewal, and before each terminal status. Absent, nothing is journaled and the queue
	 * is in memory only. */
	journal?: IOfflineJournal;
	/** Clock, for tests. Default `Date.now`. */
	now?: () => number;
};

/** What {@link OfflineQueue.restore} puts an entry back from: the journal's entry record, the
 * collections the record's segments name (opened by the caller), and the drive record, when one was
 * written. */
export type RestoreInit = {
	readonly id: EntryId;
	readonly seq: number;
	readonly queuedAt: number;
	readonly expiresAt?: number;
	/** The collections the entry sealed a segment in, in the record's order — `stage` is called for
	 * each, in this order. */
	readonly collections: readonly Collection<any>[];
	/** From the drive record, when one was written: the entry is then in doubt and resumes these.
	 * Absent: nothing was ever sent; a fresh action id is minted. */
	readonly drive?: JournalDriveState;
};

/** Per collection, what {@link OfflineQueue.restore}'s `stage` found: the segment is in place
 * (possibly refused — the refusal is reported here, since the collection cannot report it to a
 * queue that does not yet hold the entry; see `Collection.restoreSealed`), or the collection already
 * holds the entry's recorded attempt as committed (`Collection.holdsCommitted`), so nothing was
 * staged. */
export type RestoredSegment = { kind: 'staged'; refused?: ActionRefusedError } | { kind: 'already-committed' };

/** A refusal `onSealedRefused` reported and the drain has not yet acted on. */
type PendingRefusal = { readonly error: ActionRefusedError; readonly causedBy: EntryId | undefined };

type Deferred<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

/** The drain hold a {@link OfflineQueue.restore} takes: the loop parks at the top of its next
 * iteration (`parked` resolves there) until `release`, so a restore inserts its segments while no
 * submission and no removal is under way. */
type DrainHold = {
	readonly held: Promise<void>;
	readonly release: () => void;
	/** Resolved by the loop when it reaches the hold, by its exit, or at once by the taker when the
	 * loop was not running or was parked on an empty queue. */
	readonly parked: Promise<void>;
	readonly signalParked: () => void;
};

/** The journal's write-ahead write threw: nothing was sent, so the entry is kept queued and re-driven
 * after the backoff. Private to the queue — the journal's own error travels as `cause`. */
class RecordAttemptFailed extends Error {
	constructor(readonly cause: unknown) {
		super('the journal refused the attempt before it was sent');
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
 * The one transactor `remaining` share, which the per-entry coordinator commits through. An entry
 * whose collections sit on different transactors cannot be one network transaction (each transactor
 * is its own storage); the queue's callers never seal such a set together, so this is a defect that
 * stops the drain rather than a failure of the entry.
 */
function sharedTransactor(entry: Entry, remaining: readonly Collection<any>[]): ITransactor {
	const transactor = remaining[0]!.transactor;
	const stranger = remaining.find(collection => collection.transactor !== transactor);
	if (stranger !== undefined) {
		throw new Error(`offline queue: entry ${entry.id} spans collections on different transactors (${remaining[0]!.id} and ${stranger.id}); an entry is one network transaction on one transactor`);
	}
	return transactor;
}

/** The journal's entry record for `entry`, built from each sealed collection's segment. */
function entryRecord(entry: Entry): JournalEntryRecord {
	return {
		id: entry.id,
		seq: entry.seq,
		queuedAt: entry.queuedAt,
		...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
		segments: entry.collections.map(collection => {
			const actions = collection.sealedActions(entry.id);
			if (actions === undefined) {
				throw new Error(`offline queue: entry ${entry.id} is not sealed in ${collection.id}, which sealPending just answered true for`);
			}
			return { collectionId: collection.id, actions };
		}),
	};
}

/**
 * The offline-sync queue (docs/offline-sync.md §Draining): an in-memory list of locally committed
 * entries, each the sealed segments one local commit left in the collections it wrote, drained one
 * at a time in queue order once the cohort can be reached.
 *
 * **One drain loop per queue, serialised.** At most one submission is on the network at a time, and
 * the loop is the only thing that removes entries' segments from the collections apart from
 * {@link discard}, whose removal runs on the same removal chain. Each iteration: park while a
 * {@link restore} holds the drain; apply the refusals {@link onSealedRefused} has collected; expire
 * what has outlived `expireAfterMs`; wait for a wake when the queue is empty; fail the head when a
 * collection already records its refusal; ask the reachability gate; submit the head —
 * `Collection.commitHead` for an entry over one collection, `TransactionCoordinator.commitEntry`
 * over several — and apply the outcome by its class (`classifyCommitFailure`). The gate and the
 * transient failures share one re-check timer, whose step a wake or a committed entry resets.
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
 * **The journal is written through at every step of an entry's life** (docs/offline-sync.md
 * §Write ordering), when one is given: {@link enqueue} writes the entry record before it admits the
 * entry, every send is preceded by the drive record (`IOfflineJournal.driving`, the write-ahead that
 * makes the identity rule survive a crash), a partial commit and an identity renewal rewrite it, and
 * each terminal status is written before it is emitted. {@link restore} is the inverse, for a journal
 * putting its records back after a restart.
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
	private readonly refuseSoloCommit: boolean;
	private readonly expireAfterMs: number | undefined;
	private readonly journal: IOfflineJournal | undefined;
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

	/** Every {@link restore} runs on this chain, one at a time, so two never hold the drain at once.
	 * Never rejects: a restore's throw reaches its own caller. */
	private restores: Promise<void> = Promise.resolve();
	/** The hold the restore in progress has on the drain, while it has one (see {@link restore}). */
	private hold: DrainHold | undefined;
	/** The entry a {@link restore} has registered and not yet admitted: listed, so the refusals its
	 * insertion reports about other entries are attributed and its `stage` can read its position, but
	 * not yet discardable.
	 * NOTE: a `discard` of ANOTHER entry chained while `stage` runs is not held back; its drops run
	 * beside the insertion, serialised per collection only by the collection latch, and a refusal of
	 * the restoring entry's already-inserted segment that such a drop's replay reports is attributed
	 * by {@link causeOf} to the entry being discarded. Fine while restores run at start-up, before an
	 * application discards anything; if that attribution ever misleads, make `discard` wait out the
	 * hold too. */
	private restoring: Entry | undefined;

	private inFlight: { readonly entry: Entry; readonly controller: AbortController } | undefined;
	private loop: Promise<void> | undefined;
	/** The loop ran and has exited (disposal, or a defect): nothing parks any more. */
	private loopStopped = false;
	/** The loop is parked on an empty queue (so `whenDrained` can answer at once). */
	private waitingForWork = false;
	private readonly drainedWaiters: Deferred<void>[] = [];
	private disposed = false;
	private disposal: Promise<void> | undefined;
	/** The error that stopped the drain (`SealedSegmentsError` out of a submission, a removal that
	 * threw): `whenDrained` rejects with it and `enqueue` refuses. */
	private defect: unknown;

	constructor(options: OfflineQueueOptions = {}) {
		this.reachability = options.reachability ?? alwaysReachable;
		this.waker = new DrainWaker(
			{ baseMs: options.recheck?.baseMs ?? DefaultRecheckBaseMs, capMs: options.recheck?.maxMs ?? DefaultRecheckMaxMs },
			options.recheck?.rand);
		this.submitOptions = options.submit;
		this.refuseSoloCommit = options.allowSoloCommit !== true;
		this.expireAfterMs = options.expireAfterMs;
		this.journal = options.journal;
		this.now = options.now ?? Date.now;
		this.unsubscribeWake = options.wakeOn?.(() => this.wake());
	}

	/**
	 * Seal each collection's open segment under a new entry, write the journal's entry record, and
	 * queue it — in that order, so an entry is never admitted that the journal does not hold
	 * (docs/offline-sync.md §Write ordering, rule 1). `undefined` when no collection had anything
	 * staged — nothing to queue, nothing sealed, nothing written (`Collection.sealPending` answers
	 * `false` and changes nothing for an empty open segment, so a sibling with nothing staged is
	 * simply not part of the entry). Emits `queued` before resolving, so a caller can attribute it to
	 * the commit it is in. Starts the drain on the first call.
	 *
	 * **A journal write that throws fails the enqueue**: every collection sealed is unsealed again, in
	 * reverse sealing order (`Collection.unseal`, which puts each segment's actions back into its open
	 * segment), nothing is registered, no status is emitted, and the journal's error is rethrown. The
	 * caller then rolls its transaction back as for any failed commit. Without a journal the write is
	 * skipped and the enqueue cannot fail this way; it is one path either way.
	 *
	 * Latch-free like `sealPending`: the caller brackets it (no act or commit of these collections is
	 * in flight, and no second enqueue of them runs until this one has resolved — the unseal on
	 * failure requires each segment to still be the newest sealed one).
	 *
	 * @throws QueueDisposedError after {@link dispose}; the drain's defect, as `cause`, once the
	 * drain has stopped on one (nothing queued then would ever drain); whatever the journal threw. */
	async enqueue(collections: readonly Collection<any>[], init?: { id?: EntryId; timestamp?: number }): Promise<QueuedEntry | undefined> {
		this.assertAccepting();
		const id = init?.id ?? mintId();
		if (this.byId.has(id)) throw new Error(`entry ${id} is already queued`);
		const sealed = collections.filter(collection => collection.sealPending(id));
		if (sealed.length === 0) return undefined;
		const queuedAt = init?.timestamp ?? this.now();
		const entry: Entry = {
			id,
			seq: this.nextSeq,
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
		// The sequence number is reserved for the write, so a restore that runs meanwhile takes a later
		// one, and handed back when the write is refused and nothing took a later one since, so a
		// refused enqueue leaves no gap in the order the journal lists.
		this.nextSeq = entry.seq + 1;
		try {
			await this.journalQueued(entry);
		} catch (err) {
			if (this.nextSeq === entry.seq + 1) this.nextSeq = entry.seq;
			throw err;
		}
		this.list.push(entry);
		this.byId.set(id, entry);
		this.emitQueued(entry);
		this.publishState();
		this.startDrain();
		return snapshot(entry);
	}

	/**
	 * Put an entry back from a journal's records after a restart (docs/offline-sync.md §Restore after
	 * a restart): the only way to register an entry whose segments `enqueue` did not seal. The entry
	 * is registered first — inserted by `seq`, so a record restored late sits ahead of entries queued
	 * since — and `stage` is then called for each of its collections, in `init.collections` order, to
	 * put the segment in place (`Collection.restoreSealed`, at the position the caller finds by
	 * reading {@link entries}) or to answer that the collection already holds the entry's recorded
	 * attempt as committed (`Collection.holdsCommitted`). What `stage` answers decides what follows:
	 *
	 * - every collection `already-committed`: the entry is settled `committed` at once, with a
	 *   durability whose every collection has an `undefined` class (the write is saved; who holds it
	 *   is unknown), the journal's `settled` written as for any commit, and no `queued` status;
	 * - some `already-committed`: those are recorded as committed with `undefined` durability and the
	 *   entry stays queued in doubt, as after a partial commit, the next submission driving the rest;
	 * - a `staged` segment `refused`: the refusal is queued for the loop's first step, which fails the
	 *   entry through the ordinary cascade (with no `causedBy`);
	 * - otherwise it is simply queued. In every case but the first, `queued` is emitted and the drain
	 *   woken, and the result is the entry as {@link entries} lists it.
	 *
	 * **The drain is held for the whole call.** The call waits until the loop is parked between
	 * iterations — not mid-submission, not mid-removal — holds it there, registers the entry, runs
	 * `stage`, and releases. A segment inserted ahead of the current head while that head's commit
	 * is on the network would fail the commit's own "head still first" assertion when it retakes the
	 * latch, and a `commitHead` that finds another segment ahead of the one it was asked for throws
	 * `SealedSegmentsError` (`not-head`), which the loop reads as a defect. A loop that is not
	 * running, or is parked on an empty queue, counts as parked at once; several restores serialise.
	 * `discard` during a restore is refused for the entry being restored (`UnknownEntryError`: it is
	 * registered but not yet admitted) and allowed for others, whose removals run on the removal
	 * chain the hold waits out before `stage` runs. A removal chained DURING `stage` runs beside it,
	 * serialised per collection by the collection latch only.
	 *
	 * **Identity.** With `init.drive`: the action id, the attempts to resume and the committed
	 * collections are taken from it, and the entry is in doubt when either map is non-empty. Without:
	 * a fresh action id, nothing retained, not in doubt.
	 *
	 * **A `stage` that throws** rolls the registration back: the entry leaves the queue, every segment
	 * `stage` already put in place is dropped (`Collection.dropSealed`), nothing is emitted, and the
	 * error is rethrown.
	 *
	 * **`dispose` during a restore.** A restore that has not started `stage` when the queue is
	 * disposed rejects with `QueueDisposedError` and releases the hold; one that has finishes its
	 * registration (the loop is stopping anyway, and an entry registered after disposal is left
	 * sealed for the application exactly like one that was queued before it).
	 *
	 * @throws QueueDisposedError after {@link dispose}; the drain's defect, as `cause`, once the
	 * drain has stopped on one; an `Error` for an id or a `seq` already queued; whatever `stage`
	 * threw. */
	restore(init: RestoreInit, stage: (collection: Collection<any>) => Promise<RestoredSegment>): Promise<QueuedEntry | undefined> {
		this.assertAccepting();
		if (this.byId.has(init.id)) throw new Error(`entry ${init.id} is already queued`);
		const run = this.restores.then(() => this.restoreHeld(init, stage));
		const settled = (): void => {};
		this.restores = run.then(settled, settled);
		return run;
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
			// NOTE: this also covers an entry `enqueue` has sealed but not yet registered (its journal
			// write is outstanding) whose segment a head commit's replay refused meanwhile. The refusal
			// stays recorded on the segment, and the loop's head check (`recordedRefusal`) fails the entry
			// once it reaches the head — later than a pending refusal would, never lost. If that delay
			// ever matters, re-check `sealedRefusal` for each collection when `enqueue` registers.
			log('offline:refusal-for-unknown-entry entry=%s error=%s', entryId, error.message);
			return;
		}
		// The first refusal reported for an entry is the one it fails with; a second collection's
		// refusal of the same entry adds nothing the application can act on separately.
		if (this.pendingRefusals.has(entryId)) return;
		this.pendingRefusals.set(entryId, { error, causedBy: this.causeOf(entry) });
		this.wake();
	};

	/**
	 * Reserve every sequence number up to and including `seq`: the next {@link enqueue} takes a higher
	 * one. For a journal that has read records it cannot put back yet (a table it cannot reach), so a
	 * transaction queued meanwhile never takes a journaled record's number — {@link restore} refuses a
	 * `seq` another queued entry holds. Never lowers the counter.
	 */
	reserveSeqThrough(seq: number): void {
		this.nextSeq = Math.max(this.nextSeq, seq + 1);
	}

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
	 * UnknownEntryError for an id not queued, or one a {@link restore} has registered but not yet
	 * admitted. */
	discard(entryId: EntryId): void {
		const entry = this.byId.get(entryId);
		if (entry === undefined || this.restoring === entry) throw new UnknownEntryError(entryId);
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
	 * on one.
	 * NOTE: a {@link restore} in progress is not waited for: on an empty queue it answers at once
	 * while the restore is about to register an entry. Fine while restores run at start-up, before
	 * anything awaits a drain; if a host ever awaits both, make this wait out the restore chain. */
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

	/** The refusal every entry point makes after {@link dispose} and once the drain has stopped on a
	 * defect: nothing queued then would ever drain. */
	private assertAccepting(): void {
		if (this.disposed) throw new QueueDisposedError();
		if (this.defect !== undefined) throw new Error('the offline queue stopped on a defect; see cause', { cause: this.defect });
	}

	/** Start the drain on the first entry; wake it for every later one. */
	private startDrain(): void {
		if (this.loop === undefined) {
			this.loop = this.drain();
		} else {
			this.wake();
		}
	}

	// ── the drain ──────────────────────────────────────────────────────────────────────────────

	private async drain(): Promise<void> {
		try {
			while (!this.disposed) {
				if (this.defect !== undefined) throw this.defect;
				await this.parkForHold();
				if (this.disposed) break;
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
		} finally {
			// Nothing parks any more: a restore waiting for the loop to park proceeds, since the loop
			// touches no entry from here on.
			this.loopStopped = true;
			this.hold?.signalParked();
		}
	}

	/** Step zero of every iteration: while a {@link restore} holds the drain, say so and wait for its
	 * release — between iterations, so no submission and no removal of the loop's is under way. */
	private async parkForHold(): Promise<void> {
		const hold = this.hold;
		if (hold === undefined) return;
		hold.signalParked();
		await hold.held;
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
		const blockIds = this.remainingCollections(entry).flatMap(gateBlockIds);
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
			await this.committed(entry, outcome.durability);
			return false;
		}
		return this.applyFailure(entry, outcome.error);
	}

	/** One submission: `commitHead` for an entry over one collection, the coordinator's per-entry
	 * slice over several — built on the transactor the remaining collections share, since a queue
	 * holds collections of whatever transactor each was opened on — each under the entry's action id
	 * and local commit time, resuming from the attempts retained under that id, and — unless the queue
	 * allows it — refusing to be committed by a lone node that knows it is not alone. */
	private async send(entry: Entry, remaining: readonly Collection<any>[], signal: AbortSignal): Promise<TransactionDurability> {
		const submit: SyncOptions = { ...this.submitOptions, signal, ...(this.refuseSoloCommit ? { refuseSoloCommit: true } : {}) };
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
		const coordinator = new TransactionCoordinator(sharedTransactor(entry, remaining),
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
	 * journal's drive record goes first, with the attempts about to go beside the ones already
	 * retained (docs/offline-sync.md §Write ordering, rule 2); a throw out of it aborts the cycle with
	 * nothing sent (both drivers promise that), so an attempt it refused is neither retained nor a
	 * reason for doubt — the entry stays discardable, and `resume` on the next drive names only
	 * attempts that may have landed. */
	private async recordAttempts(entry: Entry, attempts: ReadonlyMap<CollectionId, InFlightAttempt>): Promise<void> {
		try {
			await this.journal?.driving(entry.id, driveState(entry, attempts));
		} catch (err) {
			log('offline:journal-write-failed entry=%s action=%s step=send error=%s', entry.id, entry.actionId, describe(err));
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
	 * answer, beside what earlier partial commits committed. The journal hears the status first
	 * (docs/offline-sync.md §Write ordering, rule 3). */
	private async committed(entry: Entry, written?: TransactionDurability): Promise<void> {
		this.claimRemoval(entry);
		this.pendingRefusals.delete(entry.id);
		entry.retained.clear();
		entry.inDoubt = false;
		const status: JournalSettledStatus = { kind: 'committed', entryId: entry.id, durability: entryDurability(entry, written) };
		await this.journalSettled(status);
		this.emit(status);
		this.waker.resetBackoff();
		this.publishState();
	}

	/**
	 * Apply a failed submission by its class (docs/offline-sync.md §Classifying an attempt's outcome):
	 *
	 * | class | transition |
	 * |---|---|
	 * | the journal's write-ahead threw | `queued`, `backoff` — nothing was sent |
	 * | `ActionRefusedError` thrown directly (the head's recorded refusal) | `failed`, `refusalReason` |
	 * | `cohort-unreachable` | `queued`, `cohort`; the timer re-checks the gate |
	 * | `contention`, `expired`, `in-doubt`, `unknown` | `queued`, `backoff`; `unknown` is also logged and counted |
	 * | `guard-refused`, `rejected`, `too-large` | `failed`, with the class's reason |
	 * | `torn-not-saved` | `queued`, `backoff`; doubt cleared (unless part of the entry is committed), a fresh action id, retained attempts cleared, the drive record rewritten |
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
				await this.journalDriving(entry, 'renewal');
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
	 * neither discarded nor expired. The journal's drive record is rewritten once the entry's state is
	 * settled — after a renewal too, so one write carries both — and `partially-committed` is emitted
	 * in place of the `queued` status this transition would otherwise report.
	 *
	 * @returns whether the entry stays queued: `false` only when no collection still holds its segment
	 * (the failure came after every collection was saved), which settles it committed. */
	private async partiallyCommitted(entry: Entry, error: CoordinatorPartialCommitError): Promise<boolean> {
		for (const [collectionId, durability] of error.durability.collections) {
			recordCollectionDurability(entry.committed, collectionId, durability);
			entry.retained.delete(collectionId);
		}
		entry.inDoubt = true;
		const pending = this.remainingCollections(entry).map(collection => collection.id);
		if (pending.length === 0) {
			await this.committed(entry);
			return false;
		}
		// The coordinator reports any failure after a saved participant as a partial commit, so the
		// rest may have failed `torn-not-saved`; re-driving it under the same id would only meet that
		// stranded entry again.
		if (classifyCommitFailure(error.reason).kind === 'torn-not-saved') this.renewIdentity(entry);
		await this.journalDriving(entry, 'partial-commit');
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
	 * entry's committed half keeps the old id; only the remainder commits under the new one. The
	 * caller writes the journal's drive record afterwards ({@link journalDriving}). */
	private renewIdentity(entry: Entry): void {
		entry.actionId = mintId();
		entry.retained.clear();
	}

	// ── the journal ────────────────────────────────────────────────────────────────────────────

	/** Rule 1 of docs/offline-sync.md §Write ordering: the entry record, before the entry is admitted.
	 * On a throw every collection sealed is unsealed, in reverse sealing order, and the error
	 * rethrown — nothing is queued. */
	private async journalQueued(entry: Entry): Promise<void> {
		if (this.journal === undefined) return;
		try {
			await this.journal.queued(entryRecord(entry));
		} catch (err) {
			for (const collection of [...entry.collections].reverse()) {
				collection.unseal(entry.id);
			}
			log('offline:journal-write-failed entry=%s step=queued error=%s: the enqueue fails and nothing is queued', entry.id, describe(err));
			throw err;
		}
	}

	/** The drive record after a partial commit or an identity renewal (rules 2 and 4 of
	 * docs/offline-sync.md §Write ordering). A throw is logged and the drain goes on: the entry stays
	 * at the head in doubt either way, and the next send's write-ahead repeats the state. The write
	 * before a send is {@link recordAttempts}', whose throw aborts the send. */
	private async journalDriving(entry: Entry, step: 'partial-commit' | 'renewal'): Promise<void> {
		try {
			await this.journal?.driving(entry.id, driveState(entry));
		} catch (err) {
			log('offline:journal-write-failed entry=%s action=%s step=%s error=%s: the drain goes on; the next send rewrites the record',
				entry.id, entry.actionId, step, describe(err));
		}
	}

	/** Rule 3 of docs/offline-sync.md §Write ordering: the terminal status, before it is emitted. A
	 * throw is logged and swallowed here, never where the outcome was decided: the network has the
	 * write, or the segments are gone, and a stale record is what the restore after a restart
	 * resolves. */
	private async journalSettled(status: JournalSettledStatus): Promise<void> {
		try {
			await this.journal?.settled(status);
		} catch (err) {
			log('offline:journal-write-failed entry=%s step=settled error=%s: the outcome stands; a restart resolves the stale record',
				status.entryId, describe(err));
		}
	}

	// ── restoring ──────────────────────────────────────────────────────────────────────────────
	// NOTE: this file is near 1300 lines (`wc -l`). The restore machinery below (the hold, the
	// registration by seq, the staging and its rollback) reads and writes the queue's private state
	// directly, which is why it stays here; if the file grows again, it is the section to extract
	// behind a small interface over `list`, `byId` and the hold.

	/** One {@link restore}, run on the restore chain: take the hold, wait for the loop to park and the
	 * removal chain to drain, register, stage, admit, release. */
	private async restoreHeld(init: RestoreInit, stage: (collection: Collection<any>) => Promise<RestoredSegment>): Promise<QueuedEntry | undefined> {
		const hold = this.takeHold();
		try {
			await hold.parked;
			await this.settledRemovals();
			this.assertAccepting();
			const entry = this.registerRestored(init);
			this.restoring = entry;
			let outcomes: Map<CollectionId, RestoredSegment>;
			try {
				outcomes = await this.stageRestored(entry, stage);
			} finally {
				this.restoring = undefined;
			}
			return await this.admitRestored(entry, outcomes);
		} finally {
			this.releaseHold(hold);
		}
	}

	/** Hold the drain: the loop parks at the top of its next iteration. A loop that is not running
	 * (never started, or stopped) or is parked on an empty queue is parked already; one waiting out
	 * the re-check timer is woken so it reaches the hold without waiting the timer out. */
	private takeHold(): DrainHold {
		let release!: () => void;
		let signalParked!: () => void;
		const held = new Promise<void>(resolve => { release = resolve; });
		const parked = new Promise<void>(resolve => { signalParked = resolve; });
		const hold: DrainHold = { held, release, parked, signalParked };
		this.hold = hold;
		if (this.loop === undefined || this.loopStopped || this.waitingForWork) {
			signalParked();
		} else {
			this.wake();
		}
		return hold;
	}

	/** Release the hold and wake the loop, which goes on from the top of the iteration it parked in. */
	private releaseHold(hold: DrainHold): void {
		if (this.hold === hold) this.hold = undefined;
		hold.release();
		if (this.loop !== undefined) this.wake();
	}

	/** Register a restored entry: built from the record and the drive state, inserted by `seq`, with
	 * `waitingFor` set by position and `nextSeq` raised past it. */
	private registerRestored(init: RestoreInit): Entry {
		if (this.byId.has(init.id)) throw new Error(`entry ${init.id} is already queued`);
		if (this.list.some(queued => queued.seq === init.seq)) {
			throw new Error(`entry ${init.id} cannot be restored at seq ${init.seq}, which another queued entry holds`);
		}
		const drive = init.drive;
		const entry: Entry = {
			id: init.id,
			seq: init.seq,
			queuedAt: init.queuedAt,
			expiresAt: init.expiresAt,
			collections: init.collections,
			actionId: drive?.actionId ?? mintId(),
			// The count of submissions is not journaled. A drive record is written only ahead of a send,
			// so one proves at least one submission was made; it is reported as exactly one, the least
			// that is true, rather than invented.
			attempts: drive === undefined ? 0 : 1,
			inDoubt: drive !== undefined && (drive.attempts.size > 0 || drive.committed.size > 0),
			retained: new Map(drive?.attempts),
			committed: new Map(drive?.committed),
			phase: 'queued',
			waitingFor: undefined,
			lastError: undefined,
			lastQueued: undefined,
			expiryDeferredLogged: false,
		};
		this.insertBySeq(entry);
		this.byId.set(entry.id, entry);
		this.nextSeq = Math.max(this.nextSeq, entry.seq + 1);
		return entry;
	}

	/** Insert `entry` into the list by `seq` and re-derive every entry's "waiting for an earlier
	 * entry" flag from its position: the head waits for no earlier entry, every other entry does. */
	private insertBySeq(entry: Entry): void {
		const index = this.list.findIndex(queued => queued.seq > entry.seq);
		this.list.splice(index < 0 ? this.list.length : index, 0, entry);
		this.list.forEach((queued, position) => {
			if (position === 0) {
				if (queued.waitingFor === 'earlier-entry') queued.waitingFor = undefined;
			} else {
				queued.waitingFor = 'earlier-entry';
			}
		});
	}

	/** Run `stage` for each of the entry's collections, in order; on a throw, roll the registration
	 * back — the entry leaves the queue and every segment already staged is dropped — and rethrow. */
	private async stageRestored(entry: Entry, stage: (collection: Collection<any>) => Promise<RestoredSegment>): Promise<Map<CollectionId, RestoredSegment>> {
		const outcomes = new Map<CollectionId, RestoredSegment>();
		try {
			for (const collection of entry.collections) {
				outcomes.set(collection.id, await stage(collection));
			}
		} catch (err) {
			await this.unregisterRestored(entry, outcomes);
			throw err;
		}
		return outcomes;
	}

	/** The rollback of a restore whose `stage` threw: the entry leaves the queue, and each segment
	 * `stage` put in place is dropped — every one, a drop that throws being logged, since the stage's
	 * own error is the one the caller hears. */
	private async unregisterRestored(entry: Entry, outcomes: ReadonlyMap<CollectionId, RestoredSegment>): Promise<void> {
		this.claimRemoval(entry);
		this.pendingRefusals.delete(entry.id);
		for (const collection of entry.collections) {
			if (outcomes.get(collection.id)?.kind !== 'staged' || !collection.sealedEntries().includes(entry.id)) continue;
			try {
				await collection.dropSealed(entry.id);
			} catch (err) {
				log('offline:restore-rollback-drop-failed entry=%s collection=%s error=%s', entry.id, collection.id, describe(err));
			}
		}
	}

	/** Admit a registered entry by what `stage` answered (see {@link restore}). */
	private async admitRestored(entry: Entry, outcomes: ReadonlyMap<CollectionId, RestoredSegment>): Promise<QueuedEntry | undefined> {
		let staged = 0;
		for (const [collectionId, outcome] of outcomes) {
			if (outcome.kind === 'already-committed') {
				// A class the drive record knew is kept; one it did not is unknown, not fabricated.
				if (!entry.committed.has(collectionId)) entry.committed.set(collectionId, undefined);
				entry.inDoubt = true;
				continue;
			}
			staged++;
			if (outcome.refused !== undefined && !this.pendingRefusals.has(entry.id)) {
				this.pendingRefusals.set(entry.id, { error: outcome.refused, causedBy: undefined });
			}
		}
		if (staged === 0) {
			log('offline:restored-already-committed entry=%s action=%s collections=%o', entry.id, entry.actionId, [...outcomes.keys()]);
			// Every collection is in `entry.committed` by now, each with the class the drive record knew
			// or none; nothing new was written, so nothing is merged over them.
			await this.committed(entry);
			return undefined;
		}
		this.emitQueued(entry);
		this.publishState();
		this.startDrain();
		return snapshot(entry);
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
	 * committed whatever triggered the failure — the journal hearing the status first. Each drop
	 * replays and may report refusals of later entries through {@link onSealedRefused}, which
	 * {@link causeOf} attributes while `removing` names this entry. */
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
		const status: JournalSettledStatus = {
			kind: 'failed',
			entryId: entry.id,
			reason,
			error,
			changedCollections,
			...(causedBy === undefined ? {} : { causedBy }),
			...committedField(entry),
		};
		await this.journalSettled(status);
		this.emit(status);
		this.publishState();
	}

	/**
	 * Which earlier entry a refusal of `entry` is attributed to: the nearest one, in queue order, that
	 * is being removed right now or already has a refusal pending; `undefined` when there is none (a
	 * rival's commit refused the entry directly, found by a reader's refresh — or a restore's
	 * insertion did, which removes nothing).
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
