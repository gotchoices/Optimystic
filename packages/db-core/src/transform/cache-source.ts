import type { IBlock, BlockHeader, BlockId, BlockSource, BlockType, Transforms } from "../index.js";
import { applyOperation } from "../index.js";
import { LruMap } from "../utility/lru-map.js";
import { createLogger } from "../logger.js";

const log = createLogger('cache');

const DefaultMaxSize = 128;

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

	constructor(
		protected readonly source: BlockSource<T>,
		maxSize = DefaultMaxSize
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

	async tryGet(id: BlockId): Promise<T | undefined> {
		let block = this.cache.get(id);
		if (block) {
			log('hit id=%s', id);
		} else {
			block = await this.source.tryGet(id);
			if (block) {
				this.cache.set(id, block);
				this.bump(id);
				log('miss:loaded id=%s cacheSize=%d', id, this.cache.size);
			} else {
				log('miss:absent id=%s', id);
			}
		}
		return structuredClone(block);
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
				this.bump(id);
			}
		} else {
			for (const [id] of this.cache) {
				this.bump(id);
			}
			this.cache.clear();
		}
	}

	/** Mutates the cache without affecting the source */
	transformCache(transform: Transforms) {
		for (const blockId of transform.deletes ?? []) {
			this.cache.delete(blockId);
			this.bump(blockId);
		}
		for (const [, block] of Object.entries(transform.inserts ?? {})) {
			this.cache.set(block.header.id, structuredClone(block) as T);
			this.bump(block.header.id);
		}
		for (const [blockId, operations] of Object.entries(transform.updates ?? {})) {
			for (const op of operations) {
				const block = this.cache.get(blockId);
				if (block) {
					applyOperation(block, op);
					this.bump(blockId);
				}
			}
		}
	}
}
