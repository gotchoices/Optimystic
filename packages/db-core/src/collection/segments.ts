import type { Action } from "../index.js";
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
};

/**
 * A collection's staged actions, in two parts: the sealed segments, one per queued entry that wrote
 * the collection, oldest first, and the open segment the current transaction is staging into
 * (docs/offline-sync.md §The segment model). The pure list operations live here; everything that
 * touches the tracker or the collection latch stays on `Collection`.
 */
export class SegmentList<TAction> {
	/** Sealed segments in queue order, oldest first (invariant 1). */
	sealed: SealedSegment<TAction>[] = [];
	/** The open segment: what the current transaction has staged. */
	open: Action<TAction>[] = [];
	/** Bumped on every change to the sealed list — a seal, a drop, a refusal recorded. Captured by a
	 * snapshot so a restore can tell whether the sealed segments it was taken over are still the ones
	 * in place (ticket `offline-sync-open-segment-snapshot`). Read and written only under the
	 * collection latch or from synchronous callers. */
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

	/** The sealed segments a replay re-stages, in order: every one not refused. */
	replayable(): SealedSegment<TAction>[] {
		return this.sealed.filter(segment => segment.refused === undefined);
	}

	/** How many actions a replay re-stages: the replayable sealed segments' plus the open segment's. */
	replayableCount(): number {
		return this.replayable().reduce((count, segment) => count + segment.actions.length, this.open.length);
	}
}
