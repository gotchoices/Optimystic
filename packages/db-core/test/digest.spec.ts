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

		it('id with no staged transform: omitted', async () => {
			tracker.insert(makeBlock('n', 'new'));

			const digests = await computeBlockContentDigests(tracker, ['n' as BlockId, 'z' as BlockId]);
			expect(Object.keys(digests)).to.deep.equal(['n']);
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

	describe('peekMaterialized', () => {
		it('returns undefined when the source cannot answer locally (no peek probe)', () => {
			// Tracker over a bare source (no peek/getCachedRevision): updates are un-digestable.
			const bare = new Tracker<TestBlock>(makeRevSource(blocks, revs));
			bare.update('a' as BlockId, ['data', 0, 0, 'updated']);
			expect(bare.peekMaterialized('a' as BlockId)).to.be.undefined;
		});

		it('leaves tracker and cache state observably unchanged', async () => {
			const before = await tracker.tryGet('a' as BlockId);
			tracker.update('a' as BlockId, ['data', 0, 0, 'updated']);
			tracker.insert(makeBlock('n', 'new'));
			const transformsBefore = structuredClone(tracker.transforms);
			const genBefore = cache.getGeneration('a' as BlockId);

			await computeBlockContentDigests(tracker, ['a', 'n', 'b'] as BlockId[]);

			// Staged transforms untouched (peekMaterialized clones before applyTransform mutates)
			expect(tracker.transforms).to.deep.equal(transformsBefore);
			// Cache content generation stable — no reload, no fold
			expect(cache.getGeneration('a' as BlockId)).to.equal(genBefore);
			// Reads still see the same materialized content (base + staged op)
			const after = await tracker.tryGet('a' as BlockId);
			expect(after!.data).to.equal('updated');
			expect(after!.items).to.deep.equal(before!.items);
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
