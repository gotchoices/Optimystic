import { expect } from 'chai';
import type { BlockId, BlockOperation, BlockSource, BlockType, IBlock } from '../src/index.js';
import { CacheSource } from '../src/transform/cache-source.js';
import { Tracker } from '../src/transform/tracker.js';
import { computeBlockContentDigests } from '../src/transform/digest.js';
import { canonicalBlockHash } from '../src/blocks/helpers.js';
import { applyTransform, transformForBlockId } from '../src/transform/helpers.js';

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

/** Source that reports a per-id read revision (the duck-typed `getReadRevision` CacheSource probes
 * on a miss-load), mirroring what a real TransactorSource exposes. */
function makeRevSource(blocks: Map<string, TestBlock>, revs: Map<string, number>): BlockSource<TestBlock> {
	return {
		tryGet: async (id: BlockId) => {
			const block = blocks.get(id);
			return block ? structuredClone(block) : undefined;
		},
		generateId: () => 'gen-id' as BlockId,
		createBlockHeader: (type: BlockType) => ({ id: 'gen-id' as BlockId, type, collectionId: 'col' as BlockId }),
		getReadRevision: (id: BlockId) => revs.get(id),
	} as BlockSource<TestBlock>;
}

describe('commit content digests', () => {
	let blocks: Map<string, TestBlock>;
	let revs: Map<string, number>;
	let cache: CacheSource<TestBlock>;
	let tracker: Tracker<TestBlock>;

	beforeEach(() => {
		blocks = new Map([
			['a', makeBlock('a', 'alpha', ['x', 'y'])],
			['b', makeBlock('b', 'beta')],
		]);
		revs = new Map([['a', 7], ['b', 3]]);
		cache = new CacheSource(makeRevSource(blocks, revs));
		tracker = new Tracker(cache);
	});

	describe('computeBlockContentDigests', () => {
		it('insert: digest present, baseRev absent (base-independent)', async () => {
			const inserted = makeBlock('n', 'new', ['q']);
			tracker.insert(inserted);

			const digests = await computeBlockContentDigests(tracker, ['n' as BlockId]);
			expect(Object.keys(digests)).to.deep.equal(['n']);
			expect(digests['n' as BlockId]!.digest).to.equal(await canonicalBlockHash(inserted));
			expect(digests['n' as BlockId]).to.not.have.property('baseRev');
		});

		it('update-only with cached base: digest present, baseRev = cached materialized revision', async () => {
			await tracker.tryGet('a' as BlockId);            // populate the cache (+ its revision) via a read
			const op: BlockOperation = ['data', 0, 0, 'updated'];
			tracker.update('a' as BlockId, op);

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests['a' as BlockId]).to.not.be.undefined;
			expect(digests['a' as BlockId]!.baseRev).to.equal(7);

			// Client/member agreement (in-package half): the digest equals canonicalBlockHash of the
			// canonical applyTransform over the same base — the member-side materialization.
			const expected = applyTransform(
				structuredClone(blocks.get('a')!),
				transformForBlockId(tracker.transforms, 'a' as BlockId)
			);
			expect(digests['a' as BlockId]!.digest).to.equal(await canonicalBlockHash(expected!));
		});

		it('insert with staged updates: updates apply on top, insert stays base-independent', async () => {
			// update-then-insert is reachable: Tracker.insert clears a staged delete but NOT staged
			// updates, so both ride on the same id. tryGet serves the bare insert, but COMMIT applies
			// insert-then-updates (applyTransform) — the digest must describe what commit produces.
			tracker.update('n' as BlockId, ['items', 0, 0, ['late']]);
			const inserted = makeBlock('n', 'new', ['q']);
			tracker.insert(inserted);

			const digests = await computeBlockContentDigests(tracker, ['n' as BlockId]);
			expect(digests['n' as BlockId]).to.not.have.property('baseRev');
			expect(digests['n' as BlockId]!.digest).to.equal(
				await canonicalBlockHash(makeBlock('n', 'new', ['late', 'q']))
			);
			// The staged insert must not have the updates baked into it by the peek pass.
			expect(tracker.transforms.inserts!['n' as BlockId]).to.deep.equal(inserted);
			expect(tracker.transforms.updates!['n' as BlockId]).to.deep.equal([['items', 0, 0, ['late']]]);
		});

		it('delete-only: omitted (materializes to nothing), cached or not', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.delete('a' as BlockId);                  // cached base
			tracker.delete('b' as BlockId);                  // uncached base

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId, 'b' as BlockId]);
			expect(digests).to.deep.equal({});
		});

		it('update-then-delete: omitted (delete-last-wins)', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['data', 0, 0, 'doomed']);
			tracker.delete('a' as BlockId);

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests).to.deep.equal({});
		});

		it('update-only with UNcached base: omitted rather than fetched', async () => {
			tracker.update('b' as BlockId, ['data', 0, 0, 'updated']);  // 'b' never read → not cached

			const digests = await computeBlockContentDigests(tracker, ['b' as BlockId]);
			expect(digests).to.deep.equal({});
			expect(cache.peek('b' as BlockId)).to.be.undefined;         // and nothing got loaded
		});

		it('LRU-evicted base: omitted even though a stale cached revision lingers', async () => {
			const smallCache = new CacheSource(makeRevSource(blocks, revs), 1);
			const smallTracker = new Tracker(smallCache);
			await smallTracker.tryGet('a' as BlockId);
			await smallTracker.tryGet('b' as BlockId);         // evicts 'a' from the cache, not from `revisions`
			expect(smallCache.peek('a' as BlockId)).to.be.undefined;
			expect(smallCache.getCachedRevision('a' as BlockId)).to.equal(7);

			smallTracker.update('a' as BlockId, ['data', 0, 0, 'updated']);
			const digests = await computeBlockContentDigests(smallTracker, ['a' as BlockId]);
			expect(digests).to.deep.equal({});                 // both halves required, so no stale pairing
		});

		it('id with no staged transform: omitted', async () => {
			tracker.insert(makeBlock('n', 'new'));

			const digests = await computeBlockContentDigests(tracker, ['n' as BlockId, 'z' as BlockId]);
			expect(Object.keys(digests)).to.deep.equal(['n']);
		});

		// Declaring content must never break committing it. Materializing replays the staged ops
		// against the LOCALLY CACHED base, which can fail on its own (an op naming an entity the
		// cached base does not have — reachable when another action's commit folds a different shape
		// into the cache between staging and digesting). That must degrade to "undeclared", not
		// throw out of the caller's sync() before it has even pended.
		it('an op that cannot replay against the cached base is omitted, not thrown', async () => {
			await tracker.tryGet('a' as BlockId);
			await tracker.tryGet('b' as BlockId);
			tracker.update('a' as BlockId, ['nonexistent-entity', 0, 0, ['z']]);
			tracker.update('b' as BlockId, ['items', 0, 0, ['z']]);   // valid: makeBlock gives `items`

			const digests = await computeBlockContentDigests(tracker, ['a', 'b'] as BlockId[]);
			expect(Object.keys(digests), 'the unreplayable id is skipped, the sibling still declares')
				.to.deep.equal(['b']);
		});

		it('is deterministic: repeated passes yield identical digests', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			tracker.insert(makeBlock('n', 'new'));

			const ids = ['a', 'n'] as BlockId[];
			const first = await computeBlockContentDigests(tracker, ids);
			const second = await computeBlockContentDigests(tracker, ids);
			expect(second).to.deep.equal(first);
		});
	});

	describe('base pins', () => {
		it('pin survives LRU eviction: the base pinned at update time still declares', async () => {
			const smallCache = new CacheSource(makeRevSource(blocks, revs), 1);
			const smallTracker = new Tracker(smallCache);
			await smallTracker.tryGet('a' as BlockId);
			smallTracker.update('a' as BlockId, ['data', 0, 0, 'updated']);   // pin captured here
			await smallTracker.tryGet('b' as BlockId);         // evicts 'a' from the cache
			expect(smallCache.peek('a' as BlockId)).to.be.undefined;

			const digests = await computeBlockContentDigests(smallTracker, ['a' as BlockId]);
			expect(digests['a' as BlockId], 'declared from the pin despite eviction').to.not.be.undefined;
			expect(digests['a' as BlockId]!.baseRev).to.equal(7);
			const expected = applyTransform(
				structuredClone(blocks.get('a')!),
				transformForBlockId(smallTracker.transforms, 'a' as BlockId)
			);
			expect(digests['a' as BlockId]!.digest).to.equal(await canonicalBlockHash(expected!));
		});

		it('stale pin after clear(): omitted rather than declared from the stale base', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);          // pin captured
			cache.clear(['a' as BlockId]);                     // generation bump: pin is now stale

			// The cache can no longer answer either (cleared), so the only wrong outcome — declaring
			// from the stale pin — must not happen; the id is omitted.
			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests).to.deep.equal({});
		});

		it('stale pin after transformCache(): recomputed from the folded live base, never the pin', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);          // pin captured at rev 7
			const stalePinExpected = applyTransform(
				structuredClone(blocks.get('a')!),
				transformForBlockId(tracker.transforms, 'a' as BlockId)
			);
			cache.transformCache({ inserts: {}, updates: { ['a' as BlockId]: [['data', 0, 0, 'folded']] }, deletes: [] }, 9);

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests['a' as BlockId]!.baseRev, 'declared at the folded revision').to.equal(9);
			const foldedExpected = applyTransform(
				cache.peek('a' as BlockId)!,
				transformForBlockId(tracker.transforms, 'a' as BlockId)
			);
			expect(digests['a' as BlockId]!.digest).to.equal(await canonicalBlockHash(foldedExpected!));
			expect(digests['a' as BlockId]!.digest, 'and NOT the stale pinned materialization')
				.to.not.equal(await canonicalBlockHash(stalePinExpected!));
		});

		it('one base probe per id: 50 updates clone the base once', async () => {
			await tracker.tryGet('a' as BlockId);
			let peeks = 0;
			const origPeek = cache.peek.bind(cache);
			cache.peek = (id: BlockId) => { peeks++; return origPeek(id); };
			for (let i = 0; i < 50; i++) {
				tracker.update('a' as BlockId, ['items', 0, 0, [`v${i}`]]);
			}
			expect(peeks, 'the fresh-pin guard suppresses re-probing').to.equal(1);
		});

		it('insert after update drops the pin (result is base-independent)', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			expect(tracker.pins.get('a' as BlockId)).to.not.be.undefined;
			tracker.insert(makeBlock('a', 'replaced'));
			expect(tracker.pins.get('a' as BlockId)).to.be.undefined;

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests['a' as BlockId]).to.not.have.property('baseRev');
		});

		it('delete after update drops the pin (omitted)', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			tracker.delete('a' as BlockId);
			expect(tracker.pins.get('a' as BlockId)).to.be.undefined;

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests).to.deep.equal({});
		});

		it('reset() empties the pin store; reset(transforms) retains exactly the still-staged updates', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			await tracker.tryGet('b' as BlockId);
			tracker.update('b' as BlockId, ['data', 0, 0, 'bee']);
			expect(tracker.pins.size).to.equal(2);

			tracker.reset();
			expect(tracker.pins.size, 'a plain reset clears every pin').to.equal(0);

			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			await tracker.tryGet('b' as BlockId);
			tracker.update('b' as BlockId, ['data', 0, 0, 'bee']);
			tracker.reset({ inserts: {}, updates: { ['a' as BlockId]: [['items', 0, 0, ['z']]] }, deletes: [] });
			expect(tracker.pins.get('a' as BlockId), 'the still-staged id keeps its pin').to.not.be.undefined;
			expect(tracker.pins.get('b' as BlockId), 'the dropped id loses its pin').to.be.undefined;
			expect(tracker.pins.size).to.equal(1);
		});

		it('a source without getGeneration pins nothing and declares via the live path as before', async () => {
			// peek/getCachedRevision present, getGeneration absent: drift-blind, so nothing pins —
			// but the pre-pin live-peek path still answers.
			const driftBlind = {
				...makeRevSource(blocks, revs),
				peek: (id: BlockId) => {
					const block = blocks.get(id);
					return block ? structuredClone(block) : undefined;
				},
				getCachedRevision: (id: BlockId) => revs.get(id),
			} as BlockSource<TestBlock>;
			const blindTracker = new Tracker(driftBlind);
			await blindTracker.tryGet('a' as BlockId);
			blindTracker.update('a' as BlockId, ['data', 0, 0, 'updated']);
			expect(blindTracker.pins.size).to.equal(0);

			const digests = await computeBlockContentDigests(blindTracker, ['a' as BlockId]);
			expect(digests['a' as BlockId]!.baseRev).to.equal(7);
		});

		it('a digest pass leaves the pin store unchanged', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			const pinBefore = structuredClone(tracker.pins.get('a' as BlockId));

			const first = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			const second = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(second, 'repeat passes agree (the pin is cloned on use, not mutated)').to.deep.equal(first);
			expect(tracker.pins.size).to.equal(1);
			expect(tracker.pins.get('a' as BlockId)).to.deep.equal(pinBefore);
		});
	});

	describe('peekMaterialized', () => {
		it('returns undefined when the source cannot answer locally (no peek probe)', () => {
			// Tracker over a bare source (no peek/getCachedRevision): updates are un-digestable.
			const bare = new Tracker<TestBlock>(makeRevSource(blocks, revs));
			bare.update('a' as BlockId, ['data', 0, 0, 'updated']);
			expect(bare.peekMaterialized('a' as BlockId)).to.be.undefined;
		});

		it('leaves tracker and cache state observably unchanged', async () => {
			const before = await tracker.tryGet('a' as BlockId);
			// A splice op, not a scalar set: applying it twice is observable, so a peeked base that
			// leaked back into the cache would show up below.
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			tracker.insert(makeBlock('n', 'new'));
			const transformsBefore = structuredClone(tracker.transforms);
			const genBefore = cache.getGeneration('a' as BlockId);

			await computeBlockContentDigests(tracker, ['a', 'n', 'b'] as BlockId[]);

			// Staged transforms untouched (peekMaterialized clones before applyTransform mutates)
			expect(tracker.transforms).to.deep.equal(transformsBefore);
			// Cache content generation stable — no reload, no fold
			expect(cache.getGeneration('a' as BlockId)).to.equal(genBefore);
			// The cached BASE is untouched — applyTransform ran over peek's clone, not the cache entry
			expect(cache.peek('a' as BlockId)!.items).to.deep.equal(before!.items);
			// Reads still see the same materialized content (base + staged op), applied exactly once
			const after = await tracker.tryGet('a' as BlockId);
			expect(after!.items).to.deep.equal(['z', ...before!.items]);
		});

		it('mutating a peeked block does not leak into the staged insert', () => {
			const inserted = makeBlock('n', 'new', ['q']);
			tracker.insert(inserted);

			const peeked = tracker.peekMaterialized('n' as BlockId)!;
			(peeked.block as TestBlock).data = 'mutated';
			(peeked.block as TestBlock).items.push('leak');

			expect(tracker.transforms.inserts!['n' as BlockId]).to.deep.equal(inserted);
		});
	});
});
