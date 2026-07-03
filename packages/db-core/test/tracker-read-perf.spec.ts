import { expect } from 'chai';
import type { BlockId, BlockOperation, BlockSource, BlockType, IBlock } from '../src/index.js';
import { Tracker } from '../src/transform/tracker.js';

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

/** In-memory source that (a) counts underlying fetches and (b) exposes a per-id generation,
 * mirroring the drift signal `CacheSource.getGeneration` gives a live tracker. `set` bumps the
 * generation so a content change is observable to the tracker's memo guard. */
class FakeSource implements BlockSource<TestBlock> {
	tryGetCalls = 0;
	private blocks = new Map<string, TestBlock>();
	private gens = new Map<string, number>();

	set(id: string, block: TestBlock) {
		this.blocks.set(id, block);
		this.gens.set(id, (this.gens.get(id) ?? 0) + 1);
	}

	async tryGet(id: BlockId): Promise<TestBlock | undefined> {
		this.tryGetCalls++;
		const block = this.blocks.get(id);
		return block ? structuredClone(block) : undefined;
	}

	getGeneration(id: BlockId): number {
		return this.gens.get(id) ?? 0;
	}

	generateId(): BlockId {
		return 'gen-id' as BlockId;
	}

	createBlockHeader(type: BlockType): { id: BlockId; type: BlockType; collectionId: BlockId } {
		return { id: 'gen-id' as BlockId, type, collectionId: 'col' as BlockId };
	}
}

/** Plain source without a generation signal — the memo must NOT engage (always-replay fallback). */
function makePlainSource(blocks: Map<string, TestBlock>): BlockSource<TestBlock> & { tryGetCalls: number } {
	const src = {
		tryGetCalls: 0,
		tryGet: async (id: BlockId) => {
			src.tryGetCalls++;
			const block = blocks.get(id);
			return block ? structuredClone(block) : undefined;
		},
		generateId: () => 'gen-id' as BlockId,
		createBlockHeader: (type: BlockType) => ({ id: 'gen-id' as BlockId, type, collectionId: 'col' as BlockId }),
	};
	return src;
}

/** Append one item via a splice op so K ops leave K items — a cumulative, checkable effect. */
function appendOp(value: string): BlockOperation {
	return ['items', 0, 0, [value]];
}

describe('Tracker read-path memo', () => {
	describe('scaling (counting assertions)', () => {
		it('serves repeated reads from the memo without re-fetching the source', async () => {
			const src = new FakeSource();
			src.set('h', makeBlock('h'));
			const tracker = new Tracker<TestBlock>(src);

			const K = 500;
			for (let i = 0; i < K; i++) tracker.update('h' as BlockId, appendOp(String(i)));

			// Warmup materializes once.
			await tracker.tryGet('h' as BlockId);
			const afterWarmup = src.tryGetCalls;
			expect(afterWarmup).to.equal(1);

			const R = 50;
			for (let i = 0; i < R; i++) await tracker.tryGet('h' as BlockId);

			// No further source fetches (and thus no re-replay) across R reads.
			expect(src.tryGetCalls).to.equal(afterWarmup);
		});

		it('source-fetch count is independent of accumulated op count', async () => {
			async function fetchesFor(opCount: number): Promise<number> {
				const src = new FakeSource();
				src.set('h', makeBlock('h'));
				const tracker = new Tracker<TestBlock>(src);
				for (let i = 0; i < opCount; i++) tracker.update('h' as BlockId, appendOp(String(i)));
				for (let r = 0; r < 20; r++) await tracker.tryGet('h' as BlockId);
				return src.tryGetCalls;
			}

			const few = await fetchesFor(100);
			const many = await fetchesFor(2000);
			// O(1) in op count (one materialization), not O(K) or O(K·R).
			expect(few).to.equal(1);
			expect(many).to.equal(1);
		});

		it('memoized read reflects every accumulated op', async () => {
			const src = new FakeSource();
			src.set('h', makeBlock('h', 'base', []));
			const tracker = new Tracker<TestBlock>(src);

			const K = 30;
			for (let i = 0; i < K; i++) tracker.update('h' as BlockId, appendOp(String(i)));

			await tracker.tryGet('h' as BlockId);        // materialize
			const result = await tracker.tryGet('h' as BlockId); // served from memo
			expect(result!.items).to.have.length(K);
			expect(result!.data).to.equal('base');
		});

		it('an op applied after materialization is reflected without a full replay', async () => {
			const src = new FakeSource();
			src.set('h', makeBlock('h', 'base', []));
			const tracker = new Tracker<TestBlock>(src);

			tracker.update('h' as BlockId, appendOp('a'));
			await tracker.tryGet('h' as BlockId);        // materialize with 1 op
			const fetchesBefore = src.tryGetCalls;

			tracker.update('h' as BlockId, appendOp('b')); // incrementally folded into the memo
			const result = await tracker.tryGet('h' as BlockId);

			expect(result!.items).to.deep.equal(['b', 'a']);
			expect(src.tryGetCalls).to.equal(fetchesBefore); // no reload for the incremental update
		});
	});

	describe('correctness', () => {
		it('returns caller-isolated clones (mutating a read cannot corrupt the memo)', async () => {
			const src = new FakeSource();
			src.set('h', makeBlock('h', 'base', []));
			const tracker = new Tracker<TestBlock>(src);
			tracker.update('h' as BlockId, appendOp('a'));

			const first = await tracker.tryGet('h' as BlockId);
			first!.items.push('MUTATED');
			first!.data = 'MUTATED';

			const second = await tracker.tryGet('h' as BlockId);
			expect(second!.items).to.deep.equal(['a']);
			expect(second!.data).to.equal('base');
		});

		it('re-materializes when the source generation advances (source drift)', async () => {
			const src = new FakeSource();
			src.set('h', makeBlock('h', 'orig', []));
			const tracker = new Tracker<TestBlock>(src);
			tracker.update('h' as BlockId, appendOp('op'));

			const first = await tracker.tryGet('h' as BlockId);
			expect(first!.data).to.equal('orig');
			expect(first!.items).to.deep.equal(['op']);

			// External change to the underlying source content, with a generation bump.
			src.set('h', makeBlock('h', 'changed', ['base']));

			const second = await tracker.tryGet('h' as BlockId);
			expect(second!.data).to.equal('changed');            // new base content observed
			expect(second!.items).to.deep.equal(['op', 'base']); // op re-applied over the new base
		});

		it('an update after external source drift does not mask the stale base (gen is not refreshed)', async () => {
			// Guards the crux of the change: update() folds the new op into the memo block but must
			// leave memo.gen at the base-content generation. If update() instead refreshed gen to the
			// current source generation, the post-drift read below would find gen === memo.gen and serve
			// the stale (pre-drift) base with ops folded on top, silently returning wrong data.
			const src = new FakeSource();
			src.set('h', makeBlock('h', 'orig', [])); // gen 1
			const tracker = new Tracker<TestBlock>(src);
			tracker.update('h' as BlockId, appendOp('op'));

			const first = await tracker.tryGet('h' as BlockId); // materialize, memo.gen = 1
			expect(first!.data).to.equal('orig');

			src.set('h', makeBlock('h', 'changed', ['base'])); // external drift, gen 2
			tracker.update('h' as BlockId, appendOp('op2'));   // folds into memo; must NOT refresh gen

			const second = await tracker.tryGet('h' as BlockId);
			// Drift detected (gen 2 !== memo.gen 1) => reload new base, replay BOTH ops over it.
			expect(second!.data).to.equal('changed');
			expect(second!.items).to.deep.equal(['op2', 'op', 'base']);
		});

		it('invalidates the memo on delete and reset', async () => {
			const src = new FakeSource();
			src.set('h', makeBlock('h', 'base', []));
			const tracker = new Tracker<TestBlock>(src);
			tracker.update('h' as BlockId, appendOp('a'));
			await tracker.tryGet('h' as BlockId);

			tracker.delete('h' as BlockId);
			expect(await tracker.tryGet('h' as BlockId)).to.be.undefined;

			const src2 = new FakeSource();
			src2.set('h', makeBlock('h', 'base', []));
			const tracker2 = new Tracker<TestBlock>(src2);
			tracker2.update('h' as BlockId, appendOp('a'));
			await tracker2.tryGet('h' as BlockId);
			tracker2.reset();
			// After reset there are no ops; the read returns pristine source content.
			const afterReset = await tracker2.tryGet('h' as BlockId);
			expect(afterReset!.items).to.deep.equal([]);
		});
	});

	describe('fallback for sources without a generation signal', () => {
		it('never memoizes, so an external source change is always observed', async () => {
			const blocks = new Map([['h', makeBlock('h', 'orig', [])]]);
			const src = makePlainSource(blocks);
			const tracker = new Tracker<TestBlock>(src);
			tracker.update('h' as BlockId, appendOp('op'));

			const first = await tracker.tryGet('h' as BlockId);
			expect(first!.data).to.equal('orig');

			// No generation signal — the tracker must reload every time, so this change is seen.
			blocks.set('h', makeBlock('h', 'changed', []));
			const second = await tracker.tryGet('h' as BlockId);
			expect(second!.data).to.equal('changed');
			expect(second!.items).to.deep.equal(['op']);

			// Every read reloaded (no memo): 2 reads => 2 source fetches.
			expect(src.tryGetCalls).to.equal(2);
		});
	});
});
