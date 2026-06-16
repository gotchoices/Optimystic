/**
 * Reactivity — slow-subscriber backpressure (`docs/reactivity.md` §Slow-subscriber backpressure).
 *
 * A forwarder's primary maintains a **per-subscriber** bounded queue with **drop-oldest** semantics. When
 * a subscriber's queue is full and a new notification arrives, the *oldest* queued entry is dropped and a
 * monotone `dropped` counter increments. The subscriber detects the resulting revision jump on its next
 * delivery and issues a `BackfillV1` against the replay buffer (the backfill RPC is owned by
 * [reactivity-backfill-resume-checkpoints]; this module only produces the gap).
 *
 * The point is **isolation**: each subscriber has its own queue, so one phone on a flaky link fills and
 * drops *its own* queue without stalling fan-out to the rest of the cohort's attached subscribers. Memory
 * is bounded by `cohort_subscribers × queue_max × notification_size` — the per-subscriber queue depth is
 * the small `queue_max` (default 32), never the unbounded backlog of the slowest receiver.
 *
 * This is the primary-local fan-out buffer, **not** cohort soft state: it is never gossiped (only the
 * primary drives delivery), so it is absent from {@link import("./push-state.js").PushStateGossipV1}. A
 * `cohortEpoch` handoff rebuilds it empty at the new primary — a few dropped notifications at handoff are
 * exactly what the replay buffer + backfill path recover.
 */

import { QUEUE_MAX_DEFAULT } from "./config.js";
import type { NotificationV1 } from "./wire.js";

/** The result of enqueuing one notification onto a subscriber's bounded queue. */
export interface EnqueueResult {
	/** `true` iff the queue was full and its oldest entry was evicted to make room (drop-oldest). */
	readonly droppedOldest: boolean;
	/** The evicted notification, when `droppedOldest`; the subscriber will detect the gap and backfill. */
	readonly evicted?: NotificationV1;
	/** Queue depth after the enqueue (`<= capacity`). */
	readonly depth: number;
}

/**
 * A bounded, drop-oldest per-subscriber delivery queue (`docs/reactivity.md` §Slow-subscriber
 * backpressure). Holds at most `capacity` (= `queue_max`) pending notifications; a full queue evicts its
 * oldest on the next enqueue and increments {@link dropped}.
 */
export class BoundedQueue {
	readonly capacity: number;
	private readonly entries: NotificationV1[] = [];
	private droppedCount = 0;

	constructor(capacity: number = QUEUE_MAX_DEFAULT) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`reactivity bounded queue: capacity must be an integer >= 1, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	/** Pending depth (`0..capacity`). */
	get size(): number {
		return this.entries.length;
	}

	/** Monotone count of notifications dropped to drop-oldest pressure over this queue's lifetime. */
	get dropped(): number {
		return this.droppedCount;
	}

	/** True iff a further enqueue would evict the oldest entry. */
	get full(): boolean {
		return this.entries.length >= this.capacity;
	}

	/**
	 * Enqueue `n` for delivery. On overflow the **oldest** entry is dropped (not the incoming one — a slow
	 * subscriber wants the freshest revisions, and the dropped span is recovered via backfill) and
	 * {@link dropped} increments. Returns whether an eviction occurred and the resulting depth.
	 */
	enqueue(n: NotificationV1): EnqueueResult {
		let evicted: NotificationV1 | undefined;
		if (this.entries.length >= this.capacity) {
			evicted = this.entries.shift();
			this.droppedCount += 1;
		}
		this.entries.push(n);
		return evicted !== undefined
			? { droppedOldest: true, evicted, depth: this.entries.length }
			: { droppedOldest: false, depth: this.entries.length };
	}

	/** The oldest pending notification, or `undefined` when empty (does not dequeue). */
	peek(): NotificationV1 | undefined {
		return this.entries[0];
	}

	/** Remove and return the oldest pending notification (FIFO delivery), or `undefined` when empty. */
	dequeue(): NotificationV1 | undefined {
		return this.entries.shift();
	}

	/** Drain and return all pending notifications in FIFO order, leaving the queue empty. */
	drain(): NotificationV1[] {
		return this.entries.splice(0, this.entries.length);
	}

	/** A read-only snapshot of the pending notifications, oldest first (does not mutate). */
	pending(): readonly NotificationV1[] {
		return [...this.entries];
	}
}

/** The per-subscriber drop record surfaced by {@link SubscriberBackpressure.enqueue}. */
export interface SubscriberEnqueueResult extends EnqueueResult {
	/** The subscriber this enqueue targeted, base64url peer id. */
	readonly subscriberId: string;
}

/**
 * The forwarder primary's per-subscriber backpressure map (the `PushState.perSubscriberQueue` field). One
 * {@link BoundedQueue} per attached subscriber, created lazily on first delivery. `enqueue` routes a
 * notification to exactly one subscriber's queue, so a slow subscriber's drops never touch another
 * subscriber's queue — the isolation the §Slow-subscriber backpressure section requires.
 */
export class SubscriberBackpressure {
	readonly capacity: number;
	private readonly queues = new Map<string, BoundedQueue>();

	constructor(capacity: number = QUEUE_MAX_DEFAULT) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`reactivity backpressure: capacity must be an integer >= 1, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	/** Number of subscribers with a live queue. */
	get subscriberCount(): number {
		return this.queues.size;
	}

	/** The live queue for `subscriberId`, creating an empty one on first use. */
	queue(subscriberId: string): BoundedQueue {
		let q = this.queues.get(subscriberId);
		if (q === undefined) {
			q = new BoundedQueue(this.capacity);
			this.queues.set(subscriberId, q);
		}
		return q;
	}

	/** The live queue for `subscriberId`, or `undefined` if none exists yet (no lazy creation). */
	peekQueue(subscriberId: string): BoundedQueue | undefined {
		return this.queues.get(subscriberId);
	}

	/** Enqueue `n` for one subscriber. A drop on that subscriber's queue isolates it from the others. */
	enqueue(subscriberId: string, n: NotificationV1): SubscriberEnqueueResult {
		return { subscriberId, ...this.queue(subscriberId).enqueue(n) };
	}

	/**
	 * Fan one notification out to every named subscriber, returning only the subscribers whose queue
	 * dropped its oldest under pressure. A slow subscriber that drops is the *only* one affected — fast
	 * subscribers' queues accept the same notification contiguously (the isolation property).
	 */
	fanOut(subscriberIds: Iterable<string>, n: NotificationV1): SubscriberEnqueueResult[] {
		const drops: SubscriberEnqueueResult[] = [];
		for (const id of subscriberIds) {
			const result = this.enqueue(id, n);
			if (result.droppedOldest) {
				drops.push(result);
			}
		}
		return drops;
	}

	/** Drop a departed subscriber's queue (TTL eviction / withdrawal), reclaiming its memory. */
	remove(subscriberId: string): void {
		this.queues.delete(subscriberId);
	}

	/** The total notifications dropped across all subscribers (diagnostics). */
	totalDropped(): number {
		let total = 0;
		for (const q of this.queues.values()) {
			total += q.dropped;
		}
		return total;
	}

	/** The subscriber ids currently holding a queue (for iteration / diagnostics). */
	subscribers(): IterableIterator<string> {
		return this.queues.keys();
	}
}

/** Build a {@link SubscriberBackpressure} map with the configured per-subscriber depth (default `queue_max`). */
export function createSubscriberBackpressure(capacity: number = QUEUE_MAX_DEFAULT): SubscriberBackpressure {
	return new SubscriberBackpressure(capacity);
}
