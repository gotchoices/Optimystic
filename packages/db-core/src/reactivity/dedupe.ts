/**
 * Reactivity — per-revision dedupe (sliding-window set), `docs/reactivity.md` §Per-revision dedupe.
 *
 * A scalar `lastRevision` is insufficient under partition healing: the same revision may legitimately
 * arrive from multiple parents during a merge, and dropping all but the first on `revision > lastRevision`
 * would discard honest retransmits exactly when a subscriber needs them. Instead each forwarder keeps a
 * sliding set of `(revision, sigDigest)` pairs for the last `dedupe_window` revisions (default 64).
 *
 * A notification is forwarded if:
 *  - it is for the *highest revision* seen in the window (normal case), OR
 *  - it is for an earlier revision, its `(revision, sigDigest)` is not already in the set, and it passes
 *    verification (recovery: a retransmit closing a gap).
 *
 * Both reduce to: **forward iff the `(revision, sigDigest)` key is not already present** (verification is
 * the forwarder's prior step, applied to every inbound). Keys already in the set are dropped silently.
 * The set is gossiped within the cohort ({@link DedupeWindow.serialize} / {@link DedupeWindow.merge}) so
 * all members agree on what has been seen.
 */

import { DEDUPE_WINDOW_DEFAULT } from "./config.js";

/** The dedupe decision for one inbound notification. */
export type DedupeOutcome = "forward" | "duplicate";

/** Serializable dedupe state for intra-cohort gossip convergence. */
export interface DedupeStateV1 {
	/** Highest revision observed (anchors the sliding window's high edge). */
	readonly highestRevision: number;
	/** Seen `(revision, sigDigest)` keys with their revision, for window-bounded merge. */
	readonly entries: ReadonlyArray<{ readonly key: string; readonly revision: number }>;
}

/** A sliding-window dedupe set over `(revision, sigDigest)` pairs. */
export interface DedupeWindow {
	/** Highest revision observed so far (`-1` before any observation). */
	readonly highestRevision: number;
	/** Number of retained keys. */
	readonly size: number;
	/** True iff `(revision, sigDigest)` is already in the set. */
	has(revision: number, sigDigest: string): boolean;
	/**
	 * Record `(revision, sigDigest)` and report whether it should be forwarded. Returns `"duplicate"`
	 * (no state change) if already seen, else records it, advances the window, and returns `"forward"`.
	 */
	observe(revision: number, sigDigest: string): DedupeOutcome;
	/** Snapshot for gossip. */
	serialize(): DedupeStateV1;
	/** Union another member's gossiped state into this one (idempotent, commutative within the window). */
	merge(state: DedupeStateV1): void;
}

class SlidingDedupeWindow implements DedupeWindow {
	private readonly windowSize: number;
	/** key → revision, for window-bounded eviction. */
	private readonly seen = new Map<string, number>();
	private highest = -1;

	constructor(windowSize: number) {
		if (!Number.isInteger(windowSize) || windowSize < 1) {
			throw new RangeError(`reactivity dedupe: windowSize must be an integer >= 1, got ${windowSize}`);
		}
		this.windowSize = windowSize;
	}

	get highestRevision(): number {
		return this.highest;
	}

	get size(): number {
		return this.seen.size;
	}

	has(revision: number, sigDigest: string): boolean {
		return this.seen.has(keyOf(revision, sigDigest));
	}

	observe(revision: number, sigDigest: string): DedupeOutcome {
		const key = keyOf(revision, sigDigest);
		if (this.seen.has(key)) {
			return "duplicate";
		}
		this.insert(key, revision);
		return "forward";
	}

	serialize(): DedupeStateV1 {
		return {
			highestRevision: this.highest,
			entries: [...this.seen].map(([key, rev]) => ({ key, revision: rev })),
		};
	}

	merge(state: DedupeStateV1): void {
		if (state.highestRevision > this.highest) {
			this.highest = state.highestRevision;
		}
		for (const { key, revision } of state.entries) {
			if (!this.seen.has(key)) {
				this.seen.set(key, revision);
			}
		}
		this.evictBelowWindow();
	}

	private insert(key: string, revision: number): void {
		if (revision > this.highest) {
			this.highest = revision;
		}
		this.seen.set(key, revision);
		this.evictBelowWindow();
	}

	/** Retain only revisions within `[highest - windowSize + 1, highest]`. */
	private evictBelowWindow(): void {
		const low = this.highest - this.windowSize + 1;
		for (const [key, revision] of this.seen) {
			if (revision < low) {
				this.seen.delete(key);
			}
		}
	}
}

/** `${revision}:${sigDigest}` — the dedupe-set key. */
function keyOf(revision: number, sigDigest: string): string {
	return `${revision}:${sigDigest}`;
}

/** Build a {@link DedupeWindow} with the configured (default {@link DEDUPE_WINDOW_DEFAULT}) span. */
export function createDedupeWindow(windowSize: number = DEDUPE_WINDOW_DEFAULT): DedupeWindow {
	return new SlidingDedupeWindow(windowSize);
}
