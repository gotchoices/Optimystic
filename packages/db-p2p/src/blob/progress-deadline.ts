import { unrefTimer } from '../unref-timer.js';
import { BlobTransferStalledError } from './blob-protocol.js';

/**
 * Aborts {@link signal} with {@link BlobTransferStalledError} when {@link touch} has not been called
 * for `ms`. Measures the time between any two chunks of bytes moved on a blob stream, not between
 * pieces: a slow link that keeps delivering never trips it, a dead one trips it within one `ms`
 * (docs/blobs.md §Moving pieces between machines).
 *
 * One timer, armed for the whole `ms` and re-armed only when it fires: a touch just records the time,
 * so a per-chunk touch costs one assignment. When the timer fires it re-arms for the remainder if a
 * touch happened since, and aborts otherwise. Built from a timer rather than `AbortSignal.timeout`,
 * which Hermes lacks and which could not be pushed back by a touch anyway.
 */
export class ProgressDeadline {
	private readonly controller = new AbortController();
	readonly signal: AbortSignal = this.controller.signal;
	/** When bytes last moved; the constructor counts as the first touch. */
	private lastTouch = Date.now();
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly peer: string, private readonly ms: number) {
		this.arm(ms);
	}

	/** Bytes moved. */
	touch(): void {
		this.lastTouch = Date.now();
	}

	/** Clears the timer. Idempotent; a stopped deadline never aborts. */
	stop(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private arm(delayMs: number): void {
		this.timer = unrefTimer(setTimeout(() => this.expire(), delayMs));
	}

	private expire(): void {
		const idleMs = Date.now() - this.lastTouch;
		if (idleMs < this.ms) {
			this.arm(this.ms - idleMs);
			return;
		}
		this.timer = undefined;
		this.controller.abort(new BlobTransferStalledError(this.peer, this.ms));
	}
}
