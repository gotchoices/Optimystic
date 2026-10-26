/**
 * Sealed segments in a `Collection` (stage 2 of docs/offline-sync.md): the staged actions are an
 * ordered list of sealed segments, one per queued entry, ahead of the open segment the current
 * transaction stages into. A segment can be removed on its own, a replay stages each sealed segment
 * atomically and records a refusal of one instead of throwing it, a whole-collection commit refuses
 * while anything is sealed (ticket `offline-sync-segment-bookkeeping`), a snapshot covers the open
 * segment only (`offline-sync-open-segment-snapshot`), and the head segment is committed on its own
 * without holding the collection latch across the network (`offline-sync-collection-segments`).
 *
 * Every case runs over `Tree` and `TestTransactor`, with a real rival handle committing through
 * `commitRivalTreeWrite` where a refusal has to be provoked — nothing is faked. The doubles that
 * park or tear a commit (`GatedCommitTransactor`, `GatedPendTransactor`, `TailLandsButReportsStale`)
 * delegate the real round trip and only decide WHEN the answer comes back, or how much of it lands.
 */

import { expect } from 'chai';
import {
	Tree,
	TreeEntryChangedError,
	TreeKeyTakenError,
	ActionRefusedError,
	PromiseShortfallError,
	SealedSegmentsError,
	SegmentList,
	SyncRetryExhaustedError,
	TornActionError,
	TransactionCoordinator,
	createTransactionStamp,
	createTransactionId,
	ACTIONS_ENGINE_ID,
	type CommitRequest,
	type CommitResult,
	type HeadCommitOptions,
	type InFlightAttempt,
	type ITransactor,
	type PendRequest,
	type PendResult,
	type Transaction,
	type TreeReplaceAction,
} from '../src/index.js';
import {
	TestTransactor,
	DelegatingTransactor,
	GatedCommitTransactor,
	GatedPendTransactor,
	RecordsAttemptsRefusesFirstCommit,
	RefusesPendsAsShortfall,
	TailLandsButReportsStale,
	commitRivalTreeWrite,
} from '../src/testing/test-transactor.js';
import { captureCollectionLog } from './capture-log.js';

interface Entry {
	key: number;
	name: string;
}

const USERS = 'users';
const byKey = (e: Entry) => e.key;
const entry = (key: number, name: string): Entry => ({ key, name });

type Refusal = { entryId: string; error: ActionRefusedError };

/** Run `fn` and hand back what it threw; fails the test if it resolved. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected operation to throw, but it resolved');
}

/** Commit one row through a handle of its own, so the handles under test open over a committed
 * collection rather than inventing one. */
async function seedUsers(transactor: TestTransactor): Promise<void> {
	await commitRivalTreeWrite<number, Entry>(transactor, USERS, byKey, [[5, entry(5, 'seed')]]);
}

/** A tree whose collection reports sealed-segment refusals into `refusals`. */
async function openReporting(transactor: ITransactor, refusals: Refusal[], id = USERS): Promise<Tree<number, Entry>> {
	return Tree.createOrOpen<number, Entry>(transactor, id, byKey, undefined, undefined, {
		onSealedRefused: (entryId, error) => { refusals.push({ entryId, error }); },
	});
}

/** Stage `actions` as one action and seal it under `entryId`. */
async function sealAs(tree: Tree<number, Entry>, entryId: string, actions: TreeReplaceAction<number, Entry>): Promise<void> {
	await tree.stage(actions);
	expect(tree.getCollection().sealPending(entryId), `${entryId} seals a non-empty open segment`).to.be.true;
}

async function rivalWrites(transactor: TestTransactor, key: number, name: string): Promise<void> {
	await commitRivalTreeWrite<number, Entry>(transactor, USERS, byKey, [[key, entry(key, name)]]);
}

/** The head commit's identity, as the queue would supply it, with a short retry budget. */
const headOptions = (actionId: string): HeadCommitOptions =>
	({ actionId, timestamp: Date.now(), maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 });

/** The keys each committed log entry of `id` replaced, in log order, read through a fresh handle
 * over the UNWRAPPED transactor — durable storage, not the handle under test's view. */
async function committedKeys(inner: TestTransactor, id = USERS): Promise<number[][]> {
	const fresh = await Tree.createOrOpen<number, Entry>(inner, id, byKey);
	const keys: number[][] = [];
	for await (const action of fresh.getCollection().selectLog()) {
		keys.push(action.data.map(([key]) => key));
	}
	return keys;
}

/** `promise`, or a failure naming `what` if it has not settled within `ms` — for a call that must
 * not wait on the network. */
async function withinMs<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} blocked for ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Lands the first commit durably and then throws, as a connection dropped after the answer left
 * the coordinator would: the write is saved and the writer not told. Every later call delegates. */
class CommitLandsThenThrows extends DelegatingTransactor {
	pends = 0;
	commits = 0;

	constructor(inner: TestTransactor) {
		super(inner);
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		this.pends++;
		return this.inner.pend(request);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		const result = await this.inner.commit(request);	// durable FIRST
		if (this.commits++ === 0) {
			throw new Error('connection reset after the commit landed');
		}
		return result;
	}
}

/** `TailLandsButReportsStale` that also counts the pends it delegates, so a test can say how many
 * attempts and re-sends went to the network: with no injections it tears nothing and only counts. */
class CountsPends extends TailLandsButReportsStale {
	pends = 0;

	override async pend(request: PendRequest): Promise<PendResult> {
		this.pends++;
		return super.pend(request);
	}
}

describe('Collection sealed segments', function () {
	this.timeout(20000);

	describe('SegmentList', () => {
		it('seals only a non-empty open segment, and bumps the version on every change to the sealed list', () => {
			const list = new SegmentList<number>();
			expect(list.seal('E0'), 'nothing to seal').to.be.false;
			expect(list.version, 'a refused seal is not a change').to.equal(0);

			list.open.push({ type: 'a', data: 1 }, { type: 'a', data: 2 });
			expect(list.seal('E1')).to.be.true;
			expect(list.open, 'the open segment starts afresh').to.deep.equal([]);
			expect(list.entryIds()).to.deep.equal(['E1']);
			expect(list.version).to.equal(1);
			expect(() => list.seal('E1'), 'an id seals once').to.throw(/already sealed/);

			list.open.push({ type: 'a', data: 3 });
			list.seal('E2');
			expect(list.replayableCount(), 'both segments, no open action').to.equal(3);

			list.refuse('E1', new ActionRefusedError('c', 'refused'));
			expect(list.version).to.equal(3);
			expect(list.replayable().map(s => s.entryId), 'a refused segment is excluded').to.deep.equal(['E2']);
			expect(list.replayableCount()).to.equal(1);
			expect(list.entryIds(), 'but still listed').to.deep.equal(['E1', 'E2']);

			expect(list.drop('E1').entryId).to.equal('E1');
			expect(list.version).to.equal(4);
			expect(list.head()?.entryId).to.equal('E2');
			expect(() => list.drop('E1')).to.throw(/not sealed/);
		});
	});

	it('sealPending with an empty open segment returns false and leaves an invented collection untouched', async () => {
		const transactor = new TestTransactor();
		const tree = await Tree.createOrOpen<number, Entry>(transactor, 'fresh', byKey);
		const collection = tree.getCollection();

		expect(collection.sealPending('E0')).to.be.false;
		expect(collection.sealedEntries()).to.deep.equal([]);
		// The invented header, log and root are not an action: they stay in the tracker, owned by no
		// segment, and the tree still reads.
		expect(collection.hasUnsyncedChanges()).to.be.true;
		expect(await tree.get(1)).to.be.undefined;

		await tree.stage([[1, entry(1, 'one')]]);
		expect(collection.sealPending('E1')).to.be.true;
		expect(collection.sealedEntries()).to.deep.equal(['E1']);
		expect(() => collection.sealPending('E1')).to.throw(/already sealed/);
	});

	describe('a refresh that refuses a sealed segment', () => {
		/** The shape of the ticket's case: a sealed segment inserting under an `absent` guard, then a
		 * rival committing the same key, then a refresh (the one a live read triggers). */
		async function refuseOnRefresh(): Promise<{ transactor: TestTransactor; tree: Tree<number, Entry>; refusals: Refusal[]; lines: string[] }> {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			await sealAs(tree, 'E1', [[1, entry(1, 'queued'), { kind: 'absent' }]]);
			await rivalWrites(transactor, 1, 'rival');
			const lines = await captureCollectionLog(() => tree.update());
			return { transactor, tree, refusals, lines };
		}

		it('records the refusal, reports it once, keeps the segment listed, and the read sees the rival', async () => {
			const { tree, refusals, lines } = await refuseOnRefresh();
			const collection = tree.getCollection();

			expect(refusals, 'reported exactly once').to.have.length(1);
			expect(refusals[0]!.entryId).to.equal('E1');
			expect(refusals[0]!.error, 'the handler\'s own refusal').to.be.instanceOf(TreeKeyTakenError);
			expect(collection.sealedRefusal('E1'), 'recorded on the segment').to.equal(refusals[0]!.error);
			expect(collection.sealedEntries(), 'a refused segment stays listed until dropped').to.deep.equal(['E1']);
			expect(await tree.get(1), 'the read proceeds without the segment\'s effect').to.deep.equal(entry(1, 'rival'));
			expect(lines.some(line => line.includes('collection:sealed-segment-refused') && line.includes('entry=E1')),
				`the refusal is logged: ${lines.join('\n')}`).to.be.true;
		});

		it('does not replay or report a refused segment again on a later refresh', async () => {
			const { transactor, tree, refusals } = await refuseOnRefresh();
			await rivalWrites(transactor, 2, 'rival-2');
			await tree.update();

			expect(refusals, 'the second refresh reports nothing').to.have.length(1);
			expect(tree.getCollection().sealedRefusal('E1')).to.be.instanceOf(TreeKeyTakenError);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'rival'));
			expect(await tree.get(2), 'the second refresh did adopt the rival').to.deep.equal(entry(2, 'rival-2'));
		});

		it('stages a sealed segment atomically: a refusal of its third action leaves none of the three', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			await tree.stage([[1, entry(1, 'one')]]);
			await tree.stage([[2, entry(2, 'two')]]);
			await tree.stage([[3, entry(3, 'three'), { kind: 'absent' }]]);
			expect(tree.getCollection().sealPending('E')).to.be.true;
			await rivalWrites(transactor, 3, 'rival');

			await tree.update();

			expect(refusals.map(r => r.entryId)).to.deep.equal(['E']);
			expect(await tree.get(1), 'the first action\'s write is discarded with the segment').to.be.undefined;
			expect(await tree.get(2)).to.be.undefined;
			expect(await tree.get(3)).to.deep.equal(entry(3, 'rival'));
		});

		it('propagates a refusal of the OPEN segment out of update() and reports nothing', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			await tree.stage([[1, entry(1, 'live'), { kind: 'absent' }]]);	// not sealed
			await rivalWrites(transactor, 1, 'rival');

			const err = await capture(() => tree.update());
			expect(err, 'the live transaction\'s own refusal').to.be.instanceOf(TreeKeyTakenError);
			expect(refusals, 'the callback is for sealed segments only').to.be.empty;
		});

		it('logs a throwing callback and still records the refusal and finishes the replay', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey, undefined, undefined, {
				onSealedRefused: () => { throw new Error('callback boom'); },
			});
			await sealAs(tree, 'E1', [[1, entry(1, 'queued'), { kind: 'absent' }]]);
			await sealAs(tree, 'E2', [[2, entry(2, 'after')]]);
			await rivalWrites(transactor, 1, 'rival');

			const lines = await captureCollectionLog(() => tree.update());

			expect(lines.some(line => line.includes('collection:refusal-callback-threw') && line.includes('callback boom')),
				`the throw is logged: ${lines.join('\n')}`).to.be.true;
			expect(tree.getCollection().sealedRefusal('E1')).to.be.instanceOf(TreeKeyTakenError);
			expect(await tree.get(2), 'the segment after the refused one was replayed').to.deep.equal(entry(2, 'after'));
			expect(await tree.get(1)).to.deep.equal(entry(1, 'rival'));
		});
	});

	describe('dropSealed', () => {
		it('removes a non-head segment, reports a later segment the drop makes refuse, and clears a refused one when it is dropped', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			const collection = tree.getCollection();
			const one = entry(1, 'one');
			await sealAs(tree, 'E0', [[10, entry(10, 'ten')]]);
			await sealAs(tree, 'E1', [[1, one, { kind: 'absent' }]]);
			// E2 updates the row E1 inserted, so it holds only while E1 does.
			await sealAs(tree, 'E2', [[1, entry(1, 'one-updated'), { kind: 'unchanged', expected: one }]]);
			await sealAs(tree, 'E3', [[3, entry(3, 'three'), { kind: 'absent' }]]);

			await collection.dropSealed('E1');

			expect(collection.sealedEntries(), 'removed wherever it sits').to.deep.equal(['E0', 'E2', 'E3']);
			expect(refusals.map(r => r.entryId), 'the dependent segment is refused by the replay').to.deep.equal(['E2']);
			expect(refusals[0]!.error).to.be.instanceOf(TreeEntryChangedError);
			expect((refusals[0]!.error as TreeEntryChangedError<number, Entry>).actual, 'its row is gone').to.be.undefined;
			expect(collection.sealedRefusal('E2')).to.equal(refusals[0]!.error);
			expect(await tree.get(1)).to.be.undefined;
			expect(await tree.get(10), 'the segments that still hold are staged').to.deep.equal(entry(10, 'ten'));
			expect(await tree.get(3)).to.deep.equal(entry(3, 'three'));

			await collection.dropSealed('E2');

			expect(collection.sealedEntries()).to.deep.equal(['E0', 'E3']);
			expect(collection.sealedRefusal('E2'), 'dropped, so no longer refused').to.be.undefined;
			expect(refusals, 'the remaining segments replay cleanly').to.have.length(1);
			expect(await tree.get(10)).to.deep.equal(entry(10, 'ten'));
			expect(await tree.get(3)).to.deep.equal(entry(3, 'three'));

			const err = await capture(() => collection.dropSealed('E1'));
			expect((err as Error).message, 'an unknown id throws').to.match(/not sealed/);
			expect(collection.sealedEntries(), 'and changes nothing').to.deep.equal(['E0', 'E3']);
		});

		it('replays an invented collection from its baseline, so its header, log and root survive', async () => {
			const transactor = new TestTransactor();
			const tree = await Tree.createOrOpen<number, Entry>(transactor, 'fresh', byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'one')]]);
			await sealAs(tree, 'E2', [[2, entry(2, 'two')]]);

			await collection.dropSealed('E1');

			expect(collection.committedRevision(), 'still invented: nothing was committed').to.be.undefined;
			expect(await tree.get(1), 'the dropped segment\'s row is gone').to.be.undefined;
			expect(await tree.get(2), 'the tree is still readable and holds the remaining segment').to.deep.equal(entry(2, 'two'));
			expect(collection.hasUnsyncedChanges(), 'the invented header is still staged').to.be.true;
			expect(collection.sealedEntries()).to.deep.equal(['E2']);
			expect(await Tree.open<number, Entry>(transactor, 'fresh', byKey), 'nothing reached storage').to.be.undefined;

			// With every segment dropped a whole-collection sync is allowed again, and its first commit
			// folds and adopts BEFORE replaying, so the committed header is not shadowed by the
			// baseline's and the collection reads as synced.
			await collection.dropSealed('E2');
			await tree.sync();
			expect(collection.hasUnsyncedChanges(), 'the first commit of an invented collection settles').to.be.false;
			expect(collection.committedRevision()).to.equal(1);
			expect(await Tree.open<number, Entry>(transactor, 'fresh', byKey), 'the header is committed').to.not.be.undefined;
		});
	});

	describe('a snapshot covers the open segment only (ticket offline-sync-open-segment-snapshot)', () => {
		it('restoring across a dropped segment replays what remains: the dropped entry is not put back, the open action is gone, the pins are current, and the snapshot\'s read view still sees the entry', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'one')]]);
			await sealAs(tree, 'E2', [[5, entry(5, 'seed-updated')]]);	// updates the committed row

			// The bridge's markDirty moment: captured over two sealed segments, with nothing open.
			const snapshot = collection.snapshotPending();
			expect(snapshot.pending, 'the open segment only').to.deep.equal([]);
			expect(snapshot.sealedVersion).to.equal(2);
			await tree.stage([[2, entry(2, 'open')]]);
			// The drain commits E1 and removes it while the snapshot is outstanding (dropSealed stands
			// in for the head commit the next ticket adds; both bump the version).
			await collection.dropSealed('E1');

			await collection.restorePending(snapshot);

			expect(collection.sealedEntries(), 'the dropped segment is not put back').to.deep.equal(['E2']);
			expect(await tree.get(1), 'nor its effect').to.be.undefined;
			expect(await tree.get(2), 'the open action staged after the capture is gone').to.be.undefined;
			expect(await tree.get(5), 'the remaining segment is re-staged').to.deep.equal(entry(5, 'seed-updated'));
			expect(collection.snapshotPending().sealedVersion, 'a new snapshot carries the changed version').to.not.equal(snapshot.sealedVersion);

			// The tracker equals a fresh replay of the remaining state: E2 alone over the committed base.
			const fresh = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			await fresh.stage([[5, entry(5, 'seed-updated')]]);
			expect(collection.tracker.transforms).to.deep.equal(fresh.getCollection().tracker.transforms);

			// Pins through the replay arm: the re-staged update names the revision the cache holds for
			// its block (every block is at the seed commit's revision), and nothing reads as moved.
			const updated = Object.keys(collection.tracker.transforms.updates ?? {});
			expect(updated, 'E2 updated a committed block').to.not.be.empty;
			const bases = collection.tracker.stagedBaseRevs(updated);
			expect(Object.keys(bases)).to.have.members(updated);
			for (const rev of Object.values(bases)) {
				expect(rev).to.equal(collection.committedRevision());
			}
			expect(collection.tracker.movedBases()).to.deep.equal([]);

			// The snapshot's transforms still hold E1's effect: a committed read view built from it
			// sees the entry the SQL layer was told had committed, after E1 was dropped live.
			expect(await tree.readView(snapshot).get(1)).to.deep.equal(entry(1, 'one'));
		});

		it('restoring while a refused segment was removed keeps the later segment refused rather than retrying it', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			const collection = tree.getCollection();
			const one = entry(1, 'one');
			await sealAs(tree, 'E1', [[1, one, { kind: 'absent' }]]);
			// E2 updates the row E1 inserted, so it holds only while E1 does.
			await sealAs(tree, 'E2', [[1, entry(1, 'one-updated'), { kind: 'unchanged', expected: one }]]);
			const savepoint = collection.snapshotPending();
			await tree.stage([[2, entry(2, 'open')]]);
			await collection.dropSealed('E1');	// the replay refuses E2: its row is gone
			expect(refusals.map(r => r.entryId)).to.deep.equal(['E2']);

			await collection.restorePending(savepoint);

			expect(collection.sealedEntries()).to.deep.equal(['E2']);
			expect(collection.sealedRefusal('E2'), 'still refused, by the same refusal').to.equal(refusals[0]!.error);
			expect(refusals, 'the restore\'s replay skipped it rather than retrying and re-reporting it').to.have.length(1);
			expect(await tree.get(1)).to.be.undefined;
			expect(await tree.get(2), 'the open action is gone').to.be.undefined;
			expect(await tree.get(5), 'the committed row reads through').to.deep.equal(entry(5, 'seed'));
		});

		it('restoring an invented collection across a dropped segment replays from its baseline, so it stays readable', async () => {
			const transactor = new TestTransactor();
			const tree = await Tree.createOrOpen<number, Entry>(transactor, 'fresh', byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'one')]]);
			const snapshot = collection.snapshotPending();
			await tree.stage([[2, entry(2, 'open')]]);
			await collection.dropSealed('E1');

			await collection.restorePending(snapshot);

			expect(collection.committedRevision(), 'still invented').to.be.undefined;
			expect(collection.sealedEntries()).to.deep.equal([]);
			expect(await tree.get(1)).to.be.undefined;
			expect(await tree.get(2)).to.be.undefined;
			expect(collection.hasUnsyncedChanges(), 'the invented header is still staged').to.be.true;
			await tree.stage([[3, entry(3, 'three')]]);
			expect(await tree.get(3), 'the tree is readable and writable').to.deep.equal(entry(3, 'three'));
		});

		it('a refusal of the restored open segment inside the replay arm propagates, after the sealed segments were re-staged', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[10, entry(10, 'ten')]]);
			const outer = collection.snapshotPending();
			await tree.stage([[1, entry(1, 'live'), { kind: 'absent' }]]);
			const inner = collection.snapshotPending();	// a nested savepoint carrying the guarded open action
			expect(inner.pending).to.have.length(1);
			await collection.restorePending(outer);	// verbatim: nothing sealed changed, nothing moved
			expect(await tree.get(1)).to.be.undefined;
			await sealAs(tree, 'E2', [[20, entry(20, 'twenty')]]);	// the sealed list changes
			await rivalWrites(transactor, 1, 'rival');	// and a rival takes the open action's key
			await tree.update();	// adopted cleanly: nothing is open, and both segments hold

			const err = await capture(() => collection.restorePending(inner));

			expect(err, 'the live transaction\'s own refusal').to.be.instanceOf(TreeKeyTakenError);
			expect(refusals, 'the callback is for sealed segments only').to.be.empty;
			expect(collection.sealedEntries()).to.deep.equal(['E1', 'E2']);
			expect(await tree.get(10), 'the sealed segments were re-staged before the refusal').to.deep.equal(entry(10, 'ten'));
			expect(await tree.get(20)).to.deep.equal(entry(20, 'twenty'));
			expect(await tree.get(1)).to.deep.equal(entry(1, 'rival'));
		});
	});


	describe('commitHead (ticket offline-sync-collection-segments)', () => {
		it('releases the latch while the commit is on the network: staging goes on, a second commitHead and a dropSealed of the head are refused as in flight, and the outcome folds before the replay', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new GatedCommitTransactor(inner);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);

			const committing = collection.commitHead('E1', headOptions('A1'));
			await transactor.commitParked;	// durable on the inner transactor; the answer not yet returned

			// The latch is released: staging does not wait for the network.
			await withinMs(2000, tree.stage([[2, entry(2, 'open')]]), 'staging during the head commit');
			const second = await capture(() => collection.commitHead('E1', headOptions('A2')));
			expect(second).to.be.instanceOf(SealedSegmentsError);
			expect((second as SealedSegmentsError).reason).to.equal('in-flight');
			const drop = await capture(() => collection.dropSealed('E1'));
			expect(drop).to.be.instanceOf(SealedSegmentsError);
			expect((drop as SealedSegmentsError).reason).to.equal('in-flight');
			expect(collection.sealedEntries(), 'the head stays sealed while in flight').to.deep.equal(['E1']);

			transactor.openGate();
			const durability = await committing;

			expect(durability, 'who holds the commit').to.not.equal(undefined);
			expect(collection.sealedEntries()).to.deep.equal([]);
			expect(await committedKeys(inner), 'the committed log holds the head alone').to.deep.equal([[5], [1]]);
			expect(collection.committedRevision()).to.equal(2);
			expect(collection.hasUnsyncedChanges(), 'the open action is still staged').to.be.true;
			expect(await tree.get(1), 'a read sees the committed head').to.deep.equal(entry(1, 'queued'));
			expect(await tree.get(2), 'and the open action, replayed over it').to.deep.equal(entry(2, 'open'));
		});

		it('refuses a segment that is not the head, and commits each head in turn, re-staging the segment behind it over the committed state', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const tree = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'one')]]);
			await sealAs(tree, 'E2', [[2, entry(2, 'two')]]);

			const notHead = await capture(() => collection.commitHead('E2', headOptions('A2')));
			expect(notHead).to.be.instanceOf(SealedSegmentsError);
			expect((notHead as SealedSegmentsError).reason).to.equal('not-head');
			expect(collection.sealedEntries(), 'nothing changed').to.deep.equal(['E1', 'E2']);

			await collection.commitHead('E1', headOptions('A1'));

			expect(collection.sealedEntries(), 'E2 is the head now, its actions never consumed').to.deep.equal(['E2']);
			expect(await committedKeys(inner)).to.deep.equal([[5], [1]]);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'one'));
			expect(await tree.get(2), 'E2 is re-staged over the committed head').to.deep.equal(entry(2, 'two'));

			await collection.commitHead('E2', headOptions('A2'));

			expect(collection.sealedEntries()).to.deep.equal([]);
			expect(await committedKeys(inner)).to.deep.equal([[5], [1], [2]]);
			expect(collection.hasUnsyncedChanges()).to.be.false;
		});

		it('a reader\'s refresh that walks into the in-flight entry defers to the commit: nothing adopted, nothing refused, and the refresh after the commit finds nothing new', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new GatedCommitTransactor(inner);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);

			const committing = collection.commitHead('E1', headOptions('A1'));
			await transactor.commitParked;
			const lines = await captureCollectionLog(() => tree.update());

			expect(lines.some(line => line.includes('collection:refresh-deferred-to-head-commit') && line.includes('entry=E1') && line.includes('action=A1')),
				`the deferral is logged: ${lines.join('\n')}`).to.be.true;
			expect(collection.committedRevision(), 'the held revision is unchanged').to.equal(1);
			expect(collection.sealedEntries(), 'the head is still sealed').to.deep.equal(['E1']);
			expect(collection.sealedRefusal('E1')).to.be.undefined;
			expect(refusals).to.be.empty;

			transactor.openGate();
			await committing;

			expect(collection.committedRevision(), 'the commit applied its own outcome').to.equal(2);
			const after = await captureCollectionLog(() => tree.update());
			expect(after.filter(line => line.includes('refresh-deferred')), 'nothing to defer to any more').to.be.empty;
			expect(collection.committedRevision(), 'and nothing new to adopt').to.equal(2);
			expect(collection.sealedEntries()).to.deep.equal([]);
			expect(await committedKeys(inner), 'the head is logged once').to.deep.equal([[5], [1]]);
		});

		it('a rival that lands while the attempt is in flight: a reader\'s refresh proceeds and adopts it, the attempt is refused, and the retry commits the head rebuilt at the adopted revision', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new GatedPendTransactor<TreeReplaceAction<number, Entry>>(inner);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			transactor.collection = collection;
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);

			const committing = collection.commitHead('E1', headOptions('A1'));
			await transactor.pendParked;	// the attempt is built, nothing has reached storage
			await rivalWrites(inner, 2, 'rival');	// lands first
			await tree.update();	// the reader's refresh finds the rival, not our entry: it proceeds

			expect(collection.committedRevision(), 'the rival was adopted while the attempt was in flight').to.equal(2);
			expect(collection.sealedRefusal('E1'), 'the head holds over the rival').to.be.undefined;

			transactor.openGate();	// the stale attempt reaches storage and is refused
			const durability = await committing;

			expect(durability).to.not.equal(undefined);
			expect(transactor.snapshots, 'the refused attempt, then the retry').to.have.length(2);
			expect(collection.sealedEntries()).to.deep.equal([]);
			expect(collection.committedRevision()).to.equal(3);
			expect(await committedKeys(inner), 'the rival first, then the head').to.deep.equal([[5], [2], [1]]);
			const fresh = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
			expect(await fresh.get(1)).to.deep.equal(entry(1, 'queued'));
			expect(await fresh.get(2)).to.deep.equal(entry(2, 'rival'));
		});

		it('a head attempt whose tail landed but was refused: the refresh finishes it from the retained attempt and consumes the HEAD, not the action staged during the window, and the segment behind it is untouched', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new TailLandsButReportsStale(inner);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);
			await sealAs(tree, 'E2', [[3, entry(3, 'behind')]]);

			const committing = collection.commitHead('E1', headOptions('A1'));
			// Queued on the latch, which the head commit releases for its network round trip: this
			// stages while the attempt is in flight, and holds the latch until the commit retakes it.
			const staging = tree.stage([[2, entry(2, 'open')]]);
			const durability = await committing;
			await staging;

			expect(transactor.tears, 'the attempt landed its tail only').to.equal(1);
			expect(durability, 'the refresh that finished the write reports who holds it').to.not.equal(undefined);
			expect(collection.sealedEntries(), 'the head was consumed; the segment behind it was not').to.deep.equal(['E2']);
			expect(await committedKeys(inner), 'the head is logged once').to.deep.equal([[5], [1]]);
			expect(collection.committedRevision()).to.equal(2);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'queued'));
			expect(await tree.get(2), 'the open action is still staged').to.deep.equal(entry(2, 'open'));
			expect(await tree.get(3), 'E2 is re-staged, its actions never consumed').to.deep.equal(entry(3, 'behind'));
			const fresh = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
			expect(await fresh.get(2), 'nothing of the open segment landed').to.be.undefined;
			expect(await fresh.get(3), 'nor of E2').to.be.undefined;
		});

		it('a head refused on rebase before anything is sent: the recorded refusal is thrown, reported once, and no attempt is made', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new RecordsAttemptsRefusesFirstCommit(inner, 0);	// records pends, refuses nothing
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued'), { kind: 'absent' }]]);
			await rivalWrites(inner, 1, 'rival');

			const err = await capture(() => collection.commitHead('E1', headOptions('A1')));

			expect(err, 'the handler\'s own refusal').to.be.instanceOf(TreeKeyTakenError);
			expect(refusals.map(r => r.entryId), 'reported once').to.deep.equal(['E1']);
			expect(collection.sealedRefusal('E1')).to.equal(err);
			expect(transactor.attempts, 'nothing was sent').to.be.empty;
			expect(collection.sealedEntries(), 'the refused segment stays listed for the queue to drop').to.deep.equal(['E1']);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'rival'));

			const again = await capture(() => collection.commitHead('E1', headOptions('A2')));
			expect(again, 'a refused head meets the precondition').to.be.instanceOf(SealedSegmentsError);
			expect((again as SealedSegmentsError).reason).to.equal('refused');
			expect(refusals, 'and is not reported again').to.have.length(1);
		});

		it('a head refused by a rival that landed while the attempt was in flight: the refresh adopts the rival, the replay refuses the head, and the recorded refusal is thrown instead of a retry', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new GatedPendTransactor<TreeReplaceAction<number, Entry>>(inner);
			const refusals: Refusal[] = [];
			const tree = await openReporting(transactor, refusals);
			const collection = tree.getCollection();
			transactor.collection = collection;
			await sealAs(tree, 'E1', [[1, entry(1, 'queued'), { kind: 'absent' }]]);

			const committing = collection.commitHead('E1', headOptions('A1'));
			await transactor.pendParked;
			await rivalWrites(inner, 1, 'rival');	// takes the head's key
			transactor.openGate();
			const err = await capture(() => committing);

			expect(err).to.be.instanceOf(TreeKeyTakenError);
			expect(refusals.map(r => r.entryId)).to.deep.equal(['E1']);
			expect(transactor.snapshots, 'one attempt, no retry').to.have.length(1);
			expect(collection.sealedEntries()).to.deep.equal(['E1']);
			expect(collection.committedRevision(), 'the rival was adopted').to.equal(2);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'rival'));
			expect(await committedKeys(inner), 'the seed and the rival only').to.deep.equal([[5], [1]]);
		});

		it('a snapshot restored across a head commit takes the replay arm: the committed segment is not put back, the open action is gone, and the log holds it once', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const tree = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E', [[1, entry(1, 'one')]]);
			const snapshot = collection.snapshotPending();
			await tree.stage([[2, entry(2, 'open')]]);

			await collection.commitHead('E', headOptions('A1'));
			await collection.restorePending(snapshot);

			expect(collection.sealedEntries()).to.deep.equal([]);
			expect(collection.hasUnsyncedChanges(), 'nothing is staged: E was not re-staged, the open action is gone').to.be.false;
			expect(await tree.get(1), 'E reads through, committed').to.deep.equal(entry(1, 'one'));
			expect(await tree.get(2)).to.be.undefined;
			expect(await committedKeys(inner), 'E is committed once').to.deep.equal([[5], [1]]);
			await tree.sync();	// nothing to commit: the restore did not reinstate E
			expect(await committedKeys(inner)).to.deep.equal([[5], [1]]);
		});

		it('an invented collection commits its header, log and root with the head, re-stages the segment behind it over the committed state, and stops consulting the baseline', async () => {
			const transactor = new TestTransactor();
			const tree = await Tree.createOrOpen<number, Entry>(transactor, 'fresh', byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'one')]]);
			await sealAs(tree, 'E2', [[2, entry(2, 'two')]]);
			expect(collection.committedRevision(), 'invented').to.be.undefined;

			const durability = await collection.commitHead('E1', headOptions('A1'));

			expect(durability).to.not.equal(undefined);
			expect(collection.committedRevision(), 'a committed revision is adopted, so the baseline is no longer consulted').to.equal(1);
			expect(collection.sealedEntries()).to.deep.equal(['E2']);
			const opened = await Tree.open<number, Entry>(transactor, 'fresh', byKey);
			expect(opened, 'the header is committed').to.not.be.undefined;
			expect(await opened!.get(1), 'with the root and E1').to.deep.equal(entry(1, 'one'));
			expect(await opened!.get(2), 'E2 is not committed').to.be.undefined;
			expect(await committedKeys(transactor, 'fresh')).to.deep.equal([[1]]);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'one'));
			expect(await tree.get(2), 'E2 is re-staged over the committed state and readable').to.deep.equal(entry(2, 'two'));
		});

		it('a promise shortfall out of a head attempt is thrown by name and leaves every segment staged', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new RefusesPendsAsShortfall(inner);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'one')]]);
			await sealAs(tree, 'E2', [[2, entry(2, 'two')]]);
			await tree.stage([[3, entry(3, 'open')]]);

			const err = await capture(() => collection.commitHead('E1', headOptions('A1')));

			expect(err).to.be.instanceOf(PromiseShortfallError);
			expect(transactor.pends, 'one attempt, stopped by name').to.equal(1);
			expect(collection.sealedEntries()).to.deep.equal(['E1', 'E2']);
			expect(collection.sealedRefusal('E1'), 'a shortfall is not a refusal of the segment').to.be.undefined;
			expect(collection.committedRevision()).to.equal(1);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'one'));
			expect(await tree.get(2)).to.deep.equal(entry(2, 'two'));
			expect(await tree.get(3)).to.deep.equal(entry(3, 'open'));
			expect(await committedKeys(inner)).to.deep.equal([[5]]);
		});

		it('a re-drive under the same action id after a commit that landed but was never answered: the opening refresh recognises the entry as the write\'s own, consumes the head, sends nothing again, and answers undefined', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new CommitLandsThenThrows(inner);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);
			await sealAs(tree, 'E2', [[3, entry(3, 'behind')]]);

			const err = await capture(() => collection.commitHead('E1', headOptions('A1')));
			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.include('connection reset');
			expect(collection.sealedEntries(), 'in doubt: nothing was applied').to.deep.equal(['E1', 'E2']);
			expect(collection.committedRevision()).to.equal(1);
			await tree.stage([[2, entry(2, 'open')]]);

			const durability = await collection.commitHead('E1', headOptions('A1'));	// the queue re-supplies the id

			expect(durability, 'saved without re-sending, so who holds it is not known').to.equal(undefined);
			expect(transactor.pends, 'only the first attempt was sent').to.equal(1);
			expect(transactor.commits).to.equal(1);
			expect(collection.sealedEntries(), 'the head was consumed; E2 was not').to.deep.equal(['E2']);
			expect(collection.committedRevision()).to.equal(2);
			expect(await committedKeys(inner), 'the head is logged once').to.deep.equal([[5], [1]]);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'queued'));
			expect(await tree.get(2), 'the open action is still staged').to.deep.equal(entry(2, 'open'));
			expect(await tree.get(3), 'E2 is re-staged over the committed head').to.deep.equal(entry(3, 'behind'));
		});
	});

	describe('the write-ahead hook and resuming a recorded attempt (ticket offline-sync-head-commit-handle)', () => {
		it('a recordAttempt hook that throws aborts the cycle before anything is sent: its error escapes commitHead unchanged, every segment is intact, and the next commitHead lands the head once', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new CountsPends(inner, 0);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);
			await sealAs(tree, 'E2', [[3, entry(3, 'behind')]]);
			const recorded: InFlightAttempt[] = [];
			const journalDown = new Error('journal write failed');
			const recordAttempt = async (attempt: InFlightAttempt) => {
				recorded.push(attempt);
				if (recorded.length === 1) throw journalDown;
			};

			const err = await capture(() => collection.commitHead('E1', { ...headOptions('A1'), recordAttempt }));

			expect(err, 'the hook\'s own error, unchanged').to.equal(journalDown);
			expect(transactor.pends, 'nothing was sent').to.equal(0);
			expect(recorded[0], 'the hook saw the attempt as it would have been sent').to.include({ actionId: 'A1', rev: 2 });
			expect(recorded[0]?.tailId).to.be.a('string');
			expect(collection.sealedEntries()).to.deep.equal(['E1', 'E2']);
			expect(collection.committedRevision()).to.equal(1);
			expect(await committedKeys(inner)).to.deep.equal([[5]]);

			// The latch was released with the handle: this would wait forever otherwise.
			const durability = await collection.commitHead('E1', { ...headOptions('A1'), recordAttempt });

			expect(durability).to.not.equal(undefined);
			expect(recorded, 'the retry recorded its attempt too, before sending it').to.have.length(2);
			expect(transactor.pends).to.equal(1);
			expect(transactor.landedCommits).to.equal(1);
			expect(collection.sealedEntries()).to.deep.equal(['E2']);
			expect(await committedKeys(inner), 'the head is logged once').to.deep.equal([[5], [1]]);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'queued'));
			expect(await tree.get(3), 'E2 is re-staged over the committed head').to.deep.equal(entry(3, 'behind'));
		});

		it('a recorded attempt finishes a torn head on a later cycle: without resume the re-drive is refused as torn (transforms-not-held); with it the opening refresh finishes the write, consumes the head, and no new attempt is built', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const transactor = new CountsPends(inner, 1);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);
			await sealAs(tree, 'E2', [[3, entry(3, 'behind')]]);
			const recorded: InFlightAttempt[] = [];
			// One attempt and no refresh after it, so the cycle ends with its tail landed and the
			// attempt retained nowhere a later cycle can see — except through the hook.
			const options = (resume?: InFlightAttempt): HeadCommitOptions => ({
				...headOptions('A1'),
				maxAttempts: 1,
				recordAttempt: async attempt => { recorded.push(attempt); },
				...(resume === undefined ? {} : { resume }),
			});

			const first = await capture(() => collection.commitHead('E1', options()));
			expect(first).to.be.instanceOf(SyncRetryExhaustedError);
			expect(transactor.tears, 'the tail landed, the rest was abandoned').to.equal(1);
			expect(recorded).to.have.length(1);
			expect(recorded[0]).to.include({ actionId: 'A1', rev: 2 });
			expect(collection.sealedEntries(), 'in doubt: nothing was applied').to.deep.equal(['E1', 'E2']);
			expect(collection.committedRevision()).to.equal(1);

			// The control: a re-drive under the same id with nothing handed back finds the entry and
			// can only refuse it — the blocks are missing and nothing holds the transforms.
			const control = await capture(() => collection.commitHead('E1', options()));
			expect(control).to.be.instanceOf(TornActionError);
			expect((control as TornActionError).reason).to.equal('transforms-not-held');
			expect(recorded, 'the opening refresh threw before any attempt was built').to.have.length(1);
			expect(transactor.pends, 'nothing was re-sent').to.equal(1);
			expect(collection.sealedEntries()).to.deep.equal(['E1', 'E2']);
			expect(collection.committedRevision()).to.equal(1);

			const durability = await collection.commitHead('E1', options(recorded[0]));

			expect(durability, 'finished by re-sending the recorded attempt, so who holds it is known').to.not.equal(undefined);
			expect(recorded, 'no new attempt was built').to.have.length(1);
			expect(transactor.pends, 'the re-send of the recorded attempt only').to.equal(2);
			expect(transactor.landedCommits, 'landed whole once').to.equal(1);
			expect(collection.sealedEntries(), 'the head was consumed; E2 was not').to.deep.equal(['E2']);
			expect(collection.committedRevision()).to.equal(2);
			expect(await committedKeys(inner), 'the head is logged once').to.deep.equal([[5], [1]]);
			expect(await tree.get(1)).to.deep.equal(entry(1, 'queued'));
			expect(await tree.get(3), 'E2 is re-staged over the committed head').to.deep.equal(entry(3, 'behind'));
			const fresh = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
			expect(await fresh.get(1), 'the data block landed, not only the tail').to.deep.equal(entry(1, 'queued'));
		});

		it('a recorded attempt under another action id is refused before the latch is taken', async () => {
			const inner = new TestTransactor();
			await seedUsers(inner);
			const tree = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);
			const recorded: InFlightAttempt[] = [];
			await capture(() => collection.commitHead('E1', {
				...headOptions('A1'), maxAttempts: 1,
				recordAttempt: async attempt => { recorded.push(attempt); throw new Error('stop here'); },
			}));

			const err = await capture(() => collection.commitHead('E1', { ...headOptions('A2'), resume: recorded[0] }));

			expect(err).to.be.instanceOf(Error);
			expect((err as Error).message).to.include('A1').and.include('A2');
			expect(collection.sealedEntries()).to.deep.equal(['E1']);
			await withinMs(500, tree.stage([[2, entry(2, 'open')]]), 'staging after the refused open');
		});
	});

	describe('whole-collection commits over sealed segments', () => {
		it('sync refuses with SealedSegmentsError, leaves everything staged, and the coordinator restores every participant', async () => {
			const transactor = new TestTransactor();
			await seedUsers(transactor);
			const tree = await Tree.createOrOpen<number, Entry>(transactor, USERS, byKey);
			const collection = tree.getCollection();
			await sealAs(tree, 'E1', [[1, entry(1, 'queued')]]);
			await tree.stage([[2, entry(2, 'open')]]);
			const committedBefore = transactor.getCommittedActions().size;

			const err = await capture(() => tree.sync());
			expect(err).to.be.instanceOf(SealedSegmentsError);
			expect((err as SealedSegmentsError).collectionId).to.equal(USERS);
			expect((err as SealedSegmentsError).sealedEntries).to.deep.equal(['E1']);
			expect(collection.sealedEntries()).to.deep.equal(['E1']);
			expect(await tree.get(1), 'the sealed segment is still staged').to.deep.equal(entry(1, 'queued'));
			expect(await tree.get(2), 'and so is the open one').to.deep.equal(entry(2, 'open'));
			expect(collection.hasUnsyncedChanges()).to.be.true;
			expect(transactor.getCommittedActions().size, 'nothing was sent').to.equal(committedBefore);

			// A stage-and-flush refuses before staging, so there is nothing to take back.
			const replaceErr = await capture(() => tree.replace([[4, entry(4, 'four')]]));
			expect(replaceErr).to.be.instanceOf(SealedSegmentsError);
			expect(await tree.get(4), 'nothing was staged').to.be.undefined;

			// The coordinator's append asks for the open segment, meets the same refusal inside its
			// commit span, and its existing catch restores every participant.
			const posts = await Tree.createOrOpen<number, Entry>(transactor, 'posts', byKey);
			await posts.stage([[100, entry(100, 'clean')]]);
			const coordinator = new TransactionCoordinator(transactor, new Map<string, any>([
				[USERS, collection],
				['posts', posts.getCollection()],
			]));
			const stamp = await createTransactionStamp('peer1', Date.now(), 'schema1', ACTIONS_ENGINE_ID);
			const statements = ['insert users 2 + posts 100'];
			const transaction: Transaction = {
				stamp, statements, reads: [],
				id: await createTransactionId(stamp.id, statements, []),
			};

			const commitErr = await capture(() => coordinator.commit(transaction, { baseBackoffMs: 1, maxBackoffMs: 5 }));
			expect(commitErr, 'thrown out of commit() by name').to.be.instanceOf(SealedSegmentsError);
			expect(collection.sealedEntries()).to.deep.equal(['E1']);
			expect(await tree.get(2), 'the users participant is as it was').to.deep.equal(entry(2, 'open'));
			expect(await posts.get(100), 'the sibling participant is restored with its staged action').to.deep.equal(entry(100, 'clean'));
			expect(posts.hasUnsyncedChanges()).to.be.true;
			expect(await Tree.open<number, Entry>(transactor, 'posts', byKey), 'nothing of the sibling landed').to.be.undefined;
			expect(transactor.getCommittedActions().size).to.equal(committedBefore);
		});
	});
});
