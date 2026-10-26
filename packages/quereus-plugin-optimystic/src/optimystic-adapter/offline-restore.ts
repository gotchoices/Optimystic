import { BlockUnavailableError, EntryDiscardedError, EntryNotDiscardableError, QueueDisposedError } from '@optimystic/db-core';
import type {
	Collection, CollectionId, InFlightAttempt, JournalDriveState, JournalSettledStatus, OfflineQueue, RestoreInit, RestoredSegment,
} from '@optimystic/db-core';
import {
	decodeDriveRecord, decodeEntryRecord, decodeOutcome, decodeOutcomeRecord, seqKey,
	type DriveRecordV1, type EntryRecordV1, type JournaledSegment, type OfflineJournal, type RetainedOutcome, type ScannedRecord,
} from './offline-journal.js';
import { qualifiedTableName, type QualifiedTableName } from '../schema/table-identity.js';
import { createLogger } from '../logger.js';

const log = createLogger('offline-restore');

/**
 * Why a journaled transaction is not back in the queue yet (docs/offline-sync.md §Restore after a
 * restart): a table it wrote is not in the engine's catalog (`table-missing`: dropped by another
 * machine while this one was down, or not yet declared by a host that restores before `apply
 * schema`); initializing or opening the table threw `BlockUnavailableError` (`unreadable`: its base
 * blocks cannot be read, since this machine never held them and the cohort cannot be reached); the
 * record names a collection the table no longer backs (`collection-mismatch`: re-declared over
 * another URI while down); or an earlier record is deferred for one of those (`behind-deferred`), and
 * the queue keeps its order.
 */
export type DeferredReason = 'table-missing' | 'unreadable' | 'collection-mismatch' | 'behind-deferred';

/** One journaled transaction the restore has read and not yet put back. */
export interface DeferredRecord {
	readonly transactionId: string;
	readonly seq: number;
	readonly queuedAt: number;
	/** `schema.table` of each table the transaction wrote, each once, in segment order. */
	readonly tables: readonly string[];
	readonly reason: DeferredReason;
	/** The table the pass stopped at — for `behind-deferred`, the stopping record's. */
	readonly table: string;
	/** As the queue would report it: a drive record with attempts or committed collections was written,
	 * so a send may have landed. Such a record is not discardable. */
	readonly inDoubt: boolean;
	/** 1 when a drive record exists (a send was at least begun), else 0, as `OfflineQueue.restore` counts. */
	readonly attempts: 0 | 1;
}

/** What the restore asks of its owner, `OfflineMode`. */
export interface RestoreHost {
	readonly queue: OfflineQueue;
	readonly journal: OfflineJournal;
	readonly outcomeRetentionMs: number;
	now(): number;
	/** Whether a transaction is open on the bridge: a pass refuses to run inside one. */
	transactionOpen(): boolean;
	/** The collections `table` backs — its main tree and its index trees — after initializing it
	 * (`OptimysticModule.collectionsOfTable`); `undefined` when the engine's catalog does not know it. */
	collectionsOfTable(table: QualifiedTableName): Promise<readonly Collection<any>[] | undefined>;
	/** An outcome record read back: retain it for `outcomes()` and `status()`. */
	retainOutcome(outcome: RetainedOutcome): void;
	/** A terminal status the restore settled itself (a deferred record discarded), to report as the queue's. */
	emitSettled(status: JournalSettledStatus): void;
}

type RestoreOutcome = { kind: 'restored' } | { kind: 'deferred'; reason: Exclude<DeferredReason, 'behind-deferred'>; table: string };
type ResolvedCollections = { kind: 'resolved'; collections: Collection<any>[] } | Extract<RestoreOutcome, { kind: 'deferred' }>;
type Waiter = { resolve: () => void; reject: (error: unknown) => void };

const openTransactionMessage = 'offline restore: a transaction is open on this Database; the restore runs only between transactions, since the open segment of each collection belongs to the transaction';

/**
 * Puts journaled transactions back in the queue after a restart (docs/offline-sync.md §Restore after
 * a restart), through `OfflineQueue.restore`. One pass reads every record under the journal's label
 * once and walks the entry records in queue order: a record whose transaction has an outcome record
 * is settled and its records deleted; one the queue already holds is skipped; otherwise each table it
 * names is initialized to reach the collection, and the entry is put back — a collection that already
 * holds the recorded attempt committed answers so, the rest re-stage their segments ahead of every
 * entry queued since. A record whose table cannot be reached is **deferred** ({@link DeferredReason}),
 * and the pass stops there: it and every record after it stay journaled, listed by the controller as
 * `queued` with `waitingFor: 'restore'`, and another pass retries them — on every `restore()` call,
 * when a deferred table's vtab initializes or a live refresh of it reaches the cohort
 * ({@link wantsRetryFor}), and from the queue's reachability gate while anything is deferred, so the
 * queue's re-check timer is also the restore's. A record of an unknown version stops the pass with
 * {@link OfflineJournalError}, nothing dropped; any other error out of a table's initialization
 * propagates out of the pass, since a corrupt catalog or a programming error is no reason to wait.
 *
 * Passes run one at a time; a pass requested while one runs starts after it (one such pass at most
 * is pending at a time, and later requests join it). A pass refuses to run while a transaction is
 * open on the bridge: `Collection.restoreSealed` refuses over a non-empty open segment for the same
 * reason — the segment belongs to that transaction.
 */
export class OfflineRestore {
	/** The records the last pass left unrestored, by transaction id. */
	private deferred = new Map<string, DeferredRecord>();
	/** The record a pass is putting back right now: still listed as deferred, but a trigger for its
	 * table schedules nothing, since this pass is the retry. */
	private attempting: string | undefined;
	/** Ids whose discard is settling; a pass skips their records until the deletes are done. */
	private readonly discarding = new Set<string>();
	/** Passes and discard settlements, one at a time. Never rejects. */
	private chain: Promise<void> = Promise.resolve();
	/** The pass chained and not yet started; a request before it starts gets the same one. */
	private pendingPass: Promise<void> | undefined;
	/** Passes and settlements running or pending. */
	private active = 0;
	private readonly changeWaiters: Waiter[] = [];
	/** Records whose `offline:restore-stuck` line was logged. */
	private readonly stuckLogged = new Set<string>();
	private disposed = false;

	constructor(private readonly host: RestoreHost) {}

	/** Run a pass; resolves when it has finished. Rejects with the pass's error. */
	run(): Promise<void> {
		if (this.disposed) return Promise.reject(new QueueDisposedError());
		if (this.pendingPass !== undefined) return this.pendingPass;
		const pass = this.chained(() => {
			this.pendingPass = undefined;
			return this.pass();
		});
		this.pendingPass = pass;
		return pass;
	}

	/** The deferred records, oldest first. */
	records(): DeferredRecord[] {
		return [...this.deferred.values()].sort((a, b) => a.seq - b.seq);
	}

	find(transactionId: string): DeferredRecord | undefined {
		return this.deferred.get(transactionId);
	}

	hasDeferred(): boolean {
		return this.deferred.size > 0;
	}

	/** A record is deferred, or a discarded one is still being settled: what counts as queued for the
	 * bridge's routing and the DDL gate. */
	holdsRecords(): boolean {
		return this.deferred.size > 0 || this.discarding.size > 0;
	}

	/** Whether a deferred record wrote the table named `schema.table`. */
	isDeferredTable(name: string): boolean {
		for (const record of this.deferred.values()) {
			if (record.tables.includes(name)) return true;
		}
		return false;
	}

	/** Whether a pass should run because the table named `schema.table` became readable: a deferred
	 * record other than the one being put back right now wrote it. */
	wantsRetryFor(name: string): boolean {
		for (const record of this.deferred.values()) {
			if (record.transactionId !== this.attempting && record.tables.includes(name)) return true;
		}
		return false;
	}

	/** Nothing deferred, nothing running or pending: what `whenDrained` needs beside an empty queue. */
	settled(): boolean {
		return this.deferred.size === 0 && this.active === 0 && this.discarding.size === 0;
	}

	/** Resolves when the deferred set changes, a pass ends or a discard settles; rejects with
	 * `QueueDisposedError` on {@link dispose}. */
	whenChanged(): Promise<void> {
		if (this.disposed) return Promise.reject(new QueueDisposedError());
		return new Promise((resolve, reject) => { this.changeWaiters.push({ resolve, reject }); });
	}

	/**
	 * Withdraw a deferred record: its records are deleted and it fails with reason `discarded`, with
	 * empty `changedCollections` (nothing was staged, so nothing is announced). Answers `false` for an id
	 * that is not deferred, so the caller can throw its own `UnknownEntryError`.
	 * @throws EntryNotDiscardableError for a record in doubt: a change the network may hold is not
	 * withdrawn on this machine's say-so, as for a queued entry.
	 */
	discard(transactionId: string): boolean {
		const record = this.deferred.get(transactionId);
		if (record === undefined) return false;
		// NOTE: accepted tradeoff — an in-doubt record whose table was dropped while this machine was
		// down is stuck: its table will not come back, and this refusal keeps it from being withdrawn,
		// so it stays listed `waitingFor: 'restore'` until the table exists again or the record is
		// removed from the store by hand (`offline:restore-stuck` names it once). Simplicity weighed
		// over resolving the attempt without the table; revisit if it is ever hit in the field, by
		// teaching the restore to settle the attempt from the collection's log without the table.
		if (record.inDoubt) throw new EntryNotDiscardableError(transactionId, 'in-doubt');
		this.deferred.delete(transactionId);
		this.discarding.add(transactionId);
		const status: JournalSettledStatus = {
			kind: 'failed',
			entryId: transactionId,
			reason: 'discarded',
			error: new EntryDiscardedError(transactionId),
			changedCollections: [],
		};
		this.chained(() => this.settleDiscarded(record, status))
			.catch(error => log('offline:restore-discard-failed transaction=%s: %o', transactionId, error));
		return true;
	}

	/** Stop: a pass finishes the record it is on and goes no further; resolves once nothing runs. */
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.chain;
		const error = new QueueDisposedError();
		for (const waiter of this.changeWaiters.splice(0)) waiter.reject(error);
	}

	/** Run `step` after everything chained before it; the chain itself never rejects. */
	private chained(step: () => Promise<void>): Promise<void> {
		this.active++;
		const run = this.chain.then(step);
		const done = (): void => {
			this.active--;
			this.notifyChanged();
		};
		this.chain = run.then(done, done);
		return run;
	}

	private notifyChanged(): void {
		for (const waiter of this.changeWaiters.splice(0)) waiter.resolve();
	}

	// ── the pass ───────────────────────────────────────────────────────────────────────────────

	private async pass(): Promise<void> {
		if (this.disposed) return;
		if (this.host.transactionOpen()) throw new Error(openTransactionMessage);
		const scan = await this.host.journal.scan();
		// Before anything is put back: a transaction queued meanwhile must not take a journaled record's
		// number, since `OfflineQueue.restore` refuses one another queued entry holds.
		this.host.queue.reserveSeqThrough(highestSeq(scan.entries, this.host.journal.keys.entries));
		const settled = await this.loadOutcomes(scan.outcomes);
		const next = new Map<string, DeferredRecord>();
		const handled = new Set<string>();
		let completed = false;
		try {
			await this.walk(scan.entries, scan.drives, settled, next, handled);
			completed = true;
		} finally {
			if (completed) {
				this.deferred = next;
			} else {
				// A pass that threw leaves the records it did not reach as the last pass left them.
				for (const id of handled) this.deferred.delete(id);
				for (const [id, record] of next) this.deferred.set(id, record);
			}
			this.notifyChanged();
		}
	}

	/** The entry records in queue order: settle, skip, put back or defer each, until one is deferred;
	 * every record after that one is listed behind it. */
	private async walk(
		entries: readonly ScannedRecord[], drives: ReadonlyMap<string, ScannedRecord>, settled: ReadonlySet<string>,
		next: Map<string, DeferredRecord>, handled: Set<string>,
	): Promise<void> {
		let stoppedAt: DeferredRecord | undefined;
		for (const raw of entries) {
			if (this.disposed) return;
			const entry = decodeEntryRecord(raw);
			const driveRaw = drives.get(seqKey(entry.seq));
			const drive = driveRaw === undefined ? undefined : decodeDriveRecord(driveRaw);
			const id = entry.transactionId;
			if (this.discarding.has(id)) continue;
			if (this.host.queue.status(id) !== undefined) {
				handled.add(id);
				continue;
			}
			if (settled.has(id)) {
				await this.host.journal.deleteRecords(entry.seq);
				log('offline:restore-settled-record transaction=%s seq=%d: its outcome record exists, so nothing is put back and its entry and drive records are deleted', id, entry.seq);
				handled.add(id);
				continue;
			}
			if (stoppedAt !== undefined) {
				next.set(id, deferredRecord(entry, drive, 'behind-deferred', stoppedAt.table));
				continue;
			}
			const outcome = await this.attempt(entry, drive);
			if (outcome.kind === 'restored') {
				handled.add(id);
				continue;
			}
			const record = deferredRecord(entry, drive, outcome.reason, outcome.table);
			stoppedAt = record;
			next.set(id, record);
			log('offline:restore-deferred transaction=%s seq=%d table=%s reason=%s: it and every later record stay journaled until the table can be read',
				id, entry.seq, record.table, record.reason);
			if (record.inDoubt && record.reason === 'table-missing' && !this.stuckLogged.has(id)) {
				this.stuckLogged.add(id);
				log('offline:restore-stuck transaction=%s table=%s: in doubt and its table is gone; it stays until the table exists again or the record is removed by hand', id, record.table);
			}
		}
	}

	/** Put one record back, naming it as the one being put back meanwhile ({@link attempting}). */
	private async attempt(entry: EntryRecordV1, drive: DriveRecordV1 | undefined): Promise<RestoreOutcome> {
		this.attempting = entry.transactionId;
		try {
			return await this.restoreOne(entry, drive);
		} finally {
			this.attempting = undefined;
		}
	}

	/**
	 * Resolve the record's collections and put the entry back through `OfflineQueue.restore`. A
	 * `BlockUnavailableError` out of a table's initialization, or out of a segment's replay (the queue
	 * then rolls the registration back), defers the record; any other error propagates.
	 */
	private async restoreOne(entry: EntryRecordV1, drive: DriveRecordV1 | undefined): Promise<RestoreOutcome> {
		const resolved = await this.resolveCollections(entry);
		if (resolved.kind === 'deferred') return resolved;
		const segments = new Map(entry.segments.map(segment => [segment.collectionId, segment]));
		const init: RestoreInit = {
			id: entry.transactionId,
			seq: entry.seq,
			queuedAt: entry.queuedAt,
			...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
			collections: resolved.collections,
			...(drive === undefined ? {} : { drive: driveStateOf(drive) }),
		};
		// Before the queue can drive it: its first drive record, or the settlement of an entry whose every
		// collection already holds its attempt, is keyed by this sequence number.
		this.host.journal.adopt(entry.transactionId, entry.seq);
		let staging: JournaledSegment | undefined;
		try {
			await this.host.queue.restore(init, collection => {
				staging = segments.get(collection.id)!;
				return this.stage(entry, drive, staging, collection);
			});
		} catch (error) {
			if (unavailableIn(error) === undefined) throw error;
			return { kind: 'deferred', reason: 'unreadable', table: qualifiedTableName((staging ?? entry.segments[0]!).table) };
		}
		return { kind: 'restored' };
	}

	/** Each segment's table initialized, and its collection found among the table's. */
	private async resolveCollections(entry: EntryRecordV1): Promise<ResolvedCollections> {
		const collections: Collection<any>[] = [];
		for (const segment of entry.segments) {
			const table = qualifiedTableName(segment.table);
			let backing: readonly Collection<any>[] | undefined;
			try {
				backing = await this.host.collectionsOfTable(segment.table);
			} catch (error) {
				if (unavailableIn(error) === undefined) throw error;
				return { kind: 'deferred', reason: 'unreadable', table };
			}
			if (backing === undefined) return { kind: 'deferred', reason: 'table-missing', table };
			const collection = backing.find(candidate => candidate.id === segment.collectionId);
			if (collection === undefined) {
				log('offline:restore-collection-mismatch transaction=%s table=%s collection=%s backs=%o: the table was re-declared over another collection while this machine was down',
					entry.transactionId, table, segment.collectionId, backing.map(candidate => candidate.id));
				return { kind: 'deferred', reason: 'collection-mismatch', table };
			}
			collections.push(collection);
		}
		return { kind: 'resolved', collections };
	}

	/**
	 * The queue's `stage` callback for one collection: already committed when the collection holds the
	 * attempt the drive record names for it (`Collection.holdsCommitted`), or when the drive record lists
	 * it among the committed; otherwise the segment is inserted ahead of the first later queued entry
	 * still sealed in the collection, or last.
	 */
	private async stage(entry: EntryRecordV1, drive: DriveRecordV1 | undefined, segment: JournaledSegment, collection: Collection<any>): Promise<RestoredSegment> {
		const attempt = drive?.attempts.find(([id]) => id === collection.id)?.[1];
		if (attempt !== undefined && collection.holdsCommitted({ actionId: attempt.actionId, rev: attempt.rev })) {
			return { kind: 'already-committed' };
		}
		if (drive?.committed.some(([id]) => id === collection.id)) return { kind: 'already-committed' };
		const refused = await collection.restoreSealed(entry.transactionId, segment.actions, this.positionOf(entry.seq, collection));
		return refused === undefined ? { kind: 'staged' } : { kind: 'staged', refused };
	}

	/** Where the segment goes in `collection`'s sealed list: ahead of the first entry queued after
	 * `seq` whose segment the collection still holds, or last. */
	private positionOf(seq: number, collection: Collection<any>): { before: string } | 'last' {
		const sealed = new Set(collection.sealedEntries());
		const later = this.host.queue.entries().find(queued => queued.seq > seq && sealed.has(queued.id));
		return later === undefined ? 'last' : { before: later.id };
	}

	/**
	 * Load every outcome record: a record inside the retention window is retained, one past it is
	 * deleted. Answers the transaction ids with an outcome record — settled whichever side of the
	 * window they fall, so their entry records are deleted rather than put back.
	 */
	private async loadOutcomes(records: readonly ScannedRecord[]): Promise<Set<string>> {
		const settled = new Set<string>();
		const cutoff = this.host.now() - this.host.outcomeRetentionMs;
		for (const raw of records) {
			const record = decodeOutcomeRecord(raw);
			settled.add(record.status.transactionId);
			if (record.at <= cutoff) {
				await this.host.journal.deleteOutcome(record.status.transactionId);
				continue;
			}
			this.host.retainOutcome({ at: record.at, status: decodeOutcome(record.status) });
		}
		return settled;
	}

	/** Write the discarded record's outcome (which deletes its other records) and report the status. */
	private async settleDiscarded(record: DeferredRecord, status: JournalSettledStatus): Promise<void> {
		try {
			this.host.journal.adopt(record.transactionId, record.seq);
			try {
				await this.host.journal.settled(status);
			} catch (error) {
				log('offline:journal-write-failed step=settled transaction=%s: %o', record.transactionId, error);
			}
			this.host.emitSettled(status);
		} finally {
			this.discarding.delete(record.transactionId);
		}
	}
}

function deferredRecord(entry: EntryRecordV1, drive: DriveRecordV1 | undefined, reason: DeferredReason, table: string): DeferredRecord {
	return {
		transactionId: entry.transactionId,
		seq: entry.seq,
		queuedAt: entry.queuedAt,
		tables: [...new Set(entry.segments.map(segment => qualifiedTableName(segment.table)))],
		reason,
		table,
		inDoubt: drive !== undefined && (drive.attempts.length > 0 || drive.committed.length > 0),
		attempts: drive === undefined ? 0 : 1,
	};
}

function driveStateOf(drive: DriveRecordV1): JournalDriveState {
	return {
		actionId: drive.actionId,
		attempts: new Map<CollectionId, InFlightAttempt>(drive.attempts),
		committed: new Map(drive.committed.map(([id, durability]) => [id, durability ?? undefined])),
	};
}

/** The highest `seq` any listed entry record carries, read off the keys (so a record this build
 * cannot decode still reserves its number); 0 with none. */
function highestSeq(entries: readonly ScannedRecord[], prefix: string): number {
	let highest = 0;
	for (const { key } of entries) {
		const seq = Number(key.slice(prefix.length));
		if (Number.isFinite(seq) && seq > highest) highest = seq;
	}
	return highest;
}

/** The `BlockUnavailableError` along `error`'s `cause` chain, if any: a table's initialization wraps
 * the one its collection's open threw. */
function unavailableIn(error: unknown): BlockUnavailableError | undefined {
	for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
		if (cause instanceof BlockUnavailableError) return cause;
	}
	return undefined;
}
