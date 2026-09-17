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
 * an answer fell under it. The narrow face of {@link BlockFloors} that `TransactorSource` holds. */
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
 * Raised where log entries are consumed (`Collection.updateInternal`) and checked where answers
 * arrive (`TransactorSource.tryGet`). A floor, once raised, STANDS for the life of the handle: an
 * answer that meets it does not remove it.
 *
 * Why a met floor is not dropped. The source that judges an answer cannot know whether any cache
 * went on to keep it, and "an answer met the floor" is not "the cache now holds that answer": the
 * cache drops an answer that was overtaken while in flight (`CacheSource.stillWanted`), and evicts
 * kept content under pressure (128 blocks). Either way the next read of the block goes back to
 * storage, where nothing says the same machine answers twice — and with the floor gone, a too-old
 * answer to THAT read is judged against nothing and kept for good, which is the defect floors exist
 * to prevent. Reproduced with the floor dropped when met: a too-old answer, then a current one that
 * the cache dropped as overtaken (but which removed the floor), then a too-old one — kept, and
 * served after storage had caught up (`refresh-below-floor.spec.ts`, "a current answer the cache
 * dropped..."). A standing floor costs one map lookup per fetched block and is always true of a
 * correct answer: a block never goes back below a revision it was committed at.
 *
 * NOTE: the map is never pruned, so it holds one small entry per distinct block named by entries
 * this handle walked — the same ids, and so the same bound, as `CacheSource`'s never-pruned
 * `generations` map, which `clear(entry.blockIds)` populates beside every `raise`. If that ever
 * grows large enough to matter, prune the two together (oldest floors first); a dropped floor only
 * forfeits the check for that block, it never serves anything wrong by itself. */
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
		const floor = this.applicableTo(blockId, context);
		if (floor === undefined || servedRev >= floor.rev) {
			return false;
		}
		this.onBelowFloor?.({ blockId, floor, servedRev });
		return true;
	}

	/** How many blocks have a floor. */
	get size(): number {
		return this.floors.size;
	}
}
