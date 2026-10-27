import type { Action } from "../index.js";
import type { AlreadyAppliedTally } from "./action.js";
import type { ActionRefusedError } from "./struct.js";

/** A queue entry's id, opaque to the collection: the offline-sync queue (docs/offline-sync.md)
 * mints one per locally committed transaction and seals that transaction's actions under it. */
export type EntryId = string;

/** The actions one queue entry staged into a collection, closed off from later staging. */
export type SealedSegment<TAction> = {
	readonly entryId: EntryId;
	/** Exactly the actions the entry staged into this collection, in staging order (invariant 3 of
	 * docs/offline-sync.md §The segment model). Never rewritten: the conflict filter applies to the
	 * open segment only. */
	readonly actions: readonly Action<TAction>[];
	/** The refusal recorded for this segment, once a replay refused it. A refused segment is excluded
	 * from every later replay until it is dropped. */
	refused?: ActionRefusedError;
	/** What the segment's actions accepted as already applied the last time they were staged over the
	 * committed state — by a replay (`Collection.replayActions`) or by a head commit's tracker
	 * (`Collection.buildHeadTracker`), both of which stage over the state the collection reads at, so
	 * when the head commit folds this is the tally of a staging over the state the write committed
	 * over. Set directly, with no version bump: it is not a change to the sealed list. Reported to the
	 * head commit's `onCommittedHead` hook when the segment is dropped as committed. Absent only before
	 * the segment's first staging — a refused staging leaves the previous value, which nothing reads,
	 * since a refused segment is never committed. */
	applied?: AlreadyAppliedTally;
};

/**
 * A collection's staged actions, in two parts: the sealed segments, one per queued entry that wrote
 * the collection, oldest first, and the open segment the current transaction is staging into
 * (docs/offline-sync.md §The segment model). The pure list operations live here; everything that
 * touches the tracker or the collection latch stays on `Collection`.
 */
export class SegmentList<TAction> {
	/** Sealed segments in queue order, oldest first (invariant 1). Private so every change goes
	 * through a method that bumps `version`; read it through {@link replayable}, {@link find},
	 * {@link head} and {@link entryIds}. */
	private readonly sealed: SealedSegment<TAction>[] = [];
	/** The open segment: what the current transaction has staged. */
	open: Action<TAction>[] = [];
	/** Bumped on every change to the sealed list — a seal, an unseal, an insert, a drop, a refusal
	 * recorded. Captured by a snapshot so a restore can tell whether the sealed segments it was taken
	 * over are still the ones in place (ticket `offline-sync-open-segment-snapshot`). Read and written
	 * only under the collection latch or from synchronous callers. */
	version = 0;

	/** Close the open segment into a sealed segment owned by `entryId`. Returns `false` and changes
	 * nothing — the version included — when the open segment is empty: an entry that staged nothing
	 * here owns no segment here. Throws when `entryId` is already sealed. */
	seal(entryId: EntryId): boolean {
		if (this.find(entryId) !== undefined) {
			throw new Error(`entry ${entryId} is already sealed in this collection`);
		}
		if (this.open.length === 0) {
			return false;
		}
		this.sealed.push({ entryId, actions: this.open });
		this.open = [];
		this.version++;
		return true;
	}

	/** The exact inverse of {@link seal}: move the newest sealed segment's actions back into the open
	 * segment, for an enqueue whose journal write failed after sealing (`OfflineQueue.enqueue`).
	 * Requires the segment to be the NEWEST sealed one and the open segment to be empty — both true at
	 * that one call site, which has just sealed and staged nothing since — and throws otherwise, since
	 * putting an older segment's actions behind a newer one's would reorder what was staged. Bumps
	 * `version`: the sealed list changed, even though the tracker did not (the transforms are already
	 * what they were). */
	unseal(entryId: EntryId): void {
		const newest = this.sealed[this.sealed.length - 1];
		if (newest === undefined || newest.entryId !== entryId) {
			throw new Error(`entry ${entryId} is not the newest sealed segment (${newest?.entryId ?? 'nothing is sealed'}); only the newest can be unsealed`);
		}
		if (this.open.length > 0) {
			throw new Error(`entry ${entryId} cannot be unsealed over a non-empty open segment`);
		}
		this.sealed.pop();
		this.open = [...newest.actions];
		this.version++;
	}

	/** Insert a sealed segment owned by `entryId` holding `actions`, ahead of the segment `before`
	 * names, or last when `before` is `undefined` — a segment put back from a journal after a restart
	 * (`Collection.restoreSealed`), which belongs wherever its entry sits in queue order. Throws when
	 * `entryId` is already sealed or `before` names no segment here, before anything changes. */
	insert(entryId: EntryId, actions: readonly Action<TAction>[], before: EntryId | undefined): void {
		if (this.find(entryId) !== undefined) {
			throw new Error(`entry ${entryId} is already sealed in this collection`);
		}
		const index = before === undefined ? this.sealed.length : this.sealed.findIndex(segment => segment.entryId === before);
		if (index < 0) {
			throw new Error(`entry ${before} is not sealed in this collection; cannot insert ${entryId} before it`);
		}
		this.sealed.splice(index, 0, { entryId, actions: [...actions] });
		this.version++;
	}

	/** Remove the segment owned by `entryId`, wherever it sits. Throws for an unknown id. */
	drop(entryId: EntryId): SealedSegment<TAction> {
		const index = this.sealed.findIndex(segment => segment.entryId === entryId);
		if (index < 0) {
			throw new Error(`entry ${entryId} is not sealed in this collection`);
		}
		const [dropped] = this.sealed.splice(index, 1);
		this.version++;
		return dropped!;
	}

	/** Record that a replay refused the segment owned by `entryId`, excluding it from later replays. */
	refuse(entryId: EntryId, error: ActionRefusedError): void {
		const segment = this.find(entryId);
		if (segment === undefined) {
			throw new Error(`entry ${entryId} is not sealed in this collection`);
		}
		segment.refused = error;
		this.version++;
	}

	find(entryId: EntryId): SealedSegment<TAction> | undefined {
		return this.sealed.find(segment => segment.entryId === entryId);
	}

	/** The oldest sealed segment, if any. */
	head(): SealedSegment<TAction> | undefined {
		return this.sealed[0];
	}

	entryIds(): EntryId[] {
		return this.sealed.map(segment => segment.entryId);
	}

	/** Whether any segment is sealed, refused ones included. */
	hasSealed(): boolean {
		return this.sealed.length > 0;
	}

	/** The sealed segments a replay re-stages, in order: every one not refused. */
	replayable(): SealedSegment<TAction>[] {
		return this.sealed.filter(segment => segment.refused === undefined);
	}

	/** How many actions a replay re-stages: the replayable sealed segments' plus the open segment's. */
	replayableCount(): number {
		return this.replayable().reduce((count, segment) => count + segment.actions.length, this.open.length);
	}
}
