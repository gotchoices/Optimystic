/**
 * Reactivity — replay window (`docs/reactivity.md` §Replay window).
 *
 * Each forwarder and the tail cohort keep a per-collection ring buffer of the last `W` notifications
 * (default 256). Entries are gossiped across the cohort ({@link ReplayBuffer.serialize} /
 * {@link ReplayBuffer.merge}) so **any** cohort member — not just the primary — can serve a replay if
 * the primary is unavailable. This buffer is the substrate the backfill/resume ticket reads from; this
 * ticket owns its construction, ring semantics, gossip replication, and the any-member-serves property.
 *
 * The ring is keyed by revision, not by insertion slot, so a retransmit that arrives out of order (the
 * recovery case the dedupe window admits) lands at its correct revision. Capacity `W` bounds the number
 * of *distinct revisions* retained; the lowest revision is dropped when a new one overflows the ring.
 */

import { W_DEFAULT } from "./config.js";
import type { NotificationV1 } from "./wire.js";

/** One replay-buffer entry: the full signed notification plus its local receive time. */
export interface RevisionEntry {
	readonly revision: number;
	/** The full signed notification (retains the original threshold signature; backfills verify end-to-end). */
	readonly payload: NotificationV1;
	/** Unix ms. */
	readonly receivedAt: number;
}

/** Serializable replay-buffer state for intra-cohort gossip replication. */
export interface ReplayBufferStateV1 {
	readonly capacity: number;
	readonly entries: readonly RevisionEntry[];
}

/** A per-collection ring buffer of the last `W` notifications, gossip-replicated across the cohort. */
export interface ReplayBuffer {
	/** Configured ring capacity `W`. */
	readonly capacity: number;
	/** Number of distinct revisions currently retained. */
	readonly size: number;
	/** Lowest retained revision, or `undefined` when empty. */
	readonly lowRevision: number | undefined;
	/** Highest retained revision, or `undefined` when empty. */
	readonly highRevision: number | undefined;
	/** Append (or replace, on a retransmit) the entry for its revision, evicting the lowest on overflow. */
	append(entry: RevisionEntry): void;
	/** The entry for `revision`, or `undefined` if not in the window. */
	get(revision: number): RevisionEntry | undefined;
	/** Entries with `from <= revision <= to`, ascending — the intersection with the window. */
	range(from: number, to: number): RevisionEntry[];
	/** All retained entries, ascending by revision. */
	entries(): RevisionEntry[];
	/** Snapshot for gossip. */
	serialize(): ReplayBufferStateV1;
	/** Merge another member's gossiped buffer (newer `receivedAt` wins a per-revision tie). */
	merge(state: ReplayBufferStateV1): void;
}

class RingReplayBuffer implements ReplayBuffer {
	readonly capacity: number;
	/** revision → entry; trimmed to the highest `capacity` revisions. */
	private readonly byRevision = new Map<number, RevisionEntry>();

	constructor(capacity: number) {
		if (!Number.isInteger(capacity) || capacity < 1) {
			throw new RangeError(`reactivity replay buffer: capacity must be an integer >= 1, got ${capacity}`);
		}
		this.capacity = capacity;
	}

	get size(): number {
		return this.byRevision.size;
	}

	get lowRevision(): number | undefined {
		return this.size === 0 ? undefined : Math.min(...this.byRevision.keys());
	}

	get highRevision(): number | undefined {
		return this.size === 0 ? undefined : Math.max(...this.byRevision.keys());
	}

	append(entry: RevisionEntry): void {
		this.byRevision.set(entry.revision, entry);
		this.trim();
	}

	get(revision: number): RevisionEntry | undefined {
		return this.byRevision.get(revision);
	}

	range(from: number, to: number): RevisionEntry[] {
		// Iterate the retained entries (≤ capacity) rather than every integer in `[from, to]`: a backfill
		// request carries a subscriber-supplied range that may be arbitrarily wide, so a per-integer scan
		// would be an unbounded loop on attacker-controlled input. The intersection with the window is
		// bounded by `capacity` regardless.
		return this.entries().filter((e) => e.revision >= from && e.revision <= to);
	}

	entries(): RevisionEntry[] {
		return [...this.byRevision.values()].sort((a, b) => a.revision - b.revision);
	}

	serialize(): ReplayBufferStateV1 {
		return { capacity: this.capacity, entries: this.entries() };
	}

	merge(state: ReplayBufferStateV1): void {
		for (const entry of state.entries) {
			const existing = this.byRevision.get(entry.revision);
			// Per-revision convergence: the freshest receiver's copy wins (they carry the same end-to-end
			// signature, so this only breaks ties on `receivedAt`, never trusts a forged payload).
			if (existing === undefined || entry.receivedAt > existing.receivedAt) {
				this.byRevision.set(entry.revision, entry);
			}
		}
		this.trim();
	}

	/** Evict the lowest revisions until at most `capacity` distinct revisions remain. */
	private trim(): void {
		while (this.byRevision.size > this.capacity) {
			const lowest = Math.min(...this.byRevision.keys());
			this.byRevision.delete(lowest);
		}
	}
}

/** Build a {@link ReplayBuffer} with capacity `W` (default {@link W_DEFAULT}). */
export function createReplayBuffer(capacity: number = W_DEFAULT): ReplayBuffer {
	return new RingReplayBuffer(capacity);
}
