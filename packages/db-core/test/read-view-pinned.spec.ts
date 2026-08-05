/**
 * A committed read view (`Tree.readView`) must be pinned to the moment it was created:
 * a scan through it returns one consistent answer even when the live collection folds a
 * commit into its cache (`applyCommittedToCache` / `sync`), clears cached blocks
 * (`update()` after an external commit), or evicts cached blocks under LRU pressure
 * mid-scan. See ticket `committed-read-pinned-snapshot`.
 *
 * The mid-scan tests walk a view partway, mutate the LIVE collection's cache through a
 * real code path, finish the walk, and compare the full row list row-for-row against
 * the pre-mutation state. Multi-block trees (small `nodeCapacity`) are essential: a
 * `Path` holds the current leaf in memory, so only a walk that crosses block boundaries
 * after the mutation actually re-reads storage.
 */
import { expect } from 'chai';
import { Tree, type TreeReadView } from '../src/collections/tree/index.js';
import { TestTransactor } from '../src/testing/test-transactor.js';
import {
	BlockUnavailableError,
	type ITransactor,
	type BlockGets,
	type GetBlockResults,
	type ActionBlocks,
	type BlockActionStatus,
	type PendRequest,
	type PendResult,
	type CommitRequest,
	type CommitResult,
	copyTransforms,
} from '../src/index.js';

interface TestEntry {
	key: number;
	value: string;
}

const entry = (key: number, value = `value-${key}`): TestEntry => ({ key, value });

/** Build a tree over `network` holding entries with keys 1..count (one committed action). */
async function makeTree(
	network: ITransactor,
	id: string,
	count: number,
	nodeCapacity?: number,
): Promise<Tree<number, TestEntry>> {
	const tree = await Tree.createOrOpen<number, TestEntry>(
		network,
		id,
		e => e.key,
		undefined,
		nodeCapacity,
	);
	const entries: [number, TestEntry][] = [];
	for (let key = 1; key <= count; key++) {
		entries.push([key, entry(key)]);
	}
	await tree.replace(entries);
	return tree;
}

/** Walk the whole view in key order, optionally running `mutate.fn` after `mutate.count` rows. */
async function collectRows(
	view: TreeReadView<number, TestEntry>,
	mutate?: { count: number; fn: () => Promise<void> },
): Promise<TestEntry[]> {
	const rows: TestEntry[] = [];
	const start = await view.first();
	for await (const path of view.ascending(start)) {
		const row = view.at(path);
		if (row) {
			rows.push(row);
		}
		if (mutate && rows.length === mutate.count) {
			await mutate.fn();
		}
	}
	return rows;
}

/** Row-for-row comparison that names the differing rows, not just a length mismatch. */
function expectSameRows(actual: TestEntry[], expected: TestEntry[]): void {
	const diffs: string[] = [];
	const max = Math.max(actual.length, expected.length);
	for (let i = 0; i < max; i++) {
		const a = actual[i];
		const e = expected[i];
		if (JSON.stringify(a) !== JSON.stringify(e)) {
			diffs.push(`row ${i}: got ${JSON.stringify(a)}, expected ${JSON.stringify(e)}`);
		}
	}
	expect(diffs, diffs.slice(0, 10).join('; ')).to.be.empty;
}

/** Delegating transactor whose reads can be flipped to report every block `unavailable`. */
class FlippableUnavailableTransactor implements ITransactor {
	failing = false;

	constructor(private readonly inner: TestTransactor) { }

	async get(blockGets: BlockGets): Promise<GetBlockResults> {
		if (this.failing) {
			return Object.fromEntries(blockGets.blockIds.map(id =>
				[id, { block: undefined, state: {}, unavailable: 'unmaterializable' as const }]));
		}
		return this.inner.get(blockGets);
	}
	getStatus(refs: ActionBlocks[]): Promise<BlockActionStatus[]> { return this.inner.getStatus(refs); }
	pend(request: PendRequest): Promise<PendResult> { return this.inner.pend(request); }
	cancel(ref: ActionBlocks): Promise<void> { return this.inner.cancel(ref); }
	commit(request: CommitRequest): Promise<CommitResult> { return this.inner.commit(request); }
}

describe('Tree.readView pinning (committed read view)', function () {
	this.timeout(60000);

	it('is unchanged by a mid-scan applyCommittedToCache + tracker.reset (session-mode fold)', async () => {
		const network = new TestTransactor();
		const tree = await makeTree(network, 'pinned-fold', 40, 4);
		const collection = tree.getCollection();

		const view = tree.readView(tree.snapshot());
		const expected = await collectRows(view);
		expect(expected).to.have.length(40);

		const rows = await collectRows(view, {
			count: 3,
			fn: async () => {
				// Stage mutations to rows the walk has not reached, then fold them into the
				// shared cache exactly the way TransactionCoordinator.commitOnce does.
				const changes: [number, TestEntry | undefined][] = [];
				for (let key = 20; key <= 40; key++) {
					changes.push([key, entry(key, `mutated-${key}`)]);
				}
				changes.push([41, entry(41)]);
				await tree.stage(changes);
				const transforms = copyTransforms(collection.tracker.transforms);
				collection.applyCommittedToCache(transforms, collection.getNextRev());
				collection.tracker.reset();
				collection.clearPendingActions();
			},
		});

		expectSameRows(rows, expected);
	});

	it('is unchanged by a mid-scan update() that clears cached blocks (external commit)', async () => {
		const network = new TestTransactor();
		const id = 'pinned-clear';
		const tree = await makeTree(network, id, 40, 4);

		const view = tree.readView(tree.snapshot());
		const expected = await collectRows(view);

		const rows = await collectRows(view, {
			count: 3,
			fn: async () => {
				// A second collection instance over the same transactor commits new content,
				// then the live collection's update() drops the affected cached blocks — the
				// path every live read runs.
				const other = await Tree.createOrOpen<number, TestEntry>(
					network, id, e => e.key, undefined, 4);
				const changes: [number, TestEntry | undefined][] = [];
				for (let key = 20; key <= 40; key++) {
					changes.push([key, entry(key, `external-${key}`)]);
				}
				await other.replace(changes);
				await tree.update();
			},
		});

		expectSameRows(rows, expected);
	});

	it('resolves evicted-then-refetched blocks at the pinned revision (tree larger than the cache)', async () => {
		// 500 entries at fan-out 4 → well over the CacheSource LRU budget (128 blocks), so a
		// full walk must refetch blocks the view's cache never held (or evicted). Committing
		// through the SAME collection mid-scan advances its live context and folds new
		// content; only a frozen read context keeps the refetches at the pinned revision.
		const network = new TestTransactor();
		const tree = await makeTree(network, 'pinned-evict', 500, 4);

		const view = tree.readView(tree.snapshot());
		const expected = await collectRows(view);
		expect(expected).to.have.length(500);

		const rows = await collectRows(view, {
			count: 3,
			fn: async () => {
				const changes: [number, TestEntry | undefined][] = [];
				for (let key = 1; key <= 500; key++) {
					changes.push([key, entry(key, `rewritten-${key}`)]);
				}
				for (let key = 501; key <= 700; key++) {
					changes.push([key, entry(key)]);	// splits create blocks absent at the pinned revision
				}
				await tree.stage(changes);
				await tree.sync();
			},
		});

		expectSameRows(rows, expected);
	});

	it('two views of the same collection created at different revisions do not interfere', async () => {
		const network = new TestTransactor();
		const tree = await makeTree(network, 'pinned-two-views', 30, 4);

		const viewA = tree.readView(tree.snapshot());
		const expectedA = await collectRows(viewA);

		// Walk A partway, commit revision 2 through the live tree, snapshot view B there.
		let viewB: TreeReadView<number, TestEntry> | undefined;
		const rowsA = await collectRows(viewA, {
			count: 3,
			fn: async () => {
				const changes: [number, TestEntry | undefined][] = [];
				for (let key = 10; key <= 30; key++) {
					changes.push([key, entry(key, `rev2-${key}`)]);
				}
				for (let key = 31; key <= 40; key++) {
					changes.push([key, entry(key, `rev2-${key}`)]);
				}
				await tree.stage(changes);
				await tree.sync();
				viewB = tree.readView(tree.snapshot());
			},
		});
		expectSameRows(rowsA, expectedA);

		const rowsB = await collectRows(viewB!);
		const expectedB: TestEntry[] = [];
		for (let key = 1; key <= 9; key++) expectedB.push(entry(key));
		for (let key = 10; key <= 40; key++) expectedB.push(entry(key, `rev2-${key}`));
		expectSameRows(rowsB, expectedB);
	});

	it('a view built AFTER a later commit still shows the snapshot boundary (mid-sweep shape)', async () => {
		// A snapshot captures the committed boundary it sat on (CollectionSnapshot.context).
		// Building the view LATER — after the same tree flushed a further commit, folding new
		// content into the shared cache and advancing its context — must still yield the
		// snapshot's boundary, not the new one. This is the multi-tree commit sweep shape:
		// tree N has already synced while tree N+1 has not, and a committed read of BOTH must
		// describe the pre-sweep boundary. Without the pin (view context frozen at view
		// creation, seed unfiltered) this view would read post-commit content.
		const network = new TestTransactor();
		const tree = await makeTree(network, 'pinned-boundary', 40, 4);

		const preCommit = tree.snapshot();
		const expected = await collectRows(tree.readView(preCommit));
		expect(expected).to.have.length(40);

		// A second commit through the SAME live tree: rewrites every row, appends more.
		const changes: [number, TestEntry | undefined][] = [];
		for (let key = 1; key <= 40; key++) {
			changes.push([key, entry(key, `rewritten-${key}`)]);
		}
		for (let key = 41; key <= 60; key++) {
			changes.push([key, entry(key)]);
		}
		await tree.stage(changes);
		await tree.sync();

		// View built NOW from the OLD snapshot: must show the pre-commit rows.
		const pinnedRows = await collectRows(tree.readView(preCommit));
		expectSameRows(pinnedRows, expected);

		// No permanent staleness: a FRESH snapshot's view shows the committed rewrite.
		const freshRows = await collectRows(tree.readView(tree.snapshot()));
		expect(freshRows).to.have.length(60);
		expect(freshRows[0]).to.deep.equal(entry(1, 'rewritten-1'));
	});

	it('a committed view of a never-synced collection is still readable (and stays empty)', async () => {
		const network = new TestTransactor();
		const tree = await Tree.createOrOpen<number, TestEntry>(network, 'pinned-fresh', e => e.key);

		const view = tree.readView(tree.snapshot());
		expect(await view.get(1)).to.equal(undefined);
		expect(await collectRows(view)).to.deep.equal([]);

		// Rows staged into the live tree after the snapshot stay invisible to the view.
		await tree.stage([[1, entry(1)]]);
		expect(await view.get(1)).to.equal(undefined);
		expect(await collectRows(view)).to.deep.equal([]);
	});

	it('records no read dependencies by default; recordReads: true feeds the shared collector', async () => {
		const network = new TestTransactor();
		const tree = await makeTree(network, 'pinned-deps', 40, 4);
		const collection = tree.getCollection();

		// Default: a full walk and a point lookup leave the collection's conflict set untouched.
		collection.clearReadDependencies();
		const silent = tree.readView(tree.snapshot());
		await collectRows(silent);
		expect(await silent.get(7)).to.deep.equal(entry(7));
		expect(collection.getReadDependencies()).to.deep.equal([]);

		// Opt-in: the same reads grow the shared conflict set.
		const recorded = tree.readView(tree.snapshot(), { recordReads: true });
		expect(await recorded.get(7)).to.deep.equal(entry(7));
		expect(collection.getReadDependencies()).to.not.be.empty;
	});

	it('propagates BlockUnavailableError from the pinned source instead of reading absent', async () => {
		const inner = new TestTransactor();
		const network = new FlippableUnavailableTransactor(inner);
		const tree = await makeTree(network, 'pinned-unavailable', 500, 4);

		const view = tree.readView(tree.snapshot());
		network.failing = true;

		try {
			await collectRows(view);
			expect.fail('expected the walk to throw BlockUnavailableError');
		} catch (e) {
			expect(e).to.be.instanceOf(BlockUnavailableError);
		}
	});
});
