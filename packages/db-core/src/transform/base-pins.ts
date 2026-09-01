import type { BlockId, IBlock } from "../index.js";

/** The committed base of one block, captured at the moment an update for it was staged. */
export type PinnedBase = {
	/** Cloned base content. Callers MUST clone again before applying a transform — applyTransform
	 *  mutates, and the same pin is re-used by every retry attempt's digest pass. */
	block: IBlock;
	/** Committed revision of that base (CacheSource.getCachedRevision at pin time). */
	rev: number;
	/** Source drift generation at pin time (CacheSource.getGeneration). A pin whose generation no
	 *  longer matches the source's is STALE and must not be used. */
	gen: number;
};

/** Per-transaction map of block id -> {@link PinnedBase}. Owned by a {@link Tracker}, shared by
 * reference across the trackers of one transaction (the collection's live tracker and each
 * per-attempt snapshot tracker), so a base pinned when an update was staged is still available
 * when the digest pass runs — regardless of whether the read cache has since evicted it.
 *
 * NOTE: memory shape — one cloned base block per update-carrying block, held from the first
 * update staged for it until the owning tracker's next reset(). Peak retention is proportional
 * to the transaction's own write footprint (the same set of blocks whose ids and ops the commit
 * request already carries), and every transaction boundary reclaims it via reset(). */
export class BasePins {
	private pins = new Map<BlockId, PinnedBase>();

	get(id: BlockId): PinnedBase | undefined {
		return this.pins.get(id);
	}

	set(id: BlockId, pin: PinnedBase): void {
		this.pins.set(id, pin);
	}

	delete(id: BlockId): void {
		this.pins.delete(id);
	}

	/** Drop every pin whose id is not in `keep`. Called from Tracker.reset with the ids still
	 * carried by the new transforms' `updates`, so a rollback keeps its pins and a plain reset
	 * clears them. */
	retainOnly(keep: Iterable<BlockId>): void {
		const keepSet = new Set(keep);
		for (const id of this.pins.keys()) {
			if (!keepSet.has(id)) this.pins.delete(id);
		}
	}

	/** Copy every entry of `other` in, overwriting. Called from Atomic.commit so pins captured
	 * inside the atomic survive into the parent tracker's store. Overwriting is deliberate: the
	 * atomic's pin is the later observation of the same base chain, and the use-time freshness
	 * check re-validates it anyway. */
	adopt(other: BasePins): void {
		for (const [id, pin] of other.pins) {
			this.pins.set(id, pin);
		}
	}

	get size(): number {
		return this.pins.size;
	}
}
