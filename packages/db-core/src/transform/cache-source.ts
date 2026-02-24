import type { IBlock, BlockHeader, BlockId, BlockSource, BlockType, Transforms } from "../index.js";
import { applyOperation } from "../index.js";
import { LruMap } from "../utility/lru-map.js";
import { createLogger } from "../logger.js";

const log = createLogger('cache');

const DefaultMaxSize = 128;

export class CacheSource<T extends IBlock> implements BlockSource<T> {
	protected cache: LruMap<BlockId, T>;

	constructor(
		protected readonly source: BlockSource<T>,
		maxSize = DefaultMaxSize
	) {
		this.cache = new LruMap(maxSize);
	}

	async tryGet(id: BlockId): Promise<T | undefined> {
		let block = this.cache.get(id);
		if (block) {
			log('hit id=%s', id);
		} else {
			block = await this.source.tryGet(id);
			if (block) {
				this.cache.set(id, block);
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
			}
		} else {
			this.cache.clear();
		}
	}

	/** Mutates the cache without affecting the source */
	transformCache(transform: Transforms) {
		for (const blockId of transform.deletes ?? []) {
			this.cache.delete(blockId);
		}
		for (const [, block] of Object.entries(transform.inserts ?? {})) {
			this.cache.set(block.header.id, structuredClone(block) as T);
		}
		for (const [blockId, operations] of Object.entries(transform.updates ?? {})) {
			for (const op of operations) {
				const block = this.cache.get(blockId);
				if (block) {
					applyOperation(block, op);
				}
			}
		}
	}
}
