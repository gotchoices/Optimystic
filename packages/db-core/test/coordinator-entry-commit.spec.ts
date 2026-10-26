/**
 * The coordinator's per-entry slice commit (`TransactionCoordinator.commitEntry`, ticket
 * offline-sync-coordinator-entry-commit): one queued entry's head segment in each collection it
 * wrote, sent as one pend-all-then-commit round, with the head commit's steps (`HeadCommitHandle`)
 * driven in lock-step across the participants and the whole-collection commit's retry loop between
 * attempts (docs/offline-sync.md §One entry, one network transaction).
 *
 * Every case runs over two `Tree`s on one `TestTransactor`, with a real rival handle committing
 * through `commitRivalTreeWrite` where a refusal has to be provoked. The doubles decide only WHEN
 * an answer comes back, or how much of it lands; the round trip itself is the real one.
 */

import { expect } from 'chai';
import {
	CoordinatorPartialCommitError,
	CoordinatorStaleLossError,
	Log,
	TornActionError,
	TransactionCoordinator,
	Tree,
	TreeKeyTakenError,
	blockIdsForTransforms,
	type ActionRefusedError,
	type BlockId,
	type Collection,
	type CollectionHeaderBlock,
	type CollectionId,
	type CommitRequest,
	type CommitResult,
	type EntryCommit,
	type InFlightAttempt,
	type ITransactor,
	type LogEntry,
	type PendRequest,
	type PendResult,
	type SyncOptions,
	type TreeReplaceAction,
} from '../src/index.js';
import {
	CompetingWriterTransactor,
	DelegatingTransactor,
	GatedCommitTransactor,
	TestTransactor,
	commitRivalTreeWrite,
} from '../src/testing/test-transactor.js';

interface Entry {
	key: number;
	name: string;
}

type Refusal = { entryId: string; error: ActionRefusedError };

/** Two collections, named so that the sorted open order is A then B. */
const A = 'alpha';
const B = 'beta';
const byKey = (e: Entry) => e.key;
const entry = (key: number, name: string): Entry => ({ key, name });
/** The entry's local commit time, as the queue would supply it. */
const QUEUED_AT = 1_700_000_000_000;
/** Short, bounded backoff: these cases are about WHAT the retry does, not how long it waits. */
const retryFast: SyncOptions = { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 };

/** Run `fn` and hand back what it threw; fails the test if it resolved. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (err) {
		return err;
	}
	throw new Error('expected operation to throw, but it resolved');
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

/** Commit one row to `id` through a handle of its own, so the handles under test open over a
 * committed collection rather than inventing one — the half-landed shapes are only observable then. */
async function seed(inner: TestTransactor, id: CollectionId): Promise<void> {
	await commitRivalTreeWrite<number, Entry>(inner, id, byKey, [[5, entry(5, 'seed')]]);
}

/** A tree over `transactor` whose collection reports sealed-segment refusals into `refusals`. */
async function openTree(transactor: ITransactor, id: CollectionId, refusals: Refusal[] = []): Promise<Tree<number, Entry>> {
	return Tree.createOrOpen<number, Entry>(transactor, id, byKey, undefined, undefined, {
		onSealedRefused: (entryId, error) => { refusals.push({ entryId, error }); },
	});
}

/** Stage `actions` as one action and seal it under `entryId`. */
async function sealAs(tree: Tree<number, Entry>, entryId: string, actions: TreeReplaceAction<number, Entry>): Promise<void> {
	await tree.stage(actions);
	expect(tree.getCollection().sealPending(entryId), `${entryId} seals a non-empty open segment`).to.be.true;
}

/** A coordinator over exactly `trees`' collections, built as the queue builds one per submission. */
function coordinatorOver(transactor: ITransactor, ...trees: Tree<number, Entry>[]): TransactionCoordinator {
	return new TransactionCoordinator(transactor,
		new Map(trees.map(tree => [tree.getCollection().id, tree.getCollection()])),
		{ pendValidation: 'none' });
}

/** Entry `E1` under action `A1`, over `collectionIds`. */
function entryOver(collectionIds: CollectionId[], more: Partial<EntryCommit> = {}): EntryCommit {
	return { entryId: 'E1', actionId: 'A1', timestamp: QUEUED_AT, collectionIds, ...more };
}

/** The keys each committed log entry of `id` replaced, in log order, read through a fresh handle
 * over the UNWRAPPED transactor — durable storage, not the handle under test's view. */
async function committedKeys(inner: TestTransactor, id: CollectionId): Promise<number[][]> {
	const fresh = await Tree.createOrOpen<number, Entry>(inner, id, byKey);
	const keys: number[][] = [];
	for await (const action of fresh.getCollection().selectLog()) {
		keys.push(action.data.map(([key]) => key));
	}
	return keys;
}

/** The committed log entries of `id` under `actionId`, read the same way. */
async function entriesUnder(inner: TestTransactor, id: CollectionId, actionId: string): Promise<LogEntry<unknown>[]> {
	const fresh = await Tree.createOrOpen<number, Entry>(inner, id, byKey);
	const log = await Log.open<unknown>(fresh.getCollection().tracker, id);
	const found: LogEntry<unknown>[] = [];
	for await (const logEntry of log!.select()) {
		if (logEntry.action?.actionId === actionId) found.push(logEntry);
	}
	return found;
}

/** The committed row at `key` in `id`, read through a fresh handle over the unwrapped transactor. */
async function durableRow(inner: TestTransactor, id: CollectionId, key: number): Promise<Entry | undefined> {
	const fresh = await Tree.createOrOpen<number, Entry>(inner, id, byKey);
	return fresh.get(key);
}

/** The log tail block a collection's header names — the block every attempt of that collection
 * commits first, which is how a double tells one collection's round from its sibling's. */
async function logTailOf<T>(collection: Collection<T>): Promise<BlockId> {
	const header = await collection.tracker.tryGet(collection.id) as CollectionHeaderBlock | undefined;
	expect(header?.tailId, `${collection.id} names a log tail`).to.be.a('string');
	return header!.tailId!;
}

/** Throws, nothing delegated, on every commit of the collection whose log tail is `tailId` while
 * armed — the hard failure of one participant's commit after its siblings' landed. */
class ThrowsOnCommitOf extends DelegatingTransactor {
	thrown = 0;
	armed = true;

	constructor(inner: TestTransactor, private readonly tailId: BlockId) {
		super(inner);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.armed && request.tailId === this.tailId) {
			this.thrown++;
			throw new Error('connection dropped before the commit was sent');
		}
		return this.inner.commit(request);
	}
}

/** In one attempt, tears the collection whose log tail is `tornTailId` (lands its tail only, then
 * reports a retryable failure — the shape `TailLandsButReportsStale` models) and cleanly loses the
 * one whose log tail is `lostTailId` (nothing delegated), so neither is committed and the torn
 * one's log holds an entry its blocks do not. Disarmed, everything delegates. */
class TearsOneLosesOther extends DelegatingTransactor {
	pends = 0;
	tears = 0;
	losses = 0;
	armed = true;

	constructor(inner: TestTransactor, private readonly tornTailId: BlockId, private readonly lostTailId: BlockId) {
		super(inner);
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		this.pends++;
		return this.inner.pend(request);
	}

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.armed && request.tailId === this.lostTailId) {
			this.losses++;
			return { success: false, conflict: true, reason: 'stale commit: injected clean loss' };
		}
		if (this.armed && request.tailId === this.tornTailId && request.blockIds.some(blockId => blockId !== request.tailId)) {
			const tail = await this.inner.commit({ ...request, blockIds: [request.tailId] });
			if (!tail.success) return tail;
			this.tears++;
			return { success: false, conflict: true, reason: 'commit-not-durable: injected tail-only landing' };
		}
		return this.inner.commit(request);
	}
}

describe('TransactionCoordinator.commitEntry (ticket offline-sync-coordinator-entry-commit)', () => {
	it('a refusal at one participant\'s pend leaves nothing durable: the refresh adopts the rival, the replay refuses that head, and the recorded refusal is thrown with both segments still sealed', async () => {
		const inner = new TestTransactor();
		await seed(inner, A);
		await seed(inner, B);
		// Opened over the unwrapped transactor to learn B's tail; the trees under test open below.
		const tailB = await logTailOf((await openTree(inner, B)).getCollection());
		// The rival commits key 1 to B after the opening refresh and before B's pend reaches storage:
		// B's pend is then refused as stale, A's (already delegated) is cancelled, and nothing is sent
		// to any commit.
		const transactor = new CompetingWriterTransactor(inner,
			unwrapped => commitRivalTreeWrite<number, Entry>(unwrapped, B, byKey, [[1, entry(1, 'rival')]]),
			{ when: request => blockIdsForTransforms(request.transforms).includes(tailB) });
		const refusalsA: Refusal[] = [];
		const refusalsB: Refusal[] = [];
		const treeA = await openTree(transactor, A, refusalsA);
		const treeB = await openTree(transactor, B, refusalsB);
		await sealAs(treeA, 'E1', [[1, entry(1, 'a1')]]);
		await sealAs(treeB, 'E1', [[1, entry(1, 'b1'), { kind: 'absent' }]]);
		const coordinator = coordinatorOver(transactor, treeA, treeB);

		const err = await capture(() => coordinator.commitEntry(entryOver([A, B]), retryFast));

		expect(err, 'the handler\'s own refusal of B\'s head').to.be.instanceOf(TreeKeyTakenError);
		expect(treeB.getCollection().sealedRefusal('E1')).to.equal(err);
		expect(refusalsB.map(r => r.entryId), 'reported once, for B').to.deep.equal(['E1']);
		expect(refusalsA, 'A\'s head was never refused').to.be.empty;
		expect(transactor.pendCalls, 'one attempt: both participants pended, the second attempt sent nothing').to.equal(2);
		expect(transactor.commitCalls, 'nothing reached a commit').to.equal(0);
		expect(treeA.getCollection().sealedEntries(), 'both segments stay sealed').to.deep.equal(['E1']);
		expect(treeB.getCollection().sealedEntries()).to.deep.equal(['E1']);
		expect(await committedKeys(inner, A), 'A\'s log holds nothing under the action').to.deep.equal([[5]]);
		expect(await entriesUnder(inner, A, 'A1')).to.be.empty;
		expect(await committedKeys(inner, B), 'the seed and the rival only').to.deep.equal([[5], [1]]);
		expect(await durableRow(inner, A, 1), 'nothing of A landed').to.be.undefined;
		expect(await treeA.get(1), 'A\'s head is still staged').to.deep.equal(entry(1, 'a1'));
		expect(await treeB.get(1), 'B adopted the rival').to.deep.equal(entry(1, 'rival'));
	});

	it('both participants commit as one action: each log holds one entry under the action id with the entry\'s timestamp, a segment behind the head is re-staged over the committed state, and the open segment survives', async () => {
		const inner = new TestTransactor();
		await seed(inner, A);
		await seed(inner, B);
		const treeA = await openTree(inner, A);
		const treeB = await openTree(inner, B);
		await sealAs(treeA, 'E1', [[1, entry(1, 'a1')]]);
		await sealAs(treeA, 'E2', [[2, entry(2, 'a2')]]);
		await treeA.stage([[3, entry(3, 'open')]]);
		await sealAs(treeB, 'E1', [[1, entry(1, 'b1')]]);
		const coordinator = coordinatorOver(inner, treeA, treeB);

		// Named out of order: the slice opens the handles in sorted order itself.
		const durability = await coordinator.commitEntry(entryOver([B, A]), retryFast);

		expect(durability, 'who holds the entry').to.not.equal(undefined);
		expect([...durability!.collections.keys()].sort()).to.deep.equal([A, B]);
		expect(durability!.overall, 'every holder is known').to.not.equal(undefined);
		for (const id of [A, B]) {
			const entries = await entriesUnder(inner, id, 'A1');
			expect(entries, `${id} logs the action once`).to.have.length(1);
			expect(entries[0]!.timestamp, `${id}'s entry carries the entry's commit time`).to.equal(QUEUED_AT);
			expect(entries[0]!.rev).to.equal(2);
		}
		expect(await committedKeys(inner, A)).to.deep.equal([[5], [1]]);
		expect(await committedKeys(inner, B)).to.deep.equal([[5], [1]]);
		expect(treeA.getCollection().sealedEntries(), 'E2 is the head of A now, never consumed').to.deep.equal(['E2']);
		expect(treeB.getCollection().sealedEntries()).to.deep.equal([]);
		expect(treeA.getCollection().committedRevision()).to.equal(2);
		expect(treeB.getCollection().committedRevision()).to.equal(2);
		expect(await treeA.get(1), 'the committed head reads through').to.deep.equal(entry(1, 'a1'));
		expect(await treeA.get(2), 'E2 is re-staged over the committed head').to.deep.equal(entry(2, 'a2'));
		expect(await treeA.get(3), 'the open segment survives').to.deep.equal(entry(3, 'open'));
		expect(treeA.getCollection().hasUnsyncedChanges()).to.be.true;
		expect(treeB.getCollection().hasUnsyncedChanges()).to.be.false;
		expect(await durableRow(inner, A, 2), 'E2 is not committed').to.be.undefined;
		expect(await durableRow(inner, B, 1)).to.deep.equal(entry(1, 'b1'));
	});

	it('releases every latch during the round trip: staging into a participant resolves while the commit is parked, and the staged action is in the open segment after the fold', async () => {
		const inner = new TestTransactor();
		await seed(inner, A);
		await seed(inner, B);
		const transactor = new GatedCommitTransactor(inner);
		const treeA = await openTree(transactor, A);
		const treeB = await openTree(transactor, B);
		await sealAs(treeA, 'E1', [[1, entry(1, 'a1')]]);
		await sealAs(treeB, 'E1', [[1, entry(1, 'b1')]]);
		const coordinator = coordinatorOver(transactor, treeA, treeB);

		const committing = coordinator.commitEntry(entryOver([A, B]), retryFast);
		await transactor.commitParked;	// one commit durable on the inner transactor; its answer not yet returned

		// The latches are released: staging does not wait for the network.
		await withinMs(2000, treeA.stage([[7, entry(7, 'during')]]), 'staging during the entry commit');
		expect(treeA.getCollection().sealedEntries(), 'the head is still sealed while in flight').to.deep.equal(['E1']);

		transactor.openGate();
		const durability = await committing;

		expect(durability).to.not.equal(undefined);
		expect([...durability!.collections.keys()].sort()).to.deep.equal([A, B]);
		expect(transactor.commitRevs, 'one commit per participant, at the revision each pended').to.deep.equal([2, 2]);
		expect(treeA.getCollection().sealedEntries(), 'the head was consumed').to.deep.equal([]);
		expect(treeB.getCollection().sealedEntries()).to.deep.equal([]);
		expect(await treeA.get(1), 'the committed head').to.deep.equal(entry(1, 'a1'));
		expect(await treeA.get(7), 'the action staged meanwhile, replayed over it').to.deep.equal(entry(7, 'during'));
		expect(treeA.getCollection().hasUnsyncedChanges(), 'it is in the open segment').to.be.true;
		expect(await durableRow(inner, A, 7), 'and not committed').to.be.undefined;
		expect(await committedKeys(inner, A)).to.deep.equal([[5], [1]]);
	});

	it('a partial landing on a hard failure: thrown as a partial commit with A committed and B failed, A\'s head consumed and B\'s still sealed and first; a re-drive over B alone under the same action id lands B, and each log holds the entry once', async () => {
		const inner = new TestTransactor();
		await seed(inner, A);
		await seed(inner, B);
		const tailB = await logTailOf((await openTree(inner, B)).getCollection());
		const transactor = new ThrowsOnCommitOf(inner, tailB);
		const treeA = await openTree(transactor, A);
		const treeB = await openTree(transactor, B);
		await sealAs(treeA, 'E1', [[1, entry(1, 'a1')]]);
		await sealAs(treeB, 'E1', [[1, entry(1, 'b1')]]);
		const coordinator = coordinatorOver(transactor, treeA, treeB);

		const err = await capture(() => coordinator.commitEntry(entryOver([A, B]), retryFast));

		expect(err).to.be.instanceOf(CoordinatorPartialCommitError);
		const partial = err as CoordinatorPartialCommitError;
		expect(partial.committedCollections).to.deep.equal([A]);
		expect(partial.failedCollections).to.deep.equal([B]);
		expect(partial.durability.collections.get(A), 'who holds A').to.not.equal(undefined);
		expect(transactor.thrown, 'B\'s commit was retried as transient before being given up on').to.be.at.least(2);
		expect(treeA.getCollection().sealedEntries(), 'A\'s head is consumed').to.deep.equal([]);
		expect(treeA.getCollection().committedRevision()).to.equal(2);
		expect(await treeA.get(1)).to.deep.equal(entry(1, 'a1'));
		expect(treeB.getCollection().sealedEntries(), 'B\'s head is still sealed and first').to.deep.equal(['E1']);
		expect(treeB.getCollection().sealedRefusal('E1')).to.be.undefined;
		expect(treeB.getCollection().committedRevision()).to.equal(1);
		expect(await committedKeys(inner, A)).to.deep.equal([[5], [1]]);
		expect(await committedKeys(inner, B), 'nothing of B landed').to.deep.equal([[5]]);

		transactor.armed = false;
		const durability = await coordinator.commitEntry(entryOver([B]), retryFast);

		expect(durability).to.not.equal(undefined);
		expect([...durability!.collections.keys()]).to.deep.equal([B]);
		expect(treeB.getCollection().sealedEntries()).to.deep.equal([]);
		expect(treeB.getCollection().committedRevision()).to.equal(2);
		expect(await entriesUnder(inner, A, 'A1'), 'A logs the action once').to.have.length(1);
		expect(await entriesUnder(inner, B, 'A1'), 'B logs the action once').to.have.length(1);
		expect(await committedKeys(inner, B)).to.deep.equal([[5], [1]]);
		expect(await durableRow(inner, B, 1)).to.deep.equal(entry(1, 'b1'));
	});

	it('a recorded attempt resumes a torn participant: the first drive throws with its attempts recorded; without resume the re-drive is refused as torn; with it the opening refresh finishes A and the attempt commits B, answering a durability with both', async () => {
		const inner = new TestTransactor();
		await seed(inner, A);
		await seed(inner, B);
		const tailA = await logTailOf((await openTree(inner, A)).getCollection());
		const tailB = await logTailOf((await openTree(inner, B)).getCollection());
		const transactor = new TearsOneLosesOther(inner, tailA, tailB);
		const treeA = await openTree(transactor, A);
		const treeB = await openTree(transactor, B);
		await sealAs(treeA, 'E1', [[1, entry(1, 'a1')]]);
		await sealAs(treeB, 'E1', [[1, entry(1, 'b1')]]);
		const coordinator = coordinatorOver(transactor, treeA, treeB);
		const recorded: ReadonlyMap<CollectionId, InFlightAttempt>[] = [];
		// One attempt and no refresh after it, so the cycle ends with A's tail landed and the attempts
		// retained nowhere a later cycle can see — except through the hook.
		const drive = (resume?: ReadonlyMap<CollectionId, InFlightAttempt>) => coordinator.commitEntry(entryOver([A, B], {
			recordAttempt: async attempts => { recorded.push(attempts); },
			...(resume === undefined ? {} : { resume }),
		}), { ...retryFast, maxAttempts: 1 });

		const first = await capture(drive);

		expect(first, 'the budget spent on a clean loss').to.be.instanceOf(CoordinatorStaleLossError);
		expect(transactor.tears, 'A\'s tail landed, the rest of A was abandoned').to.equal(1);
		expect(transactor.losses, 'nothing of B landed').to.equal(1);
		expect(recorded, 'the hook saw the one attempt, with every participant').to.have.length(1);
		expect([...recorded[0]!.keys()]).to.deep.equal([A, B]);
		expect(recorded[0]!.get(A)).to.include({ actionId: 'A1', rev: 2 });
		expect(recorded[0]!.get(B)).to.include({ actionId: 'A1', rev: 2 });
		expect(treeA.getCollection().sealedEntries(), 'in doubt: nothing was applied').to.deep.equal(['E1']);
		expect(treeB.getCollection().sealedEntries()).to.deep.equal(['E1']);
		expect(treeA.getCollection().committedRevision()).to.equal(1);
		expect(await entriesUnder(inner, A, 'A1'), 'A\'s log holds the torn entry').to.have.length(1);
		expect(await durableRow(inner, A, 1), 'but its data block did not land').to.be.undefined;
		transactor.armed = false;

		// The control: a re-drive under the same id with nothing handed back finds A's entry and can
		// only refuse it — the blocks are missing and nothing holds the transforms.
		const control = await capture(() => drive());
		expect(control).to.be.instanceOf(TornActionError);
		expect((control as TornActionError).reason).to.equal('transforms-not-held');
		expect(recorded, 'the opening refresh threw before any attempt was built').to.have.length(1);
		expect(transactor.pends, 'nothing was re-sent').to.equal(2);
		expect(treeA.getCollection().sealedEntries()).to.deep.equal(['E1']);
		expect(treeB.getCollection().sealedEntries()).to.deep.equal(['E1']);

		const durability = await drive(recorded[0]);

		expect(durability, 'A finished from the recorded attempt, B committed by the attempt').to.not.equal(undefined);
		expect([...durability!.collections.keys()].sort()).to.deep.equal([A, B]);
		expect(durability!.overall, 'both holders are known').to.not.equal(undefined);
		expect(recorded, 'one new attempt, over B alone').to.have.length(2);
		expect([...recorded[1]!.keys()]).to.deep.equal([B]);
		expect(transactor.pends, 'the re-send of A\'s recorded attempt, then B\'s attempt').to.equal(4);
		expect(treeA.getCollection().sealedEntries(), 'both heads consumed').to.deep.equal([]);
		expect(treeB.getCollection().sealedEntries()).to.deep.equal([]);
		expect(treeA.getCollection().committedRevision()).to.equal(2);
		expect(treeB.getCollection().committedRevision()).to.equal(2);
		expect(await entriesUnder(inner, A, 'A1'), 'A logs the action once').to.have.length(1);
		expect(await entriesUnder(inner, B, 'A1'), 'B logs the action once').to.have.length(1);
		expect(await durableRow(inner, A, 1), 'A\'s data block landed, not only its tail').to.deep.equal(entry(1, 'a1'));
		expect(await durableRow(inner, B, 1)).to.deep.equal(entry(1, 'b1'));
	});
});
