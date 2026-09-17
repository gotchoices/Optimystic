import type { ActionContext, ActionId, BlockId } from "../index.js";

/** The lowest revision a block may be served at, and the action that set it.
 *
 * A refresh walks the log entries that landed since the collection last looked. Each entry says
 * "action `actionId`, committed at revision `rev`, changed these blocks", and every block an action
 * changes is committed at that action's revision. So once an entry has been walked, a read of a
 * block it names — made at a context at or above `rev` — must come back materialized at `rev` or
 * later; anything lower is provably not the view that was asked for. The FLOOR of a block is that
 * bound: the revision and action id of the newest walked entry naming it. */
export type BlockFloor = {
	readonly rev: number;
	readonly actionId: ActionId;
};

/** A BELOW-FLOOR ANSWER: a block served at a revision under the floor that applied to the read. */
export type BelowFloorAnswer = {
	blockId: BlockId;
	floor: BlockFloor;
	/** The revision the served content actually is (`servedRevision` of the answer). */
	servedRev: number;
};

/** What a read source needs from a collection's floors: which floor applies to a read, and whether
 * an answer fell under it. {@link BlockFloors} is the collection's own; {@link BlockFloors.checkOnly}
 * is the same judgement for a source that must not retire anything. */
export interface BlockFloorCheck {
	/** The floor a read of `blockId` at `context` must meet, or `undefined` when none applies.
	 *
	 * A floor applies only to a view that should CONTAIN the entry that set it: an unpinned read, or
	 * one pinned at or above the floor's revision. A read pinned strictly below it legitimately asks
	 * for an older view and is served — and remembered — exactly as if there were no floor. (The same
	 * at-or-above test `answeredBlock` applies to `unconfirmedAheadRev`.) */
	applicableTo(blockId: BlockId, context: ActionContext | undefined): BlockFloor | undefined;

	/** Weighs a served block against the floor that applies to the read that fetched it.
	 *
	 * @param servedRev the revision the served content is — `servedRevision` of the answer.
	 * @returns `true` for a below-floor answer, which the caller hands on but must not let any cache
	 * remember (see `TransactorSource.describeServed`). */
	answeredBelowFloor(blockId: BlockId, context: ActionContext | undefined, servedRev: number): boolean;
}

/** The floors of one collection handle, shared by EVERY read source that handle builds — its own
 * and each pinned read view's — the way the `ReadDependencyCollector` is shared. Held on one
 * source only, a view created right after a refresh would fetch the changed block through a source
 * that knows no floor.
 *
 * Raised where log entries are consumed (`Collection.updateInternal`), checked where answers arrive
 * (`TransactorSource.tryGet`), and retired when the collection's own source receives an answer that
 * meets one.
 *
 * NOTE: a floor is retired only by an answer to a read, so one for a block this handle never reads
 * again (including a block the entry deleted) is never retired. The map is therefore bounded by the
 * distinct blocks named by entries this handle walked — the same ids, and so the same bound, as
 * `CacheSource`'s never-pruned `generations` map, which `clear(entry.blockIds)` populates beside
 * every `raise`. If that ever grows large enough to matter, prune the two together; a dropped floor
 * only forfeits the check for that block, it never serves anything wrong by itself.
 *
 * NOTE: retiring on the first answer that meets a floor is what keeps the map small for a handle
 * that re-reads what changes, and it leaves one hole: a retired floor guards nothing, so content
 * kept, then evicted under cache pressure (128 blocks), then re-read from a machine STILL behind —
 * all inside that machine's lag, one read-repair window — is kept too old again, with no report.
 * (The concurrent form, a too-old answer landing just after the one that retired the floor, is
 * closed separately by `CacheSource.stillWanted`.) Never retiring would close it, at the cost of
 * the bound above applying to every block a walked entry ever named rather than only to those not
 * re-read — the `generations` map already pays exactly that. If a stale row is ever traced to a
 * block whose floor had been met, stop retiring (and drop `checkOnly`, which then has no job). */
export class BlockFloors implements BlockFloorCheck {
	private readonly floors = new Map<BlockId, BlockFloor>();

	/** @param onBelowFloor told about every below-floor answer, from any source sharing these floors
	 * — the collection reports them as `collection:block-below-floor`. */
	constructor(private readonly onBelowFloor?: (answer: BelowFloorAnswer) => void) {}

	/** Record that the walked entry `floor` describes changed `blockIds`. Highest revision wins, so
	 * entries may be walked in any order and re-walked harmlessly. */
	raise(blockIds: readonly BlockId[], floor: BlockFloor): void {
		for (const blockId of blockIds) {
			const held = this.floors.get(blockId);
			if (held === undefined || floor.rev > held.rev) {
				this.floors.set(blockId, floor);
			}
		}
	}

	applicableTo(blockId: BlockId, context: ActionContext | undefined): BlockFloor | undefined {
		const floor = this.floors.get(blockId);
		return floor !== undefined && (context === undefined || context.rev >= floor.rev) ? floor : undefined;
	}

	answeredBelowFloor(blockId: BlockId, context: ActionContext | undefined, servedRev: number): boolean {
		return this.weigh(blockId, context, servedRev, true);
	}

	/** These floors for a source whose answers land somewhere SHORT-LIVED — a pinned read view's
	 * private cache. It judges answers identically but never retires a floor.
	 *
	 * A floor exists to stop the collection's long-lived cache keeping a too-old answer, so its job
	 * is done only once THAT cache holds an answer meeting it. Were a view allowed to retire it, the
	 * collection's own next read of the block would arrive unguarded: nothing says the same machine
	 * answers twice, and a below-floor answer to that read would be kept forever — the defect floors
	 * exist to prevent, re-opened by whichever view happened to read first. */
	checkOnly(): BlockFloorCheck {
		return {
			applicableTo: (blockId, context) => this.applicableTo(blockId, context),
			answeredBelowFloor: (blockId, context, servedRev) => this.weigh(blockId, context, servedRev, false),
		};
	}

	/** How many floors are outstanding. */
	get size(): number {
		return this.floors.size;
	}

	private weigh(blockId: BlockId, context: ActionContext | undefined, servedRev: number, retireWhenMet: boolean): boolean {
		const floor = this.applicableTo(blockId, context);
		if (floor === undefined) {
			return false;
		}
		if (servedRev >= floor.rev) {
			if (retireWhenMet) {
				this.floors.delete(blockId);
			}
			return false;
		}
		this.onBelowFloor?.({ blockId, floor, servedRev });
		return true;
	}
}
