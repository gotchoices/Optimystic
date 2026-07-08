import { expect } from 'chai';
import type { BlockId, BlockOperation, BlockSource, BlockType, IBlock, Transforms } from '../src/index.js';
import { CacheSource } from '../src/transform/cache-source.js';
import { ReadDependencyCollector } from '../src/transaction/read-dependency-collector.js';

interface TestBlock extends IBlock {
	data: string;
	items: string[];
}

function makeBlock(id: string, data = 'test', items: string[] = []): TestBlock {
	return {
		header: { id: id as BlockId, type: 'test' as BlockType, collectionId: 'col' as BlockId },
		data,
		items,
	};
}

function makeSource(blocks: Map<string, TestBlock>): BlockSource<TestBlock> {
	return {
		tryGet: async (id: BlockId) => {
			const block = blocks.get(id);
			return block ? structuredClone(block) : undefined;
		},
		generateId: () => 'gen-id' as BlockId,
		createBlockHeader: (type: BlockType) => ({ id: 'gen-id' as BlockId, type, collectionId: 'col' as BlockId }),
	};
}

/** A source that also reports a per-id read revision (the duck-typed `getReadRevision` that
 * CacheSource probes on a miss-load), mirroring what a real TransactorSource exposes. */
function makeRevSource(blocks: Map<string, TestBlock>, revs: Map<string, number>): BlockSource<TestBlock> {
	return {
		...makeSource(blocks),
		getReadRevision: (id: BlockId) => revs.get(id),
	} as BlockSource<TestBlock>;
}

describe('CacheSource', () => {
	let blocks: Map<string, TestBlock>;
	let source: BlockSource<TestBlock>;
	let cache: CacheSource<TestBlock>;

	beforeEach(() => {
		blocks = new Map([
			['a', makeBlock('a', 'alpha', ['x', 'y'])],
			['b', makeBlock('b', 'beta')],
		]);
		source = makeSource(blocks);
		cache = new CacheSource(source);
	});

	describe('tryGet', () => {
		it('should return block from source on cache miss', async () => {
			const result = await cache.tryGet('a' as BlockId);
			expect(result).to.not.be.undefined;
			expect(result!.data).to.equal('alpha');
			expect(result!.items).to.deep.equal(['x', 'y']);
		});

		it('should return cached block on subsequent calls', async () => {
			await cache.tryGet('a' as BlockId);
			// Mutate the source to prove cache is used
			blocks.set('a', makeBlock('a', 'changed'));
			const result = await cache.tryGet('a' as BlockId);
			expect(result!.data).to.equal('alpha');
		});

		it('should return undefined for absent blocks', async () => {
			const result = await cache.tryGet('missing' as BlockId);
			expect(result).to.be.undefined;
		});

		it('should not cache absent blocks', async () => {
			await cache.tryGet('missing' as BlockId);
			// Add the block to source
			blocks.set('missing', makeBlock('missing', 'now-here'));
			const result = await cache.tryGet('missing' as BlockId);
			expect(result!.data).to.equal('now-here');
		});

		it('should return a clone — mutating result does not affect cache', async () => {
			const first = await cache.tryGet('a' as BlockId);
			first!.data = 'mutated';
			first!.items.push('z');

			const second = await cache.tryGet('a' as BlockId);
			expect(second!.data).to.equal('alpha');
			expect(second!.items).to.deep.equal(['x', 'y']);
		});
	});

	describe('clear', () => {
		it('should clear specific blocks', async () => {
			await cache.tryGet('a' as BlockId);
			await cache.tryGet('b' as BlockId);

			cache.clear(['a' as BlockId]);

			// Mutate source to detect refetch
			blocks.set('a', makeBlock('a', 'refetched'));

			const a = await cache.tryGet('a' as BlockId);
			const b = await cache.tryGet('b' as BlockId);
			expect(a!.data).to.equal('refetched');
			expect(b!.data).to.equal('beta');
		});

		it('should clear all blocks when called without arguments', async () => {
			await cache.tryGet('a' as BlockId);
			await cache.tryGet('b' as BlockId);

			cache.clear();
			blocks.set('a', makeBlock('a', 'new-a'));
			blocks.set('b', makeBlock('b', 'new-b'));

			const a = await cache.tryGet('a' as BlockId);
			const b = await cache.tryGet('b' as BlockId);
			expect(a!.data).to.equal('new-a');
			expect(b!.data).to.equal('new-b');
		});
	});

	describe('transformCache', () => {
		it('should apply deletes to cached blocks', async () => {
			await cache.tryGet('a' as BlockId);

			const transform: Transforms = { deletes: ['a' as BlockId] };
			cache.transformCache(transform, 1);

			// Block is removed from cache — refetch from source
			blocks.set('a', makeBlock('a', 'refetched'));
			const result = await cache.tryGet('a' as BlockId);
			expect(result!.data).to.equal('refetched');
		});

		it('should apply inserts to cache', async () => {
			const newBlock = makeBlock('c', 'gamma');
			const transform: Transforms = { inserts: { c: newBlock } };
			cache.transformCache(transform, 1);

			const result = await cache.tryGet('c' as BlockId);
			expect(result!.data).to.equal('gamma');
		});

		it('should clone inserted blocks', async () => {
			const newBlock = makeBlock('c', 'gamma');
			const transform: Transforms = { inserts: { c: newBlock } };
			cache.transformCache(transform, 1);

			// Mutate original
			newBlock.data = 'mutated';

			const result = await cache.tryGet('c' as BlockId);
			expect(result!.data).to.equal('gamma');
		});

		it('should apply updates to cached blocks', async () => {
			await cache.tryGet('a' as BlockId);

			const op: BlockOperation = ['data', 0, 0, 'updated'];
			const transform: Transforms = { updates: { a: [op] } };
			cache.transformCache(transform, 1);

			const result = await cache.tryGet('a' as BlockId);
			expect(result!.data).to.equal('updated');
		});

		it('should apply array updates to cached blocks', async () => {
			await cache.tryGet('a' as BlockId);

			const op: BlockOperation = ['items', 1, 1, ['z']];
			const transform: Transforms = { updates: { a: [op] } };
			cache.transformCache(transform, 1);

			const result = await cache.tryGet('a' as BlockId);
			expect(result!.items).to.deep.equal(['x', 'z']);
		});

		it('should no-op for updates on uncached blocks', async () => {
			const op: BlockOperation = ['data', 0, 0, 'updated'];
			const transform: Transforms = { updates: { a: [op] } };
			cache.transformCache(transform, 1);

			// Block was not in cache, so update is a no-op — source data is unchanged
			const result = await cache.tryGet('a' as BlockId);
			expect(result!.data).to.equal('alpha');
		});
	});

	describe('getGeneration', () => {
		it('should start at 0 for an unseen id', () => {
			expect(cache.getGeneration('a' as BlockId)).to.equal(0);
		});

		it('should advance on miss-load', async () => {
			const before = cache.getGeneration('a' as BlockId);
			await cache.tryGet('a' as BlockId);
			expect(cache.getGeneration('a' as BlockId)).to.be.greaterThan(before);
		});

		it('should be stable across pure cache hits', async () => {
			await cache.tryGet('a' as BlockId);
			const gen = cache.getGeneration('a' as BlockId);
			await cache.tryGet('a' as BlockId);
			await cache.tryGet('a' as BlockId);
			expect(cache.getGeneration('a' as BlockId)).to.equal(gen);
		});

		it('should advance when transformCache updates a cached block', async () => {
			await cache.tryGet('a' as BlockId);
			const gen = cache.getGeneration('a' as BlockId);

			const op: BlockOperation = ['data', 0, 0, 'updated'];
			cache.transformCache({ updates: { a: [op] } }, 1);

			expect(cache.getGeneration('a' as BlockId)).to.be.greaterThan(gen);
		});

		it('should advance on clear', async () => {
			await cache.tryGet('a' as BlockId);
			const gen = cache.getGeneration('a' as BlockId);
			cache.clear(['a' as BlockId]);
			expect(cache.getGeneration('a' as BlockId)).to.be.greaterThan(gen);
		});
	});

	describe('LRU eviction', () => {
		it('should evict oldest entry when maxSize exceeded', async () => {
			const smallCache = new CacheSource(source, 2);

			await smallCache.tryGet('a' as BlockId);
			await smallCache.tryGet('b' as BlockId);

			// Add a third block — should evict 'a' (oldest)
			blocks.set('c', makeBlock('c', 'gamma'));
			await smallCache.tryGet('c' as BlockId);

			// 'b' is still cached (verify before refetching 'a', which would evict 'b')
			blocks.set('b', makeBlock('b', 'should-not-see'));
			const b = await smallCache.tryGet('b' as BlockId);
			expect(b!.data).to.equal('beta');

			// 'a' was evicted — refetch from source
			blocks.set('a', makeBlock('a', 'refetched'));
			const a = await smallCache.tryGet('a' as BlockId);
			expect(a!.data).to.equal('refetched');
		});

		it('should refresh entry on access', async () => {
			const smallCache = new CacheSource(source, 2);

			await smallCache.tryGet('a' as BlockId);
			await smallCache.tryGet('b' as BlockId);

			// Access 'a' again to refresh it
			await smallCache.tryGet('a' as BlockId);

			// Add 'c' — should evict 'b' (oldest), not 'a' (refreshed)
			blocks.set('c', makeBlock('c', 'gamma'));
			await smallCache.tryGet('c' as BlockId);

			// 'a' is still cached
			blocks.set('a', makeBlock('a', 'should-not-see'));
			const a = await smallCache.tryGet('a' as BlockId);
			expect(a!.data).to.equal('alpha');

			// 'b' was evicted
			blocks.set('b', makeBlock('b', 'refetched'));
			const b = await smallCache.tryGet('b' as BlockId);
			expect(b!.data).to.equal('refetched');
		});

		it('should work with maxSize of 1', async () => {
			const tinyCache = new CacheSource(source, 1);

			await tinyCache.tryGet('a' as BlockId);
			await tinyCache.tryGet('b' as BlockId);

			// 'a' was evicted
			blocks.set('a', makeBlock('a', 'refetched'));
			const a = await tinyCache.tryGet('a' as BlockId);
			expect(a!.data).to.equal('refetched');
		});
	});

	describe('delegation', () => {
		it('should delegate generateId to source', () => {
			expect(cache.generateId()).to.equal('gen-id');
		});

		it('should delegate createBlockHeader to source', () => {
			const header = cache.createBlockHeader('test' as BlockType);
			expect(header.type).to.equal('test');
		});
	});

	describe('read-dependency capture', () => {
		it('records a dependency on a cache HIT, re-emitting the revision learned on miss-load', async () => {
			const collector = new ReadDependencyCollector();
			const revSource = makeRevSource(blocks, new Map([['a', 7]]));
			const c = new CacheSource(revSource, undefined, collector);

			await c.tryGet('a' as BlockId);   // miss -> learns + records a@7
			collector.clear();

			await c.tryGet('a' as BlockId);   // hit -> re-emits a@7
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 7 }]);
		});

		it('records revision 0 on miss-load when the source cannot report a revision', async () => {
			const collector = new ReadDependencyCollector();
			const c = new CacheSource(source, undefined, collector); // plain source: no getReadRevision

			await c.tryGet('a' as BlockId);
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 0 }]);
		});

		it('advances the recorded revision after transformCache folds in a newer commit', async () => {
			const collector = new ReadDependencyCollector();
			const revSource = makeRevSource(blocks, new Map([['a', 1]]));
			const c = new CacheSource(revSource, undefined, collector);

			await c.tryGet('a' as BlockId);   // records a@1, cache revision = 1
			c.transformCache({ updates: { a: [['data', 0, 0, 'v2']] } }, 2); // fold committed rev 2
			collector.clear();

			await c.tryGet('a' as BlockId);   // hit -> records a@2, not the stale a@1
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 2 }]);
		});

		it('records nothing for an absent block (miss:absent)', async () => {
			const collector = new ReadDependencyCollector();
			const c = new CacheSource(source, undefined, collector);

			await c.tryGet('missing' as BlockId);
			await c.tryGet('missing' as BlockId); // absent is never cached — still a miss
			expect(collector.getReadDependencies()).to.be.empty;
		});

		it('drops the stored revision when transformCache deletes the block (later read re-learns)', async () => {
			const collector = new ReadDependencyCollector();
			const revs = new Map([['a', 3]]);
			const revSource = makeRevSource(blocks, revs);
			const c = new CacheSource(revSource, undefined, collector);

			await c.tryGet('a' as BlockId);   // cache a@3
			c.transformCache({ deletes: ['a' as BlockId] }, 4); // evict from cache + revision map
			collector.clear();

			revs.set('a', 5);                 // source now serves a newer revision
			await c.tryGet('a' as BlockId);   // miss -> re-learns a@5
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 5 }]);
		});

		it('works without a collector (log-walk caches pass none)', async () => {
			const c = new CacheSource(makeRevSource(blocks, new Map([['a', 1]]))); // no collector
			// Just must not throw on hit or miss.
			await c.tryGet('a' as BlockId);
			const hit = await c.tryGet('a' as BlockId);
			expect(hit!.data).to.equal('alpha');
		});
	});
});

describe('ReadDependencyCollector', () => {
	it('keeps the highest revision per id (never downgrades)', () => {
		const collector = new ReadDependencyCollector();
		collector.record('a' as BlockId, 5);
		collector.record('a' as BlockId, 3); // lower — must not overwrite
		expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 5 }]);
	});

	it('upgrades to a higher revision', () => {
		const collector = new ReadDependencyCollector();
		collector.record('a' as BlockId, 2);
		collector.record('a' as BlockId, 4);
		expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 4 }]);
	});

	it('collects one entry per distinct id and clears', () => {
		const collector = new ReadDependencyCollector();
		collector.record('a' as BlockId, 1);
		collector.record('b' as BlockId, 2);
		expect(collector.getReadDependencies()).to.have.length(2);
		collector.clear();
		expect(collector.getReadDependencies()).to.be.empty;
	});
});
