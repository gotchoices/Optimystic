import type { IBlock, BlockHeader, BlockId, BlockSource, BlockType, ReadPurpose, Transforms } from "../index.js";
import { applyOperation } from "./helpers.js";
import { LruMap } from "../utility/lru-map.js";
import { createLogger } from "../logger.js";
import type { ReadDependencyCollector } from "../transaction/read-dependency-collector.js";

const log = createLogger('cache');

const DefaultMaxSize = 128;

/** The revision a source reports for an id, or undefined if the source can't report one.
 *  Duck-typed exactly like {@link Tracker}'s getGeneration probe — CacheSource layers over
 *  arbitrary BlockSources (including test doubles) that need not implement it. */
function sourceReadRevision(source: unknown, id: BlockId): number | undefined {
	const src = source as { getReadRevision?: (id: BlockId) => number | undefined };
	return typeof src.getReadRevision === 'function' ? src.getReadRevision(id) : undefined;
}

/** What the source says about `block`, the object it just returned for `id`: the revision the
 *  content is, and whether it may be kept and served again without re-asking.
 *
 *  Prefers the source's per-OBJECT answer (`describeServed`, which TransactorSource provides) over
 *  the by-id {@link sourceReadRevision}. This runs after an `await`, so with two reads of one id in
 *  flight a by-id record describes whichever answer the source processed last — not necessarily
 *  this one — and would stamp one answer's content with the other's revision and verdict. A source
 *  that offers neither allows keeping at revision 0, the behaviour before either probe existed. */
function sourceServed(source: unknown, id: BlockId, block: IBlock): { rev: number; mayRetain: boolean } {
	const src = source as { describeServed?: (block: IBlock) => { rev: number; mayRetain: boolean } | undefined };
	const described = typeof src.describeServed === 'function' ? src.describeServed(block) : undefined;
	return described ?? { rev: sourceReadRevision(source, id) ?? 0, mayRetain: true };
}

export class CacheSource<T extends IBlock> implements BlockSource<T> {
	protected cache: LruMap<BlockId, T>;
	/** Per-id monotonic counter, bumped whenever the cached content for an id changes.
	 * Consumers (e.g. {@link Tracker}'s materialized-block memo) read it via
	 * {@link getGeneration} to detect that a cached "source + ops" result has gone stale.
	 * Over-bumping is safe (it only forces a re-materialize); under-bumping is a correctness
	 * bug, so every content-changing site bumps. A benign LRU evict + reload also bumps. */
	// NOTE: generations is never pruned — it retains one small (id → number) entry per distinct id
	// ever touched, even after LRU eviction from `cache`. Bounded by the number of distinct blocks a
	// collection sees over its lifetime; if that ever grows large enough to matter, evict alongside
	// the LRU (dropping a generation is safe — a reload re-bumps from 0/absent, forcing re-materialize).
	private generations = new Map<BlockId, number>();
	/** Per-id committed revision of the content currently cached for that id. Learned from the
	 *  source on a miss-load, advanced by {@link transformCache} when a commit folds new content
	 *  in, and dropped alongside the cached block on delete/clear. Re-emitted on every cache HIT
	 *  so a hit records a read dependency at the right revision — the whole point of this map, since
	 *  the underlying source is never consulted on a hit. */
	// NOTE: an LRU-evicted id can leave a stale `revisions` entry (eviction drops `cache` but not
	// this map — see clear()/the LruMap eviction). Benign: the next read of that id is a cache MISS
	// that re-learns the revision from the source and overwrites the entry before recording anything.
	private revisions = new Map<BlockId, number>();
	/** The most recent answer per id that the source served but forbade keeping — a below-floor
	 *  answer, content older than a log entry the collection already walked says the block is (see
	 *  {@link sourceServed}). NEVER served to a read: {@link tryGet} re-asks the source every time
	 *  such an id is read, which is the whole point. It exists for the base probes alone
	 *  ({@link peek} / {@link getCachedRevision}): a write staged over this content must still declare
	 *  the base it was really built on, at the revision it was really served at. Were the block to go
	 *  undeclared instead, the storage-side guard that refuses a transform whose declared base is not
	 *  the one the member holds would abstain, and edits computed against the old content would be
	 *  applied over the newer content silently rather than refused loudly.
	 *  An id is never in both this map and `cache`/`revisions`. It leaves on its next keepable answer,
	 *  on {@link clear}, and on any {@link transformCache} that touches it, so the map is bounded by
	 *  the source's unmet floors. */
	private unkept = new Map<BlockId, { block: T; rev: number }>();

	constructor(
		protected readonly source: BlockSource<T>,
		maxSize = DefaultMaxSize,
		/** Shared per-transaction read-dependency accumulator (same instance the collection's
		 *  TransactorSource holds). Optional: log-walk caches that never form a transaction omit it. */
		private readonly collector?: ReadDependencyCollector,
		/** Pre-warm entries for a pinned read view — the output of another cache's
		 *  {@link snapshotEntries}. Entries are already cloned by snapshotEntries, so they are
		 *  adopted as-is; per-id revisions ride along so a seeded HIT still records at the
		 *  revision the block was committed at. Seeding does not bump generations (a fresh
		 *  cache has no consumers with stale memos). */
		seed?: ReadonlyArray<[BlockId, T, number]>,
	) {
		this.cache = new LruMap(maxSize);
		if (seed) {
			for (const [id, block, revision] of seed) {
				this.cache.set(id, block);
				this.revisions.set(id, revision);
			}
		}
	}

	private bump(id: BlockId) {
		this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
	}

	/** The current generation for an id — advances every time this cache's content for
	 * the id changes (miss-load, clear, or transformCache). Stable across pure cache hits. */
	getGeneration(id: BlockId): number {
		return this.generations.get(id) ?? 0;
	}

	async tryGet(id: BlockId, purpose: ReadPurpose = 'value'): Promise<T | undefined> {
		let block = this.cache.get(id);
		if (block) {
			// Cache hit: the source is never consulted, so re-emit the revision we learned when this
			// id was first loaded/folded. Without this a block served from cache records NO read
			// dependency (the original bug), so its stale-read check could never fire. Carry the
			// caller's purpose so a navigation-only cache hit stays droppable from the conflict set.
			const rev = this.revisions.get(id);
			if (rev !== undefined) this.collector?.record(id, rev, purpose);
			log('hit id=%s', id);
		} else {
			const generationAtMiss = this.getGeneration(id);
			block = await this.source.tryGet(id, purpose);
			if (block) {
				// Learn the revision from the source (which just served it) and record it. On a miss the
				// underlying TransactorSource already recorded the same id@rev/purpose into the shared
				// collector; max-wins (revision) + value-wins (purpose) collapse the two to one entry.
				const { rev, mayRetain } = sourceServed(this.source, id, block);
				if (!mayRetain) {
					this.handThrough(id, block, rev);
				} else if (this.stillWanted(id, rev, generationAtMiss)) {
					this.keep(id, block, rev);
				}
				this.collector?.record(id, rev, purpose);
			} else {
				// Absent block: record nothing (matches TransactorSource, which skips missing blocks).
				log('miss:absent id=%s', id);
			}
		}
		return structuredClone(block);
	}

	/** Whether an answer at `rev`, asked for when this id's generation was `generationAtMiss`, is
	 *  still one to keep now that it has arrived.
	 *
	 *  A miss is decided before the `await` and acted on after it. If the generation has not moved,
	 *  nothing happened to the id meanwhile and the answer is kept. If it has — a second read of the
	 *  id landed first, a refresh cleared it, a commit folded in ({@link transformCache}) — this answer
	 *  was asked for in a world that has since changed, and keeping it blindly is how old content gets
	 *  remembered for good: nothing clears a block but a log entry naming it, and that entry may be
	 *  the very thing that moved the generation. So it is then kept only to REPLACE strictly older
	 *  content (every answer to one source is for one view, so of two the higher revision is the
	 *  truer, whichever arrives last), and otherwise dropped — the reader that fetched it still gets
	 *  it, and the next read of the id asks again.
	 *  Only a CACHED id is compared: `revisions` can outlive an LRU-evicted block (see its NOTE). */
	private stillWanted(id: BlockId, rev: number, generationAtMiss: number): boolean {
		if (this.getGeneration(id) === generationAtMiss) {
			return true;
		}
		const held = this.cache.has(id) ? this.revisions.get(id) : undefined;
		const replacesOlder = held !== undefined && held < rev;
		if (!replacesOlder) {
			log('miss:overtaken id=%s rev=%d heldRev=%s', id, rev, held ?? 'none');
		}
		return replacesOlder;
	}

	/** A keepable answer: cached, and served to every later read of `id` until something clears it. */
	private keep(id: BlockId, block: T, rev: number) {
		this.cache.set(id, block);
		this.revisions.set(id, rev);
		this.unkept.delete(id);
		this.bump(id);
		log('miss:loaded id=%s cacheSize=%d', id, this.cache.size);
	}

	/** An answer the source forbade keeping: returned to this one reader and described to the base
	 *  probes (see {@link unkept}), but the next read of `id` asks the source again.
	 *
	 *  If the id was filled while this read was out (a concurrent read that was answered well, or a
	 *  folded commit), that content stands and this answer leaves no trace here: a cached id is never
	 *  also in {@link unkept}.
	 *
	 *  Bumped like a load: the answer changes what this cache can say about the id, and the bump is
	 *  what invalidates a base pin or a materialized memo built on whatever the previous answer was. */
	private handThrough(id: BlockId, block: T, rev: number) {
		if (this.cache.has(id)) {
			return;
		}
		this.revisions.delete(id);
		this.unkept.set(id, { block, rev });
		this.bump(id);
		log('miss:unkept id=%s rev=%d', id, rev);
	}

	/** The base this cache can describe for `id`, without consulting the source: the cached block,
	 *  or the content last handed through unkept (see {@link unkept}). Cloned (callers apply ops
	 *  to it) and recency-neutral ({@link LruMap.peek}) — an observation pass must neither pay a
	 *  network read nor reshape eviction order. Records no read dependency: the caller that peeks
	 *  already read the block through {@link tryGet} (that is how this cache learned it), so the
	 *  dependency exists; a digest pass merely re-describes it. */
	peek(id: BlockId): T | undefined {
		const block = this.cache.peek(id) ?? this.unkept.get(id)?.block;
		return block === undefined ? undefined : structuredClone(block);
	}

	/** Whether a later {@link tryGet} of `id` is answered from memory with the content this cache
	 *  holds now. `false` for content handed through unkept, which {@link peek} still describes — so
	 *  a consumer that would FREEZE a read result ({@link Tracker}'s materialized memo) asks this, not
	 *  {@link peek}. Recency-neutral. */
	retains(id: BlockId): boolean {
		return this.cache.has(id);
	}

	/** The committed revision of the content currently cached for `id` — the source-reported
	 *  materialized revision learned on miss-load (see {@link revisions}), NOT the block's own
	 *  `state.latest.rev`. An LRU-evicted id can leave a stale entry here (see the NOTE on
	 *  {@link revisions}); callers must therefore require BOTH {@link peek} and this to be present —
	 *  {@link peek} returns `undefined` for the evicted id, so a stale revision never pairs with a
	 *  peeked block. */
	getCachedRevision(id: BlockId): number | undefined {
		return this.revisions.get(id) ?? this.unkept.get(id)?.rev;
	}

	/** Upgrade an already-captured read of `id` to a `value` read in the shared collector,
	 *  retaining it in the conflict set. The B-tree point-lookup descent calls this (through the
	 *  Tracker, which forwards) to pin the terminal leaf after recording the interior nodes as
	 *  `navigation`. No-op when no collector is wired (log-walk caches) or the id was never
	 *  recorded. Duck-typed by the Tracker; keep the name in sync with Tracker.markReadValue. */
	markReadValue(id: BlockId): void {
		this.collector?.markValue(id);
	}

	generateId(): BlockId {
		return this.source.generateId();
	}

	createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader {
		return this.source.createBlockHeader(type, newId);
	}

	clear(blockIds: BlockId[] | undefined = undefined) {
		if (blockIds) {
			for (const id of blockIds) {
				this.cache.delete(id);
				this.revisions.delete(id);
				this.unkept.delete(id);
				this.bump(id);
			}
		} else {
			for (const [id] of this.cache) {
				this.bump(id);
			}
			for (const id of this.unkept.keys()) {
				this.bump(id);
			}
			this.cache.clear();
			this.revisions.clear();
			this.unkept.clear();
		}
	}

	/** A cloned copy of the current cache contents with each id's committed revision, in LRU
	 *  order (oldest first, so replaying into another LruMap preserves eviction order). For
	 *  building a pinned read view ONLY (see {@link Collection.createReadTracker}): pass the
	 *  result as the `seed` of a fresh, PRIVATE CacheSource. Blocks are cloned on the way out,
	 *  so the seeded cache shares no mutable state with this one. */
	snapshotEntries(): Array<[BlockId, T, number]> {
		const entries: Array<[BlockId, T, number]> = [];
		for (const [id, block] of this.cache) {
			entries.push([id, structuredClone(block), this.revisions.get(id) ?? 0]);
		}
		return entries;
	}

	/** Mutates the cache without affecting the source. `revision` is the committed revision this
	 *  transform lands at; the stored per-id revision advances to it so a later read records a
	 *  dependency at the NEW revision (recording the old one would spuriously fail validation). */
	transformCache(transform: Transforms, revision: number) {
		for (const blockId of transform.deletes ?? []) {
			this.cache.delete(blockId);
			this.revisions.delete(blockId);
			this.unkept.delete(blockId);
			this.bump(blockId);
		}
		for (const [, block] of Object.entries(transform.inserts ?? {})) {
			this.cache.set(block.header.id, structuredClone(block) as T);
			this.revisions.set(block.header.id, revision);
			this.unkept.delete(block.header.id);
			this.bump(block.header.id);
		}
		for (const [blockId, operations] of Object.entries(transform.updates ?? {})) {
			const block = this.cache.get(blockId);
			if (block) {
				for (const op of operations) {
					applyOperation(block, op);
					this.bump(blockId);
				}
				this.revisions.set(blockId, revision);
			} else if (this.unkept.delete(blockId)) {
				// The commit superseded the unkept base, and the ops are NOT folded into it: it was
				// never trusted as this id's content, so the result would not be either. The id stays
				// out of memory and the next read asks the source, which now holds `revision`.
				this.bump(blockId);
			}
		}
	}
}
