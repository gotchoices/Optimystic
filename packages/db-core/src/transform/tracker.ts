import type { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, BlockSource as IBlockSource, ReadPurpose } from "../index.js";
import { applyOperation, applyOperations, applyTransform, emptyTransforms, blockIdsForTransforms, transformForBlockId } from "./helpers.js";
import { BasePins } from "./base-pins.js";
import type { PinnedBase } from "./base-pins.js";
import { ensured } from "../utility/ensured.js";

/** The two base probes a source may offer, duck-typed because Tracker layers over test doubles as
 * well as CacheSource. `peek` must return a clone (CacheSource's does). */
type BaseProbes = {
	peek?: (id: BlockId) => IBlock | undefined;
	getCachedRevision?: (id: BlockId) => number | undefined;
	getGeneration?: (id: BlockId) => number;
	retains?: (id: BlockId) => boolean;
};

/** The base a source can answer from memory, with the committed revision of that content — the
 * shared probe behind the unpinned {@link Tracker.peekMaterialized} path, for a source that cannot
 * report drift and so takes no pins. Returns undefined unless BOTH probes answer. */
function cachedBase(source: unknown, id: BlockId): { block: IBlock; rev: number } | undefined {
	const src = source as BaseProbes;
	if (typeof src.peek !== 'function' || typeof src.getCachedRevision !== 'function') return undefined;
	const block = src.peek(id);                        // already a clone (peek contract)
	const rev = src.getCachedRevision(id);
	return block === undefined || rev === undefined ? undefined : { block, rev };
}

/** A block store that collects transformations, without applying them to the underlying source.
 * Transformations are also applied to the retrieved blocks, making it seem like the source has been modified.
 */
export class Tracker<T extends IBlock> implements IBlockStore<T> {
	/** Per-id memo of the materialized (source block + all `updates[id]` ops) result, so a
	 * repeated read of a hot op-carrying block is O(block size) instead of O(block size + ops).
	 * Kept fresh incrementally on {@link update}, dropped on {@link insert}/{@link delete}/{@link reset},
	 * and invalidated when the source's generation for the id advances (external cache mutation).
	 * Only populated for sources that expose `getGeneration` — without a drift signal we cannot
	 * detect source changes, so those fall back to always-replay. `gen` is the source generation of
	 * the base block content the memo was built from. */
	private materialized = new Map<BlockId, { block: T; gen: number }>();

	constructor(
		private readonly source: IBlockSource<T>,
		/** The collected set of transformations to be applied. Treat as immutable */
		public transforms = emptyTransforms(),
		/** Committed bases pinned at the moment each update was staged, so the digest pass can
		 * describe every updated block even after the read cache evicts its base, and so the pend
		 * can name the revision each block's operations were computed against. Shared by
		 * reference across the trackers of one transaction (see {@link BasePins}); pass an
		 * existing store to join a transaction, omit for a private one. */
		public readonly pins: BasePins = new BasePins(),
	) {
		// A pin's `gen` and `rev` are counters PRIVATE to one base source, so a store may only be
		// shared between trackers that bottom out at the same one. Binding here turns the otherwise
		// silent failure (a pin from cache A passing the freshness check against cache B, which
		// numbers generations from 0 independently, and declaring A's content for B's block) into a
		// throw at the moment the stores are joined.
		pins.bindAuthority(this.baseSource());
	}

	/** The non-Tracker source at the bottom of the tracker stack. Single authority for everything
	 * pin-related: an Atomic layers over a Collection's tracker, which layers over the read cache,
	 * and only that cache can report a base, its committed revision, and its drift generation. */
	private baseSource(): BaseProbes {
		let src: unknown = this.source;
		while (src instanceof Tracker) src = src.source;
		return src as BaseProbes;
	}

	/** The source's generation for an id, or undefined if the source cannot report drift. */
	private sourceGeneration(id: BlockId): number | undefined {
		const src = this.source as { getGeneration?: (id: BlockId) => number };
		return typeof src.getGeneration === 'function' ? src.getGeneration(id) : undefined;
	}

	/** Whether the source will answer the next read of `id` from memory with the base it just served.
	 * A source that cannot say is taken to — the behaviour before the probe, and right for every
	 * source but a CacheSource handing an answer through unkept.
	 *
	 * The generation cannot carry this. A memo is stamped with the generation read AFTER the load
	 * (see {@link tryGet}), so however the source bumps while handing an unkept answer through, the
	 * stamp matches on the next read and the memo is served — freezing, under this tracker's staged
	 * ops, exactly the base the source declined to freeze. */
	private sourceRetains(id: BlockId): boolean {
		const src = this.source as { retains?: (id: BlockId) => boolean };
		return typeof src.retains !== 'function' || src.retains(id);
	}

	/** The drift generation from the same authority {@link probeBase} pins from — the base source,
	 * so an Atomic validates its pins against the collection's read cache rather than against the
	 * drift-blind tracker in between. */
	protected baseGeneration(id: BlockId): number | undefined {
		const src = this.baseSource();
		return typeof src.getGeneration === 'function' ? src.getGeneration(id) : undefined;
	}

	/** The base for `id` as the base source describes it now: its committed revision, its content
	 * when the source still has it, and the source's drift generation. Taken from
	 * {@link baseSource}, so an Atomic staged over a Collection's tracker pins from the collection's
	 * read cache instead of finding nothing. Returns undefined unless the source reports drift and a
	 * revision — which keeps drift-blind sources (test doubles) on exactly the pre-pin behaviour,
	 * and leaves a blind update (a block never read, or read and since cleared) unpinned. A
	 * revision without content is a REV-ONLY pin: the block was read and then evicted, so the base
	 * can be named but not materialized (see {@link PinnedBase.block}). Recency-neutral. */
	protected probeBase(id: BlockId): PinnedBase | undefined {
		const src = this.baseSource();
		// Without a drift signal a pin could never be re-judged, so never take one.
		if (typeof src.getGeneration !== 'function' || typeof src.getCachedRevision !== 'function') return undefined;
		const rev = src.getCachedRevision(id);
		if (rev === undefined) return undefined;
		const block = typeof src.peek === 'function' ? src.peek(id) : undefined;
		return { rev, gen: src.getGeneration(id), ...(block === undefined ? {} : { block }) };
	}

	/** Re-judge `pin` against what the base source describes for `id` NOW, if the source's
	 * generation for the id has advanced since the pin was last judged. The source's content for
	 * the id changed hands; whether the BASE moved is a question of revision, not generation:
	 *
	 * - the same revision (a re-load of an evicted id, a refresh that re-read identical content, a
	 *   below-floor answer served again) is the same committed content, so the pin is refreshed in
	 *   place — the clone filled or replaced, the generation restamped — and stays declarable;
	 * - a different revision, or none (the id cleared, folded away, or handed through at another
	 *   revision), means the staged operations were computed on content the source no longer
	 *   describes. The pin is marked {@link PinnedBase.moved} and is never repaired here: re-pinning
	 *   would put the new revision on operations built for the old one, which is precisely the wrong
	 *   base the storage guard cannot catch. Only a re-stage (which resets this tracker) recovers.
	 *
	 * Cheap — one generation compare on the common path, two probes on drift — so every consumer of
	 * a pin runs it first. */
	private revalidatePin(id: BlockId, pin: PinnedBase): PinnedBase {
		const gen = this.baseGeneration(id);
		if (pin.moved || gen === undefined || pin.gen === gen) return pin;
		const src = this.baseSource();
		const rev = typeof src.getCachedRevision === 'function' ? src.getCachedRevision(id) : undefined;
		if (rev !== pin.rev) {
			this.pins.markMoved(id);
			return pin;
		}
		const block = typeof src.peek === 'function' ? src.peek(id) : undefined;
		const refreshed: PinnedBase = { rev, gen, ...(block ?? pin.block ? { block: block ?? pin.block } : {}) };
		this.pins.set(id, refreshed);
		return refreshed;
	}

	async tryGet(id: BlockId, purpose: ReadPurpose = 'value'): Promise<T | undefined> {
		// NOTE: precedence here is insert > delete > source+updates. In a well-formed transform an id is
		// never in both `inserts` and `deletes` (insert/delete each clear the other), so order is moot. It
		// only diverges from the canonical `applyTransform` (delete-last-wins, see struct.ts / helpers.ts:132)
		// in the malformed insert+delete state reachable via the phantom-delete bug (double-delete then
		// reinsert). Likewise the insert path intentionally skips `updates[id]` — inserted blocks bake ops
		// in-place via update(); a stale pre-insert `updates[id]` is discarded here but would be re-applied
		// on commit. Both are read-vs-commit inconsistencies confined to malformed states; fix the source
		// bug (phantom delete / stale updates) rather than papering over it here.
		if (this.transforms.inserts && Object.hasOwn(this.transforms.inserts, id)) {
			return structuredClone(this.transforms.inserts[id]) as T;
		}
		if (this.transforms.deletes?.includes(id)) {
			return undefined;
		}
		const gen = this.sourceGeneration(id);
		const memo = this.materialized.get(id);
		if (memo && (gen === undefined || memo.gen === gen)) {
			return structuredClone(memo.block);           // O(block size), no replay
		}
		const block = await this.source.tryGet(id, purpose);
		if (block) {
			const ops = this.transforms.updates?.[id] ?? [];
			if (ops.length > 0) {
				// A read of a block whose base has MOVED under its staged ops is served as the live
				// content plus those ops all the same — never refused. The pend is what pays for a
				// moved base (Collection.restageIfBasesMoved), with one replay.
				applyOperations(block, ops);
				// Memoize only when the source can report drift, and stamp with the generation read
				// AFTER the load — the source may bump during tryGet (a cache miss-load), and stamping
				// with the pre-load generation would force a needless reload on the very next read.
				// And only over a base the source kept: one it will re-ask for must be re-asked for
				// here too, or this memo outlives the source's own refusal to remember it.
				const freshGen = this.sourceGeneration(id);
				if (freshGen !== undefined && this.sourceRetains(id)) {
					this.materialized.set(id, { block, gen: freshGen });
				} else {
					this.materialized.delete(id);
				}
				return structuredClone(block);              // clone so callers can't mutate the memo
			}
		}
		return block;                                    // no-ops path unchanged (source already cloned)
	}

	/** The block `id` materializes to under the staged transforms, computed WITHOUT loading from the
	 * source, plus the committed revision of the base used. `undefined` when not computable here —
	 * nothing staged for the id, the result is a delete, or an update's base cannot be materialized:
	 * unpinned over a drift-blind source and not locally cached (a commit must not pay a network
	 * round trip to describe itself), pinned rev-only (the content was evicted before the update was
	 * staged — the base is still named by {@link stagedBaseRevs}, only its digest is undeclared), or
	 * pinned but MOVED (the operations no longer describe any content; see {@link revalidatePin}).
	 *
	 * Materializes with the canonical {@link applyTransform} — the exact function the member side
	 * uses at commit — so client and member can never disagree on semantics (insert replaces the
	 * block, then updates apply, then delete wins). An insert makes the result base-independent, so
	 * `baseRev` is absent; updates-only returns the pinned base's revision, which is the revision the
	 * staged operations were computed against — never the live cache's, which may have moved on.
	 * Memo-neutral and recency-neutral: reads observe no change. The one thing it may record is the
	 * discovery that a pinned base has moved. */
	peekMaterialized(id: BlockId): { block: IBlock; baseRev?: number } | undefined {
		const transform = transformForBlockId(this.transforms, id);
		if (transform.insert === undefined && transform.updates === undefined && transform.delete === undefined) {
			return undefined;                              // nothing staged for this id
		}
		if (transform.delete) {
			return undefined;                              // delete-last-wins: materializes to nothing
		}
		if (transform.insert) {
			// No clone needed: transformForBlockId already deep-cloned `insert`, which applyTransform mutates.
			const block = applyTransform(undefined, transform);
			return block ? { block } : undefined;
		}
		const pin = this.pins.get(id);
		if (pin) {
			const current = this.revalidatePin(id, pin);
			if (current.moved || current.block === undefined) return undefined;
			// The clone on use is required, not defensive: applyTransform mutates, and syncAttempts
			// re-runs the digest pass on every retry attempt against the same pin.
			const block = applyTransform(structuredClone(current.block), transform);
			return block ? { block, baseRev: current.rev } : undefined;
		}
		// Unpinned. Over a drift-aware base source that is a blind update (the block was never read,
		// or was cleared before the update was staged): nothing is known about what the operations
		// were computed against, so nothing is declared — the live cache may hold the block by now,
		// but declaring ITS revision would name a base the operations were not built on. Only a
		// drift-blind source, which takes no pins, keeps its pre-pin behaviour: the IMMEDIATE source's
		// live peek, not {@link baseSource}, exactly as before pins existed.
		if (typeof this.baseSource().getGeneration === 'function') return undefined;
		const base = cachedBase(this.source, id);
		if (!base) return undefined;
		const block = applyTransform(base.block, transform); // base already a clone (peek contract)
		return block ? { block, baseRev: base.rev } : undefined;
	}

	/** Per block in `blockIds`, the committed revision its staged UPDATE operations were computed
	 * against — the pinned base, fixed when the first of them was staged and unchanged since, even
	 * if the base has moved (a moved base is still the truth about the operations; the pend
	 * carrying it is refused, which is the point). Only update-only blocks are named: an inserted
	 * block is base-independent, a deleted one materializes to nothing, and a block updated
	 * without a pin (a blind update, or a drift-blind source) has no base to name. */
	stagedBaseRevs(blockIds: readonly BlockId[]): Record<BlockId, number> {
		const revs: Record<BlockId, number> = {};
		for (const id of blockIds) {
			if (!this.isUpdateOnly(id)) continue;
			const pin = this.pins.get(id);
			if (pin) revs[id] = pin.rev;
		}
		return revs;
	}

	/** The staged update-only blocks whose pinned base has MOVED — the base source no longer
	 * describes the id at the revision the operations were computed against — after re-judging
	 * every such pin against the source (one generation compare each; see {@link revalidatePin}).
	 * Restricted to ids THIS tracker stages as updates: the shared store can also hold pins an
	 * abandoned per-attempt tracker took for its log blocks, which describe operations this tracker
	 * does not carry. A non-empty answer means the pending actions must be re-staged before they
	 * are pended (Collection.restageIfBasesMoved). */
	movedBases(): BlockId[] {
		const moved: BlockId[] = [];
		for (const id of Object.keys(this.transforms.updates ?? {}) as BlockId[]) {
			const pin = this.pins.get(id);
			if (pin && this.isUpdateOnly(id) && this.revalidatePin(id, pin).moved) moved.push(id);
		}
		return moved;
	}

	/** The staged update-only blocks whose pinned base the base source describes but does not RETAIN
	 * — content handed through unkept (a below-floor answer), which the source re-asks for on every
	 * read. The pin names the revision last served; storage may have caught up since without any
	 * log movement to say so, and only a read can tell. The candidates for a pre-pend re-read. */
	unretainedBases(): BlockId[] {
		const src = this.baseSource();
		if (typeof src.retains !== 'function' || typeof src.peek !== 'function') return [];
		const ids: BlockId[] = [];
		for (const id of Object.keys(this.transforms.updates ?? {}) as BlockId[]) {
			if (this.isUpdateOnly(id) && this.pins.get(id) && !src.retains(id) && src.peek(id) !== undefined) ids.push(id);
		}
		return ids;
	}

	/** Whether `id` is staged as updates alone — not inserted (base-independent) and not deleted
	 * (materializes to nothing), the two shapes for which no base is ever named. */
	private isUpdateOnly(id: BlockId): boolean {
		return (this.transforms.updates?.[id]?.length ?? 0) > 0
			&& !(this.transforms.inserts && Object.hasOwn(this.transforms.inserts, id))
			&& !this.transforms.deletes?.includes(id);
	}

	/** Forward a leaf-value upgrade down to the source's read collector (duck-typed: only the
	 *  CacheSource layer implements it). Lets the B-tree point-lookup descent, which reads through
	 *  this tracker, pin its terminal leaf as a `value` read after tagging interior nodes
	 *  `navigation`. No-op for sources without a collector (test doubles, log-walk caches). */
	markReadValue(id: BlockId): void {
		(this.source as { markReadValue?: (id: BlockId) => void }).markReadValue?.(id);
	}

	generateId(): BlockId {
		return this.source.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.source.createBlockHeader(type, newId);
	}

	insert(block: T) {
		const inserts = this.transforms.inserts ??= {};
		inserts[block.header.id] = structuredClone(block);
		// Served from `inserts` now, not source+updates — the materialized memo no longer applies.
		this.materialized.delete(block.header.id);
		// An insert makes the materialized result base-independent, so any pinned base is moot.
		this.pins.delete(block.header.id);
		const deletes = this.transforms.deletes;
		const deleteIndex = deletes?.indexOf(block.header.id) ?? -1;
		if (deleteIndex >= 0) {
			deletes!.splice(deleteIndex, 1);
		}
	}

	update(blockId: BlockId, op: BlockOperation) {
		const inserted = this.transforms.inserts?.[blockId];
		if (inserted) {
			applyOperation(inserted, op);
			return;
		}
		const updates = this.transforms.updates ??= {};
		const ops = ensured(updates, blockId, () => []);
		const first = ops.length === 0;
		ops.push(structuredClone(op));
		// The memo already equals (base source content + prior ops); applying just the new op
		// keeps it equal to the full ops list — O(1), no full replay. Leave `gen` untouched: it
		// still records the base-content generation, so a later external source change still
		// forces a reload. (Refreshing gen here would mask stale base content.)
		const memo = this.materialized.get(blockId);
		if (memo) {
			applyOperation(memo.block, op);
		}
		if (first) {
			this.pinBase(blockId);
		} else {
			const existing = this.pins.get(blockId);
			if (existing) this.revalidatePin(blockId, existing);
		}
	}

	/** Fix the base of `id`'s staged operations at the moment the FIRST of them is staged in this
	 * tracker: the caller just read the block, so the base source describes what the operation was
	 * computed against.
	 *
	 * The store may already hold a pin for the id. One that names the revision the source describes
	 * NOW, and has not moved, is the base of this op list too — the same committed content — and is
	 * kept: that is how an Atomic's flush into its parent ({@link Atomic.commit} adopts the atomic's
	 * pins, then replays its ops through the parent's `update`) keeps the FULL pin the atomic took
	 * while the block was resident, instead of re-probing a cache that has since evicted it. Any
	 * other entry describes some OTHER tracker's operations — an abandoned per-attempt tracker's
	 * log-block pin from before a refresh cleared the block, say — and is replaced, or dropped when
	 * nothing can be pinned, so a stale entry never speaks for this op list. A later operation for
	 * the same id never re-pins: it re-judges the pin ({@link revalidatePin}), and a base found to
	 * have moved stays moved. */
	private pinBase(id: BlockId): void {
		const existing = this.pins.get(id);
		if (existing && !existing.moved && existing.rev === this.baseRevision(id)) {
			this.revalidatePin(id, existing);
			return;
		}
		const pin = this.probeBase(id);
		if (pin) this.pins.set(id, pin);
		else this.pins.delete(id);
	}

	/** The committed revision the base source describes for `id` now, or undefined if it cannot. */
	private baseRevision(id: BlockId): number | undefined {
		const src = this.baseSource();
		return typeof src.getCachedRevision === 'function' ? src.getCachedRevision(id) : undefined;
	}

	delete(blockId: BlockId) {
		if (this.transforms.inserts) delete this.transforms.inserts[blockId];
		if (this.transforms.updates) delete this.transforms.updates[blockId];
		this.materialized.delete(blockId);
		// A delete materializes to nothing (delete-last-wins), so the pinned base is moot.
		this.pins.delete(blockId);
		const deletes = this.transforms.deletes ??= [];
		deletes.push(blockId);
	}

	reset(newTransform = emptyTransforms()) {
		const oldTransform = this.transforms;
		this.transforms = newTransform;
		this.materialized.clear();
		// The single reclamation point for pins: a plain reset clears them (empty updates), a
		// rollback-style reset(transforms) keeps exactly the pins — moved marks included — for ids
		// still staged as updates.
		this.pins.retainOnly(Object.keys(newTransform.updates ?? {}));
		return oldTransform;
	}

	transformedBlockIds(): BlockId[] {
		return blockIdsForTransforms(this.transforms);
	}

	conflicts(blockIds: Set<BlockId>) {
		return this.transformedBlockIds().filter(id => blockIds.has(id));
	}
}
