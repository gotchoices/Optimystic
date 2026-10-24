import type { ActionId, BlockId, CollectionChangeEvent } from "@optimystic/db-core";

/**
 * The bookkeeping behind `StorageRepo`'s per-collection change hold: pure state, no I/O, no timers.
 *
 * A transaction that writes several collections — a SQL table and each of its indexes, or several
 * tables — pends and commits each collection as its own request under ONE action id, so a member
 * applies them as separate `StorageRepo.commit` calls, possibly hundreds of milliseconds apart. A
 * watcher woken by the first collection's event then reads the others before they have landed here.
 * The writer pends every collection before committing any, so at the moment the first commit applies
 * this node already holds the other collections' pending records under the same action id: that is
 * the signal this module tracks.
 *
 * **Pend group.** The set of blocks one `StorageRepo.pend` call saved for an action — one
 * collection's reservation on this node (also inside a batch record, which is applied one operation
 * at a time). A group is **open** until a block of it lands here (a commit, a read-driven promotion
 * or a replica of the action's revision), or until none of its blocks still holds the action's
 * pending record (cancelled, dropped, replaced). Closing is by group rather than by block on
 * purpose: a group already partly landed is the SAME collection mid-commit, whose remaining blocks
 * the documented eager emission (docs/internals.md §Change Notification, "Emission guarantee") must
 * keep announcing as they land. Only another collection's untouched reservation holds a wake.
 *
 * **Held event.** A per-collection change event of an action that still has an open group here.
 * When the action's last open group closes, {@link release} hands the held events back in the order
 * they were held, and the action is forgotten. The owner — `StorageRepo` — decides what closes a
 * group by reading storage, arms the timer that bounds a hold, and dispatches released events.
 *
 * **Memory.** In memory only, so a restart forgets every hold, which only means the next commit of
 * an action pended before the restart wakes at once. The map is capped: at {@link maxActions} the
 * oldest action is evicted, and {@link notePendGroup} returns its held events so the owner releases
 * them (never drops them). An action with no held events whose groups never close — a writer that
 * pended and vanished — is dropped by {@link ageOut} once older than {@link staleEntryMs}.
 */
export class ActionChangeHold {
	/** Insertion order is creation order, so the first entry is always the oldest. */
	private readonly entries = new Map<ActionId, ActionEntry>();
	private readonly maxActions: number;
	private readonly staleEntryMs: number;

	constructor(options: ActionChangeHoldOptions = {}) {
		this.maxActions = options.maxActions ?? DEFAULT_MAX_HELD_ACTIONS;
		this.staleEntryMs = options.staleEntryMs ?? DEFAULT_STALE_ENTRY_MS;
	}

	/**
	 * Record the blocks one `pend` call saved for `actionId`, at `now`. A pend whose blocks overlap an
	 * existing group of the action extends that group — a re-delivered or retried pend is the same
	 * reservation, not a second one — and leaves its open/closed state as it was. An empty `blockIds`
	 * records nothing.
	 *
	 * Returns the action evicted to make room, with its held events, when the map was at capacity and
	 * `actionId` is new; the caller releases those events and drops that action's timer.
	 */
	notePendGroup(actionId: ActionId, blockIds: readonly BlockId[], now: number): EvictedAction | undefined {
		if (blockIds.length === 0) {
			return undefined;
		}
		let evicted: EvictedAction | undefined;
		let entry = this.entries.get(actionId);
		if (entry === undefined) {
			evicted = this.evictOldestIfFull();
			entry = { groups: [], held: [], since: now };
			this.entries.set(actionId, entry);
		}
		const overlapping = entry.groups.find(group => blockIds.some(id => group.blockIds.has(id)));
		if (overlapping !== undefined) {
			for (const id of blockIds) overlapping.blockIds.add(id);
		} else {
			const group: TrackedGroup = { blockIds: new Set(blockIds), open: true };
			entry.groups.push(group);
		}
		return evicted;
	}

	/** Whether this module tracks `actionId` at all — false for an action never pended here (or already forgotten). */
	knows(actionId: ActionId): boolean {
		return this.entries.has(actionId);
	}

	/**
	 * Close every group of `actionId` that holds any of `blockIds`: a block of the group landed here,
	 * or the writer cancelled it. No read is needed for either. Unknown actions and blocks are ignored.
	 */
	closeGroups(actionId: ActionId, blockIds: readonly BlockId[]): void {
		const entry = this.entries.get(actionId);
		if (entry === undefined) {
			return;
		}
		for (const group of entry.groups) {
			if (group.open && blockIds.some(id => group.blockIds.has(id))) {
				group.open = false;
			}
		}
	}

	/** The still-open groups of `actionId`, as a snapshot: safe to {@link closeGroup} while iterating. */
	openGroups(actionId: ActionId): readonly PendGroup[] {
		return (this.entries.get(actionId)?.groups ?? []).filter(group => group.open);
	}

	/** Close one group returned by {@link openGroups} for `actionId` — the owner found none of its blocks still holding the action's pending record. */
	closeGroup(actionId: ActionId, group: PendGroup): void {
		const tracked = this.entries.get(actionId)?.groups.find(candidate => candidate === group);
		if (tracked !== undefined) {
			tracked.open = false;
		}
	}

	hasOpenGroups(actionId: ActionId): boolean {
		return this.entries.get(actionId)?.groups.some(group => group.open) ?? false;
	}

	/**
	 * Hold `event` under `actionId`, which must still have an open group. Returns `true` when it is
	 * the action's FIRST held event — the moment the owner arms the hold's bounding timer.
	 */
	hold(actionId: ActionId, event: CollectionChangeEvent): boolean {
		const entry = this.entries.get(actionId);
		if (entry === undefined) {
			throw new Error(`ActionChangeHold: cannot hold an event of untracked action ${actionId}`);
		}
		entry.held.push(event);
		return entry.held.length === 1;
	}

	/**
	 * Take `actionId`'s held events, in the order they were held, and forget the action — its groups
	 * included. One synchronous step, so two callers racing to release cannot both fire the same
	 * events: the second finds nothing. Called when the action's last open group closes, when the
	 * bounding timer fires, and on eviction. An unknown action yields nothing.
	 */
	release(actionId: ActionId): CollectionChangeEvent[] {
		const entry = this.entries.get(actionId);
		if (entry === undefined) {
			return [];
		}
		this.entries.delete(actionId);
		return entry.held;
	}

	/**
	 * Drop every action older than {@link staleEntryMs} that holds no events: a writer that pended
	 * here and vanished before committing or cancelling. An action WITH held events is never aged
	 * out here — its bounding timer releases it. Entries are created in order, so the walk stops at
	 * the first one young enough to keep.
	 */
	ageOut(now: number): void {
		for (const [actionId, entry] of this.entries) {
			if (now - entry.since < this.staleEntryMs) {
				return;
			}
			if (entry.held.length === 0) {
				this.entries.delete(actionId);
			}
		}
	}

	/** How many actions are tracked, for tests and diagnostics. */
	get size(): number {
		return this.entries.size;
	}

	private evictOldestIfFull(): EvictedAction | undefined {
		if (this.entries.size < this.maxActions) {
			return undefined;
		}
		const oldest = this.entries.keys().next();
		if (oldest.done) {
			return undefined;
		}
		return { actionId: oldest.value, held: this.release(oldest.value) };
	}
}

export interface ActionChangeHoldOptions {
	/** Actions tracked at most; the oldest is evicted (its held events released) to admit a new one. Default {@link DEFAULT_MAX_HELD_ACTIONS}. */
	maxActions?: number;
	/** Age past which an action holding no events is dropped by {@link ActionChangeHold.ageOut}. Default {@link DEFAULT_STALE_ENTRY_MS}. */
	staleEntryMs?: number;
}

/** One `pend` call's saved blocks for an action, as the owner sees it: read-only, mutated only through {@link ActionChangeHold}. */
export interface PendGroup {
	readonly blockIds: ReadonlySet<BlockId>;
	readonly open: boolean;
}

/** An action evicted at capacity: its id, so the owner drops its timer, and the events it held, to release. */
export interface EvictedAction {
	readonly actionId: ActionId;
	readonly held: CollectionChangeEvent[];
}

/** {@link PendGroup} as this module keeps it. */
interface TrackedGroup extends PendGroup {
	readonly blockIds: Set<BlockId>;
	open: boolean;
}

interface ActionEntry {
	readonly groups: TrackedGroup[];
	readonly held: CollectionChangeEvent[];
	/** When the action was first pended here, for {@link ActionChangeHold.ageOut}. */
	readonly since: number;
}

/** Actions tracked at most; a node sees nowhere near this many in flight, so the cap only bounds a flood of pends that never commit. */
export const DEFAULT_MAX_HELD_ACTIONS = 4096;

/** A writer that pended here and went silent is forgotten after this long. Well past any transaction's expiry. */
export const DEFAULT_STALE_ENTRY_MS = 5 * 60_000;
