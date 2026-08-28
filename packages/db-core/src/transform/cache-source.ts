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
			block = await this.source.tryGet(id, purpose);
			if (block) {
				this.cache.set(id, block);
				this.bump(id);
				// Learn the revision from the source (which just served it) and record it. On a miss the
				// underlying TransactorSource already recorded the same id@rev/purpose into the shared
				// collector; max-wins (revision) + value-wins (purpose) collapse the two to one entry.
				const rev = sourceReadRevision(this.source, id) ?? 0;
				this.revisions.set(id, rev);
				this.collector?.record(id, rev, purpose);
				log('miss:loaded id=%s cacheSize=%d', id, this.cache.size);
			} else {
				// Absent block: record nothing (matches TransactorSource, which skips missing blocks).
				log('miss:absent id=%s', id);
			}
		}
		return structuredClone(block);
	}

	/** The block currently cached for `id`, without consulting the source. Cloned (callers apply ops
	 *  to it) and recency-neutral ({@link LruMap.peek}) — an observation pass must neither pay a
	 *  network read nor reshape eviction order. Records no read dependency: the caller that peeks
	 *  already read the block through {@link tryGet} (that is how it got cached), so the dependency
	 *  exists; a digest pass merely re-describes it. */
	peek(id: BlockId): T | undefined {
		const block = this.cache.peek(id);
		return block === undefined ? undefined : structuredClone(block);
	}

	/** The committed revision of the content currently cached for `id` — the source-reported
	 *  materialized revision learned on miss-load (see {@link revisions}), NOT the block's own
	 *  `state.latest.rev`. An LRU-evicted id can leave a stale entry here (see the NOTE on
	 *  {@link revisions}); callers must therefore require BOTH {@link peek} and this to be present —
	 *  {@link peek} returns `undefined` for the evicted id, so a stale revision never pairs with a
	 *  peeked block. */
	getCachedRevision(id: BlockId): number | undefined {
		return this.revisions.get(id);
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
				this.bump(id);
			}
		} else {
			for (const [id] of this.cache) {
				this.bump(id);
			}
			this.cache.clear();
			this.revisions.clear();
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
			this.bump(blockId);
		}
		for (const [, block] of Object.entries(transform.inserts ?? {})) {
			this.cache.set(block.header.id, structuredClone(block) as T);
			this.revisions.set(block.header.id, revision);
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
			}
		}
	}
}
