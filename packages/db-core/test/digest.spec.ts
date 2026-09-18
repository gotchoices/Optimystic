import { expect } from 'chai';
import type { BlockId, BlockOperation, BlockSource, BlockType, IBlock } from '../src/index.js';
import { CacheSource } from '../src/transform/cache-source.js';
import { Tracker } from '../src/transform/tracker.js';
import { computeBlockContentDigests } from '../src/transform/digest.js';
import { canonicalBlockHash } from '../src/blocks/helpers.js';
import { applyTransform, copyTransforms, transformForBlockId } from '../src/transform/helpers.js';
import { Atomic } from '../src/transform/atomic.js';

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

		it('a base folded to a new revision under a staged update has MOVED: undeclared, never re-described', async () => {
			// The ops were computed on rev 7. Declaring them over the folded rev 9 content would put
			// the one wrong base on the commit that the storage guard cannot catch (a member holding
			// rev 9 applies them and agrees with everyone). So neither the stale pin nor the live base
			// is declared; the base is reported as moved and the pinned revision stays what it was.
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);          // pin captured at rev 7
			cache.transformCache({ inserts: {}, updates: { ['a' as BlockId]: [['data', 0, 0, 'folded']] }, deletes: [] }, 9);

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests, 'nothing is declared for a moved base').to.deep.equal({});
			expect(tracker.movedBases()).to.deep.equal(['a']);
			expect(tracker.stagedBaseRevs(['a' as BlockId]), 'the base named is still the one the ops were built on').to.deep.equal({ a: 7 });
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

		it('Atomic.commit hands its pins to the parent, so an oversized atomic still declares', async () => {
			const smallCache = new CacheSource(makeRevSource(blocks, revs), 1);
			const parent = new Tracker(smallCache);
			const atomic = new Atomic<TestBlock>(parent);
			await atomic.tryGet('a' as BlockId);
			atomic.update('a' as BlockId, ['data', 0, 0, 'updated']);   // pinned inside the atomic
			await atomic.tryGet('b' as BlockId);               // evicts 'a' from the shared cache
			atomic.update('b' as BlockId, ['data', 0, 0, 'bee']);
			expect(smallCache.peek('a' as BlockId), 'the early base is gone by flush time').to.be.undefined;

			atomic.commit();
			expect(atomic.pins.size, 'the atomic reclaims its own store on commit').to.equal(0);

			const digests = await computeBlockContentDigests(parent, parent.transformedBlockIds());
			expect(Object.keys(digests).sort(), 'both bases survived the flush').to.deep.equal(['a', 'b']);
			expect(digests['a' as BlockId]!.baseRev).to.equal(7);
			expect(digests['b' as BlockId]!.baseRev).to.equal(3);
		});

		it('a joined tracker declares from the pins the staging tracker took', async () => {
			const smallCache = new CacheSource(makeRevSource(blocks, revs), 1);
			const live = new Tracker(smallCache);
			await live.tryGet('a' as BlockId);
			live.update('a' as BlockId, ['data', 0, 0, 'updated']);
			await live.tryGet('b' as BlockId);                 // evicts 'a'
			expect(smallCache.peek('a' as BlockId)).to.be.undefined;

			// The Collection.syncAttempts shape: a per-attempt tracker over the same cache that
			// inherits the transforms by COPY (so it never stages the update itself, and would have
			// nothing to pin) and JOINS the live tracker's pin store.
			const attempt = new Tracker(smallCache, copyTransforms(live.transforms), live.pins);
			const digests = await computeBlockContentDigests(attempt, ['a' as BlockId]);
			expect(digests['a' as BlockId]!.baseRev, 'the joined store answers for the evicted base').to.equal(7);
		});

		it('a pin store cannot be joined by a tracker over a different base source', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['data', 0, 0, 'updated']);
			// A second cache numbers its generations from 0 for the same ids, so a pin taken against
			// `cache` would pass the freshness check here and declare the wrong base.
			const otherCache = new CacheSource(makeRevSource(blocks, revs));
			expect(() => new Tracker(otherCache, undefined, tracker.pins))
				.to.throw(/different base sources/);
		});
	});

	describe('the base of a staged update is fixed at the first update', () => {
		it('a generation bump at the SAME revision keeps the digest declared, at that revision', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);          // pinned at rev 7
			const genAtPin = cache.getGeneration('a' as BlockId);
			cache.clear(['a' as BlockId]);
			await tracker.tryGet('a' as BlockId);                              // re-load: same content, same rev, new generation
			expect(cache.getGeneration('a' as BlockId)).to.not.equal(genAtPin);

			const digests = await computeBlockContentDigests(tracker, ['a' as BlockId]);
			expect(digests['a' as BlockId]!.baseRev).to.equal(7);
			expect(tracker.movedBases()).to.deep.equal([]);
			expect(tracker.pins.get('a' as BlockId)!.gen, 'the pin was restamped, not replaced').to.equal(cache.getGeneration('a' as BlockId));
		});

		it('a generation bump to a DIFFERENT revision marks the base moved; the pinned revision is still reported', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);          // pinned at rev 7
			cache.clear(['a' as BlockId]);
			revs.set('a', 8);
			await tracker.tryGet('a' as BlockId);                              // re-load at rev 8

			expect(tracker.movedBases()).to.deep.equal(['a']);
			expect(tracker.peekMaterialized('a' as BlockId), 'no digest can be declared').to.be.undefined;
			expect(tracker.stagedBaseRevs(['a' as BlockId])).to.deep.equal({ a: 7 });
			tracker.update('a' as BlockId, ['items', 0, 0, ['y']]);           // a later op never re-pins
			expect(tracker.stagedBaseRevs(['a' as BlockId])).to.deep.equal({ a: 7 });
			expect(tracker.movedBases()).to.deep.equal(['a']);
		});

		it('a base cleared under a staged update has moved: the pin is never repaired from the live cache', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			cache.clear(['a' as BlockId]);
			expect(tracker.movedBases()).to.deep.equal(['a']);
			await tracker.tryGet('a' as BlockId);                              // same rev again — but the mark stands
			expect(tracker.movedBases(), 'once moved, moved until the tracker is reset').to.deep.equal(['a']);
			expect(tracker.stagedBaseRevs(['a' as BlockId])).to.deep.equal({ a: 7 });
		});

		it('stagedBaseRevs names update-only blocks, never inserted or deleted ones, nor unpinned ones', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			await tracker.tryGet('b' as BlockId);
			tracker.update('b' as BlockId, ['data', 0, 0, 'bee']);
			tracker.delete('b' as BlockId);                                     // update then delete
			tracker.update('n' as BlockId, ['items', 0, 0, ['late']]);
			tracker.insert(makeBlock('n', 'new'));                              // update then insert
			tracker.update('u' as BlockId, ['data', 0, 0, 'blind']);           // never read: no base to name

			expect(tracker.stagedBaseRevs(['a', 'b', 'n', 'u', 'z'] as BlockId[])).to.deep.equal({ a: 7 });
			expect(tracker.movedBases()).to.deep.equal([]);
		});

		it('a rev-only pin (read, evicted, then updated) names its base and declares no digest', async () => {
			const smallCache = new CacheSource(makeRevSource(blocks, revs), 1);
			const smallTracker = new Tracker(smallCache);
			await smallTracker.tryGet('a' as BlockId);
			await smallTracker.tryGet('b' as BlockId);         // evicts 'a'; its revision lingers
			smallTracker.update('a' as BlockId, ['data', 0, 0, 'updated']);

			expect(smallTracker.pins.get('a' as BlockId)).to.deep.equal({ rev: 7, gen: smallCache.getGeneration('a' as BlockId) });
			expect(smallTracker.stagedBaseRevs(['a' as BlockId])).to.deep.equal({ a: 7 });
			expect(await computeBlockContentDigests(smallTracker, ['a' as BlockId])).to.deep.equal({});
			expect(smallTracker.movedBases()).to.deep.equal([]);

			// The same revision read again fills the pin: the digest becomes declarable after all.
			await smallTracker.tryGet('a' as BlockId);
			const digests = await computeBlockContentDigests(smallTracker, ['a' as BlockId]);
			expect(digests['a' as BlockId]!.baseRev).to.equal(7);
		});

		it('adopting a pin at a different revision than the parent already pins marks the base moved', async () => {
			const parent = new Tracker(cache);
			await parent.tryGet('a' as BlockId);
			parent.update('a' as BlockId, ['items', 0, 0, ['first']]);         // parent pins a@7

			cache.clear(['a' as BlockId]);
			revs.set('a', 8);
			const atomic = new Atomic<TestBlock>(parent);
			await atomic.tryGet('a' as BlockId);                                // re-read at rev 8
			atomic.update('a' as BlockId, ['items', 0, 0, ['second']]);         // the atomic pins a@8
			atomic.commit();

			expect(parent.movedBases()).to.deep.equal(['a']);
			expect(parent.stagedBaseRevs(['a' as BlockId]), "the parent's revision — what the first op was built on").to.deep.equal({ a: 7 });
			expect(parent.peekMaterialized('a' as BlockId)).to.be.undefined;
		});

		it("a base that moves between an atomic's pin and its flush stays the atomic's base in the parent, marked moved", async () => {
			// The parent has nothing staged for 'a'. The atomic reads a@7 and updates it; before the
			// flush a concurrent unlatched read reloads the cache at rev 9 (storage caught up, no log
			// movement). The parent's first op for 'a' arrives with the adopted pin already in place —
			// the base those ops were built on — and must not re-probe the live cache for a@9.
			const parent = new Tracker(cache);
			const atomic = new Atomic<TestBlock>(parent);
			await atomic.tryGet('a' as BlockId);
			atomic.update('a' as BlockId, ['items', 0, 0, ['z']]);            // the atomic pins a@7
			cache.clear(['a' as BlockId]);
			revs.set('a', 9);
			await cache.tryGet('a' as BlockId);                                // the cache now describes a@9
			atomic.commit();

			expect(parent.stagedBaseRevs(['a' as BlockId]), 'the base the ops were built on').to.deep.equal({ a: 7 });
			expect(parent.movedBases()).to.deep.equal(['a']);
			expect(parent.peekMaterialized('a' as BlockId)).to.be.undefined;
		});

		it('adopting a pin at the same revision the parent pins is an overwrite, not a move', async () => {
			const parent = new Tracker(cache);
			await parent.tryGet('a' as BlockId);
			parent.update('a' as BlockId, ['items', 0, 0, ['first']]);
			const atomic = new Atomic<TestBlock>(parent);
			await atomic.tryGet('a' as BlockId);
			atomic.update('a' as BlockId, ['items', 0, 0, ['second']]);
			atomic.commit();

			expect(parent.movedBases()).to.deep.equal([]);
			expect((await computeBlockContentDigests(parent, ['a' as BlockId]))['a' as BlockId]!.baseRev).to.equal(7);
		});

		it("adopting a rev-only pin at the revision the parent pins in full keeps the parent's clone", async () => {
			// The atomic read 'a', then enough else to evict it, then updated it: its pin names rev 7
			// without content. The parent's full pin at rev 7 is the same committed content and is what
			// keeps the digest declarable after the fold.
			const smallCache = new CacheSource(makeRevSource(blocks, revs), 1);
			const parent = new Tracker(smallCache);
			await parent.tryGet('a' as BlockId);
			parent.update('a' as BlockId, ['items', 0, 0, ['first']]);
			expect(parent.pins.get('a' as BlockId)!.block).to.not.be.undefined;

			const atomic = new Atomic<TestBlock>(parent);
			await atomic.tryGet('a' as BlockId);
			await atomic.tryGet('b' as BlockId);                                // evicts 'a'
			atomic.update('a' as BlockId, ['items', 0, 0, ['second']]);
			expect(atomic.pins.get('a' as BlockId)).to.deep.equal({ rev: 7, gen: smallCache.getGeneration('a' as BlockId) });
			atomic.commit();

			expect(parent.pins.get('a' as BlockId)!.block, 'the clone survives the fold').to.not.be.undefined;
			expect(parent.movedBases()).to.deep.equal([]);
			expect((await computeBlockContentDigests(parent, ['a' as BlockId]))['a' as BlockId]!.baseRev).to.equal(7);
		});

		it('reset(transforms) keeps the moved mark of a retained pin; reset() clears it', async () => {
			await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['items', 0, 0, ['z']]);
			cache.clear(['a' as BlockId]);
			expect(tracker.movedBases()).to.deep.equal(['a']);

			tracker.reset({ inserts: {}, updates: { ['a' as BlockId]: [['items', 0, 0, ['z']]] }, deletes: [] });
			expect(tracker.movedBases(), 'the same ops keep the same (moved) base').to.deep.equal(['a']);

			tracker.reset();
			expect(tracker.pins.size).to.equal(0);
			expect(tracker.movedBases()).to.deep.equal([]);
		});

		it('an update over a drift-aware source that never described the block declares nothing, even once the cache holds it', async () => {
			// The op was computed blind (no read). Declaring the revision the cache learns LATER would
			// name a base the op was not built on.
			tracker.update('b' as BlockId, ['data', 0, 0, 'blind']);
			await tracker.tryGet('b' as BlockId);                              // the cache holds 'b' now
			expect(cache.peek('b' as BlockId)).to.not.be.undefined;

			expect(await computeBlockContentDigests(tracker, ['b' as BlockId])).to.deep.equal({});
			expect(tracker.stagedBaseRevs(['b' as BlockId])).to.deep.equal({});
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
