import type {
	VTime,
	EventRun,
	BatchRun,
	EventScheduler,
	EventContext,
	SeededRng,
	LatencyModel
} from './types.js';
import { EventHeap } from './heap.js';

export interface SchedulerOptions {
	/**
	 * Optional safety backstop (Decision: reentrancy). Caps the number of events fired in a
	 * single `run()` call; exceeding it throws rather than spinning forever on an unbounded
	 * same-time reschedule loop. Counts heap pops (a batch is one pop). Default: no cap.
	 */
	readonly maxEvents?: number;
}

/**
 * Single-threaded, synchronous event-queue drain over a virtual clock. No Promises, no
 * wall-clock, no real timers — see the no-real-time guard test. Events fire in (at, seq)
 * order; `seq` is a never-reset monotonic counter so equal-`at` events fire in schedule
 * order and events queued during firing land strictly after the current equal-time cohort.
 */
export class VirtualScheduler implements EventScheduler {
	private readonly heap = new EventHeap();
	private readonly rng: SeededRng;
	private readonly latency: LatencyModel;
	private readonly maxEvents: number;
	/** Never reset across `run()` calls; exact to 2^53, far above any real event count. */
	private seqCounter = 0;
	private currentTime: VTime = 0;

	constructor(rng: SeededRng, latency: LatencyModel, options: SchedulerOptions = {}) {
		this.rng = rng;
		this.latency = latency;
		this.maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
	}

	now(): VTime {
		return this.currentTime;
	}

	scheduleAt(at: VTime, run: EventRun): void {
		this.assertInteger(at, 'at');
		this.assertNotPast(at);
		this.heap.push({ at, seq: this.seqCounter++, run, count: -1, isBatch: false });
	}

	scheduleAfter(delay: VTime, run: EventRun): void {
		this.assertInteger(delay, 'delay');
		if (delay < 0) {
			throw new RangeError(`negative delay: ${delay}`);
		}
		this.scheduleAt(this.currentTime + delay, run);
	}

	scheduleBatch(at: VTime, count: number, run: BatchRun): void {
		this.assertInteger(at, 'at');
		this.assertInteger(count, 'count');
		if (count < 0) {
			throw new RangeError(`negative batch count: ${count}`);
		}
		this.assertNotPast(at);
		if (count === 0) {
			return;
		}
		this.heap.push({ at, seq: this.seqCounter++, run, count, isBatch: true });
	}

	run(until?: VTime): number {
		if (until !== undefined) {
			this.assertInteger(until, 'until');
		}
		let fired = 0;
		let pops = 0;
		for (;;) {
			const top = this.heap.peek();
			if (top === undefined) {
				break;
			}
			if (until !== undefined && top.at > until) {
				break;
			}
			this.heap.pop();
			this.currentTime = top.at;
			if (++pops > this.maxEvents) {
				throw new Error(
					`event ceiling exceeded (maxEvents=${this.maxEvents}); likely an unbounded same-time reschedule loop`
				);
			}
			fired += this.fire(top.at, top.run, top.count, top.isBatch);
		}
		return fired;
	}

	pending(): number {
		return this.heap.size;
	}

	/** Build one context and dispatch; a batch shares a single context so all sub-invocations see `now == at`. */
	private fire(at: VTime, run: EventRun | BatchRun, count: number, isBatch: boolean): number {
		const ctx: EventContext = { scheduler: this, rng: this.rng, latency: this.latency, now: at };
		if (isBatch) {
			const batch = run as BatchRun;
			for (let i = 0; i < count; i++) {
				batch(ctx, i);
			}
			return count;
		}
		(run as EventRun)(ctx);
		return 1;
	}

	private assertInteger(value: number, name: string): void {
		if (!Number.isInteger(value)) {
			throw new TypeError(`${name} must be an integer, got ${value}`);
		}
	}

	private assertNotPast(at: VTime): void {
		if (at < this.currentTime) {
			throw new RangeError(`causality violation: at=${at} < now=${this.currentTime}`);
		}
	}
}
