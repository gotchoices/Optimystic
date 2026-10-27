/**
 * The offline queue's journal over an `IKVStore` (docs/offline-sync.md §Persistence): what is on disk
 * after an offline commit, after its drain, and after a crash at the two points the write ordering
 * names. Restoring from the journal after a restart is not pinned here; these cases read the store.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`), both responsible for every block. Node
 * A's journal is a `PowerLossKVStore`, whose `powerLoss()` loses every write no flush reached and
 * whose `reopen()` reads what survived. Node B is made unreachable for cluster rounds through
 * `mesh.failures.failingPeers`, which keeps an entry queued after its first send.
 */

import { expect } from 'chai';
import type { Database, SqlValue } from '@quereus/quereus';
import { transactionDurability, type CollectionId, type WriteDurability } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { MemoryKVStore, type IKVStore } from '@optimystic/db-p2p';
import { PowerLossKVStore, type Mesh } from '@optimystic/db-p2p/testing';
import type { QueuedTransactionStatus, TransactionOutcome } from '../dist/index.js';
import { decodeOutcome, encodeOutcome, type DriveRecordV1, type EntryRecordV1, type OutcomeRecordV1 } from '../src/optimystic-adapter/offline-journal.js';
import { keysOf, record } from './journal-records.js';
import { createMeshDbNode, loggedUnder, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { queryAll } from './query-helpers.js';

type QueuedStatus = Extract<QueuedTransactionStatus, { kind: 'queued' }>;

const NOTES_URI = 'tree://offline-journal/notes';
const NOTES_COLLECTION = 'offline-journal/notes';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;

const journaled = (journal: IKVStore | (() => IKVStore), extra: Record<string, unknown> = {}): Record<string, SqlValue> =>
	({ offline: { recheck: { baseMs: 20, maxMs: 100 }, journal, ...extra } }) as unknown as Record<string, SqlValue>;

interface TwoNodes {
	mesh: Mesh;
	a: MeshDbNode;
	b: MeshDbNode;
	/** Node A's journal. */
	store: PowerLossKVStore;
	/** Every status node A's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
}

async function twoNodes(): Promise<TwoNodes> {
	const { mesh, transactorFor } = await startMockMesh(2);
	const store = new PowerLossKVStore();
	const a = createMeshDbNode(transactorFor(0), journaled(store));
	const b = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	a.plugin.offline.onStatus(status => { statuses.push(status); });
	await a.db.exec(createNotes);
	await b.db.exec(createNotes);
	return { mesh, a, b, store, statuses };
}

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

const queuedOf = (statuses: readonly QueuedTransactionStatus[], transactionId: string): QueuedStatus | undefined =>
	statuses.find((s): s is QueuedStatus => s.kind === 'queued' && s.transactionId === transactionId);

describe('Offline mode: the journal over a key-value store', function () {
	this.timeout(60_000);

	it('an offline commit over a table and its index is journaled as one entry with two segments, in queue order, persisted; the drain leaves only its outcome', async () => {
		const { mesh, a, b, store, statuses } = await twoNodes();
		const reported: string[] = [];
		a.plugin.onCommitDurability(report => { reported.push(report.transactionId); });
		await a.db.exec('create index NotesByBody on Notes (body)');
		await b.db.exec('create index NotesByBody on Notes (body)');
		a.plugin.offline.enter();
		severB(mesh);

		const first = await insertNote(a.db, 1, 'one');
		const second = await insertNote(a.db, 2, 'two');

		expect(queuedOf(statuses, first)?.persisted, 'the queued status says persisted').to.equal(true);
		expect(a.plugin.offline.entries().map(entry => entry.persisted)).to.deep.equal([true, true]);
		expect(await keysOf(store, 'entries')).to.deep.equal([
			'optimystic-offline/default/entries/000000000001',
			'optimystic-offline/default/entries/000000000002',
		]);
		const entry = await record<EntryRecordV1>(store, 'optimystic-offline/default/entries/000000000001');
		expect(entry).to.include({ v: 1, transactionId: first, seq: 1 });
		expect(entry.segments.map(segment => segment.table)).to.deep.equal([
			{ schemaName: 'main', tableName: 'Notes' },
			{ schemaName: 'main', tableName: 'Notes' },
		]);
		const [main, index] = entry.segments;
		expect(main!.collectionId).to.equal(NOTES_COLLECTION);
		expect(index!.collectionId.startsWith(`${NOTES_COLLECTION}/index/`), `${index!.collectionId} is the index tree`).to.equal(true);
		expect(main!.actions, 'the main tree\'s staged action').to.have.length.greaterThan(0);
		expect(index!.actions, 'the index tree\'s staged action').to.have.length.greaterThan(0);
		expect((await record<EntryRecordV1>(store, 'optimystic-offline/default/entries/000000000002')).transactionId).to.equal(second);

		restoreB(mesh);
		await a.plugin.offline.whenDrained();

		expect(await keysOf(store, 'entries'), 'no entry record after the drain').to.deep.equal([]);
		expect(await keysOf(store, 'drives'), 'no drive record after the drain').to.deep.equal([]);
		expect(await keysOf(store, 'outcomes')).to.deep.equal([first, second].map(id => `optimystic-offline/default/outcomes/${id}`).sort());
		const outcome = await record<OutcomeRecordV1>(store, `optimystic-offline/default/outcomes/${first}`);
		expect(outcome.status).to.include({ kind: 'committed', transactionId: first });
		expect(reported, 'each drained commit\'s durability reported once').to.deep.equal([first, second]);
	});

	it('a journal that throws at enqueue fails the commit: rolled back, nothing queued, nothing reported, nothing on disk', async () => {
		const { a, store, statuses } = await twoNodes();
		a.plugin.offline.enter();
		const refusal = new Error('the disk is full');
		const set = store.set.bind(store);
		store.set = async () => {
			store.set = set;
			throw refusal;
		};

		let thrown: unknown;
		try {
			await a.db.exec(`insert into Notes (id, body) values (1, 'lost')`);
		} catch (error) {
			thrown = error;
		}

		expect(thrown, 'the commit rejects with the journal\'s error').to.be.instanceOf(Error);
		expect((thrown as Error).message).to.contain('the disk is full');
		expect(statuses, 'no status').to.deep.equal([]);
		expect(await store.list('optimystic-offline/'), 'no record').to.deep.equal([]);
		expect(a.plugin.txnBridge.getCollectionRegistry().get(NOTES_COLLECTION as CollectionId)?.sealedEntries() ?? [], 'nothing sealed').to.deep.equal([]);
		expect(await queryAll(a.db, 'select id from Notes'), 'the row was rolled back').to.deep.equal([]);
	});

	it('a crash after the drain committed, before the deletes were flushed: the entry, drive and outcome records all survive, the drive record naming the action id node B logged', async () => {
		const { a, b, store, statuses } = await twoNodes();
		a.plugin.offline.enter();

		const transactionId = await insertNote(a.db, 1, 'drained');
		await waitFor(() => statuses.some(s => s.kind === 'committed' && s.transactionId === transactionId),
			{ description: 'the entry to commit', timeoutMs: 10_000 });
		expect(await keysOf(store, 'entries'), 'the delete is visible before the crash').to.deep.equal([]);

		store.powerLoss();
		const reopened = store.reopen();

		expect(await keysOf(reopened, 'entries')).to.deep.equal(['optimystic-offline/default/entries/000000000001']);
		expect(await keysOf(reopened, 'drives')).to.deep.equal(['optimystic-offline/default/drives/000000000001']);
		expect(await keysOf(reopened, 'outcomes')).to.deep.equal([`optimystic-offline/default/outcomes/${transactionId}`]);
		const drive = await record<DriveRecordV1>(reopened, 'optimystic-offline/default/drives/000000000001');
		expect(drive.transactionId).to.equal(transactionId);
		expect(drive.attempts.map(([collectionId]) => collectionId)).to.deep.equal([NOTES_COLLECTION]);
		const [, attempt] = drive.attempts[0]!;
		expect(attempt.actionId).to.equal(drive.actionId);
		expect(await loggedUnder(b.plugin, NOTES_URI, attempt.actionId), 'node B logged the recorded action once').to.have.length(1);
	});

	it('a crash after the entry was sent once with node B unreachable: the entry and drive records survive, no outcome', async () => {
		const { mesh, a, store, statuses } = await twoNodes();
		a.plugin.offline.enter();
		severB(mesh);

		const transactionId = await insertNote(a.db, 1, 'in doubt');
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.transactionId === transactionId && s.attempts >= 1),
			{ description: 'the first send to fail', timeoutMs: 10_000 });

		store.powerLoss();
		await a.plugin.dispose();
		const reopened = store.reopen();

		expect(await keysOf(reopened, 'entries')).to.deep.equal(['optimystic-offline/default/entries/000000000001']);
		expect(await keysOf(reopened, 'drives')).to.deep.equal(['optimystic-offline/default/drives/000000000001']);
		expect(await keysOf(reopened, 'outcomes')).to.deep.equal([]);
		const drive = await record<DriveRecordV1>(reopened, 'optimystic-offline/default/drives/000000000001');
		expect(drive.transactionId).to.equal(transactionId);
		expect(drive.attempts.map(([collectionId, sent]) => [collectionId, sent.actionId])).to.deep.equal([[NOTES_COLLECTION, drive.actionId]]);
	});

	it('two databases over one store under two labels each see only their own records', async () => {
		const { mesh, transactorFor } = await startMockMesh(2);
		const store = new PowerLossKVStore();
		const one = createMeshDbNode(transactorFor(0), journaled(store, { journalLabel: 'one' }));
		const two = createMeshDbNode(transactorFor(0), journaled(store, { journalLabel: 'two' }));
		await one.db.exec(`create table One (id integer primary key) using optimystic('tree://offline-journal/one')`);
		await two.db.exec(`create table Two (id integer primary key) using optimystic('tree://offline-journal/two')`);
		severB(mesh);
		one.plugin.offline.enter();
		two.plugin.offline.enter();

		await one.db.exec('insert into One (id) values (1)');
		await two.db.exec('insert into Two (id) values (1)');
		const [oneId] = one.plugin.offline.entries().map(entry => entry.transactionId);
		const [twoId] = two.plugin.offline.entries().map(entry => entry.transactionId);

		for (const [label, transactionId] of [['one', oneId], ['two', twoId]] as const) {
			const keys = await keysOf(store, 'entries', label);
			expect(keys, `${label}'s entries`).to.deep.equal([`optimystic-offline/${label}/entries/000000000001`]);
			expect((await record<EntryRecordV1>(store, keys[0]!)).transactionId, `${label}'s record`).to.equal(transactionId);
		}
		await one.plugin.dispose();
		await two.plugin.dispose();
	});

	it('register refuses a journal it cannot use, and calls a journal factory once', async () => {
		const { transactorFor } = await startMockMesh(1);
		const refused = (offline: Record<string, unknown>): string => {
			try {
				createMeshDbNode(transactorFor(0), { offline } as unknown as Record<string, SqlValue>);
			} catch (error) {
				return (error as Error).message;
			}
			throw new Error(`register accepted ${JSON.stringify(Object.keys(offline))}`);
		};

		expect(refused({ journal: new MemoryKVStore() })).to.match(/MemoryKVStore, which does not survive a restart/);
		expect(refused({ journal: () => new MemoryKVStore() })).to.match(/MemoryKVStore/);
		expect(refused({ journal: { get: async () => undefined, set: async () => {}, delete: async () => {} } })).to.match(/missing: list/);
		expect(refused({ journalLabel: 'main' })).to.match(/refused without offline\.journal/);
		expect(refused({ journal: new PowerLossKVStore(), journalLabel: 'a/b' })).to.match(/journalLabel must be lowercase letters/);
		expect(refused({ journal: new PowerLossKVStore(), journalLabel: 'Main' }), 'a case-insensitive filesystem would merge it with main').to.match(/journalLabel must be lowercase letters/);

		let calls = 0;
		createMeshDbNode(transactorFor(0), journaled(() => { calls++; return new PowerLossKVStore(); }));
		expect(calls, 'the factory is called once, inside register').to.equal(1);
	});

	it('an outcome round-trips through its record: committed loses only followed, failed only the error\'s class and cause', () => {
		const full: WriteDurability = { quorum: 'full', confirmed: 2, cohort: 2, unconfirmed: [] };
		const committed: TransactionOutcome = Object.freeze({
			kind: 'committed' as const,
			transactionId: 't1',
			durability: transactionDurability(new Map([['c1' as CollectionId, full]])),
			tables: new Map<string, WriteDurability | undefined>([['main.Notes', full], ['main.Other', undefined]]),
			followed: true,
			effect: 'already-applied' as const,
		});
		const constraint = Object.assign(new Error('UNIQUE constraint failed: Notes.id', { cause: new Error('key taken') }), { name: 'ConstraintError' });
		const failed: TransactionOutcome = {
			kind: 'failed', transactionId: 't2', reason: 'constraint', error: constraint, causedBy: 't1',
			changedTables: ['main.Notes'], committedTables: ['main.Other'],
		};
		const roundTrip = (outcome: TransactionOutcome): TransactionOutcome => decodeOutcome(JSON.parse(JSON.stringify(encodeOutcome(outcome))));

		const decodedCommitted = roundTrip(committed);
		expect(decodedCommitted).to.deep.equal({ ...committed, followed: false });

		const decodedFailed = roundTrip(failed);
		if (decodedFailed.kind !== 'failed') throw new Error('decoded a failed outcome as committed');
		expect(decodedFailed.error).to.be.instanceOf(Error);
		expect(decodedFailed.error).to.include({ name: 'ConstraintError', message: 'UNIQUE constraint failed: Notes.id' });
		expect(decodedFailed.error.cause, 'no cause').to.equal(undefined);
		const { error: _error, ...rest } = decodedFailed;
		const { error: _original, ...expected } = failed;
		expect(rest).to.deep.equal(expected);
	});

	it('a committed outcome record written before effect was journaled decodes as applied', () => {
		const decoded = decodeOutcome({ kind: 'committed', transactionId: 't0', durability: { collections: [] }, tables: [] });
		expect(decoded).to.include({ kind: 'committed', effect: 'applied' });
	});
});
