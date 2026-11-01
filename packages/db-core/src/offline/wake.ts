import { jitteredBackoffMs } from '../utility/backoff.js';
import type { JitteredBackoffConfig, RandFn } from '../utility/backoff.js';
import { armUnrefTimer } from '../utility/unref-timer.js';

/**
 * Where the drain loop parks, and what wakes it: a wake signal — a new local commit, a connection
 * event, a disposal — and ONE re-check timer, shared by the reachability gate and the transient
 * failures, whose delay climbs a jittered exponential step (`jitteredBackoffMs`) that a wake or a
 * committed entry resets. A wake that finds nothing parked is kept and consumed by the next park, so
 * a connection event that arrives during a submission is not lost (the cost: a transient failure
 * right after such a wake is re-driven at once rather than after the backoff). The timer is unref'd,
 * so an idle queue holds no process open, and the wake that pre-empts it cancels it.
 */
export class DrainWaker {
	private step = 0;
	private waiter: (() => void) | undefined;
	private pending = false;

	constructor(private readonly config: JitteredBackoffConfig, private readonly rand: RandFn | undefined) {}

	/** Wake whatever is parked, or keep the wake for the next park; either way the re-check step
	 * starts over. */
	wake(): void {
		this.step = 0;
		const waiter = this.waiter;
		if (waiter === undefined) {
			this.pending = true;
			return;
		}
		this.waiter = undefined;
		waiter();
	}

	/** A committed entry: the cohort answered, so the next wait starts the climb over. */
	resetBackoff(): void {
		this.step = 0;
	}

	/** Park until {@link wake}; a wake that arrived meanwhile returns at once. */
	untilWoken(): Promise<void> {
		if (this.takePending()) return Promise.resolve();
		return new Promise<void>(resolve => { this.waiter = resolve; });
	}

	/** Park until the re-check timer at the current step fires or {@link wake} is called, whichever
	 * is first. */
	untilWokenOrTimer(): Promise<void> {
		if (this.takePending()) return Promise.resolve();
		const delayMs = jitteredBackoffMs(this.step++, this.config, this.rand);
		return new Promise<void>(resolve => {
			const cancelTimer = armUnrefTimer(() => {
				this.waiter = undefined;
				resolve();
			}, delayMs);
			this.waiter = () => {
				cancelTimer();
				resolve();
			};
		});
	}

	private takePending(): boolean {
		if (!this.pending) return false;
		this.pending = false;
		return true;
	}
}
