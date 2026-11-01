/**
 * The schema-change gate of offline mode (docs/offline-sync.md §Schema changes): a statement that
 * changes how a table's rows are stored — creating or dropping an index, adding or dropping a column,
 * dropping the table, re-declaring the table's collection with other columns — is refused with
 * `QueuedEntriesBlockSchemaChangeError` while a queued transaction wrote the table, and succeeds once
 * it settles. DDL that changes no stored shape is not gated.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`). Node A's repo parks the ONE pend that
 * follows {@link TwoNodes.parkNextPend}: the drain's submission of the queued transaction, which then
 * stays queued — being submitted, in doubt — for as long as the case needs, while every later pend,
 * the catalog writes of the DDL under test among them, goes through.
 */

import { expect } from 'chai';
import type { Database, SqlValue } from '@quereus/quereus';
import { StatusCode } from '@quereus/quereus';
import { QueuedEntriesBlockSchemaChangeError } from '../dist/index.js';
import { CommitGate, parkingPends } from './commit-gate.js';
import { createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { queryAll } from './query-helpers.js';

const NOTES_URI = 'tree://offline-ddl/notes';
const NOTES = { schemaName: 'main', tableName: 'Notes' };
const createNotes = `create table Notes (id integer primary key, body text, extra text null) using optimystic('${NOTES_URI}')`;

interface TwoNodes {
	a: MeshDbNode;
	/** Park the next pend node A's repo receives, until the returned gate is released. */
	parkNextPend(): CommitGate;
}

async function twoNodes(): Promise<TwoNodes> {
	let next: CommitGate | undefined;
	let parkedPeer: string | undefined;
	const { mesh, transactorFor } = await startMockMesh(2, {
		wrapRepo: (repo, node) => parkingPends(repo, () => {
			if (node.peerId.toString() !== parkedPeer) return undefined;
			const gate = next;
			next = undefined;
			return gate;
		}),
	});
	parkedPeer = mesh.nodes[0]!.peerId.toString();
	const a = createMeshDbNode(transactorFor(0), { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>);
	createMeshDbNode(transactorFor(1));
	return {
		a,
		parkNextPend: () => {
			next = new CommitGate();
			next.arm();
			return next;
		},
	};
}

/** Queue one offline insert on node A whose submission is parked, and answer its transaction id and gate. */
async function queueParkedInsert(nodes: TwoNodes, id: number): Promise<{ transactionId: string; gate: CommitGate }> {
	const { a } = nodes;
	const gate = nodes.parkNextPend();
	a.plugin.offline.enter();
	await a.db.exec(`insert into Notes (id, body) values (${id}, 'queued')`);
	a.plugin.offline.exit();
	await gate.entered;
	const queued = a.plugin.offline.entries();
	expect(queued, 'one transaction queued').to.have.length(1);
	return { transactionId: queued[0]!.transactionId, gate };
}

/** The refusal `error` is or wraps: Quereus rewraps a module's error out of CREATE INDEX, CREATE TABLE
 * and APPLY SCHEMA, keeping it as `cause`. */
function refusalIn(error: unknown): QueuedEntriesBlockSchemaChangeError | undefined {
	for (let at = error; at instanceof Error; at = at.cause) {
		if (at instanceof QueuedEntriesBlockSchemaChangeError) return at;
	}
	return undefined;
}

/** `sql` is refused by the gate, naming `transactionIds`; answers the refusal. */
async function expectGated(db: Database, sql: string, transactionIds: string[]): Promise<QueuedEntriesBlockSchemaChangeError> {
	let thrown: unknown;
	try {
		await db.exec(sql);
	} catch (error) {
		thrown = error;
	}
	const found = refusalIn(thrown);
	expect(found, `${sql} is refused by the gate (threw ${String(thrown)})`).to.be.instanceOf(QueuedEntriesBlockSchemaChangeError);
	const refusal = found!;
	expect(refusal.code, 'BUSY').to.equal(StatusCode.BUSY);
	expect(refusal.table).to.equal('main.Notes');
	expect(refusal.transactionIds, 'the queued transactions that wrote the table').to.deep.equal(transactionIds);
	return refusal;
}

async function settle(a: MeshDbNode, gate: CommitGate): Promise<void> {
	gate.release();
	await a.plugin.offline.whenDrained();
}

const columnsOf = (db: Database): string[] => db.schemaManager.findTable('Notes', 'main')!.columns.map(col => col.name);
const indexesOf = (db: Database): string[] => (db.schemaManager.findTable('Notes', 'main')!.indexes ?? []).map(index => index.name);

describe('Offline mode: schema changes wait for the queued transactions that wrote the table', function () {
	this.timeout(60_000);

	it('create index, drop index, add column and drop column are refused while a transaction that wrote the table is queued — the one being submitted counts — and each succeeds once it settles', async () => {
		const nodes = await twoNodes();
		const { a } = nodes;
		await a.db.exec(createNotes);

		const first = await queueParkedInsert(nodes, 1);
		expect(a.plugin.offline.status(first.transactionId)?.kind, 'the queued transaction is being submitted').to.equal('submitting');
		const refusal = await expectGated(a.db, 'create index notes_by_body on Notes (body)', [first.transactionId]);
		expect(refusal.operation).to.equal('create index');
		await expectGated(a.db, 'alter table Notes add column later text null', [first.transactionId]);
		await expectGated(a.db, 'alter table Notes drop column extra', [first.transactionId]);
		expect(columnsOf(a.db), 'no column changed').to.deep.equal(['id', 'body', 'extra']);
		expect(indexesOf(a.db), 'no index created').to.deep.equal([]);

		await settle(a, first.gate);
		await a.db.exec('create index notes_by_body on Notes (body)');

		const second = await queueParkedInsert(nodes, 2);
		await expectGated(a.db, 'drop index notes_by_body', [second.transactionId]);
		expect(indexesOf(a.db), 'the index stays').to.deep.equal(['notes_by_body']);

		await settle(a, second.gate);
		await a.db.exec('drop index notes_by_body');
		await a.db.exec('alter table Notes add column later text null');
		await a.db.exec('alter table Notes drop column extra');
		expect(columnsOf(a.db)).to.deep.equal(['id', 'body', 'later']);
		expect(await queryAll(a.db, 'select id, body from Notes order by id')).to.deep.equal([
			{ id: 1, body: 'queued' }, { id: 2, body: 'queued' },
		]);
	});

	it('drop table is refused while queued, and once the transaction settles it drops and the table\'s collections leave the bridge\'s record', async () => {
		const nodes = await twoNodes();
		const { a } = nodes;
		await a.db.exec(createNotes);
		const collections = a.plugin.txnBridge.collectionsOf(NOTES);
		expect(collections, 'the bridge records the table\'s collection').to.have.length(1);

		const { transactionId, gate } = await queueParkedInsert(nodes, 1);
		await expectGated(a.db, 'drop table Notes', [transactionId]);
		expect(a.db.schemaManager.findTable('Notes', 'main'), 'the table is still declared').to.not.equal(undefined);

		await settle(a, gate);
		await a.db.exec('drop table Notes');
		expect(a.plugin.txnBridge.collectionsOf(NOTES), 'no collection is recorded for the dropped table').to.deep.equal([]);
		expect(a.plugin.txnBridge.tablesOf(collections[0]!), 'and its collection names no table').to.equal(undefined);
	});

	it('an apply schema that adds an index fails with the refusal while a transaction is queued, and leaves the table as it was', async () => {
		const nodes = await twoNodes();
		const { a } = nodes;
		const table = `table Notes using optimystic ('${NOTES_URI}') { id integer primary key, body text, extra text null }`;
		await a.db.exec(`declare schema main {\n${table}\n}\napply schema main;`);

		const { transactionId, gate } = await queueParkedInsert(nodes, 1);
		await expectGated(a.db, `declare schema main {\n${table}\nindex notes_by_body on Notes (body)\n}\napply schema main;`, [transactionId]);
		expect(indexesOf(a.db), 'the index was not created').to.deep.equal([]);

		await settle(a, gate);
		expect(await queryAll(a.db, 'select id, body from Notes')).to.deep.equal([{ id: 1, body: 'queued' }]);
	});

	it('a tag change is not gated', async () => {
		const nodes = await twoNodes();
		const { a } = nodes;
		await a.db.exec(createNotes);
		const { gate } = await queueParkedInsert(nodes, 1);

		await a.db.exec(`alter table Notes set tags ("app.color" = 'blue')`);
		await a.plugin.whenCatalogPersisted();
		expect(a.db.schemaManager.findTable('Notes', 'main')!.tags).to.deep.include({ 'app.color': 'blue' });
		await settle(a, gate);
	});

	it('re-declaring the table\'s collection under another name passes with the same columns and primary key, and is refused with one more column', async () => {
		const nodes = await twoNodes();
		const { a } = nodes;
		await a.db.exec(createNotes);
		const { transactionId, gate } = await queueParkedInsert(nodes, 1);

		await a.db.exec(`create table NotesAgain (id integer primary key, body text, extra text null) using optimystic('${NOTES_URI}')`);
		const refusal = await expectGated(a.db,
			`create table NotesWider (id integer primary key, body text, extra text null, more text null) using optimystic('${NOTES_URI}')`,
			[transactionId]);
		expect(refusal.operation).to.equal('create table');
		expect(a.db.schemaManager.findTable('NotesWider', 'main'), 'the wider table was not created').to.equal(undefined);
		await settle(a, gate);
	});
});
