/**
 * Restoring the offline queue from its journal after a restart (docs/offline-sync.md §Restore after a
 * restart): `plugin.hydrate` puts every journaled transaction back before the application's first
 * statement, each is sent to the network once — never twice, whichever side of the network commit the
 * crash fell — and a record whose table cannot be reached waits, listed `waitingFor: 'restore'`,
 * ahead of everything queued since.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`). Node A's journal is a `PowerLossKVStore`:
 * its `powerLoss()` is the crash, its `reopen()` what the restarted process reads. "Restarting A" is a
 * fresh `Database` over the reopened journal and A's transactor; where A's node store is lost too, the
 * mesh node is restarted over a fresh driver (`Mesh.restart`). A reachability gate registered on A's
 * factory (the seam the node's own gate is registered through) keeps a transaction unsent, and `Isolation` (`isolation.ts`) makes one
 * table's blocks unreadable, as on a node that never held them while its cohort is unreachable.
 */

import { expect } from 'chai';
import type { Database, SqlValue } from '@quereus/quereus';
import { ConstraintError } from '@quereus/quereus';
import type { ICohortReachability, IRepo, ITransactor } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { KvRawStorage, MemoryRawStorage, WriteGroupDriver, durabilityWindowMs, resolveDurabilityWindowPolicy, type IKVStore } from '@optimystic/db-p2p';
import { MemoryBatchBackend, PowerLossKVStore, type Mesh } from '@optimystic/db-p2p/testing';
import { EntryNotDiscardableError, OfflineJournalError, type CommitOutlook, type QueuedTransactionStatus } from '../dist/index.js';
import type { DriveRecordV1, EntryRecordV1 } from '../src/optimystic-adapter/offline-journal.js';
import { Isolation, unavailableIn, withReads } from './isolation.js';
import { keysOf, record } from './journal-records.js';
import { countTreeEntries, createMeshDbNode, loggedUnder, startMockMesh, type MeshDbNode, type MockMeshOptions } from './mesh-node-harness.js';
import { captureThrown, expectIndexAgreesWithScan, queryAll } from './query-helpers.js';

type QueuedStatus = Extract<QueuedTransactionStatus, { kind: 'queued' }>;
type CommittedStatus = Extract<QueuedTransactionStatus, { kind: 'committed' }>;
type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

const NOTES_URI = 'tree://offline-restore/notes';
const NOTES_COLLECTION = 'offline-restore/notes';
const OTHER_URI = 'tree://offline-restore/other';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;
const createNotesIndex = 'create index NotesBody on Notes (body)';
const createOther = `create table Other (id integer primary key) using optimystic('${OTHER_URI}')`;
/** Natural primary key; a message references its conversation, a decision made against the parent row. */
const createConversations = `create table Conversations (id text primary key, title text) using optimystic('tree://offline-restore/conversations')`;
const MESSAGES_COLLECTION = 'offline-restore/messages';
const createMessages = `create table Messages (id text primary key, conversation text references Conversations(id), body text) using optimystic('tree://${MESSAGES_COLLECTION}')`;
const ENTRY_1 = 'optimystic-offline/default/entries/000000000001';
const DRIVE_1 = 'optimystic-offline/default/drives/000000000001';

const journaled = (journal: IKVStore, extra: Record<string, unknown> = {}): Record<string, SqlValue> =>
	({ offline: { recheck: { baseMs: 20, maxMs: 100 }, journal, ...extra } }) as unknown as Record<string, SqlValue>;

/** A reachability gate as a test sets it: closed keeps every submission unsent; {@link wake}
 * is the node's connection event, called by hand. */
class Gate implements ICohortReachability {
	private readonly listeners = new Set<() => void>();
	constructor(public open: boolean) {}
	readonly reachable = (): Promise<boolean> => Promise.resolve(this.open);
	readonly onChange = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};
	wake(): void {
		for (const listener of [...this.listeners]) listener();
	}
}

/** One life of node A's `Database`: its plugin over `journal`, its gate when given, and every status it reports. */
interface NodeA extends MeshDbNode {
	statuses: QueuedTransactionStatus[];
}

function openA(transactor: ITransactor, journal: IKVStore, options: { gate?: Gate; label?: string } = {}): NodeA {
	const node = createMeshDbNode(transactor, journaled(journal, options.label === undefined ? {} : { journalLabel: options.label }));
	if (options.gate !== undefined) node.plugin.collectionFactory.registerCohortReachability('shared:test', options.gate);
	const statuses: QueuedTransactionStatus[] = [];
	node.plugin.offline.onStatus(status => { statuses.push(status); });
	return { ...node, statuses };
}

/** Node B stops answering cluster (write) rounds. */
function severB(mesh: Mesh): void {
	mesh.failures.failingPeers = new Set([mesh.nodes[1]!.peerId.toString()]);
}

function restoreB(mesh: Mesh): void {
	mesh.failures.failingPeers = undefined;
}

/** Insert one row in its own transaction and answer the transaction's `StampId()`. */
async function insertNote(db: Database, id: number, body: string): Promise<string> {
	await db.exec('begin');
	await db.exec(`insert into Notes (id, body) values (${id}, '${body}')`);
	const row = await db.prepare('select StampId() as stamp_id').get() as { stamp_id: string };
	await db.exec('commit');
	return row.stamp_id;
}

const notesOf = (db: Database): Promise<Record<string, unknown>[]> => queryAll(db, 'select id, body from Notes order by id');

const statusesOf = <K extends QueuedTransactionStatus['kind']>(statuses: readonly QueuedTransactionStatus[], kind: K, transactionId: string): Extract<QueuedTransactionStatus, { kind: K }>[] =>
	statuses.filter((status): status is Extract<QueuedTransactionStatus, { kind: K }> => status.kind === kind && status.transactionId === transactionId);

/** The outlook each queued transaction's status carries, in queue order. */
const outlooksOf = (node: MeshDbNode): (CommitOutlook | undefined)[] =>
	node.plugin.offline.entries().map(entry => entry.status.kind === 'queued' ? entry.status.outlook : undefined);

/** A copy of `store` whose entry records carry no `outlook`, as a build before the field wrote them. */
async function withoutOutlook(store: IKVStore): Promise<PowerLossKVStore> {
	const durable = new Map<string, string>();
	for (const key of await store.list('optimystic-offline/')) {
		let value = (await store.get(key))!;
		if (key.includes('/entries/')) {
			const { outlook: _outlook, ...older } = JSON.parse(value) as EntryRecordV1;
			value = JSON.stringify(older);
		}
		durable.set(key, value);
	}
	return new PowerLossKVStore(durable);
}

/** The crash: the journal loses power, and A's plugin is disposed as a dead process's drain is gone. */
async function crashA(store: PowerLossKVStore, a: NodeA): Promise<PowerLossKVStore> {
	store.powerLoss();
	await a.plugin.dispose();
	return store.reopen();
}

/** Node A's journal, which loses power at its first outcome-record write — after the network commit
 * landed, before the entry's records were deleted — once `beforeCrash` has run (a node store sync, say). */
class CrashesAtOutcome extends PowerLossKVStore {
	constructor(private readonly beforeCrash: () => Promise<void>) {
		super();
	}

	override async set(key: string, value: string): Promise<void> {
		if (key.includes('/outcomes/')) {
			await this.beforeCrash();
			this.powerLoss();
		}
		return super.set(key, value);
	}
}

/** A transactor whose next block read, once {@link park} is called, is held until {@link release}:
 * the moment a restore pass is initializing a table, with the record it is putting back still listed
 * as deferred. */
class ParkedReads {
	private hold: Promise<void> | undefined;
	private open: (() => void) | undefined;
	private arrived!: () => void;
	/** Resolves once a read is parked. */
	readonly parked = new Promise<void>(resolve => { this.arrived = resolve; });

	park(): void {
		this.hold = new Promise(resolve => { this.open = resolve; });
	}

	release(): void {
		this.open?.();
	}

	wrap(inner: ITransactor): ITransactor {
		return withReads(inner, async (target, blockGets) => {
			const hold = this.hold;
			if (hold !== undefined) {
				this.hold = undefined;
				this.arrived();
				await hold;
			}
			return target.get(blockGets);
		});
	}
}

/** `repo` with every pend (a send reaching this node's coordinator) counted. */
function countingPends(repo: IRepo, counted: { pends: number }): IRepo {
	const pendMany = repo.pendMany?.bind(repo);
	return {
		get: (blockGets, options) => repo.get(blockGets, options),
		pend: (request, options) => { counted.pends++; return repo.pend(request, options); },
		cancel: (actionRef, options) => repo.cancel(actionRef, options),
		commit: (request, options) => repo.commit(request, options),
		...(pendMany ? { pendMany: (requests: Parameters<typeof pendMany>[0], options?: Parameters<typeof pendMany>[1]) => { counted.pends++; return pendMany(requests, options); } } : {}),
		...(repo.commitMany ? { commitMany: repo.commitMany.bind(repo) } : {}),
	};
}

describe('Offline mode: restoring the queue from its journal after a restart', function () {
	this.timeout(60_000);

	for (const variant of [
		{ name: 'its node store synced the commit before the loss', syncBeforeCrash: true },
		{ name: 'its node store lost the commit with the power', syncBeforeCrash: false },
	]) {
		it(`a crash after the network commit and before the journal delete, where ${variant.name}: after the restart the entry is reported committed once, nothing is sent again, the row is on both nodes and the log holds the action once`, async () => {
			// Node A's store is a write-group driver over a backend that defers its syncs, with the window a
			// two-member cohort allows, so a commit can be applied and then lost; node B's is plain memory.
			const backend = new MemoryBatchBackend({ deferSync: true });
			const policy = resolveDurabilityWindowPolicy(undefined, { superMajorityThreshold: 0.67, clusterSize: 2 });
			const counted = { pends: 0 };
			const meshOptions: MockMeshOptions = {
				rawStorageFactory: index => index === 0 ? new KvRawStorage(new WriteGroupDriver(backend)) : new MemoryRawStorage(),
				durabilityWindowFor: cohortSize => durabilityWindowMs(cohortSize, policy),
				wrapRepo: repo => countingPends(repo, counted),
			};
			const { mesh, transactorFor } = await startMockMesh(2, meshOptions);
			const store = new CrashesAtOutcome(variant.syncBeforeCrash ? () => backend.sync() : () => Promise.resolve());
			const a = openA(transactorFor(0), store);
			const b = createMeshDbNode(transactorFor(1));
			for (const node of [a, b]) {
				await node.db.exec(createNotes);
				await node.db.exec(createNotesIndex);
			}
			// What A held before the transaction is durable either way; only the commit itself can be lost.
			await backend.sync();
			a.plugin.offline.enter();

			const transactionId = await insertNote(a.db, 1, 'survives');
			await waitFor(() => statusesOf(a.statuses, 'committed', transactionId).length === 1, { description: 'the drain to commit', timeoutMs: 10_000 });
			expect(await loggedUnder(b.plugin, NOTES_URI, 'none'), 'sanity: the log helper reads B').to.deep.equal([]);
			await a.plugin.dispose();
			backend.powerLoss();
			mesh.restart(mesh.nodes[0]!, { rawStorage: new KvRawStorage(new WriteGroupDriver(backend)) });
			const reopened = store.reopen();
			expect(await keysOf(reopened, 'entries'), 'the entry record survived the crash').to.deep.equal([ENTRY_1]);
			expect(await keysOf(reopened, 'outcomes'), 'the outcome was never written').to.deep.equal([]);
			const drive = await record<DriveRecordV1>(reopened, DRIVE_1);
			const pendsBefore = counted.pends;

			const a2 = openA(transactorFor(0), reopened);
			await a2.plugin.hydrate(a2.db);

			// With the commit held locally every collection answers already-committed and the entry is
			// settled inside hydrate; a stale replica re-stages it in doubt and the drain settles it after
			// (its opening refresh finds the entry on B and consumes it, or re-sends the recorded attempt
			// verbatim, which storage treats as the write's own revision). Either way: once, and one log entry.
			if (variant.syncBeforeCrash) {
				expect(statusesOf(a2.statuses, 'committed', transactionId), 'settled before hydrate resolved').to.have.length(1);
				expect(counted.pends, 'nothing was sent again').to.equal(pendsBefore);
			}
			await a2.plugin.offline.whenDrained();
			await waitFor(() => statusesOf(a2.statuses, 'committed', transactionId).length > 0, { description: 'the restored entry to settle' });
			const committed = statusesOf(a2.statuses, 'committed', transactionId);
			expect(committed, 'reported committed exactly once').to.have.length(1);
			expect(committed[0]!.followed, 'nothing is followed across a restart').to.equal(false);
			if (variant.syncBeforeCrash) {
				expect([...committed[0]!.durability.collections.values()], 'saved with its holders unknown').to.deep.equal([undefined, undefined]);
			}
			expect(await loggedUnder(b.plugin, NOTES_URI, drive.actionId), 'B logged the recorded action once').to.have.length(1);
			expect(await notesOf(a2.db)).to.deep.equal([{ id: 1, body: 'survives' }]);
			expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'survives' }]);
			await expectIndexAgreesWithScan(a2.db, 'Notes', 'body');
			expect(await keysOf(reopened, 'entries'), 'the records are settled').to.deep.equal([]);
			expect(await keysOf(reopened, 'outcomes')).to.deep.equal([`optimystic-offline/default/outcomes/${transactionId}`]);
		});
	}

	it('a crash after the local acknowledgement, before any send: hydrate puts the entry back and reports it queued, a read on A shows its row while the cohort is unreachable, and it drains on reconnect', async () => {
		const { mesh, transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorFor(0), store, { gate });
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		severB(mesh);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'acknowledged');
		expect(await keysOf(store, 'drives'), 'never sent').to.deep.equal([]);
		const reopened = await crashA(store, a);

		const a2 = openA(transactorFor(0), reopened, { gate });
		await a2.plugin.hydrate(a2.db);

		expect(statusesOf(a2.statuses, 'queued', transactionId).length, 'queued was emitted before hydrate resolved').to.be.greaterThan(0);
		const [listed] = a2.plugin.offline.entries();
		expect(listed).to.include({ transactionId, persisted: true, seq: 1 });
		expect(listed!.status).to.include({ kind: 'queued', inDoubt: false, attempts: 0 });
		a2.plugin.offline.enter();
		expect(await notesOf(a2.db), 'served from this machine\'s own view').to.deep.equal([{ id: 1, body: 'acknowledged' }]);
		expect(await countTreeEntries(b.plugin, NOTES_URI), 'nothing reached B yet').to.equal(0);

		restoreB(mesh);
		gate.open = true;
		await a2.plugin.offline.whenDrained();
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'acknowledged' }]);
	});

	it('the outlooks queued transactions had survive a crash after the local acknowledgement: the write-description facts are journaled with each, a key-pinned read comes back matched by its table, and a record without the facts comes back judged by its checks alone', async () => {
		const { transactorFor } = await startMockMesh(1);
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorFor(0), store, { gate });
		await a.db.exec(createConversations);
		await a.db.exec(createMessages);
		a.plugin.offline.enter();
		await a.db.exec(`insert into Conversations (id, title) values ('c1', 'hello')`);
		await a.db.exec(`insert into Conversations (id, title) values ('c2', 'other')`);
		await a.db.exec(`begin; insert into Messages (id, conversation, body) values (StampId(), 'c1', 'hi'); commit`);
		// Reads c1's row alone, pinned by its key.
		await a.db.exec(`insert into Conversations (id, title) select 'c3', title from Conversations where id = 'c1'`);
		const [c1, c2, message, c3] = a.plugin.offline.entries().map(entry => entry.transactionId) as [string, string, string, string];
		const before = outlooksOf(a);
		expect(before[2], 'the message, before the crash').to.deep.equal({
			kind: 'assured',
			exposures: [],
			dependsOn: [{ transactionId: c1, via: 'unchecked' }, { transactionId: c2, via: 'unchecked' }],
			unchecked: [{ table: 'main.Conversations', kind: 'foreign-key', scope: 'global' }],
		});
		expect(before[3]!.dependsOn, 'the key-pinned read, before the crash').to.deep.equal([{ transactionId: c1, via: 'unchecked' }]);
		const reopened = await crashA(store, a);
		const messageRecord = await record<EntryRecordV1>(reopened, 'optimystic-offline/default/entries/000000000003');
		expect(messageRecord.outlook?.fresh.map(([collectionId, keys]) => [collectionId, keys.length]), "the message's key is fresh").to.deep.equal([[MESSAGES_COLLECTION, 1]]);
		expect(messageRecord.outlook).to.deep.include({
			unchecked: [{ table: { schema: 'main', table: 'conversations' }, kind: 'foreign-key', scope: 'global' }],
			complete: true,
		});

		const a2 = openA(transactorFor(0), reopened, { gate });
		await a2.plugin.hydrate(a2.db);
		expect(outlooksOf(a2), 'the same outlooks, but the key-pinned read now depends on every earlier writer of its table').to.deep.equal([
			...before.slice(0, 3),
			{ ...before[3]!, dependsOn: [{ transactionId: c1, via: 'unchecked' }, { transactionId: c2, via: 'unchecked' }] },
		]);
		await a2.plugin.dispose();

		const a3 = openA(transactorFor(0), await withoutOutlook(reopened), { gate });
		await a3.plugin.hydrate(a3.db);
		const older = outlooksOf(a3);
		expect(older[2], 'the message, from a record without the facts').to.deep.equal({
			kind: 'exposed',
			exposures: [{ table: 'main.Messages', rule: 'primary-key', key: [message] }],
			dependsOn: [],
			unchecked: 'not-computed',
		});
		expect(older[3]!.unchecked, `${c3}: nothing to judge its read by`).to.equal('not-computed');
	});

	it('a crash between writing the drive record and the send reaching the cohort: the restored entry is in doubt, discard refuses it, and it drains once under the recorded action id', async () => {
		const { mesh, transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const a = openA(transactorFor(0), store);
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		// B's cluster round is held: the send leaves A's coordinator and never arrives.
		const bPeer = mesh.nodes[1]!.peerId.toString();
		let parked: ((error: Error) => void) | undefined;
		const held = new Promise<void>((_resolve, reject) => { parked = reject; });
		held.catch(() => undefined);
		let arrived!: () => void;
		const arrivedAtB = new Promise<void>(resolve => { arrived = resolve; });
		mesh.failures.onClusterDelivery = async target => {
			if (target !== bPeer) return;
			arrived();
			await held;
		};
		a.plugin.offline.enter();

		const transactionId = await insertNote(a.db, 1, 'in doubt');
		await arrivedAtB;
		expect(await keysOf(store, 'drives'), 'the drive record is on disk before the send').to.deep.equal([DRIVE_1]);
		store.powerLoss();
		parked!(new Error('the process died with the send in flight'));
		await a.plugin.dispose();
		mesh.failures.onClusterDelivery = undefined;
		const reopened = store.reopen();
		const drive = await record<DriveRecordV1>(reopened, DRIVE_1);

		// Held unsent by the gate while its state is read; then released to drain.
		const gate = new Gate(false);
		const a2 = openA(transactorFor(0), reopened, { gate });
		await a2.plugin.hydrate(a2.db);

		const status = a2.plugin.offline.status(transactionId);
		expect(status).to.include({ kind: 'queued', inDoubt: true, attempts: 1 });
		expect(() => a2.plugin.offline.discard(transactionId)).to.throw(EntryNotDiscardableError);
		gate.open = true;
		await a2.plugin.offline.whenDrained();
		expect(statusesOf(a2.statuses, 'committed', transactionId)).to.have.length(1);
		expect(await loggedUnder(b.plugin, NOTES_URI, drive.actionId), 'exactly one entry under the recorded action id').to.have.length(1);
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'in doubt' }]);
	});

	it('a record of an unknown version stops the restore with OfflineJournalError: the valid earlier record is restored, every record stays in the store', async () => {
		const { transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorFor(0), store, { gate });
		await a.db.exec(createNotes);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'valid');
		const futureKey = 'optimystic-offline/default/entries/000000000002';
		await store.set(futureKey, JSON.stringify({ v: 2, transactionId: 'from-a-newer-build', seq: 2, queuedAt: 0, segments: [] }));
		await store.flush();
		const reopened = await crashA(store, a);

		const a2 = openA(transactorFor(0), reopened, { gate });
		const failure = await captureThrown(() => a2.plugin.hydrate(a2.db));

		expect(failure).to.be.instanceOf(OfflineJournalError);
		expect(failure as OfflineJournalError).to.include({ reason: 'unknown-version', key: futureKey, version: 2 });
		expect(a2.plugin.offline.entries().map(entry => entry.transactionId), 'the record before it is restored').to.deep.equal([transactionId]);
		expect(await keysOf(reopened, 'entries'), 'nothing dropped').to.deep.equal([ENTRY_1, futureKey]);
	});

	it('two Databases over one store under two labels each restore their own records', async () => {
		const { transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const one = openA(transactorFor(0), store, { gate, label: 'one' });
		const two = openA(transactorFor(0), store, { gate, label: 'two' });
		await one.db.exec(`create table One (id integer primary key) using optimystic('tree://offline-restore/one')`);
		await two.db.exec(`create table Two (id integer primary key) using optimystic('tree://offline-restore/two')`);
		one.plugin.offline.enter();
		two.plugin.offline.enter();
		await one.db.exec('insert into One (id) values (1)');
		await two.db.exec('insert into Two (id) values (1)');
		const [oneId] = one.plugin.offline.entries().map(entry => entry.transactionId);
		const [twoId] = two.plugin.offline.entries().map(entry => entry.transactionId);
		store.powerLoss();
		await one.plugin.dispose();
		await two.plugin.dispose();
		const reopened = store.reopen();

		const one2 = openA(transactorFor(0), reopened, { gate, label: 'one' });
		const two2 = openA(transactorFor(0), reopened, { gate, label: 'two' });
		await one2.plugin.hydrate(one2.db);
		await two2.plugin.hydrate(two2.db);

		expect(one2.plugin.offline.entries().map(entry => entry.transactionId)).to.deep.equal([oneId]);
		expect(two2.plugin.offline.entries().map(entry => entry.transactionId)).to.deep.equal([twoId]);
		await one2.plugin.dispose();
		await two2.plugin.dispose();
	});

	it("a table dropped by another machine while A was down: the record is deferred as waiting for restore, discard removes it with failed/discarded, and whenDrained then resolves", async () => {
		const { transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorFor(0), store, { gate });
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'orphaned');
		const reopened = await crashA(store, a);
		await b.db.exec('drop table Notes');

		const a2 = openA(transactorFor(0), reopened, { gate });
		await a2.plugin.hydrate(a2.db);

		const [listed] = a2.plugin.offline.entries();
		expect(listed).to.include({ transactionId, seq: 1, persisted: true });
		expect(listed!.tables).to.deep.equal(['main.Notes']);
		expect(listed!.status).to.include({ kind: 'queued', waitingFor: 'restore', inDoubt: false, attempts: 0, persisted: true });
		expect(a2.plugin.offline.status(transactionId)).to.include({ kind: 'queued', waitingFor: 'restore' });
		expect(a2.plugin.offline.hasQueuedEntries(), 'counts as queued').to.equal(true);
		expect(a2.statuses, 'no status for a deferred record').to.deep.equal([]);

		a2.plugin.offline.discard(transactionId);
		await a2.plugin.offline.whenDrained();
		const [failed] = statusesOf(a2.statuses, 'failed', transactionId);
		expect(failed).to.include({ reason: 'discarded' });
		expect(failed!.changedTables, 'nothing was staged, so nothing is announced').to.deep.equal([]);
		expect(a2.plugin.offline.entries()).to.deep.equal([]);
		expect(a2.plugin.offline.status(transactionId)?.kind, 'the outcome is retained').to.equal('failed');
		expect(await keysOf(reopened, 'entries')).to.deep.equal([]);
		expect(await keysOf(reopened, 'outcomes')).to.deep.equal([`optimystic-offline/default/outcomes/${transactionId}`]);
	});

	it('discard of a deferred record while a pass is putting that record back is refused, and the pass queues it', async () => {
		const { transactorFor } = await startMockMesh(2);
		const isolation = new Isolation(blockId => blockId.startsWith(NOTES_COLLECTION));
		const parking = new ParkedReads();
		const transactorA = parking.wrap(isolation.wrap(transactorFor(0)));
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorA, store, { gate });
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'contested');
		const reopened = await crashA(store, a);

		isolation.armed = true;
		const a2 = openA(transactorA, reopened, { gate });
		await a2.plugin.hydrate(a2.db);
		expect(a2.plugin.offline.status(transactionId)).to.include({ kind: 'queued', waitingFor: 'restore' });

		// The table can be read again; the pass that puts the record back is parked on its first read of it.
		isolation.armed = false;
		parking.park();
		const pass = a2.plugin.offline.restore();
		await parking.parked;
		expect(() => a2.plugin.offline.discard(transactionId)).to.throw(EntryNotDiscardableError).with.property('because', 'restoring');
		parking.release();
		await pass;

		const queued = a2.plugin.offline.status(transactionId) as QueuedStatus;
		expect(queued).to.include({ kind: 'queued', inDoubt: false });
		expect(queued.waitingFor, 'back in the queue').to.not.equal('restore');
		gate.open = true;
		await a2.plugin.offline.whenDrained();
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'contested' }]);
	});

	it('a table whose blocks cannot be read at restore: the record is deferred, a read of the table fails even in offline mode, and the first read that reaches the cohort puts the entry back and drains it', async () => {
		const { transactorFor } = await startMockMesh(2);
		const isolation = new Isolation(blockId => blockId.startsWith(NOTES_COLLECTION));
		const transactorA = isolation.wrap(transactorFor(0));
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorA, store, { gate });
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'unreadable');
		const reopened = await crashA(store, a);

		isolation.armed = true;
		const a2 = openA(transactorA, reopened);
		await a2.plugin.hydrate(a2.db);

		expect(a2.plugin.offline.status(transactionId)).to.include({ kind: 'queued', waitingFor: 'restore' });
		a2.plugin.offline.enter();
		const refusal = await captureThrown(() => notesOf(a2.db));
		expect(unavailableIn(refusal)?.reason, `the read fails in offline mode too: ${refusal.message}`).to.equal('cohort-unreachable');
		expect(a2.plugin.offline.queueState().readsServedLocally).to.equal(false);

		isolation.armed = false;
		expect(await notesOf(a2.db), 'the read reaches the cohort; the row is not back yet').to.deep.equal([]);
		await waitFor(() => statusesOf(a2.statuses, 'queued', transactionId).length > 0, { description: 'the read to trigger the restore' });
		await a2.plugin.offline.whenDrained();
		expect(await notesOf(a2.db)).to.deep.equal([{ id: 1, body: 'unreadable' }]);
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'unreadable' }]);
	});

	it("a deferred record with nothing else queued is put back by the gate's wake when the cohort returns, and drains, with no read of its table", async () => {
		const { transactorFor } = await startMockMesh(2);
		const isolation = new Isolation(blockId => blockId.startsWith(NOTES_COLLECTION));
		const transactorA = isolation.wrap(transactorFor(0));
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorA, store, { gate });
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'woken');
		const reopened = await crashA(store, a);

		isolation.armed = true;
		const a2 = openA(transactorA, reopened, { gate });
		await a2.plugin.hydrate(a2.db);
		expect(a2.plugin.offline.entries().map(entry => entry.transactionId), 'only the deferred record').to.deep.equal([transactionId]);
		expect(a2.plugin.offline.status(transactionId)).to.include({ kind: 'queued', waitingFor: 'restore' });

		// The queue is empty, so no drain iteration asks the gate; only the wake can start the retry.
		isolation.armed = false;
		gate.open = true;
		gate.wake();
		await waitFor(() => statusesOf(a2.statuses, 'committed', transactionId).length === 1, { description: 'the wake to put the record back and drain it' });
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'woken' }]);
	});

	it('a new offline commit made while a record is deferred waits behind it: nothing is submitted until the record is back, and the two drain in sequence order', async () => {
		const { transactorFor } = await startMockMesh(2);
		const isolation = new Isolation(blockId => blockId.startsWith(NOTES_COLLECTION));
		const transactorA = isolation.wrap(transactorFor(0));
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorA, store, { gate });
		const b = createMeshDbNode(transactorFor(1));
		for (const node of [a, b]) {
			await node.db.exec(createNotes);
			await node.db.exec(createOther);
		}
		a.plugin.offline.enter();
		const notesId = await insertNote(a.db, 1, 'older');
		const reopened = await crashA(store, a);

		isolation.armed = true;
		const a2 = openA(transactorA, reopened);
		await a2.plugin.hydrate(a2.db);
		a2.plugin.offline.enter();
		await a2.db.exec('insert into Other (id) values (1)');
		const otherId = a2.plugin.offline.entries().find(entry => entry.tables.includes('main.Other'))!.transactionId;
		await waitFor(() => a2.plugin.offline.status(otherId)?.kind === 'queued' && (a2.plugin.offline.status(otherId) as QueuedStatus).waitingFor === 'cohort',
			{ description: 'the new entry to wait on the gate' });
		expect(a2.statuses.some(status => status.kind === 'submitting'), 'nothing submitted ahead of the deferred record').to.equal(false);

		isolation.armed = false;
		await a2.plugin.offline.whenDrained();

		const order = a2.statuses.filter((status): status is CommittedStatus => status.kind === 'committed').map(status => status.transactionId);
		expect(order, 'the restored entry drains first').to.deep.equal([notesId, otherId]);
		const seqOf = (transactionId: string): number => statusesOf(a2.statuses, 'queued', transactionId)[0]!.seq;
		expect(seqOf(notesId), 'the restored entry keeps its lower sequence number').to.be.lessThan(seqOf(otherId));
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(1);
		expect(await countTreeEntries(b.plugin, OTHER_URI)).to.equal(1);
	});

	it("a restored entry refused by a guard — another machine took its key while A was down — fails with constraint, its row is not in A's view, its records are replaced by its outcome", async () => {
		const { transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const gate = new Gate(false);
		const a = openA(transactorFor(0), store, { gate });
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'mine');
		const reopened = await crashA(store, a);
		await b.db.exec(`insert into Notes (id, body) values (1, 'rival')`);

		const a2 = openA(transactorFor(0), reopened);
		await a2.plugin.hydrate(a2.db);
		await waitFor(() => statusesOf(a2.statuses, 'failed', transactionId).length === 1, { description: 'the restored entry to fail' });

		const [failed] = statusesOf(a2.statuses, 'failed', transactionId) as [FailedStatus];
		expect(failed.reason).to.equal('constraint');
		expect(failed.error).to.be.instanceOf(ConstraintError);
		expect(await notesOf(a2.db), 'the rival\'s row is what A reads').to.deep.equal([{ id: 1, body: 'rival' }]);
		expect(a2.plugin.offline.status(transactionId)?.kind, 'the retained outcome').to.equal('failed');
		expect(await keysOf(reopened, 'entries')).to.deep.equal([]);
		expect(await keysOf(reopened, 'outcomes')).to.deep.equal([`optimystic-offline/default/outcomes/${transactionId}`]);
	});

	it('an entry record left beside its outcome record (a delete that never flushed) is settled: skipped, its records deleted, the outcome listed once, no status emitted', async () => {
		const { transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const a = openA(transactorFor(0), store);
		const b = createMeshDbNode(transactorFor(1));
		await a.db.exec(createNotes);
		await b.db.exec(createNotes);
		a.plugin.offline.enter();
		const transactionId = await insertNote(a.db, 1, 'drained');
		await waitFor(() => statusesOf(a.statuses, 'committed', transactionId).length === 1, { description: 'the drain to commit', timeoutMs: 10_000 });
		const reopened = await crashA(store, a);
		expect(await keysOf(reopened, 'entries'), 'the unflushed delete was lost').to.deep.equal([ENTRY_1]);

		const a2 = openA(transactorFor(0), reopened);
		await a2.plugin.hydrate(a2.db);

		expect(a2.statuses, 'nothing reported').to.deep.equal([]);
		expect(a2.plugin.offline.entries()).to.deep.equal([]);
		expect(a2.plugin.offline.outcomes().map(outcome => outcome.transactionId)).to.deep.equal([transactionId]);
		expect(await keysOf(reopened, 'entries')).to.deep.equal([]);
		expect(await keysOf(reopened, 'drives')).to.deep.equal([]);
		expect(await keysOf(reopened, 'outcomes')).to.deep.equal([`optimystic-offline/default/outcomes/${transactionId}`]);
	});

	it('restore refuses to run while a transaction is open, and changes nothing', async () => {
		const { transactorFor } = await startMockMesh(1);
		const store = new PowerLossKVStore();
		const a = openA(transactorFor(0), store);
		await a.db.exec(createNotes);
		await a.db.exec('begin');
		await a.db.exec(`insert into Notes (id, body) values (1, 'open')`);

		const refusal = await captureThrown(() => a.plugin.offline.restore());
		expect(refusal.message).to.match(/transaction is open/);
		await a.db.exec('rollback');
		expect(a.plugin.offline.entries()).to.deep.equal([]);
		expect(await store.list('optimystic-offline/')).to.deep.equal([]);
	});
});
