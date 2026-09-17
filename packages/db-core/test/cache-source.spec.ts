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

	describe('peek / getCachedRevision', () => {
		it('peek returns undefined before the block is cached, without consulting the source', () => {
			expect(cache.peek('a' as BlockId)).to.be.undefined;
		});

		it('peek returns a clone of the cached block after a load', async () => {
			await cache.tryGet('a' as BlockId);
			const peeked = cache.peek('a' as BlockId);
			expect(peeked!.data).to.equal('alpha');

			peeked!.data = 'mutated';
			peeked!.items.push('z');
			expect(cache.peek('a' as BlockId)!.data).to.equal('alpha');
			expect(cache.peek('a' as BlockId)!.items).to.deep.equal(['x', 'y']);
		});

		it('peek does not refresh LRU recency', async () => {
			const smallCache = new CacheSource(source, 2);
			await smallCache.tryGet('a' as BlockId);
			await smallCache.tryGet('b' as BlockId);

			// Peek 'a' — must not count as a use
			expect(smallCache.peek('a' as BlockId)).to.not.be.undefined;

			// Add 'c' — 'a' is still oldest, evicted despite the peek
			blocks.set('c', makeBlock('c', 'gamma'));
			await smallCache.tryGet('c' as BlockId);
			expect(smallCache.peek('a' as BlockId)).to.be.undefined;
			expect(smallCache.peek('b' as BlockId)).to.not.be.undefined;
		});

		it('getCachedRevision reports the source-learned materialized revision after a load', async () => {
			const revSource = makeRevSource(blocks, new Map([['a', 7]]));
			const c = new CacheSource(revSource);

			expect(c.getCachedRevision('a' as BlockId)).to.be.undefined;
			await c.tryGet('a' as BlockId);
			expect(c.getCachedRevision('a' as BlockId)).to.equal(7);
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

	describe('an answer the source forbids keeping (describeServed)', () => {
		/** A source that describes each block OBJECT it returns — its revision, and whether it may be
		 *  kept — the duck-typed `describeServed` a floor-checking TransactorSource exposes. Verdict and
		 *  revision are fixed when the block is served, as they are there. Counts fetches. */
		function makeForbiddingSource(revs: Map<string, number>, forbidden: Set<string>) {
			const served = new WeakMap<object, { rev: number; mayRetain: boolean }>();
			const inner = makeSource(blocks).tryGet;
			const src = {
				...makeSource(blocks),
				fetches: 0,
				tryGet: async (id: BlockId) => {
					src.fetches++;
					const block = await inner(id);
					if (block) served.set(block, { rev: revs.get(id) ?? 0, mayRetain: !forbidden.has(id) });
					return block;
				},
				describeServed: (block: object) => served.get(block),
			};
			return src;
		}

		it('hands it to the reader but asks the source again on every read', async () => {
			const src = makeForbiddingSource(new Map([['a', 6]]), new Set(['a']));
			const c = new CacheSource(src as BlockSource<TestBlock>);

			expect((await c.tryGet('a' as BlockId))!.data).to.equal('alpha');
			blocks.set('a', makeBlock('a', 'caught-up'));
			expect((await c.tryGet('a' as BlockId))!.data, 'not served from memory').to.equal('caught-up');
			expect(src.fetches).to.equal(2);
			expect(c.retains('a' as BlockId)).to.equal(false);
			expect(c.snapshotEntries(), 'and never seeds a read view').to.deep.equal([]);
		});

		it('bumps the generation on every pass, so nothing built on the last answer survives', async () => {
			const c = new CacheSource(makeForbiddingSource(new Map([['a', 6]]), new Set(['a'])) as BlockSource<TestBlock>);
			await c.tryGet('a' as BlockId);
			const afterFirst = c.getGeneration('a' as BlockId);
			await c.tryGet('a' as BlockId);
			expect(c.getGeneration('a' as BlockId)).to.be.greaterThan(afterFirst);
		});

		it('still describes it to the base probes, at the revision it was served at', async () => {
			// A write staged over this content has to declare the base it was really built on.
			const revs = new Map([['a', 6]]);
			const c = new CacheSource(makeForbiddingSource(revs, new Set(['a'])) as BlockSource<TestBlock>);
			await c.tryGet('a' as BlockId);
			expect(c.peek('a' as BlockId)!.data).to.equal('alpha');
			expect(c.getCachedRevision('a' as BlockId)).to.equal(6);
		});

		it('a leftover revision from an evicted load does not outrank the revision it was served at', async () => {
			const revs = new Map([['a', 9], ['b', 1]]);
			const forbidden = new Set<string>();
			const tiny = new CacheSource(makeForbiddingSource(revs, forbidden) as BlockSource<TestBlock>, 1);
			await tiny.tryGet('a' as BlockId);          // kept at 9
			await tiny.tryGet('b' as BlockId);          // evicts 'a'; its revision entry lingers
			forbidden.add('a');
			revs.set('a', 6);
			await tiny.tryGet('a' as BlockId);
			expect(tiny.getCachedRevision('a' as BlockId)).to.equal(6);
		});

		it('records the read dependency at the served revision all the same', async () => {
			const collector = new ReadDependencyCollector();
			const c = new CacheSource(makeForbiddingSource(new Map([['a', 6]]), new Set(['a'])) as BlockSource<TestBlock>, undefined, collector);
			await c.tryGet('a' as BlockId);
			expect(collector.getReadDependencies()).to.deep.equal([{ blockId: 'a', revision: 6 }]);
		});

		it('keeps the next answer the source allows, and forgets the unkept one', async () => {
			const revs = new Map([['a', 6]]);
			const forbidden = new Set(['a']);
			const src = makeForbiddingSource(revs, forbidden);
			const c = new CacheSource(src as BlockSource<TestBlock>);
			await c.tryGet('a' as BlockId);

			forbidden.delete('a');
			revs.set('a', 7);
			blocks.set('a', makeBlock('a', 'caught-up'));
			await c.tryGet('a' as BlockId);
			expect(c.retains('a' as BlockId)).to.equal(true);
			expect(c.getCachedRevision('a' as BlockId)).to.equal(7);
			expect(c.peek('a' as BlockId)!.data).to.equal('caught-up');

			await c.tryGet('a' as BlockId);
			expect(src.fetches, 'now a hit').to.equal(2);
		});

		it('clear forgets the unkept answer too', async () => {
			const c = new CacheSource(makeForbiddingSource(new Map([['a', 6]]), new Set(['a'])) as BlockSource<TestBlock>);
			await c.tryGet('a' as BlockId);
			const gen = c.getGeneration('a' as BlockId);
			c.clear(['a' as BlockId]);
			expect(c.peek('a' as BlockId)).to.be.undefined;
			expect(c.getCachedRevision('a' as BlockId)).to.be.undefined;
			expect(c.getGeneration('a' as BlockId)).to.be.greaterThan(gen);

			await c.tryGet('a' as BlockId);
			c.clear();
			expect(c.peek('a' as BlockId)).to.be.undefined;
		});

		it('a committed update drops the unkept base instead of folding into it', async () => {
			const c = new CacheSource(makeForbiddingSource(new Map([['a', 6]]), new Set(['a'])) as BlockSource<TestBlock>);
			await c.tryGet('a' as BlockId);
			const gen = c.getGeneration('a' as BlockId);

			const appended: BlockOperation = ['items', 2, 0, ['z']];
			c.transformCache({ updates: { a: [appended] } } as Transforms, 8);
			expect(c.peek('a' as BlockId), 'never trusted as the content, so neither is the result').to.be.undefined;
			expect(c.retains('a' as BlockId)).to.equal(false);
			expect(c.getGeneration('a' as BlockId)).to.be.greaterThan(gen);
		});

		it('a source that cannot say is kept from, as before', async () => {
			await cache.tryGet('a' as BlockId);
			expect(cache.retains('a' as BlockId)).to.equal(true);
		});
	});

	describe('an answer overtaken while it was in flight', () => {
		/** A source whose reads park until released, each answering with its own content and
		 *  revision — so a test decides the ORDER answers arrive in, independently of the order they
		 *  were asked for. */
		function makeGatedSource() {
			const served = new WeakMap<object, { rev: number; mayRetain: boolean }>();
			const waiting: Array<(block: TestBlock) => void> = [];
			return {
				...makeSource(blocks),
				tryGet: (_id: BlockId) => new Promise<TestBlock | undefined>(resolve => { waiting.push(resolve); }),
				describeServed: (block: object) => served.get(block),
				/** Answer the OLDEST waiting read with a block 'a' holding `data`, served at `rev`. */
				answer(data: string, rev: number, mayRetain = true) {
					const block = makeBlock('a', data);
					served.set(block, { rev, mayRetain });
					waiting.shift()!(block);
				},
			};
		}
		const settle = () => new Promise<void>(resolve => setImmediate(resolve));

		it('the older of two concurrent answers, arriving second, is not what the cache remembers', async () => {
			// The shape that would re-open the too-old-forever defect: nothing clears a block but a
			// log entry naming it, so whichever answer is kept last is kept for good.
			const src = makeGatedSource();
			const c = new CacheSource(src as unknown as BlockSource<TestBlock>);
			const first = c.tryGet('a' as BlockId);
			const second = c.tryGet('a' as BlockId);
			src.answer('current', 7);
			src.answer('too-old', 6);

			expect((await first)!.data).to.equal('current');
			expect((await second)!.data, 'the reader that fetched it still gets it').to.equal('too-old');
			expect(c.peek('a' as BlockId)!.data).to.equal('current');
			expect(c.getCachedRevision('a' as BlockId)).to.equal(7);
		});

		it('the newer of two concurrent answers, arriving second, replaces the older', async () => {
			const src = makeGatedSource();
			const c = new CacheSource(src as unknown as BlockSource<TestBlock>);
			const first = c.tryGet('a' as BlockId);
			const second = c.tryGet('a' as BlockId);
			src.answer('too-old', 6);
			src.answer('current', 7);
			await Promise.all([first, second]);

			expect(c.peek('a' as BlockId)!.data).to.equal('current');
			expect(c.getCachedRevision('a' as BlockId)).to.equal(7);
		});

		it('an answer asked for before the id was cleared is not kept after it', async () => {
			// A refresh clears a block because a log entry says it changed; an answer requested
			// before that describes the block as it was, and would otherwise outlive the clear.
			const src = makeGatedSource();
			const c = new CacheSource(src as unknown as BlockSource<TestBlock>);
			const read = c.tryGet('a' as BlockId);
			c.clear(['a' as BlockId]);
			src.answer('before-the-clear', 6);

			expect((await read)!.data).to.equal('before-the-clear');
			expect(c.retains('a' as BlockId)).to.equal(false);
			expect(c.peek('a' as BlockId)).to.be.undefined;
		});

		it('an answer asked for before a commit folded in does not replace the folded content', async () => {
			const src = makeGatedSource();
			const c = new CacheSource(src as unknown as BlockSource<TestBlock>);
			const read = c.tryGet('a' as BlockId);
			c.transformCache({ inserts: { a: makeBlock('a', 'committed') } } as Transforms, 8);
			src.answer('before-the-commit', 6);
			await read;

			expect(c.peek('a' as BlockId)!.data).to.equal('committed');
			expect(c.getCachedRevision('a' as BlockId)).to.equal(8);
		});

		it('an unkeepable answer arriving over content a concurrent read kept leaves that content alone', async () => {
			const src = makeGatedSource();
			const c = new CacheSource(src as unknown as BlockSource<TestBlock>);
			const first = c.tryGet('a' as BlockId);
			const second = c.tryGet('a' as BlockId);
			src.answer('current', 7);
			await settle();
			src.answer('too-old', 6, false);
			await Promise.all([first, second]);

			expect(c.retains('a' as BlockId)).to.equal(true);
			expect(c.peek('a' as BlockId)!.data).to.equal('current');
			expect(c.getCachedRevision('a' as BlockId)).to.equal(7);
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
