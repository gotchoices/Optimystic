/**
 * How many blob `get` streams this node has open at once (docs/blobs.md §Moving pieces between
 * machines). Used by the blob fetcher, which acquires a slot before it opens a stream.
 *
 * Imports here are pure: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import { MAX_BLOB_BACKGROUND_GET_STREAMS, MAX_BLOB_FOREGROUND_GET_STREAMS } from '../protocol-limits.js';

/** A read someone is waiting on (`foreground`), or copying no one is waiting on (`background`). */
export type FetchPriority = 'foreground' | 'background';

export interface BlobGetSlotLimits {
	foreground: number;
	background: number;
}

/**
 * Per peer, at most one open `get` stream of each priority; per node, at most the limit of each
 * priority. The priorities are separate pools, so a foreground request never waits for a background
 * stream: it opens its own stream beside the background one, and the stream multiplexer interleaves
 * them frame by frame. A server's allowance (`MAX_BLOB_INBOUND_GETS_PER_PEER`) is sized for exactly one
 * stream of each kind. One stream per peer shared by both priorities was rejected because a read would
 * then wait behind up to 16 background pieces.
 */
export class BlobGetSlots {
	private readonly pools: Readonly<Record<FetchPriority, SlotPool>>;

	/** Defaults: MAX_BLOB_FOREGROUND_GET_STREAMS and MAX_BLOB_BACKGROUND_GET_STREAMS. A limit that is not a positive integer throws RangeError. */
	constructor(limits: Partial<BlobGetSlotLimits> = {}) {
		this.pools = {
			foreground: new SlotPool(checkedLimit('foreground', limits.foreground ?? MAX_BLOB_FOREGROUND_GET_STREAMS)),
			background: new SlotPool(checkedLimit('background', limits.background ?? MAX_BLOB_BACKGROUND_GET_STREAMS)),
		};
	}

	/**
	 * Waits for a slot to `peer` at `priority`; resolves with an idempotent release. Rejects with
	 * `signal.reason` when the signal aborts first (at once when it already has).
	 */
	acquire(peer: string, priority: FetchPriority, signal?: AbortSignal): Promise<() => void> {
		return this.pools[priority].acquire(peer, signal);
	}
}

interface SlotWaiter {
	readonly peer: string;
	grant(release: () => void): void;
}

/**
 * One priority's slots. Waiters queue in arrival order, and a free slot goes to the first waiter whose
 * peer has no stream of this priority open: a waiter for a busy peer is skipped, not allowed to block
 * the waiters behind it. After every change no queued waiter could be granted, which is what lets a
 * new waiter join the back of the queue and still be granted at once when a slot is free.
 */
class SlotPool {
	private open = 0;
	private readonly busyPeers = new Set<string>();
	private readonly waiters: SlotWaiter[] = [];

	constructor(private readonly limit: number) {}

	acquire(peer: string, signal: AbortSignal | undefined): Promise<() => void> {
		if (signal?.aborted === true) {
			return Promise.reject(signal.reason);
		}
		return new Promise((resolve, reject) => {
			const onAbort = (): void => {
				this.leave(waiter);
				reject(signal?.reason);
			};
			const waiter: SlotWaiter = {
				peer,
				grant: release => {
					signal?.removeEventListener('abort', onAbort);
					resolve(release);
				},
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiters.push(waiter);
			this.grantWaiting();
		});
	}

	private leave(waiter: SlotWaiter): void {
		const index = this.waiters.indexOf(waiter);
		if (index >= 0) {
			this.waiters.splice(index, 1);
		}
	}

	private grantWaiting(): void {
		for (let index = 0; index < this.waiters.length && this.open < this.limit;) {
			const waiter = this.waiters[index]!;
			if (this.busyPeers.has(waiter.peer)) {
				index++;
				continue;
			}
			this.waiters.splice(index, 1);
			waiter.grant(this.take(waiter.peer));
		}
	}

	/** Marks a stream to `peer` open and returns its release. */
	private take(peer: string): () => void {
		this.open++;
		this.busyPeers.add(peer);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.open--;
			this.busyPeers.delete(peer);
			this.grantWaiting();
		};
	}
}

function checkedLimit(priority: FetchPriority, limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new RangeError(`The ${priority} blob get stream limit must be a positive integer, not ${limit}`);
	}
	return limit;
}
