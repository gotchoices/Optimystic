import type { Action, Transforms } from "../index.js";
import type { AlreadyAppliedTally } from "./action.js";
import { addTallies, ZeroTally } from "./action.js";
import type { ActionRefusedError } from "./struct.js";
import { emptyTransforms, foldTransforms } from "../transform/helpers.js";

/** A queue entry's id, opaque to the collection: the offline-sync queue (docs/offline-sync.md)
 * mints one per locally committed transaction and seals that transaction's actions under it. */
export type EntryId = string;

/** One action of the open segment with what staging it produced: the transforms its handler staged
 * (`delta`) and what it accepted as already applied (`applied`), both as `Collection.stageInto`
 * returned them. Either is absent when the action's staging is not on record — an action put back
 * by a conflict filter's replacement or by an unseal, or one a replay has not reached — and a
 * segment sealed over such a unit carries no delta, which every reader takes as "stage it again".
 * An `act` call over several actions stages them as one unit: its delta and tally are recorded on
 * the group's LAST action, the earlier ones recording an empty delta and the zero tally, so folding
 * the units in order gives the group's effect at the point the group completed; nothing slices
 * inside a group. Immutable once made, so a snapshot may hold the same unit. */
export type StagedUnit<TAction> = {
	readonly action: Action<TAction>;
	readonly delta?: Transforms;
	readonly applied?: AlreadyAppliedTally;
};

/** Units for `actions` whose staging is not on record. */
export function unitsOf<TAction>(actions: readonly Action<TAction>[]): StagedUnit<TAction>[] {
	return actions.map(action => ({ action }));
}

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
	/** What the actions staged into the LIVE tracker, the last time they were staged there: folded
	 * from the open units at the seal, or captured again by a replay (`Collection.replayActions`),
	 * so it names the ids the live tracker holds for the segment's blocks. A head commit builds its
	 * attempt from it and, once that attempt commits, takes the head out of the live tracker without
	 * running a handler (`Collection.headTrackerFor`, `Collection.subtractCommittedHead`). `undefined`
	 * when not on record — a segment put back by `Collection.restoreSealed` or an unseal before its
	 * next replay, or one sealed over a unit with no delta — and every reader then stages the actions
	 * again, which is slower and never wrong. Never changed in place: the attempt copies it, the
	 * subtraction copies what it re-folds, and a snapshot's read view may share its values.
	 *
	 * NOTE: memory — while the segment is queued the content it staged is held about twice, once
	 * here and once folded into the live tracker (a block that later segments also write is held once
	 * more per such segment's delta). Proportional to what is queued, and reclaimed with the segment. */
	delta?: Transforms;
	/** What the segment's actions accepted as already applied the last time they were staged over the
	 * committed state — at the seal, from the open units' tallies, or by a replay
	 * (`Collection.replayActions`) or a head commit's rebuild (`Collection.buildHeadTracker`), all of
	 * which stage over the state the collection reads at, so when the head commit folds this is the
	 * tally of a staging over the state the write committed over. Set directly, with no version bump:
	 * it is not a change to the sealed list. Reported to the head commit's `onCommittedHead` hook
	 * when the segment is dropped as committed. Absent only before the segment's first staging — a
	 * refused staging leaves the previous value, which nothing reads, since a refused segment is
	 * never committed. */
	applied?: AlreadyAppliedTally;
};

/** The open units' staging folded into one — the delta and tally a segment sealed over them
 * carries — or neither, when any unit's staging is not on record. */
function foldUnits<TAction>(units: readonly StagedUnit<TAction>[]): { delta?: Transforms; applied?: AlreadyAppliedTally } {
	const delta = emptyTransforms();
	let applied = ZeroTally;
	for (const unit of units) {
		if (unit.delta === undefined || unit.applied === undefined) {
			return {};
		}
		foldTransforms(delta, unit.delta);
		applied = addTallies(applied, unit.applied);
	}
	return { delta, applied };
}

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
	/** The same segments by owner, so a lookup costs the same at any queue depth. Every method that
	 * changes {@link sealed} changes this too. */
	private readonly byEntry = new Map<EntryId, SealedSegment<TAction>>();
	/** The open segment: what the current transaction has staged, one unit per action
	 * ({@link StagedUnit}). Private so that it is replaced through {@link setOpen} alone and grown
	 * through {@link pushOpen} alone, each unit carrying what its staging produced. */
	private units: StagedUnit<TAction>[] = [];
	/** Bumped on every change to the sealed list — a seal, an unseal, an insert, a drop, a refusal
	 * recorded. Captured by a snapshot so a restore can tell whether the sealed segments it was taken
	 * over are still the ones in place (ticket `offline-sync-open-segment-snapshot`). Read and written
	 * only under the collection latch or from synchronous callers. */
	version = 0;

	/** The open segment's units, in staging order: the array the list holds, never to be changed by
	 * a caller. */
	openUnits(): readonly StagedUnit<TAction>[] {
		return this.units;
	}

	/** The open segment's actions, in staging order, as a new array. */
	openActions(): Action<TAction>[] {
		return this.units.map(unit => unit.action);
	}

	/** How many actions the open segment holds. */
	openCount(): number {
		return this.units.length;
	}

	/** Replace the open segment: the one way it is set. A caller putting actions back whose staging
	 * it does not have records them through {@link unitsOf}, and the next replay records it. */
	setOpen(units: StagedUnit<TAction>[]): void {
		this.units = units;
	}

	/** Append the actions one `act` call staged as one unit, with the delta and tally that staging
	 * produced, recorded as {@link StagedUnit} describes for a group. */
	pushOpen(actions: readonly Action<TAction>[], delta: Transforms, applied: AlreadyAppliedTally): void {
		const last = actions.length - 1;
		actions.forEach((action, index) => {
			this.units.push(index === last ? { action, delta, applied } : { action, delta: emptyTransforms(), applied: ZeroTally });
		});
	}

	/** Close the open segment into a sealed segment owned by `entryId`, carrying the open units'
	 * deltas folded into one and their tallies summed ({@link SealedSegment.delta}, `applied`) — or
	 * neither, when a unit's staging is not on record. Returns `false` and changes nothing — the
	 * version included — when the open segment is empty: an entry that staged nothing here owns no
	 * segment here. Throws when `entryId` is already sealed. */
	seal(entryId: EntryId): boolean {
		if (this.find(entryId) !== undefined) {
			throw new Error(`entry ${entryId} is already sealed in this collection`);
		}
		if (this.units.length === 0) {
			return false;
		}
		const segment: SealedSegment<TAction> = { entryId, actions: this.units.map(unit => unit.action), ...foldUnits(this.units) };
		this.sealed.push(segment);
		this.byEntry.set(entryId, segment);
		this.units = [];
		this.version++;
		return true;
	}

	/** The exact inverse of {@link seal}: move the newest sealed segment's actions back into the open
	 * segment, for an enqueue whose journal write failed after sealing (`OfflineQueue.enqueue`).
	 * Requires the segment to be the NEWEST sealed one and the open segment to be empty — both true at
	 * that one call site, which has just sealed and staged nothing since — and throws otherwise, since
	 * putting an older segment's actions behind a newer one's would reorder what was staged. Bumps
	 * `version`: the sealed list changed, even though the tracker did not (the transforms are already
	 * what they were). The units go back with no staging on record: the segment holds their deltas
	 * folded into one, and the enqueue that unseals is failing, so the rollback that follows it
	 * replays and records them again. */
	unseal(entryId: EntryId): void {
		const newest = this.sealed[this.sealed.length - 1];
		if (newest === undefined || newest.entryId !== entryId) {
			throw new Error(`entry ${entryId} is not the newest sealed segment (${newest?.entryId ?? 'nothing is sealed'}); only the newest can be unsealed`);
		}
		if (this.units.length > 0) {
			throw new Error(`entry ${entryId} cannot be unsealed over a non-empty open segment`);
		}
		this.sealed.pop();
		this.byEntry.delete(entryId);
		this.units = unitsOf(newest.actions);
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
		const segment: SealedSegment<TAction> = { entryId, actions: [...actions] };
		this.sealed.splice(index, 0, segment);
		this.byEntry.set(entryId, segment);
		this.version++;
	}

	/** Remove the segment owned by `entryId`, wherever it sits. Throws for an unknown id. */
	drop(entryId: EntryId): SealedSegment<TAction> {
		const index = this.sealed.findIndex(segment => segment.entryId === entryId);
		if (index < 0) {
			throw new Error(`entry ${entryId} is not sealed in this collection`);
		}
		const [dropped] = this.sealed.splice(index, 1);
		this.byEntry.delete(entryId);
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
		return this.byEntry.get(entryId);
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
		return this.replayable().reduce((count, segment) => count + segment.actions.length, this.units.length);
	}

	/** The deltas of everything a replay would re-stage, in staging order — each replayable sealed
	 * segment's, then each open unit's — or `undefined` when any is not on record. What a committed
	 * head is taken out of the live tracker against (`Collection.subtractCommittedHead`). */
	stagedDeltas(): Transforms[] | undefined {
		const deltas: Transforms[] = [];
		for (const segment of this.replayable()) {
			if (segment.delta === undefined) {
				return undefined;
			}
			deltas.push(segment.delta);
		}
		for (const unit of this.units) {
			if (unit.delta === undefined) {
				return undefined;
			}
			deltas.push(unit.delta);
		}
		return deltas;
	}
}
