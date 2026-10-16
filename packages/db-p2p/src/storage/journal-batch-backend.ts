import type { ActionId, BlockId } from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import type { BatchBackend, BatchEntry, StoreKey } from './batch-backend.js';
import type { StoreDurability } from './store-durability.js';
import type { StoreIdentity } from './store-identity.js';
import { SyncDeadlines, type SyncCover } from './sync-deadlines.js';
import { StoreFailedError, type CommittedBatch, type SetTimer, type SinkCommitOptions } from './write-group.js';

const log = createLogger('journal');

/** One write group recorded ahead of being applied. `seq` counts up from 1 with no gaps. */
export interface JournalRecord {
	readonly seq: number;
	readonly entries: readonly BatchEntry[];
}

/** What {@link JournalStore.readJournal} answers. */
export interface JournalContents {
	/** The applied-through mark: the highest `seq` an apply has applied, 0 when none has. */
	readonly appliedThrough: number;
	/** Every journal record present, ascending by `seq`. */
	readonly records: readonly JournalRecord[];
}

/**
 * The engine under a {@link JournalBatchBackend}: the applied stores' reads, as `BatchBackend`'s,
 * and three journal writes in place of its `commit` and `sync`. The journal — the numbered records
 * and the applied-through mark — lives in a keyspace of the engine's own (an IndexedDB object
 * store, a LevelDB tag byte) that the six block-storage stores never touch, and reads never reflect
 * a record until an apply has applied it. `durability` says what an apply survives before it
 * resolves: `'power-loss'` for an engine that syncs the apply; anything less, and the backend
 * applies every group at once and never journals, since applying already meets all the store can
 * promise.
 */
export interface JournalStore extends Omit<BatchBackend, 'commit' | 'sync'> {
	/**
	 * One atomic write that survives a crash of this process: store `record` in the journal under
	 * its `seq`, unsynced. Not applied: reads do not reflect it.
	 */
	appendJournal(record: JournalRecord): Promise<void>;
	/**
	 * One atomic write that, before it resolves, survives every crash `durability` names: apply each
	 * record's entries in the order given (a put stores the value, a delete removes the key), set the
	 * applied-through mark to `appliedThrough`, and delete the journal records numbered in `apply`
	 * and in `discard` — a number with no record present (a strict group's, which is never appended)
	 * is nothing to delete. The write carries every byte it applies, so its durability depends on no
	 * earlier write. A rejection is a storage fault: the backend latches failed on it.
	 */
	applyJournal(apply: readonly JournalRecord[], appliedThrough: number, discard: readonly number[]): Promise<void>;
	/**
	 * The applied-through mark and every journal record present, ascending by `seq`. A record the
	 * store cannot decode is left out, and recovery treats its number as missing.
	 */
	readJournal(): Promise<JournalContents>;
}

export interface JournalBatchBackendOptions {
	/** Arms the deadline timer; defaults to an unref'd `setTimeout`, so a held group never keeps a process alive. Injected by tests. */
	setTimer?: SetTimer;
	/** The clock deadlines are counted on; `Date.now` by default. Injected by tests. */
	now?: () => number;
}

/** What an open does with what `readJournal` returned; see {@link planRecovery}. */
interface RecoveryPlan {
	/** The run of consecutive records after the mark, to apply in order. */
	readonly apply: readonly JournalRecord[];
	/** The mark after the apply: the last of the run, or the mark as read when the run is empty. */
	readonly appliedThrough: number;
	/** Records to delete without applying: stale ones at or below the mark, and every one after the first gap. */
	readonly discard: readonly number[];
	/** How many of {@link discard} were stale. */
	readonly stale: number;
	/** Set when a number was missing: which one, and how many records after it were discarded. */
	readonly gap?: { readonly missing: number; readonly discarded: number };
}

/**
 * Records at or below the mark are stale — an apply deleted them in the write that set the mark,
 * so they exist only if the store lost part of that write. After the mark, the run `mark + 1,
 * mark + 2, …` with no gap is applied, and every record from the first missing number on is
 * discarded: a lost record is a lost group, and no group after it may survive it (rule 3 of the
 * flush contract on `RawStoreDriver.flush`).
 */
function planRecovery(appliedThrough: number, records: readonly JournalRecord[]): RecoveryPlan {
	const apply: JournalRecord[] = [];
	const discard: number[] = [];
	let stale = 0;
	let missing: number | undefined;
	let discardedAfterGap = 0;
	let next = appliedThrough + 1;
	for (const record of [...records].sort((a, b) => a.seq - b.seq)) {
		if (record.seq <= appliedThrough) {
			stale += 1;
			discard.push(record.seq);
		} else if (missing === undefined && record.seq === next) {
			apply.push(record);
			next += 1;
		} else {
			missing ??= next;
			discardedAfterGap += 1;
			discard.push(record.seq);
		}
	}
	return {
		apply,
		appliedThrough: next - 1,
		discard,
		stale,
		gap: missing === undefined ? undefined : { missing, discarded: discardedAfterGap },
	};
}

/** The `CommittedBatch` of a group applied before its commit resolved. */
const SETTLED: CommittedBatch = { durable: Promise.resolve() };
const noop = (): void => undefined;

/**
 * The {@link BatchBackend} for an engine that writes a group atomically but cannot be trusted to
 * keep write order across a power cut. IndexedDB can make one transaction durable but promises
 * nothing about the order earlier relaxed transactions reach the disk; LevelDB syncs only its
 * current log file, closes an old one unsynced when it switches, and under default options skips a
 * damaged log record and keeps the ones after it. Either way a later write can survive while an
 * earlier one is lost, which is exactly what rule 3 of the flush contract (what survives is a
 * prefix of the groups, in order) forbids.
 *
 * The backend keeps the rule without relying on the engine's order. A **relaxed** group (window
 * above 0) is written as one journal record, numbered by a sequence with no gaps, in one atomic
 * unsynced write (`appendJournal`); it is not applied to the stores reads come from, and the
 * `WriteGroup` overlay above serves it until it is durable. An **apply** (`applyJournal`) is one
 * atomic synced write that applies, in order, every record not yet applied — and, for a strict
 * group, that group too — sets the applied-through mark to the last of them, and deletes those
 * records. It carries every byte it applies, so its durability depends on nothing written before
 * it, and every apply is synced before the next starts, so a later apply can never survive without
 * an earlier one. **Recovery** at open reads the journal, deletes any record at or below the mark,
 * applies the run of consecutive records after it, and discards everything after the first missing
 * number. A record the engine lost — a damaged LevelDB log record, an IndexedDB transaction the
 * browser did not keep, an unsynced old log file — is a missing number, so nothing after it is
 * applied, and what survives is a prefix of the groups.
 *
 * When a group is applied is `SyncDeadlines`'s rules, shared with the file log: a strict group, or
 * one whose own or a held deadline has passed, is applied at once together with everything held; a
 * relaxed one is appended and held with its deadline, and the timer armed for the earliest deadline
 * applies everything held. Over a store whose `durability` is below `'power-loss'` — an engine that
 * cannot sync, such as today's React Native LevelDB binding — nothing is journaled and every group
 * is applied at once as one atomic write: the atomicity half of the contract now, and the ordering
 * half the moment the engine can sync, with no change above it.
 *
 * Open, commits, applies and close run one at a time on a queue of this backend's own; reads wait
 * for the open and then go to the store. Any store write rejecting latches the backend failed: the
 * held `durable`s reject, and every later commit and sync throws `StoreFailedError` carrying the
 * first cause, as a rejected commit latches the driver above (rule 5).
 */
export class JournalBatchBackend implements BatchBackend {
	readonly durability: StoreDurability;
	storeIdentity?: () => StoreIdentity;
	listBlockIds?: () => AsyncIterable<BlockId>;
	approximateBytesUsed?: () => Promise<number>;

	/**
	 * Records appended and not yet applied, in order, each with its `durable`, with the earliest
	 * deadline among them and the timer armed for it; emptied by every apply and by the latch.
	 */
	// NOTE: a held record's `entries` are the arrays `WriteGroup` handed `commit`, whose values are
	// the very `Uint8Array`s its overlay holds for the same writes, so holding them here costs the
	// entry arrays and not a second copy of the bytes. Both are bounded by `maxUnsyncedBytes`: a seal
	// that would exceed it commits strictly, and a strict commit applies everything held.
	private readonly held: SyncDeadlines<JournalRecord>;
	/** Open, commits, applies and close run one at a time, in order, on this chain; it never rejects. */
	private queue: Promise<unknown> = Promise.resolve();
	/** The open, memoized: the first operation opens, every later one waits for that. */
	private opening: Promise<void> | undefined;
	/** The sequence the next record takes: one past the last applied or appended. */
	private nextSeq = 1;
	private fault: { cause: unknown } | undefined;
	private closed = false;
	/** What the `window-overrun` line names: the store's identity when it has one. */
	private readonly subject: string;

	constructor(private readonly store: JournalStore, options: JournalBatchBackendOptions = {}) {
		this.durability = store.durability;
		this.subject = store.storeIdentity?.() ?? 'the journal store';
		this.held = new SyncDeadlines<JournalRecord>({
			onDue: firedAt => this.applyInBackground(firedAt),
			setTimer: options.setTimer,
			now: options.now,
			log,
			subject: this.subject,
		});
		if (store.storeIdentity) {
			this.storeIdentity = () => store.storeIdentity!();
		}
		if (store.listBlockIds) {
			this.listBlockIds = () => this.openedBlockIds();
		}
		if (store.approximateBytesUsed) {
			this.approximateBytesUsed = async () => {
				await this.open();
				return store.approximateBytesUsed!();
			};
		}
	}

	// --- reads: the store's, once the journal has been recovered into it ---

	async get(key: StoreKey): Promise<Uint8Array | undefined> {
		await this.open();
		return this.store.get(key);
	}

	async rangeRevisions(blockId: BlockId, lo: number, hi: number): Promise<[number, Uint8Array][]> {
		await this.open();
		return this.store.rangeRevisions(blockId, lo, hi);
	}

	async listPendingActionIds(blockId: BlockId): Promise<ActionId[]> {
		await this.open();
		return this.store.listPendingActionIds(blockId);
	}

	private async *openedBlockIds(): AsyncIterable<BlockId> {
		await this.open();
		yield* this.store.listBlockIds!();
	}

	// --- the sink ---

	/**
	 * `WriteGroupSink.commit`'s contract. The deadline is taken now, not when the queue reaches the
	 * commit, so a commit that waited in line past its own deadline is overdue and applies at once.
	 */
	commit(entries: readonly BatchEntry[], { syncWithinMs }: SinkCommitOptions): Promise<CommittedBatch> {
		if (!(syncWithinMs >= 0) || !Number.isFinite(syncWithinMs)) {
			return Promise.reject(new RangeError(`syncWithinMs must be a finite number of milliseconds at or above 0, got ${syncWithinMs}`));
		}
		const deadline = this.held.deadlineFor(syncWithinMs);
		return this.enqueue(async () => {
			await this.open();
			if (this.closed) throw new Error(`the journal backend over ${this.subject} is closed`);
			this.throwIfFailed();
			const record: JournalRecord = { seq: this.nextSeq, entries };
			this.nextSeq += 1;
			if (this.durability !== 'power-loss' || this.held.mustSyncNow(deadline)) {
				const cover = this.held.take();
				await this.applyRecords([...cover.items, record], record.seq, cover);
				return SETTLED;
			}
			await this.append(record);
			// `defer` throws once latched. Only this queue's own steps latch, and the append's failure
			// has already thrown, so nothing can have latched between it resolving and this.
			return { durable: this.held.defer(record, deadline) };
		});
	}

	/** Hasten: apply every record held when this was called. `WriteGroupSink.sync`'s contract. */
	sync(): Promise<void> {
		return this.enqueue(async () => {
			await this.open();
			this.throwIfFailed();
			await this.applyHeld();
		});
	}

	/**
	 * Apply whatever is held (the driver's strict flush normally leaves nothing), then close the
	 * store if it has a close. Nothing is held before the first open or after a latch, so neither
	 * opens the store only to close it.
	 */
	close(): Promise<void> {
		return this.enqueue(async () => {
			this.closed = true;
			try {
				if (this.opening !== undefined) {
					await this.opening.catch(noop);
					if (this.fault === undefined) await this.applyHeld();
				}
			} finally {
				await this.store.close?.();
			}
		});
	}

	// --- open and recovery ---

	private open(): Promise<void> {
		return this.opening ??= this.recover();
	}

	/** Read the journal, apply the consecutive run after the mark and delete the rest, in one apply; a failure latches the backend for its life. */
	private async recover(): Promise<void> {
		try {
			const { appliedThrough, records } = await this.store.readJournal();
			const plan = planRecovery(appliedThrough, records);
			if (plan.apply.length > 0 || plan.discard.length > 0) {
				await this.store.applyJournal(plan.apply, plan.appliedThrough, plan.discard);
			}
			this.nextSeq = plan.appliedThrough + 1;
			this.reportRecovery(plan);
		} catch (err) {
			throw this.latch(err);
		}
	}

	private reportRecovery(plan: RecoveryPlan): void {
		if (plan.gap) {
			log('recovery:gap: the journal of %s is missing record %d; %d record(s) after it discarded, %d before it applied',
				this.subject, plan.gap.missing, plan.gap.discarded, plan.apply.length);
		}
		if (plan.stale > 0) {
			log.error('recovery:stale: %d record(s) at or below the applied-through mark deleted from the journal of %s; an apply had deleted them in the write that set the mark',
				plan.stale, this.subject);
		}
	}

	// --- append and apply ---

	private async append(record: JournalRecord): Promise<void> {
		try {
			await this.store.appendJournal(record);
		} catch (err) {
			throw this.latch(err);
		}
	}

	/** The timer's apply, in the queue; its failure has latched the backend, so it is only logged here. */
	private applyInBackground(firedAt: number): void {
		this.enqueue(() => this.applyHeld(firedAt)).catch((err: unknown) => {
			log.error('apply-failed: the deferred apply of %s rejected; the store refuses every later write: %o', this.subject, err);
		});
	}

	/**
	 * Apply everything held, through the last of it. Called from a queued step only, so it covers
	 * exactly the records appended before that step began. `owedSince` is the moment the timer
	 * fired, when the timer's step runs this, so its own lateness is not read as the store's.
	 */
	private async applyHeld(owedSince?: number): Promise<void> {
		const cover = this.held.take(owedSince);
		if (cover.items.length === 0) return;
		await this.applyRecords(cover.items, cover.items[cover.items.length - 1]!.seq, cover);
	}

	/** One apply of `records` through `appliedThrough`; settles the cover on success, fails it and latches on failure. */
	private async applyRecords(records: readonly JournalRecord[], appliedThrough: number, cover: SyncCover<JournalRecord>): Promise<void> {
		try {
			await this.store.applyJournal(records, appliedThrough, []);
		} catch (err) {
			const failure = this.latch(err);
			cover.fail(err);
			throw failure;
		}
		cover.settle();
	}

	// --- failure ---

	private throwIfFailed(): void {
		if (this.fault) throw new StoreFailedError(this.fault.cause);
	}

	/**
	 * Latch the backend failed on its first fault and reject every held `durable`, so no caller
	 * waits on an apply the store will not make. Returns the error to throw.
	 */
	private latch(err: unknown): StoreFailedError {
		this.fault ??= { cause: err instanceof StoreFailedError ? err.cause : err };
		this.held.failAll(this.fault.cause);
		return new StoreFailedError(this.fault.cause);
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch(noop);
		return run;
	}
}
