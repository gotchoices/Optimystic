/**
 * The offline-sync queue in db-core (`OfflineQueue`, tickets offline-sync-queue-core and
 * offline-sync-queue-partial-commits): the in-memory list of locally committed entries that drains one
 * at a time once the cohort can be reached, applies each failure by its class, finishes an entry that
 * partly committed, removes a failed entry and everything that depended on it, and reports every step
 * (docs/offline-sync.md §Draining, §Partial commits, §Removing an entry).
 *
 * Every case runs over `Tree` on one `TestTransactor`, with a real rival handle committing through
 * `commitRivalTreeWrite` where a refusal has to be provoked. The doubles decide only WHEN an answer
 * comes back, or how much of it lands; the round trip itself is the real one. The reachability gate
 * is a switch the test flips.
 */

import { expect } from 'chai';
import {
	CoordinatorPartialCommitError,
	EntryNotDiscardableError,
	Log,
	OfflineQueue,
	QueueDisposedError,
	SyncRetryExhaustedError,
	UnknownEntryError,
	Tree,
	TreeEntryChangedError,
	TreeKeyTakenError,
	type BlockId,
	type CollectionId,
	type CommitRequest,
	type CommitResult,
	type EntryStatus,
	type ICohortReachability,
	type InFlightAttempt,
	type IOfflineJournal,
	type ITransactor,
	type JournalDriveState,
	type JournalEntryRecord,
	type JournalSettledStatus,
	type LogEntry,
	type OfflineQueueOptions,
	type OfflineQueueState,
	type PendRequest,
	type PendResult,
	type QueuedEntry,
	type RestoredSegment,
	type TreeReplaceAction,
	type Action,
} from '../src/index.js';
import {
	DelegatingTransactor,
	GatedCommitTransactor,
	RefusesPendsAsShortfall,
	TailLandsButReportsStale,
	TestTransactor,
	ThrowsOnCommitOf,
	commitRivalTreeWrite,
	delay,
	waitFor,
} from '../src/testing/index.js';
import { captureLog } from './capture-log.js';

interface Entry {
	key: number;
	name: string;
}

const USERS = 'users';
const ITEMS = 'items';
const byKey = (e: Entry) => e.key;
const entry = (key: number, name: string): Entry => ({ key, name });
const T0 = 1_700_000_000_000;

type QueuedStatus = Extract<EntryStatus, { kind: 'queued' }>;
type FailedStatus = Extract<EntryStatus, { kind: 'failed' }>;
type CommittedStatus = Extract<EntryStatus, { kind: 'committed' }>;
type PartialStatus = Extract<EntryStatus, { kind: 'partially-committed' }>;

/** Short timers: these cases are about WHAT the drain does, not how long it waits. */
const fast: OfflineQueueOptions = {
	recheck: { baseMs: 5, maxMs: 20 },
	submit: { maxAttempts: 5, baseBackoffMs: 1, maxBackoffMs: 5 },
};

/** A reachability gate a test opens and closes, recording what it was asked. */
class Gate implements ICohortReachability {
	readonly asked: BlockId[][] = [];

	constructor(public open: boolean) {}

	async reachable(blockIds: readonly BlockId[]): Promise<boolean> {
		this.asked.push([...blockIds]);
		return this.open;
	}
}

/** Records what every pend sent, so a test can say how many attempts reached the network and under
 * which action id. */
class RecordsPends extends DelegatingTransactor {
	readonly pends: { actionId: string; rev: number | undefined }[] = [];

	constructor(inner: TestTransactor) {
		super(inner);
	}

	override async pend(request: PendRequest): Promise<PendResult> {
		this.pends.push({ actionId: request.actionId, rev: request.rev });
		return this.inner.pend(request);
	}
}

/** Throws a plain `Error` out of the first commit — a transport fault no class names — and delegates
 * every later one. Nothing of the first attempt lands; `transact` cancels its pend. */
class ThrowsFirstCommit extends RecordsPends {
	commits = 0;

	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.commits++ === 0) {
			throw new Error('connection reset before the answer arrived');
		}
		return this.inner.commit(request);
	}
}

type Harness = {
	queue: OfflineQueue;
	statuses: EntryStatus[];
	states: OfflineQueueState[];
	/** Every drive record the journal double was handed, in order — the write-ahead before each send,
	 * and the rewrites after a partial commit or a renewal. */
	recorded: { entryId: string; attempts: ReadonlyMap<CollectionId, InFlightAttempt>; state: JournalDriveState }[];
	journal: JournalDouble;
};

/** A journal in memory that records what it is told; each step can be made to throw. */
class JournalDouble implements IOfflineJournal {
	readonly entries: JournalEntryRecord[] = [];
	readonly drives: { entryId: string; state: JournalDriveState }[] = [];
	readonly settledStatuses: JournalSettledStatus[] = [];
	queuedThrows: Error | undefined;
	drivingThrows: Error | undefined;
	settledThrows: Error | undefined;

	async queued(record: JournalEntryRecord): Promise<void> {
		if (this.queuedThrows !== undefined) throw this.queuedThrows;
		this.entries.push(record);
	}

	async driving(entryId: string, state: JournalDriveState): Promise<void> {
		if (this.drivingThrows !== undefined) throw this.drivingThrows;
		this.drives.push({ entryId, state });
	}

	async settled(status: JournalSettledStatus): Promise<void> {
		if (this.settledThrows !== undefined) throw this.settledThrows;
		this.settledStatuses.push(status);
	}
}

function openQueue(options: OfflineQueueOptions = {}): Harness {
	const statuses: EntryStatus[] = [];
	const states: OfflineQueueState[] = [];
	const recorded: Harness['recorded'] = [];
	const journal = new JournalDouble();
	const queue = new OfflineQueue({
		...fast,
		journal: {
			queued: record => journal.queued(record),
			driving: async (entryId, state) => {
				await journal.driving(entryId, state);
				recorded.push({ entryId, attempts: state.attempts, state });
			},
			settled: status => journal.settled(status),
		},
		...options,
	});
	queue.onStatus(status => statuses.push(status));
	queue.onQueueState(state => states.push(state));
	return { queue, statuses, states, recorded, journal };
}

/** A tree whose collection reports sealed-segment refusals to `queue`. */
function openTree(transactor: ITransactor, queue: OfflineQueue, id: CollectionId): Promise<Tree<number, Entry>> {
	return Tree.createOrOpen<number, Entry>(transactor, id, byKey, undefined, undefined, {
		onSealedRefused: queue.onSealedRefused,
	});
}

/** Commit one row to `id` through a handle of its own, so the trees under test open over a committed
 * collection rather than inventing one. */
async function seed(inner: TestTransactor, ...ids: CollectionId[]): Promise<void> {
	for (const id of ids) {
		await commitRivalTreeWrite<number, Entry>(inner, id, byKey, [[5, entry(5, 'seed')]]);
	}
}

/** Stage each `[tree, actions]` as one action in that tree and queue them together as entry `id`. */
async function queueEntry(queue: OfflineQueue, id: string, ...staged: [Tree<number, Entry>, TreeReplaceAction<number, Entry>][]): Promise<QueuedEntry> {
	for (const [tree, actions] of staged) {
		await tree.stage(actions);
	}
	const queued = await queue.enqueue(staged.map(([tree]) => tree.getCollection()), { id });
	expect(queued, `${id} queued`).to.not.equal(undefined);
	return queued!;
}

const statusesOf = (statuses: EntryStatus[], entryId: string): EntryStatus[] => statuses.filter(s => s.entryId === entryId);
const kindsOf = (statuses: EntryStatus[], entryId: string): string[] => statusesOf(statuses, entryId).map(s => s.kind);

function failedOf(statuses: EntryStatus[], entryId: string): FailedStatus {
	const failed = statusesOf(statuses, entryId).filter((s): s is FailedStatus => s.kind === 'failed');
	expect(failed, `${entryId} failed exactly once`).to.have.length(1);
	return failed[0]!;
}

function committedOf(statuses: EntryStatus[], entryId: string): CommittedStatus {
	const committed = statusesOf(statuses, entryId).filter((s): s is CommittedStatus => s.kind === 'committed');
	expect(committed, `${entryId} committed exactly once`).to.have.length(1);
	return committed[0]!;
}

function asQueued(status: EntryStatus | undefined, what: string): QueuedStatus {
	expect(status?.kind, what).to.equal('queued');
	return status as QueuedStatus;
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

/** The log tail block `id`'s header names — the block every commit of that collection carries as its
 * tail, which is how {@link ThrowsOnCommitOf} tells one collection's commit from its sibling's. */
async function logTailOf(inner: TestTransactor, id: CollectionId): Promise<BlockId> {
	const tail = (await Tree.createOrOpen<number, Entry>(inner, id, byKey)).getCollection().knownLogTailId();
	expect(tail, `${id} names a log tail`).to.be.a('string');
	return tail!;
}

/** Waits for `entryId`'s `partially-committed` status and answers it. */
async function partiallyCommitted(statuses: EntryStatus[], entryId: string): Promise<PartialStatus> {
	await waitFor(() => statuses.some(s => s.kind === 'partially-committed' && s.entryId === entryId),
		{ description: `${entryId} reported partially committed` });
	return statuses.find((s): s is PartialStatus => s.kind === 'partially-committed' && s.entryId === entryId)!;
}

const replaceAction = (data: TreeReplaceAction<number, Entry>): Action<TreeReplaceAction<number, Entry>> => ({ type: 'replace', data });

/** A `stage` answer for a segment `Collection.restoreSealed` put in place, with its refusal if any. */
const stagedSegment = (refused: Error | undefined): RestoredSegment =>
	refused === undefined ? { kind: 'staged' } : { kind: 'staged', refused: refused as never };

/** What `promise` rejected with; fails the test if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (err) {
		return err;
	}
	throw new Error('expected a rejection, but it resolved');
}

/** The action id the write-ahead hook saw for `entryId` in `collectionId`. */
function actionIdOf(recorded: Harness['recorded'], entryId: string, collectionId: CollectionId): string {
	const seen = recorded.find(r => r.entryId === entryId)?.attempts.get(collectionId);
	expect(seen, `an attempt of ${entryId} in ${collectionId} was recorded`).to.not.equal(undefined);
	return seen!.actionId;
}

describe('OfflineQueue', function () {
	this.timeout(20_000);

	it('drains two entries over one tree in order — queued, submitting, committed once each — with each log entry under its action id at its local commit time, and seals nothing for a sibling with nothing staged', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS, ITEMS);
		let clock = T0;
		const { queue, statuses, states, recorded, journal } = openQueue({ now: () => clock });
		const users = await openTree(inner, queue, USERS);
		const items = await openTree(inner, queue, ITEMS);

		expect(await queue.enqueue([users.getCollection(), items.getCollection()]), 'nothing staged: nothing queued').to.equal(undefined);
		expect(users.getCollection().sealedEntries(), 'and nothing sealed').to.deep.equal([]);
		expect(journal.entries, 'and nothing journaled').to.deep.equal([]);

		await users.stage([[1, entry(1, 'one')]]);
		let queuedDuringEnqueue: EntryStatus[] | undefined;
		const enqueued = queue.enqueue([users.getCollection(), items.getCollection()], { id: 'E1' })
			.then(queued => { queuedDuringEnqueue = statusesOf(statuses, 'E1'); return queued; });
		expect(kindsOf(statuses, 'E1'), 'nothing is admitted before the journal has the record').to.deep.equal([]);
		const e1 = (await enqueued)!;
		expect(queuedDuringEnqueue?.map(s => s.kind), 'queued was emitted before enqueue resolved').to.deep.equal(['queued']);
		expect(journal.entries.map(r => ({ id: r.id, seq: r.seq, queuedAt: r.queuedAt, segments: r.segments.map(seg => seg.collectionId) })),
			'the entry record was written first, naming the sealed collection and its actions')
			.to.deep.equal([{ id: 'E1', seq: 1, queuedAt: T0, segments: [USERS] }]);
		expect(journal.entries[0]!.segments[0]!.actions, "the segment's actions, verbatim").to.deep.equal(users.getCollection().sealedActions('E1'));
		expect(e1.collections, 'only the sibling that staged something is part of the entry').to.deep.equal([USERS]);
		expect(items.getCollection().sealedEntries()).to.deep.equal([]);
		expect(asQueued(e1.status, 'E1 is queued on return').waitingFor, 'the head waits for nothing').to.equal(undefined);
		expect(kindsOf(statuses, 'E1'), 'queued was emitted synchronously').to.deep.equal(['queued']);
		clock += 1_000;
		const e2 = await queueEntry(queue, 'E2', [users, [[2, entry(2, 'two')]]]);
		expect(e2.queuedAt).to.equal(T0 + 1_000);

		await queue.whenDrained();

		expect(kindsOf(statuses, 'E1')).to.deep.equal(['queued', 'submitting', 'committed']);
		expect(kindsOf(statuses, 'E2')).to.deep.equal(['queued', 'submitting', 'committed']);
		const order = statuses.map(s => `${s.entryId}:${s.kind}`);
		expect(order.indexOf('E1:committed'), 'E1 settles before E2 is sent').to.be.lessThan(order.indexOf('E2:submitting'));
		expect([...committedOf(statuses, 'E1').durability.collections.keys()]).to.deep.equal([USERS]);
		const a1 = actionIdOf(recorded, 'E1', USERS);
		const a2 = actionIdOf(recorded, 'E2', USERS);
		expect(a1).to.not.equal(a2);
		const [logged1] = await entriesUnder(inner, USERS, a1);
		const [logged2] = await entriesUnder(inner, USERS, a2);
		expect(logged1?.timestamp, 'the log entry carries the entry\'s local commit time').to.equal(T0);
		expect(logged2?.timestamp).to.equal(T0 + 1_000);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1], [2]]);
		const fresh = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
		expect(await fresh.get(1)).to.deep.equal(entry(1, 'one'));
		expect(await fresh.get(2)).to.deep.equal(entry(2, 'two'));
		expect(users.getCollection().sealedEntries(), 'both segments were committed').to.deep.equal([]);
		expect(journal.drives.map(d => [d.entryId, d.state.actionId, [...d.state.attempts.keys()]]), 'one drive record ahead of each send')
			.to.deep.equal([['E1', a1, [USERS]], ['E2', a2, [USERS]]]);
		expect(journal.settledStatuses.map(s => `${s.entryId}:${s.kind}`), 'each terminal status reached the journal').to.deep.equal(['E1:committed', 'E2:committed']);
		expect(journal.settledStatuses[0], 'the status the journal heard is the status emitted').to.equal(statuses[order.indexOf('E1:committed')]);
		expect(queue.entries()).to.deep.equal([]);
		expect(queue.status('E1'), 'a settled entry has left the queue').to.equal(undefined);
		expect(queue.queueState()).to.deep.equal({ depth: 0, oldestQueuedAt: undefined, draining: false, waitingFor: undefined, unclassifiedFailures: 0 });
		expect(states.some(s => s.draining), 'the state reported the drain while it ran').to.equal(true);
		await queue.dispose();
	});

	it('commits an entry over two trees through the coordinator\'s per-entry slice: one action id in both logs', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS, ITEMS);
		const { queue, statuses, recorded } = openQueue();
		const users = await openTree(inner, queue, USERS);
		const items = await openTree(inner, queue, ITEMS);

		const e1 = await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]], [items, [[7, entry(7, 'seven')]]]);
		expect(e1.collections).to.deep.equal([USERS, ITEMS]);
		await queue.whenDrained();

		expect(kindsOf(statuses, 'E1')).to.deep.equal(['queued', 'submitting', 'committed']);
		const actionId = actionIdOf(recorded, 'E1', USERS);
		expect(actionIdOf(recorded, 'E1', ITEMS), 'one action id for the whole entry').to.equal(actionId);
		expect(await entriesUnder(inner, USERS, actionId)).to.have.length(1);
		expect(await entriesUnder(inner, ITEMS, actionId)).to.have.length(1);
		expect([...committedOf(statuses, 'E1').durability.collections.keys()].sort()).to.deep.equal([ITEMS, USERS]);
		const freshUsers = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
		const freshItems = await Tree.createOrOpen<number, Entry>(inner, ITEMS, byKey);
		expect(await freshUsers.get(1)).to.deep.equal(entry(1, 'one'));
		expect(await freshItems.get(7)).to.deep.equal(entry(7, 'seven'));
		await queue.dispose();
	});

	it('sends nothing while the gate is closed and reports the head waiting for the cohort; a wake drains it once the gate opens, and so does the re-check timer with no wake', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const transactor = new RecordsPends(inner);
		const gate = new Gate(false);
		const { queue, statuses } = openQueue({ reachability: gate });
		const users = await openTree(transactor, queue, USERS);

		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.entryId === 'E1' && s.waitingFor === 'cohort'),
			{ description: 'E1 reported waiting for the cohort' });

		expect(transactor.pends, 'nothing was sent').to.have.length(0);
		expect(queue.queueState().waitingFor).to.equal('cohort');
		expect(gate.asked[0], 'asked with the header id and the known log tail id').to.deep.equal([USERS, users.getCollection().knownLogTailId()]);
		expect(kindsOf(statuses, 'E1'), 'no submission was reported').to.not.include('submitting');

		gate.open = true;
		queue.wake();
		await queue.whenDrained();
		expect(kindsOf(statuses, 'E1').at(-1)).to.equal('committed');
		expect(transactor.pends).to.have.length(1);

		gate.open = false;
		await queueEntry(queue, 'E2', [users, [[2, entry(2, 'two')]]]);
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.entryId === 'E2' && s.waitingFor === 'cohort'),
			{ description: 'E2 reported waiting for the cohort' });
		gate.open = true;
		// No wake: the re-check timer (5–20 ms here) asks the gate again and drains.
		await queue.whenDrained();
		expect(kindsOf(statuses, 'E2').at(-1)).to.equal('committed');
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1], [2]]);
		await queue.dispose();
	});

	it('cascades three deep: a rival takes the key E1 inserted, so E1 fails with constraint, E2 (which updated it) with concurrent-modification caused by E1, and E3 caused by E2; the local read shows none of them and the queue drains empty', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const transactor = new RecordsPends(inner);
		const gate = new Gate(false);
		const { queue, statuses } = openQueue({ reachability: gate });
		const users = await openTree(transactor, queue, USERS);
		const one = entry(1, 'one');
		const oneUpdated = entry(1, 'one-updated');
		await queueEntry(queue, 'E1', [users, [[1, one, { kind: 'absent' }]]]);
		await queueEntry(queue, 'E2', [users, [[1, oneUpdated, { kind: 'unchanged', expected: one }]]]);
		await queueEntry(queue, 'E3', [users, [[1, entry(1, 'one-again'), { kind: 'unchanged', expected: oneUpdated }]]]);
		expect(await users.get(1), 'the local view shows the queued edits').to.deep.equal(entry(1, 'one-again'));

		await commitRivalTreeWrite<number, Entry>(inner, USERS, byKey, [[1, entry(1, 'rival')]]);
		gate.open = true;
		queue.wake();
		await queue.whenDrained();

		const f1 = failedOf(statuses, 'E1');
		expect(f1.reason).to.equal('constraint');
		expect(f1.error).to.be.instanceOf(TreeKeyTakenError);
		expect(f1.causedBy, 'the rival, not an earlier entry, refused E1').to.equal(undefined);
		expect(f1.changedCollections).to.deep.equal([USERS]);
		const f2 = failedOf(statuses, 'E2');
		expect(f2.reason).to.equal('concurrent-modification');
		expect(f2.error).to.be.instanceOf(TreeEntryChangedError);
		expect(f2.causedBy).to.equal('E1');
		expect(f2.changedCollections).to.deep.equal([USERS]);
		const f3 = failedOf(statuses, 'E3');
		expect(f3.reason).to.equal('concurrent-modification');
		expect(f3.causedBy).to.equal('E2');
		const failedOrder = statuses.filter(s => s.kind === 'failed').map(s => s.entryId);
		expect(failedOrder, 'failed in queue order').to.deep.equal(['E1', 'E2', 'E3']);
		expect(statuses.filter(s => s.kind === 'committed')).to.have.length(0);
		expect(transactor.pends, 'the refusal was found on the opening refresh; nothing was sent').to.have.length(0);
		expect(await users.get(1), 'the local read shows the rival\'s row').to.deep.equal(entry(1, 'rival'));
		expect(users.getCollection().sealedEntries()).to.deep.equal([]);
		expect(queue.entries()).to.deep.equal([]);
		expect(queue.queueState().depth).to.equal(0);
		await queue.dispose();
	});

	it('fails an entry a reader\'s refresh refused before the drain reached it, with the gate still closed and nothing sent', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const transactor = new RecordsPends(inner);
		const gate = new Gate(false);
		const { queue, statuses } = openQueue({ reachability: gate });
		const users = await openTree(transactor, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one'), { kind: 'absent' }]]]);

		await commitRivalTreeWrite<number, Entry>(inner, USERS, byKey, [[1, entry(1, 'rival')]]);
		await users.update();	// the reader's refresh adopts the rival and refuses E1 in its replay
		await queue.whenDrained();

		const failed = failedOf(statuses, 'E1');
		expect(failed.reason).to.equal('constraint');
		expect(failed.error).to.be.instanceOf(TreeKeyTakenError);
		expect(failed.causedBy).to.equal(undefined);
		expect(kindsOf(statuses, 'E1')).to.not.include('submitting');
		expect(transactor.pends).to.have.length(0);
		expect(gate.open, 'the gate never opened').to.equal(false);
		expect(users.getCollection().sealedEntries()).to.deep.equal([]);
		expect(await users.get(1)).to.deep.equal(entry(1, 'rival'));
		await queue.dispose();
	});

	it('a promise shortfall leaves the entry queued waiting for the cohort and is re-driven once the cohort answers; a plain Error out of commit is counted unclassified and re-driven under the SAME action id', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const shortfall = new RefusesPendsAsShortfall(inner);
		const { queue, statuses } = openQueue();
		const users = await openTree(shortfall, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.entryId === 'E1' && s.waitingFor === 'cohort'),
			{ description: 'E1 reported waiting for the cohort after the shortfall' });
		const waiting = asQueued(statuses.find(s => s.kind === 'queued' && s.entryId === 'E1' && s.waitingFor === 'cohort'), 'the waiting status');
		expect(waiting.attempts).to.be.greaterThanOrEqual(1);
		expect(waiting.inDoubt, 'an attempt was about to be sent, so the entry is in doubt').to.equal(true);
		expect(queue.queueState().waitingFor).to.equal('cohort');
		expect(shortfall.pends).to.be.greaterThanOrEqual(1);

		shortfall.refusing = false;
		queue.wake();
		await queue.whenDrained();
		expect(kindsOf(statuses, 'E1').at(-1)).to.equal('committed');
		expect(queue.queueState().unclassifiedFailures, 'a shortfall is classified').to.equal(0);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		await queue.dispose();

		const throwing = new ThrowsFirstCommit(inner);
		const second = openQueue();
		const users2 = await openTree(throwing, second.queue, USERS);
		await queueEntry(second.queue, 'E2', [users2, [[2, entry(2, 'two')]]]);
		await second.queue.whenDrained();

		expect(kindsOf(second.statuses, 'E2').at(-1)).to.equal('committed');
		expect(second.queue.queueState().unclassifiedFailures).to.equal(1);
		expect(throwing.pends.map(p => p.actionId), 'the re-drive used the same action id').to.have.length(2);
		expect(throwing.pends[0]!.actionId).to.equal(throwing.pends[1]!.actionId);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1], [2]]);
		await second.queue.dispose();
	});

	it('a journal whose write-ahead throws keeps the entry queued with nothing sent and NOT in doubt, so it can still be discarded; whenDrained waits for that discard\'s removal', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const transactor = new RecordsPends(inner);
		const journalFull = new Error('journal write failed');
		const { queue, statuses, journal } = openQueue({ recheck: { baseMs: 60_000, maxMs: 60_000 } });
		journal.drivingThrows = journalFull;
		const users = await openTree(transactor, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.entryId === 'E1' && s.waitingFor === 'backoff'),
			{ description: 'E1 reported queued again after the hook refused its attempt' });

		const after = asQueued(queue.status('E1'), 'E1 is queued');
		expect(after.inDoubt, 'nothing was sent, so nothing may have landed').to.equal(false);
		expect(after.lastError, 'the hook\'s own error is reported').to.equal(journalFull);
		expect(transactor.pends).to.have.length(0);

		queue.discard('E1');
		await queue.whenDrained();
		expect(failedOf(statuses, 'E1').reason, 'whenDrained resolved only once the discard\'s removal had reported').to.equal('discarded');
		expect(users.getCollection().sealedEntries()).to.deep.equal([]);
		expect(await users.get(1)).to.equal(undefined);
		await queue.dispose();
	});

	it('resolves an in-doubt entry without a crash: a torn first drive leaves it queued and in doubt, discard refuses it, a passed expiry is deferred, and the next drive resumes the recorded attempt and commits it once', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const torn = new TailLandsButReportsStale(inner, 1);
		const gate = new Gate(true);
		let clock = T0;
		const { queue, statuses, recorded } = openQueue({
			reachability: gate,
			now: () => clock,
			expireAfterMs: 10,
			// One attempt and no refresh after it, so the first drive ends with its tail landed and the
			// outcome unknown; a long re-check so the test, not the timer, decides when the next drive runs.
			submit: { ...fast.submit, maxAttempts: 1 },
			recheck: { baseMs: 60_000, maxMs: 60_000 },
		});
		const users = await openTree(torn, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.entryId === 'E1' && s.attempts === 1),
			{ description: 'E1 reported queued again after its first attempt' });

		const after = asQueued(queue.status('E1'), 'E1 is queued');
		expect(after.inDoubt).to.equal(true);
		expect(after.waitingFor).to.equal('backoff');
		expect(after.lastError).to.be.instanceOf(SyncRetryExhaustedError);
		expect(torn.tears, 'the tail landed, the rest was abandoned').to.equal(1);
		expect(recorded).to.have.length(1);
		expect(() => queue.discard('E1')).to.throw(EntryNotDiscardableError);
		expect(queue.status('E1')?.kind, 'still queued').to.equal('queued');

		clock += 100;	// past the entry's expiry
		gate.open = false;
		const lines = await captureLog('optimystic:db-core:offline', async () => {
			queue.wake();
			await waitFor(() => asQueued(queue.status('E1'), 'E1 still queued').waitingFor === 'cohort',
				{ description: 'the loop ran its expiry step and met the closed gate' });
		});
		expect(lines.some(line => line.includes('offline:expiry-deferred') && line.includes('E1')), 'the expiry was deferred, not applied').to.equal(true);
		expect(statuses.filter(s => s.kind === 'failed')).to.have.length(0);
		expect(asQueued(queue.status('E1'), 'E1 still queued').inDoubt).to.equal(true);

		gate.open = true;
		queue.wake();
		await queue.whenDrained();

		expect(kindsOf(statuses, 'E1').at(-1)).to.equal('committed');
		expect(recorded, 'the next drive finished the recorded attempt rather than building a new one').to.have.length(1);
		expect(torn.landedCommits, 'landed whole once, by the re-send of the recorded attempt').to.equal(1);
		const actionId = actionIdOf(recorded, 'E1', USERS);
		expect(await entriesUnder(inner, USERS, actionId), 'the log holds the entry once').to.have.length(1);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		const fresh = await Tree.createOrOpen<number, Entry>(inner, USERS, byKey);
		expect(await fresh.get(1), 'the data block landed, not only the tail').to.deep.equal(entry(1, 'one'));
		await queue.dispose();
	});

	it('finishes an entry over two trees that partly committed: partially-committed with ITEMS committed and USERS pending — listed queued with its committed half, in doubt, not discardable — then committed with a durability naming both, the remainder sent alone under the same action id, each log holding the entry once', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS, ITEMS);
		// `users` sorts after `items`, so its commit is the one that fails after its sibling's landed.
		const throwing = new ThrowsOnCommitOf(inner, await logTailOf(inner, USERS));
		const { queue, statuses, recorded } = openQueue({ recheck: { baseMs: 60_000, maxMs: 60_000 } });
		const users = await openTree(throwing, queue, USERS);
		const items = await openTree(throwing, queue, ITEMS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]], [items, [[7, entry(7, 'seven')]]]);

		const partial = await partiallyCommitted(statuses, 'E1');
		expect(partial.committedCollections).to.deep.equal([ITEMS]);
		expect(partial.pendingCollections).to.deep.equal([USERS]);
		expect(partial.cause, 'a commit-phase reason is a string, so the cause is the partial commit itself').to.be.instanceOf(CoordinatorPartialCommitError);
		expect(throwing.thrown).to.be.at.least(1);
		const [listed] = queue.entries();
		expect(listed?.committedCollections, 'entries() shows the committed half').to.deep.equal([ITEMS]);
		const between = asQueued(listed?.status, 'E1 is queued between submissions');
		expect(between.committedCollections).to.deep.equal([ITEMS]);
		expect(between.inDoubt).to.equal(true);
		expect(between.waitingFor).to.equal('backoff');
		expect(() => queue.discard('E1')).to.throw(EntryNotDiscardableError);
		expect(items.getCollection().sealedEntries(), 'the committed half is consumed').to.deep.equal([]);
		expect(users.getCollection().sealedEntries(), 'the rest is still sealed').to.deep.equal(['E1']);
		const firstDriveRecords = recorded.length;

		throwing.armed = false;
		queue.wake();
		await queue.whenDrained();

		expect(kindsOf(statuses, 'E1')).to.deep.equal(['queued', 'submitting', 'partially-committed', 'submitting', 'committed']);
		expect([...committedOf(statuses, 'E1').durability.collections.keys()].sort(), 'every collection the entry wrote').to.deep.equal([ITEMS, USERS]);
		const actionId = actionIdOf(recorded, 'E1', ITEMS);
		const remainder = recorded.slice(firstDriveRecords);
		expect(remainder.length, 'the remainder was sent').to.be.at.least(1);
		for (const { attempts } of remainder) {
			expect([...attempts.keys()], 'only the pending collection').to.deep.equal([USERS]);
			expect(attempts.get(USERS)!.actionId, 'under the entry\'s one action id').to.equal(actionId);
		}
		expect(await entriesUnder(inner, ITEMS, actionId)).to.have.length(1);
		expect(await entriesUnder(inner, USERS, actionId)).to.have.length(1);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		expect(await committedKeys(inner, ITEMS)).to.deep.equal([[5], [7]]);
		await queue.dispose();
	});

	it('fails a partly committed entry whose remainder a rival then refuses: constraint, naming the committed half and changing only the pending collection; the committed row stays, the refused one is gone locally, and a later entry that updated it fails caused by it', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS, ITEMS);
		const throwing = new ThrowsOnCommitOf(inner, await logTailOf(inner, USERS));
		const { queue, statuses } = openQueue({ recheck: { baseMs: 60_000, maxMs: 60_000 } });
		const users = await openTree(throwing, queue, USERS);
		const items = await openTree(throwing, queue, ITEMS);
		const one = entry(1, 'one');
		await queueEntry(queue, 'E1', [users, [[1, one, { kind: 'absent' }]]], [items, [[7, entry(7, 'seven')]]]);
		await queueEntry(queue, 'E2', [users, [[1, entry(1, 'one-updated'), { kind: 'unchanged', expected: one }]]]);
		await partiallyCommitted(statuses, 'E1');

		await commitRivalTreeWrite<number, Entry>(inner, USERS, byKey, [[1, entry(1, 'rival')]]);
		queue.wake();
		await queue.whenDrained();

		const f1 = failedOf(statuses, 'E1');
		expect(f1.reason).to.equal('constraint');
		expect(f1.error).to.be.instanceOf(TreeKeyTakenError);
		expect(f1.committedCollections, 'the half the network holds').to.deep.equal([ITEMS]);
		expect(f1.changedCollections, 'only the dropped segment changed what is visible').to.deep.equal([USERS]);
		const f2 = failedOf(statuses, 'E2');
		expect(f2.reason).to.equal('concurrent-modification');
		expect(f2.causedBy).to.equal('E1');
		expect(f2.committedCollections, 'nothing of E2 committed').to.equal(undefined);
		expect(await items.get(7), 'the committed row stays').to.deep.equal(entry(7, 'seven'));
		expect(await users.get(1), 'E1\'s row is gone; the rival\'s shows').to.deep.equal(entry(1, 'rival'));
		expect(await committedKeys(inner, ITEMS)).to.deep.equal([[5], [7]]);
		expect(users.getCollection().sealedEntries()).to.deep.equal([]);
		expect(queue.entries()).to.deep.equal([]);
		await queue.dispose();
	});

	it('discard racing the drain: the head on the network cannot be discarded, a never-sent entry behind it can, and its segment is gone while the head\'s commit is still parked', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const gated = new GatedCommitTransactor(inner);
		const { queue, statuses } = openQueue();
		const users = await openTree(gated, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await queueEntry(queue, 'E2', [users, [[2, entry(2, 'two')]]]);
		await gated.commitParked;

		expect(() => queue.discard('E1')).to.throw(EntryNotDiscardableError);
		queue.discard('E2');
		await waitFor(() => statuses.some(s => s.kind === 'failed' && s.entryId === 'E2'), { description: 'E2 reported failed' });

		const failed = failedOf(statuses, 'E2');
		expect(failed.reason).to.equal('discarded');
		expect(failed.changedCollections).to.deep.equal([USERS]);
		expect(users.getCollection().sealedEntries(), 'E2\'s segment is gone; the head\'s is in flight').to.deep.equal(['E1']);
		expect(queue.entries().map(e => e.id)).to.deep.equal(['E1']);
		expect(await users.get(2), 'the discarded row is gone from the local view').to.equal(undefined);

		gated.openGate();
		await queue.whenDrained();
		expect(kindsOf(statuses, 'E1').at(-1)).to.equal('committed');
		expect(kindsOf(statuses, 'E2')).to.deep.equal(['queued', 'failed']);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		await queue.dispose();
	});

	it('a local commit that seals a new segment while the drain is on the network: both commit, in order, and the second was queued waiting for the earlier entry', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const gated = new GatedCommitTransactor(inner);
		const { queue, statuses } = openQueue();
		const users = await openTree(gated, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await gated.commitParked;

		const e2 = await queueEntry(queue, 'E2', [users, [[2, entry(2, 'two')]]]);
		expect(asQueued(e2.status, 'E2 queued').waitingFor).to.equal('earlier-entry');
		expect(queue.queueState()).to.include({ depth: 2, draining: true });

		gated.openGate();
		await queue.whenDrained();
		const order = statuses.map(s => `${s.entryId}:${s.kind}`);
		expect(order.indexOf('E1:committed')).to.be.lessThan(order.indexOf('E2:submitting'));
		expect(kindsOf(statuses, 'E2').at(-1)).to.equal('committed');
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1], [2]]);
		await queue.dispose();
	});

	it('disposal while an attempt is in flight resolves only after the outcome is applied: committed is emitted, whenDrained rejects, the next entry was never submitted and is still sealed', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const gated = new GatedCommitTransactor(inner);
		const { queue, statuses } = openQueue();
		const users = await openTree(gated, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await queueEntry(queue, 'E2', [users, [[2, entry(2, 'two')]]]);
		await gated.commitParked;
		const drained = queue.whenDrained().then(() => 'resolved' as const, (err: unknown) => err);

		let disposed = false;
		const disposal = queue.dispose().then(() => { disposed = true; });
		await delay(30);
		expect(disposed, 'disposal waits for the parked commit\'s outcome').to.equal(false);

		gated.openGate();
		await disposal;
		expect(kindsOf(statuses, 'E1').at(-1), 'the outcome in flight was applied and reported').to.equal('committed');
		expect(await drained).to.be.instanceOf(QueueDisposedError);
		expect(kindsOf(statuses, 'E2'), 'never submitted').to.deep.equal(['queued']);
		expect(users.getCollection().sealedEntries(), 'left sealed for the application').to.deep.equal(['E2']);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		await expectRejects(queue.enqueue([users.getCollection()]), QueueDisposedError);
		await expectRejects(queue.whenDrained(), QueueDisposedError);
		await queue.dispose();	// idempotent
	});
});

describe('OfflineQueue with a journal (ticket offline-sync-journal-port)', function () {
	this.timeout(20_000);

	it("a journal that refuses the entry record fails the enqueue with every collection unsealed and nothing queued or reported; the caller's rollback then leaves the transaction's actions gone, and the next enqueue takes the same seq", async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS, ITEMS);
		const { queue, statuses, journal } = openQueue();
		const users = await openTree(inner, queue, USERS);
		const items = await openTree(inner, queue, ITEMS);
		// The caller's pre-transaction snapshots, taken before the first stage as the plugin's markDirty does.
		const usersBefore = users.getCollection().snapshotPending();
		const itemsBefore = items.getCollection().snapshotPending();
		await users.stage([[1, entry(1, 'one')]]);
		await items.stage([[7, entry(7, 'seven')]]);
		journal.queuedThrows = new Error('journal store is full');

		const err = await rejectionOf(queue.enqueue([users.getCollection(), items.getCollection()], { id: 'E1' }));

		expect(err, "the journal's own error").to.equal(journal.queuedThrows);
		expect(statuses, 'nothing was reported').to.deep.equal([]);
		expect(queue.entries()).to.deep.equal([]);
		expect(queue.status('E1')).to.equal(undefined);
		expect(users.getCollection().sealedEntries(), 'unsealed again').to.deep.equal([]);
		expect(items.getCollection().sealedEntries()).to.deep.equal([]);
		expect(users.getCollection().getPendingActions(), 'the actions are the open segment again').to.have.length(1);
		expect(items.getCollection().getPendingActions()).to.have.length(1);
		expect(await users.get(1), 'still staged, as before the enqueue').to.deep.equal(entry(1, 'one'));

		// The caller rolls the transaction back as for any failed commit: the segment version moved, so
		// the restore replays, and ends with the transaction's actions gone.
		await users.getCollection().restorePending(usersBefore);
		await items.getCollection().restorePending(itemsBefore);
		expect(await users.get(1), "the transaction's actions are gone").to.equal(undefined);
		expect(await items.get(7)).to.equal(undefined);
		expect(users.getCollection().getPendingActions()).to.deep.equal([]);
		expect(users.getCollection().hasUnsyncedChanges()).to.equal(false);
		expect(items.getCollection().hasUnsyncedChanges()).to.equal(false);

		journal.queuedThrows = undefined;
		const e1 = await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		expect(e1.seq, 'the refused enqueue took no sequence number').to.equal(1);
		await queue.whenDrained();
		expect(kindsOf(statuses, 'E1')).to.deep.equal(['queued', 'submitting', 'committed']);
		expect(journal.entries.map(r => r.seq)).to.deep.equal([1]);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		await queue.dispose();
	});

	it('a journal whose settled write rejects: the committed status is still emitted, the entry leaves the queue, the failure is logged, and whenDrained resolves', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const { queue, statuses, journal } = openQueue();
		journal.settledThrows = new Error('journal store is full');
		const users = await openTree(inner, queue, USERS);

		const lines = await captureLog('optimystic:db-core:offline', async () => {
			await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
			await queue.whenDrained();
		});

		expect(kindsOf(statuses, 'E1')).to.deep.equal(['queued', 'submitting', 'committed']);
		expect(queue.entries()).to.deep.equal([]);
		expect(journal.settledStatuses, 'the write failed').to.deep.equal([]);
		expect(lines.some(line => line.includes('offline:journal-write-failed') && line.includes('step=settled') && line.includes('entry=E1')),
			`logged: ${lines.join('\n')}`).to.equal(true);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		await queue.dispose();
	});

	it("restore while a submission is in flight waits for its outcome: the entry is inserted by seq ahead of the one queued behind the head, its segment first in the collection, and it drains next", async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const gated = new GatedCommitTransactor(inner);
		const { queue, statuses, journal } = openQueue();
		const users = await openTree(gated, queue, USERS);
		await queueEntry(queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await queueEntry(queue, 'E2', [users, [[2, entry(2, 'two')]]]);
		await gated.commitParked;

		const listedAtStage: string[] = [];
		const restoring = queue.restore({ id: 'R', seq: 1.5, queuedAt: T0, collections: [users.getCollection()] }, async collection => {
			listedAtStage.push(queue.entries().map(e => `${e.id}:${(e.status as QueuedStatus).waitingFor ?? 'head'}`).join(','));
			return stagedSegment(await collection.restoreSealed('R', [replaceAction([[3, entry(3, 'restored')]])], { before: 'E2' }));
		});
		await delay(30);
		expect(listedAtStage, "stage has not run: the head's commit is still on the network").to.deep.equal([]);
		expect(users.getCollection().sealedEntries()).to.deep.equal(['E1', 'E2']);
		expect(() => queue.discard('R'), 'not yet admitted, so not discardable').to.throw(UnknownEntryError);

		gated.openGate();
		const restored = await restoring;

		expect(listedAtStage, "stage ran after the head's outcome was applied, with the entry listed at its position").to.deep.equal(['R:head,E2:earlier-entry']);
		expect(restored?.id).to.equal('R');
		expect(asQueued(restored?.status, 'R is queued').waitingFor, 'the head').to.equal(undefined);
		expect(users.getCollection().sealedEntries(), 'the restored segment is first').to.deep.equal(['R', 'E2']);
		expect(queue.entries().map(e => e.id), 'the queue lists it first').to.deep.equal(['R', 'E2']);
		expect(journal.entries.map(r => r.id), 'a restore writes no entry record: the journal already holds it').to.deep.equal(['E1', 'E2']);

		await queue.whenDrained();

		expect(kindsOf(statuses, 'E1'), 'the parked entry committed once').to.deep.equal(['queued', 'submitting', 'committed']);
		expect(kindsOf(statuses, 'R'), 'the restored entry drained next').to.deep.equal(['queued', 'submitting', 'committed']);
		expect(kindsOf(statuses, 'E2')).to.deep.equal(['queued', 'submitting', 'committed']);
		const order = statuses.map(s => `${s.entryId}:${s.kind}`);
		expect(order.indexOf('E1:committed')).to.be.lessThan(order.indexOf('R:queued'));
		expect(order.indexOf('R:committed')).to.be.lessThan(order.indexOf('E2:submitting'));
		expect(journal.drives.map(d => d.entryId), 'one drive record ahead of each send').to.deep.equal(['E1', 'R', 'E2']);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1], [3], [2]]);
		await queue.dispose();
	});

	it("restore of an entry every collection already holds committed settles it at once — one committed status with unknown classes, the journal told, nothing sent, nothing sealed — and a restored segment the replay refuses fails through the ordinary cascade", async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS);
		const transactor = new RecordsPends(inner);
		const first = openQueue();
		const users = await openTree(transactor, first.queue, USERS);
		await queueEntry(first.queue, 'E1', [users, [[1, entry(1, 'one')]]]);
		await first.queue.whenDrained();
		const drive = first.journal.drives.find(d => d.entryId === 'E1')!.state;
		await first.queue.dispose();
		expect(transactor.pends).to.have.length(1);

		// A restart: a second queue over fresh handles, which open over the committed log.
		const { queue, statuses, journal } = openQueue();
		const users2 = await openTree(transactor, queue, USERS);
		const attempt = drive.attempts.get(USERS)!;
		const restored = await queue.restore(
			{ id: 'E1', seq: 1, queuedAt: T0, collections: [users2.getCollection()], drive },
			async collection => collection.holdsCommitted(attempt) ? { kind: 'already-committed' } : { kind: 'staged' });

		expect(restored, 'settled, not queued').to.equal(undefined);
		expect(kindsOf(statuses, 'E1'), 'committed at once, never queued').to.deep.equal(['committed']);
		const committed = committedOf(statuses, 'E1');
		expect([...committed.durability.collections.entries()], 'saved; who holds it is unknown').to.deep.equal([[USERS, undefined]]);
		expect(committed.durability.overall).to.equal(undefined);
		expect(journal.settledStatuses).to.deep.equal([committed]);
		expect(transactor.pends, 'nothing was sent').to.have.length(1);
		expect(users2.getCollection().sealedEntries()).to.deep.equal([]);
		expect(queue.entries()).to.deep.equal([]);
		await queue.whenDrained();

		const refusedRestore = await queue.restore({ id: 'E2', seq: 2, queuedAt: T0, collections: [users2.getCollection()] },
			async collection => stagedSegment(await collection.restoreSealed('E2', [replaceAction([[1, entry(1, 'again'), { kind: 'absent' }]])], 'last')));
		expect(refusedRestore?.id).to.equal('E2');
		await queue.whenDrained();

		const failed = failedOf(statuses, 'E2');
		expect(failed.reason).to.equal('constraint');
		expect(failed.error).to.be.instanceOf(TreeKeyTakenError);
		expect(failed.causedBy, 'the committed state refused it, no earlier entry').to.equal(undefined);
		expect(kindsOf(statuses, 'E2')).to.deep.equal(['queued', 'failed']);
		expect(journal.settledStatuses.at(-1)).to.equal(failed);
		expect(users2.getCollection().sealedEntries()).to.deep.equal([]);
		expect(transactor.pends, 'still nothing sent').to.have.length(1);
		await queue.dispose();
	});

	it('restore of a partly committed entry: the committed collection answers already-committed and is recorded, the rest is staged, the entry is queued in doubt with its committed half, and the next submission drives only the rest under the recorded action id', async () => {
		const inner = new TestTransactor();
		await seed(inner, USERS, ITEMS);
		const throwing = new ThrowsOnCommitOf(inner, await logTailOf(inner, USERS));
		const first = openQueue({ recheck: { baseMs: 60_000, maxMs: 60_000 } });
		const users = await openTree(throwing, first.queue, USERS);
		const items = await openTree(throwing, first.queue, ITEMS);
		await queueEntry(first.queue, 'E1', [users, [[1, entry(1, 'one')]]], [items, [[7, entry(7, 'seven')]]]);
		await partiallyCommitted(first.statuses, 'E1');
		const drive = first.journal.drives.at(-1)!.state;
		expect([...drive.committed.keys()], 'the drive record was rewritten after the partial commit').to.deep.equal([ITEMS]);
		expect([...drive.attempts.keys()], 'with the attempt still to resolve').to.deep.equal([USERS]);
		const record = first.journal.entries.find(r => r.id === 'E1')!;
		await first.queue.dispose();

		throwing.armed = false;
		const { queue, statuses, journal } = openQueue();
		const users2 = await openTree(throwing, queue, USERS);
		const items2 = await openTree(throwing, queue, ITEMS);
		const restored = await queue.restore(
			{ id: 'E1', seq: record.seq, queuedAt: record.queuedAt, collections: [users2.getCollection(), items2.getCollection()], drive },
			async collection => {
				if (drive.committed.has(collection.id)) return { kind: 'already-committed' };
				const actions = record.segments.find(segment => segment.collectionId === collection.id)!.actions;
				return stagedSegment(await collection.restoreSealed('E1', actions, 'last'));
			});

		const between = asQueued(restored?.status, 'E1 is queued');
		expect(between.inDoubt).to.equal(true);
		expect(between.committedCollections, 'the committed half, recorded').to.deep.equal([ITEMS]);
		expect(between.attempts, 'a drive record proves at least one send').to.equal(1);
		expect(users2.getCollection().sealedEntries(), 'the rest is sealed').to.deep.equal(['E1']);
		expect(items2.getCollection().sealedEntries(), 'nothing staged for the committed half').to.deep.equal([]);
		expect(() => queue.discard('E1')).to.throw(EntryNotDiscardableError);

		await queue.whenDrained();

		expect(kindsOf(statuses, 'E1')).to.deep.equal(['queued', 'submitting', 'committed']);
		expect(journal.drives.map(d => [d.entryId, d.state.actionId, [...d.state.attempts.keys()]]), 'the remainder alone, under the recorded id')
			.to.deep.equal([['E1', drive.actionId, [USERS]]]);
		expect([...committedOf(statuses, 'E1').durability.collections.keys()].sort(), 'every collection the entry wrote').to.deep.equal([ITEMS, USERS]);
		expect(await entriesUnder(inner, USERS, drive.actionId)).to.have.length(1);
		expect(await entriesUnder(inner, ITEMS, drive.actionId)).to.have.length(1);
		expect(await committedKeys(inner, USERS)).to.deep.equal([[5], [1]]);
		expect(await committedKeys(inner, ITEMS)).to.deep.equal([[5], [7]]);
		await queue.dispose();
	});
});

async function expectRejects(promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
	try {
		await promise;
	} catch (err) {
		expect(err).to.be.instanceOf(type);
		return;
	}
	throw new Error(`expected a rejection with ${type.name}, but it resolved`);
}
