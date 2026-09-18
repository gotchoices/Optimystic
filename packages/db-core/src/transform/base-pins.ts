import type { BlockId, IBlock } from "../index.js";

/** The committed base of one block, fixed at the moment the FIRST update for it was staged in a
 * tracker. `rev` is the number the staged operations were computed against, and it never changes
 * while those operations remain staged: a later change to what the source holds for the id marks
 * the pin {@link moved} rather than replacing it (see {@link Tracker.revalidatePin}). */
export type PinnedBase = {
	/** Cloned base content. Absent for a REV-ONLY pin: the block was evicted from the read cache
	 *  between the read that computed the update and the update itself, so the revision is known
	 *  (the cache's per-id revision outlives the block) but the content is not — the base can be
	 *  declared, its digest cannot. Filled in if the same revision is later re-read.
	 *  Callers MUST clone before applying a transform — applyTransform mutates, and the same pin is
	 *  re-used by every retry attempt's digest pass. */
	block?: IBlock;
	/** Committed revision of the base (CacheSource.getCachedRevision at pin time). */
	rev: number;
	/** Source drift generation at the last validation (CacheSource.getGeneration). A generation
	 *  that no longer matches the source's means the source's content for the id changed hands
	 *  since; whether the BASE moved is decided by comparing revisions, not generations. */
	gen: number;
	/** The source no longer describes this id at `rev`: the staged operations were computed on
	 *  content that is not the content any commit would now apply them to. Never repaired in
	 *  place — only a re-stage (which resets the owning tracker) clears it. */
	moved?: true;
};

/** Per-transaction map of block id -> {@link PinnedBase}. Owned by a {@link Tracker}, shared by
 * reference across the trackers of one transaction (the collection's live tracker and each
 * per-attempt snapshot tracker), so a base pinned when an update was staged is still available
 * when the digest pass runs — regardless of whether the read cache has since evicted it.
 *
 * NOTE: memory shape — one cloned base block per update-carrying block (one number per block for
 * a rev-only pin), held from the first update staged for it until the owning tracker's next
 * reset(). Peak retention is proportional to the transaction's own write footprint (the same set
 * of blocks whose ids and ops the commit request already carries), and every transaction boundary
 * reclaims it via reset(). */
export class BasePins {
	private pins = new Map<BlockId, PinnedBase>();
	/** The base source every `rev`/`gen` in here was read from — see {@link bindAuthority}. */
	private authority: unknown;
	private bound = false;

	/** Claim this store for `source`, the base source at the bottom of the binding tracker's stack.
	 * A fresh store binds; a store being joined must present the same source. Both `rev` and `gen`
	 * are counters private to one source — a second CacheSource numbers generations from 0 for the
	 * same ids — so a store shared across two sources would let a pin taken from one pass the
	 * freshness check against the other and declare the wrong content. Throwing here makes that
	 * mistake impossible to make quietly. */
	bindAuthority(source: unknown): void {
		if (!this.bound) {
			this.authority = source;
			this.bound = true;
		} else if (this.authority !== source) {
			throw new Error('BasePins shared between trackers over different base sources: pin revisions and generations are per-source counters and are not comparable across them.');
		}
	}

	get(id: BlockId): PinnedBase | undefined {
		return this.pins.get(id);
	}

	set(id: BlockId, pin: PinnedBase): void {
		this.pins.set(id, pin);
	}

	delete(id: BlockId): void {
		this.pins.delete(id);
	}

	/** Record that the base under `id`'s staged operations has moved (see {@link PinnedBase.moved}).
	 * No-op for an unpinned id: with no pin there is no base to have moved from. */
	markMoved(id: BlockId): void {
		const pin = this.pins.get(id);
		if (pin) pin.moved = true;
	}

	/** Drop every pin whose id is not in `keep`. Called from Tracker.reset with the ids still
	 * carried by the new transforms' `updates`, so a rollback keeps its pins — moved marks
	 * included, the operations being the same operations — and a plain reset clears them. */
	retainOnly(keep: Iterable<BlockId>): void {
		const keepSet = new Set(keep);
		for (const id of this.pins.keys()) {
			if (!keepSet.has(id)) this.pins.delete(id);
		}
	}

	/** Fold every entry of `other` in. Called from Atomic.commit so pins captured inside the atomic
	 * survive into the parent tracker's store.
	 *
	 * An id the parent does not pin takes the atomic's pin. An id it pins at the SAME revision takes
	 * the atomic's too — the later observation of the same committed content, possibly with a clone
	 * a rev-only parent pin lacked. An id it pins at a DIFFERENT revision is a base that MOVED
	 * between the two actions: the parent's operations were computed on one content and the
	 * atomic's on another, and the combined list has no single base. The parent's pin is kept (its
	 * revision is what the earlier operations were built on) and marked moved, and a mark on either
	 * side survives the fold. */
	adopt(other: BasePins): void {
		if (other.authority !== this.authority) {
			throw new Error('BasePins.adopt across different base sources: pin revisions and generations are not comparable across them.');
		}
		for (const [id, pin] of other.pins) {
			const existing = this.pins.get(id);
			if (existing === undefined || (existing.rev === pin.rev && !existing.moved)) {
				this.pins.set(id, pin);
			} else {
				existing.moved = true;
			}
		}
	}

	get size(): number {
		return this.pins.size;
	}
}
