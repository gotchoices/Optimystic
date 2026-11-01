import type { ITransactor } from '../transactor/transactor.js';
import { createLogger } from '../logger.js';
import { compareHlc, isHlc, type Hlc } from './hlc.js';
import { DEFAULT_HLC_PERSIST_INTERVAL_MS, DEFAULT_HLC_RESTART_SLACK_MS, restartFloor, type HlcClockStore } from './clock-store.js';

const log = createLogger('hlc');

export type HlcClockOptions = {
	/** This node's peer id string, stamped on every HLC the clock issues. Never `''`, which marks a legacy HLC. */
	readonly nodeId: string;
	/** Wall-clock milliseconds. Defaults to `Date.now`; tests inject a fake. */
	readonly localClock?: () => number;
};

export type HlcClockStartOptions = HlcClockOptions & {
	/** Where the clock's high-water mark survives a restart. */
	readonly store: HlcClockStore;
	/** Default {@link DEFAULT_HLC_PERSIST_INTERVAL_MS}. */
	readonly persistIntervalMs?: number;
	/** Default {@link DEFAULT_HLC_RESTART_SLACK_MS}. */
	readonly restartSlackMs?: number;
};

/**
 * A node's hybrid logical clock: the only thing in the repository that mints an {@link Hlc}.
 *
 * It holds the last HLC it issued or observed. {@link now} issues above it, {@link observe} raises
 * it. Built with `new`, the clock is purely in memory; {@link HlcClock.start} builds one whose mark
 * survives a restart through an {@link HlcClockStore}, so a store-backed clock is always one that
 * has loaded its mark before it can issue.
 */
export class HlcClock {
	readonly nodeId: string;
	private readonly localClock: () => number;
	private last: Hlc | undefined;
	private persistence: MarkPersistence | undefined;

	constructor(options: HlcClockOptions) {
		if (typeof options.nodeId !== 'string' || options.nodeId === '') {
			throw new Error('HlcClock needs a non-empty nodeId: the empty node id marks a legacy HLC');
		}
		this.nodeId = options.nodeId;
		this.localClock = options.localClock ?? Date.now;
	}

	/**
	 * A clock that resumes from the mark `store` holds: it treats {@link restartFloor} of that mark as
	 * already observed, so it issues above every HLC it saved before the restart and, by the slack,
	 * above the ones it issued after its last save. A `load` that rejects starts the clock from the
	 * local clock alone, logged: refusing to start a node because its mark could not be read would turn
	 * a lost record into an outage.
	 */
	static async start(options: HlcClockStartOptions): Promise<HlcClock> {
		const persistIntervalMs = nonNegative('persistIntervalMs', options.persistIntervalMs ?? DEFAULT_HLC_PERSIST_INTERVAL_MS);
		const restartSlackMs = nonNegative('restartSlackMs', options.restartSlackMs ?? DEFAULT_HLC_RESTART_SLACK_MS);
		const clock = new HlcClock(options);
		const stored = await loadMark(options.store);
		clock.persistence = new MarkPersistence(options.store, persistIntervalMs, stored?.wallMs);
		if (stored !== undefined) clock.observe(restartFloor(stored, restartSlackMs, clock.nodeId));
		return clock;
	}

	/**
	 * The local wall clock's reading, the one this clock issues from, without issuing anything. What a
	 * peer's HLC is measured against (`SkewLedger`): the mark itself is no reference, since it has
	 * already moved up to whatever far-ahead HLC this clock observed.
	 */
	localTime(): number {
		return this.localClock();
	}

	/** Issue an HLC above every one this clock has issued or observed. */
	now(): Hlc {
		const issued = this.next();
		this.advance(issued);
		return issued;
	}

	/**
	 * Raise the mark to `hlc` when it is above it; otherwise nothing. A value without the shape of an
	 * HLC ({@link isHlc}) is ignored: a wire field is checked, and reported, by the
	 * caller that read it.
	 */
	observe(hlc: Hlc): void {
		if (!isHlc(hlc)) return;
		if (this.last !== undefined && compareHlc(hlc, this.last) <= 0) return;
		this.advance({ wallMs: hlc.wallMs, logical: hlc.logical, nodeId: hlc.nodeId });
	}

	/**
	 * The HLC after the mark at the local clock's reading. A logical count already at the top of the
	 * safe-integer range carries into `wallMs` instead: past it `logical + 1` stops changing the value,
	 * and the clock would issue one HLC twice after observing a peer's far-advanced count.
	 */
	private next(): Hlc {
		const prior = this.last;
		const wallMs = Math.max(this.localClock(), prior?.wallMs ?? -Infinity);
		if (prior === undefined || wallMs !== prior.wallMs) return { wallMs, logical: 0, nodeId: this.nodeId };
		if (prior.logical < Number.MAX_SAFE_INTEGER) return { wallMs, logical: prior.logical + 1, nodeId: this.nodeId };
		return { wallMs: wallMs + 1, logical: 0, nodeId: this.nodeId };
	}

	private advance(hlc: Hlc): void {
		const moved = hlc.wallMs !== this.last?.wallMs;
		this.last = hlc;
		if (moved) this.persistence?.offer(hlc);
	}
}

/**
 * The clock for a transactor that declares none (`ITransactor.clock`): the reference peer's, the
 * Quereus plugin's `local` and `test` transactors, a host's own. One per process, in the node id
 * `'local'`, which is also the peer id `TransactionSession.create` stamps when none is given, so the
 * two defaults agree. It has no store, so its mark does not survive a restart.
 *
 * This is the one place a second {@link HlcClock} can exist in a process beside a node's own;
 * reach it only through {@link clockOf}.
 */
let undeclaredClock: HlcClock | undefined;

/** The clock a write through `transactor` mints from: the transactor's own, or the process-wide fallback. */
export function clockOf(transactor: ITransactor): HlcClock {
	return transactor.clock ?? (undeclaredClock ??= new HlcClock({ nodeId: 'local' }));
}

async function loadMark(store: HlcClockStore): Promise<Hlc | undefined> {
	try {
		const stored = await store.load();
		if (stored === undefined || isHlc(stored)) return stored;
		log('hlc:load-malformed value=%o', stored);
	} catch (error) {
		log('hlc:load-failed error=%s', error instanceof Error ? error.message : String(error));
	}
	return undefined;
}

function nonNegative(name: string, value: number): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(`HlcClock ${name} must be a finite number at or above 0, got ${value}`);
	}
	return value;
}

/**
 * The clock's saves: one whenever `wallMs` has moved at least `intervalMs` past the last mark handed
 * to the store, fire-and-forget, never awaited on a write path. At most one save is in flight; a mark
 * offered meanwhile waits, replaced by any newer one. A rejection is logged and the next qualifying
 * advance tries again.
 */
class MarkPersistence {
	private lastOfferedWallMs: number | undefined;
	private inFlight = false;
	private queued: Hlc | undefined;

	constructor(
		private readonly store: HlcClockStore,
		private readonly intervalMs: number,
		storedWallMs: number | undefined,
	) {
		this.lastOfferedWallMs = storedWallMs;
	}

	offer(hlc: Hlc): void {
		if (this.lastOfferedWallMs !== undefined && hlc.wallMs < this.lastOfferedWallMs + this.intervalMs) return;
		this.lastOfferedWallMs = hlc.wallMs;
		if (this.inFlight) {
			this.queued = hlc;
			return;
		}
		this.save(hlc);
	}

	private save(hlc: Hlc): void {
		this.inFlight = true;
		void this.callStore(hlc)
			.catch(error => log('hlc:save-failed wallMs=%d logical=%d error=%s',
				hlc.wallMs, hlc.logical, error instanceof Error ? error.message : String(error)))
			.finally(() => this.settled());
	}

	/** The store's `save`, with a synchronous throw turned into a rejection so it never reaches the caller of `now`. */
	private callStore(hlc: Hlc): Promise<void> {
		try {
			return this.store.save(hlc);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private settled(): void {
		this.inFlight = false;
		const next = this.queued;
		this.queued = undefined;
		if (next !== undefined) this.save(next);
	}
}
