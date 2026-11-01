import { armUnrefTimer } from '../unref-timer.js';
import { deferred, type Deferred } from '../deferred.js';
import { StoreFailedError, type SetTimer } from './write-group.js';

/** What a {@link SyncDeadlines} is built with. */
export interface SyncDeadlinesOptions {
	/**
	 * Called from the timer once the earliest deadline held is due, with the moment it fired. The
	 * owner enqueues its sync step, which hands that moment to {@link SyncDeadlines.take}.
	 */
	readonly onDue: (firedAt: number) => void;
	/** Arms the deadline timer; defaults to an unref'd `setTimeout`, as `WriteGroup`'s idle timer does, so a held batch never keeps a process alive. Injected by tests. */
	readonly setTimer?: SetTimer;
	/** The clock deadlines are counted on; `Date.now` by default. Injected by tests. */
	readonly now?: () => number;
	/** Where `window-overrun` is said: the owner's own channel. */
	readonly log: (formatter: string, ...args: unknown[]) => void;
	/** What the `window-overrun` line names as being synced, such as the store's directory. */
	readonly subject: string;
}

/** The batches one sync covers, taken just before it starts. */
export interface SyncCover<T> {
	/** Each covered batch's payload, in the order the batches were deferred. */
	readonly items: readonly T[];
	/** The sync succeeded: resolve each batch's `durable`, in order, and say `window-overrun` if the sync started late. */
	settle(): void;
	/** The sync failed: reject each batch's `durable` with {@link StoreFailedError} carrying `cause`. */
	fail(cause: unknown): void;
}

interface Held<T> {
	readonly item: T;
	readonly durable: Deferred;
}

const noop = (): void => undefined;
const EMPTY_COVER: SyncCover<never> = { items: [], settle: noop, fail: noop };

/**
 * The bookkeeping a store that defers its sync keeps between a commit and the sync that makes it
 * durable: the batches appended and not yet synced, in order, each with its `durable`; the earliest
 * deadline any of them was given, with a timer armed for it; and whether syncs are running late.
 * The file log (`FileWriteLog` in `@optimystic/db-p2p-storage-fs`) is the first owner; the sync step
 * itself — what is synced and what a covered batch's payload is applied to — is each owner's.
 *
 * Three rules every owner relies on:
 *
 * - **Covered batches settle in commit order**: {@link take} hands them over in the order they were
 *   deferred, and a cover resolves them in that order.
 * - **A sync covers exactly what was held before it started**: the owner serializes its commits and
 *   its sync step on one queue of its own, and calls {@link take} inside the queued sync step. This
 *   class queues nothing.
 * - **Backpressure**: a deadline already passed makes the next commit sync before it resolves,
 *   whatever its own window ({@link mustSyncNow}). When the disk falls behind, writers wait for it
 *   instead of the window quietly growing.
 *
 * A batch's deadline is counted from its commit's call, not from when the owner's queue reached
 * it, so a commit that waited in line past its own deadline is overdue: the owner takes the
 * deadline with {@link deadlineFor} as the commit is called and passes it to {@link defer} and
 * {@link mustSyncNow} from its queued step.
 */
export class SyncDeadlines<T> {
	/** Batches deferred and not yet taken, in order. Bounded by the window: the earliest deadline among them forces a sync. */
	private held: Held<T>[] = [];
	/** The earliest deadline in {@link held}; absent when nothing there has one. */
	private earliest: number | undefined;
	/**
	 * Cancels the timer armed for {@link earliest}: armed exactly while something held has a
	 * deadline. Left in place when the timer fires, since the sync step the owner enqueues then covers
	 * whatever is deferred before that step runs.
	 */
	private cancelTimer: (() => void) | undefined;
	/** True from a late sync until the next on-time one; the overrun is said when it begins (see {@link reportOverrun}). */
	private overrunning = false;
	/** Set by {@link failAll}: the owner has latched, and nothing will sync a batch deferred from here on. */
	private failed = false;
	private readonly setTimer: SetTimer;
	private readonly now: () => number;

	constructor(private readonly options: SyncDeadlinesOptions) {
		this.setTimer = options.setTimer ?? armUnrefTimer;
		this.now = options.now ?? Date.now;
	}

	/**
	 * The deadline of a batch whose commit is called now with this window: `syncWithinMs` from now,
	 * or `undefined` for 0, a **strict** batch, whose deadline is the commit itself. The owner
	 * validates `syncWithinMs` first.
	 */
	deadlineFor(syncWithinMs: number): number | undefined {
		return syncWithinMs > 0 ? this.now() + syncWithinMs : undefined;
	}

	/**
	 * Whether a batch committing with this deadline must be synced before its commit resolves: it is
	 * strict, or its own deadline or a held batch's has passed.
	 */
	mustSyncNow(deadline: number | undefined): boolean {
		if (deadline === undefined) return true;
		const now = this.now();
		return deadline <= now || (this.earliest !== undefined && this.earliest <= now);
	}

	/**
	 * Hold a batch the owner committed without its sync, and return its `durable`, which a later
	 * {@link take}'s cover settles. Arms the timer for its deadline, or re-arms it when that is
	 * earlier than the one armed; a later deadline never pushes the timer back, and a strict batch
	 * (`undefined`) arms nothing, since its owner syncs at once. The `durable` is pre-observed: a
	 * strict commit whose sync fails throws, and its caller never holds the promise.
	 *
	 * Throws after {@link failAll}: the owner refuses commits once it has latched, and a batch held
	 * then would wait for a sync nobody makes.
	 */
	defer(item: T, deadline: number | undefined): Promise<void> {
		if (this.failed) throw new Error('a batch was deferred after its store latched failed; nothing would ever sync it');
		const durable = deferred();
		this.held.push({ item, durable });
		if (deadline !== undefined && (this.earliest === undefined || deadline < this.earliest)) {
			this.earliest = deadline;
			this.arm(deadline);
		}
		return durable.promise;
	}

	/**
	 * Everything held, in order, for a sync that starts now, and disarm the timer. Called from the
	 * owner's queued sync step. Nothing held: an empty cover whose `settle` and `fail` do nothing.
	 *
	 * `owedSince` is the moment the sync became due when that is later than the covered deadlines:
	 * the timer's step passes the time the timer fired (see {@link SyncDeadlinesOptions.onDue}), so
	 * the operating system's own timer slop is not read as the store running late.
	 */
	take(owedSince?: number): SyncCover<T> {
		const covered = this.held;
		const earliest = this.earliest;
		this.held = [];
		this.earliest = undefined;
		this.disarm();
		if (covered.length === 0) return EMPTY_COVER;
		const startedAt = this.now();
		// A sync covering no deadline — only strict batches — is due at no particular moment, and so is never late.
		const lateness = earliest === undefined ? 0 : startedAt - Math.max(earliest, owedSince ?? -Infinity);
		return {
			items: covered.map(({ item }) => item),
			settle: () => {
				for (const { durable } of covered) durable.resolve();
				this.reportOverrun(lateness, covered.length);
			},
			fail: (cause: unknown) => {
				const failure = new StoreFailedError(cause);
				for (const { durable } of covered) durable.reject(failure);
			},
		};
	}

	/**
	 * The owner latched failed: reject everything held with {@link StoreFailedError} carrying
	 * `cause`, so no caller waits on a `durable` for ever, and disarm the timer. {@link defer} throws
	 * from here on.
	 */
	failAll(cause: unknown): void {
		this.failed = true;
		this.take().fail(cause);
	}

	/**
	 * Once per episode, say that a sync started `lateness` ms after it was due. `lateness` counts from
	 * the earliest deadline the sync covered (or from the timer firing for it) to the sync STARTING,
	 * not finishing: the sync's own duration is the disk's, and no scheduling could have hidden it,
	 * whereas a sync that started late waited for the owner's queue — an earlier sync, an apply or a
	 * seal that ran past the deadline — which is the disk falling behind the window. An episode ends
	 * at the next sync that started on time, a sync covering no deadline included.
	 */
	private reportOverrun(lateness: number, batches: number): void {
		// NOTE: a commit that arrives in the instant between a deadline and its timer firing syncs by
		// backpressure and is late here by the timer's slop, a few ms, through no fault of the disk. One
		// line per episode, and an on-time sync ends it; if the line ever proves noisy under steady
		// load, ignore a lateness below the timer's granularity.
		const late = lateness > 0;
		if (late && !this.overrunning) {
			this.options.log('window-overrun: a sync of %s started %dms after its deadline, covering %d batch(es); the disk is behind the window', this.options.subject, lateness, batches);
		}
		this.overrunning = late;
	}

	/** Replace the timer with one for `deadline`, which {@link defer} has just made the earliest. */
	private arm(deadline: number): void {
		this.disarm();
		this.cancelTimer = this.setTimer(() => this.options.onDue(this.now()), Math.max(0, deadline - this.now()));
	}

	private disarm(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
	}
}
