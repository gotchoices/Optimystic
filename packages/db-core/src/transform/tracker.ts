import type { IBlock, BlockId, BlockStore as IBlockStore, BlockHeader, BlockOperation, BlockType, BlockSource as IBlockSource, ReadPurpose } from "../index.js";
import { applyOperation, applyOperations, applyTransform, emptyTransforms, blockIdsForTransforms, transformForBlockId } from "./helpers.js";
import { BasePins } from "./base-pins.js";
import type { PinnedBase } from "./base-pins.js";
import { ensured } from "../utility/ensured.js";

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
		 * describe every updated block even after the read cache evicts its base. Shared by
		 * reference across the trackers of one transaction (see {@link BasePins}); pass an
		 * existing store to join a transaction, omit for a private one. */
		public readonly pins: BasePins = new BasePins(),
	) { }

	/** The source's generation for an id, or undefined if the source cannot report drift. */
	private sourceGeneration(id: BlockId): number | undefined {
		const src = this.source as { getGeneration?: (id: BlockId) => number };
		return typeof src.getGeneration === 'function' ? src.getGeneration(id) : undefined;
	}

	/** The drift generation from the same authority {@link probeBase} pins from — chained through
	 * nested trackers so an Atomic (whose source is the collection's tracker) validates its pins
	 * against the collection's read cache, not against the drift-blind tracker in between. */
	protected baseGeneration(id: BlockId): number | undefined {
		if (this.source instanceof Tracker) return this.source.baseGeneration(id);
		return this.sourceGeneration(id);
	}

	/** The committed base for `id` as this tracker's source can report it, plus that source's
	 * revision and drift generation. Duck-typed on the source (CacheSource supplies all three),
	 * and CHAINED when the source is itself a Tracker — the Atomic case — so an Atomic staged over
	 * a Collection's tracker pins from the collection's read cache instead of finding nothing.
	 * Returns undefined unless ALL THREE probes are available, which keeps drift-blind sources
	 * (test doubles) on exactly the pre-pin behaviour. Recency-neutral: uses CacheSource.peek. */
	protected probeBase(id: BlockId): PinnedBase | undefined {
		if (this.source instanceof Tracker) return this.source.probeBase(id);
		const src = this.source as {
			peek?: (id: BlockId) => T | undefined;
			getCachedRevision?: (id: BlockId) => number | undefined;
			getGeneration?: (id: BlockId) => number;
		};
		if (typeof src.peek !== 'function' || typeof src.getCachedRevision !== 'function'
			|| typeof src.getGeneration !== 'function') return undefined;
		const block = src.peek(id);                      // already a clone (peek contract)
		const rev = src.getCachedRevision(id);
		// Require BOTH: an LRU-evicted id can leave a stale cached revision behind (see the NOTE on
		// CacheSource's revisions map); peek returning undefined keeps it from pairing with a block.
		if (block === undefined || rev === undefined) return undefined;
		return { block, rev, gen: src.getGeneration(id) };
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
				applyOperations(block, ops);
				// Memoize only when the source can report drift, and stamp with the generation read
				// AFTER the load — the source may bump during tryGet (a cache miss-load), and stamping
				// with the pre-load generation would force a needless reload on the very next read.
				const freshGen = this.sourceGeneration(id);
				if (freshGen !== undefined) {
					this.materialized.set(id, { block, gen: freshGen });
				}
				return structuredClone(block);              // clone so callers can't mutate the memo
			}
		}
		return block;                                    // no-ops path unchanged (source already cloned)
	}

	/** The block `id` materializes to under the staged transforms, computed WITHOUT loading from the
	 * source, plus the committed revision of the base used. `undefined` when not computable here —
	 * nothing staged for the id, the result is a delete, or an update's base is neither pinned
	 * (see {@link pins}) nor locally cached (a commit must not pay a network round trip to
	 * describe itself).
	 *
	 * Materializes with the canonical {@link applyTransform} — the exact function the member side
	 * uses at commit — so client and member can never disagree on semantics (insert replaces the
	 * block, then updates apply, then delete wins). An insert makes the result base-independent, so
	 * `baseRev` is absent; updates-only returns the base's cached committed revision, probed from the
	 * source via `peek`/`getCachedRevision` (duck-typed like {@link sourceGeneration}, because Tracker
	 * layers over test doubles; `peek` must return a clone — CacheSource's does). Recency-neutral and
	 * memo-neutral: observably changes no tracker or source state. */
	peekMaterialized(id: BlockId): { block: IBlock; baseRev?: number } | undefined {
		const transform = transformForBlockId(this.transforms, id);
		if (transform.insert === undefined && transform.updates === undefined && transform.delete === undefined) {
			return undefined;                              // nothing staged for this id
		}
		if (transform.delete) {
			return undefined;                              // delete-last-wins: materializes to nothing
		}
		if (transform.insert) {
			// applyTransform mutates the insert in place when updates ride along; transformForBlockId
			// clones `updates` but NOT `insert`, so clone here to keep the staged transform pristine.
			transform.insert = structuredClone(transform.insert);
			const block = applyTransform(undefined, transform);
			return block ? { block } : undefined;
		}
		// Prefer the base pinned when the update was staged — it survives read-cache eviction, which
		// is what keeps digest coverage a function of the transaction rather than of cache residency.
		// The freshness check is correctness-critical, not an optimisation: a stale pin would declare
		// a digest the member disagrees with, turning a blind-but-passing vote into a REJECT — an
		// inaccurate declaration is strictly worse than no declaration, so a drifted pin falls through
		// to the live peek below (which re-answers from the refreshed cache, or omits). The clone on
		// use is also required, not defensive: applyTransform mutates, and syncAttempts re-runs the
		// digest pass on every retry attempt against the same pin.
		const pin = this.pins.get(id);
		if (pin && pin.gen === this.baseGeneration(id)) {
			const block = applyTransform(structuredClone(pin.block), transform);
			return block ? { block, baseRev: pin.rev } : undefined;
		}
		const src = this.source as {
			peek?: (id: BlockId) => T | undefined;
			getCachedRevision?: (id: BlockId) => number | undefined;
		};
		if (typeof src.peek !== 'function' || typeof src.getCachedRevision !== 'function') return undefined;
		const base = src.peek(id);
		const baseRev = src.getCachedRevision(id);
		// Require BOTH: an LRU-evicted id can leave a stale cached revision behind (see the NOTE on
		// CacheSource's revisions map); peek returning undefined keeps it from pairing with a block.
		if (base === undefined || baseRev === undefined) return undefined;
		const block = applyTransform(base, transform);   // base already a clone (peek contract)
		return block ? { block, baseRev } : undefined;
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
		} else {
			const updates = this.transforms.updates ??= {};
			ensured(updates, blockId, () => []).push(structuredClone(op));
			// The memo already equals (base source content + prior ops); applying just the new op
			// keeps it equal to the full ops list — O(1), no full replay. Leave `gen` untouched: it
			// still records the base-content generation, so a later external source change still
			// forces a reload. (Refreshing gen here would mask stale base content.)
			const memo = this.materialized.get(blockId);
			if (memo) {
				applyOperation(memo.block, op);
			}
			// Pin the committed base NOW — the caller just read this block, so it is resident — and
			// only when there is no still-fresh pin, so a block updated 50 times pays one base clone.
			// A generation change (an external commit folded into the cache) re-pins against the new
			// base, which is the base the member will apply the whole op list to.
			// NOTE: read-far-then-update stays unpinned — a block read, then evicted by 128+ other
			// reads, and only then updated, probes an already-evicted cache here and is omitted from
			// the digest (pre-existing behaviour; digest.spec.ts pins it). If a workload ever reads a
			// large batch before writing any of it, the closure is to pin on READ for ids that later
			// get updated, at retention proportional to reads rather than to writes.
			const existing = this.pins.get(blockId);
			if (!existing || existing.gen !== this.baseGeneration(blockId)) {
				const pin = this.probeBase(blockId);
				if (pin) this.pins.set(blockId, pin);
			}
		}
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
		// rollback-style reset(transforms) keeps exactly the pins for ids still staged as updates.
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
