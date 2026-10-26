/**
 * Sealed segments in a `Collection` (ticket `offline-sync-segment-bookkeeping`, stage 2 of
 * docs/offline-sync.md): the staged actions are an ordered list of sealed segments, one per
 * queued entry, ahead of the open segment the current transaction stages into. A segment can be
 * removed on its own, a replay stages each sealed segment atomically and records a refusal of one
 * instead of throwing it, and a whole-collection commit refuses while anything is sealed.
 *
 * Every case runs over `Tree` and `TestTransactor`, with a real rival handle committing through
 * `commitRivalTreeWrite` where a refusal has to be provoked — nothing is faked.
 */

import { expect } from 'chai';
import {
	Tree,
	TreeEntryChangedError,
	TreeKeyTakenError,
	ActionRefusedError,
	SealedSegmentsError,
	SegmentList,
	TransactionCoordinator,
	createTransactionStamp,
	createTransactionId,
	ACTIONS_ENGINE_ID,
	type Transaction,
	type TreeReplaceAction,
} from '../src/index.js';
import { TestTransactor, commitRivalTreeWrite } from '../src/testing/test-transactor.js';
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
async function openReporting(transactor: TestTransactor, refusals: Refusal[], id = USERS): Promise<Tree<number, Entry>> {
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
