import type { IBlock, BlockHeader, BlockId, BlockSource, BlockType, ReadPurpose, Transforms } from "../index.js";
import { applyOperation } from "../index.js";
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
	) {
		this.cache = new LruMap(maxSize);
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
