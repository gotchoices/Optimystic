/**
 * The outlook of a queued transaction (docs/offline-sync.md §Predicting whether an entry will commit),
 * judged from the checks its staged actions carry and the queue ahead of it: delivered on the `queued`
 * status before `commit` resolves, and answered for an open transaction by `CommitOutlook()`.
 *
 * Mostly one node on the in-process mesh, with a reachability gate that never opens, so every offline
 * commit stays queued and the queue ahead of each case is exactly what it built. The cases that follow
 * an outlook as the queue drains run node A of a two-node mesh, whose gate the test opens, beside node
 * B, which commits as a rival.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import type { CommitOutlook, QueuedTransactionStatus } from '../dist/index.js';
import { createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { expectAssuredFailures } from './outlook-predictions.js';
import { queryAll } from './query-helpers.js';
import { captureTrace, plain } from './trace-helpers.js';

type QueuedStatus = Extract<QueuedTransactionStatus, { kind: 'queued' }>;
type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

const offlineConfig = { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>;

/** Fresh primary key: the application generates `id` unique per write. */
const createNotes = `create table Notes (id text primary key with tags ("optimystic.fresh" = true), body text) using optimystic('tree://outlook/notes')`;
/** Natural primary key: two machines can pick the same name. */
const createUsers = `create table Users (name text primary key, bio text) using optimystic('tree://outlook/users')`;
/** Fresh primary key, natural UNIQUE columns of two affinities. */
const createAccounts = `create table Accounts (id text primary key with tags ("optimystic.fresh" = true), email text unique, badge integer unique) using optimystic('tree://outlook/accounts')`;
/** Natural primary key, written by this machine alone. */
const createPrefs = `create table Prefs (pref text primary key, choice text) using optimystic('tree://outlook/prefs') with tags ("optimystic.single_writer" = true)`;
/** No tag: whether a key is fresh is read from where the statement's value came from (the write description). */
const createMemos = `create table Memos (id text primary key, body text) using optimystic('tree://outlook/memos')`;

interface Node extends MeshDbNode {
	/** Every status the plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
	/** The `queued` statuses the plugin reported, in order. */
	queued: QueuedStatus[];
}

function followed(node: MeshDbNode): Node {
	const statuses: QueuedTransactionStatus[] = [];
	const queued: QueuedStatus[] = [];
	node.plugin.offline.onStatus(status => {
		statuses.push(status);
		if (status.kind === 'queued') queued.push(status);
	});
	return { ...node, statuses, queued };
}

async function oneNode(): Promise<Node> {
	const { transactorFor } = await startMockMesh(1);
	const node = followed(createMeshDbNode(transactorFor(0), offlineConfig));
	node.plugin.collectionFactory.registerCohortReachability('shared:test', { reachable: () => Promise.resolve(false) });
	for (const sql of [createNotes, createUsers, createAccounts, createMemos]) await node.db.exec(sql);
	return node;
}

/** The open transaction's `StampId()`, which is what `StampId()` inside its statements writes. */
async function stampIdOf(db: MeshDbNode['db']): Promise<string> {
	const rows = await queryAll(db, 'select StampId() as id');
	expect(rows[0]?.id, 'a transaction is open').to.be.a('string');
	return rows[0]!.id as string;
}

/** Node A, whose gate stays closed until `openGate`, and node B, both with `creates` declared. */
async function twoNodes(...creates: string[]): Promise<{ a: Node; b: MeshDbNode; openGate(): void }> {
	const { transactorFor } = await startMockMesh(2);
	const a = followed(createMeshDbNode(transactorFor(0), offlineConfig));
	const b = createMeshDbNode(transactorFor(1));
	let open = false;
	a.plugin.collectionFactory.registerCohortReachability('shared:test', { reachable: () => Promise.resolve(open) });
	for (const sql of creates) {
		await a.db.exec(sql);
		await b.db.exec(sql);
	}
	return { a, b, openGate: () => { open = true; } };
}

/** Each status as `kind:transactionId`, in the order reported. */
const timelineOf = (statuses: readonly QueuedTransactionStatus[]): string[] =>
	statuses.map(status => `${status.kind}:${status.transactionId}`);

/** Run `sql` as one offline transaction and answer the outlook its `queued` status carried. */
async function queuedOutlook(node: Node, sql: string): Promise<{ transactionId: string; outlook: CommitOutlook | undefined }> {
	const before = node.queued.length;
	await node.db.exec(sql);
	const status = node.queued[before];
	expect(status, `a queued status was delivered before the commit resolved: ${sql}`).to.not.equal(undefined);
	return { transactionId: status!.transactionId, outlook: status!.outlook };
}

const assured = (dependsOn: CommitOutlook['dependsOn'] = []): CommitOutlook =>
	({ kind: 'assured', exposures: [], dependsOn, unchecked: 'not-computed' });

describe('Offline mode: the outlook of a queued transaction', function () {
	this.timeout(30_000);

	it('an insert then an update of the row in one transaction is assured under a fresh key, and exposed once, on the key, under a natural one', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();

		const fresh = await queuedOutlook(node, `begin; insert into Notes (id, body) values ('n1', 'a'); update Notes set body = 'b' where id = 'n1'; commit;`);
		expect(fresh.outlook).to.deep.equal(assured());

		const natural = await queuedOutlook(node, `begin; insert into Users (name, bio) values ('ann', 'a'); update Users set bio = 'b' where name = 'ann'; commit;`);
		expect(natural.outlook).to.deep.equal({
			kind: 'exposed',
			exposures: [{ table: 'main.Users', rule: 'primary-key', key: ['ann'] }],
			dependsOn: [],
			unchecked: 'not-computed',
		});
	});

	it('an update of a row an earlier queued transaction inserted under a fresh key depends on that transaction and is assured with it', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();
		const insert = await queuedOutlook(node, `insert into Notes (id, body) values ('n2', 'a')`);
		expect(insert.outlook).to.deep.equal(assured());

		const update = await queuedOutlook(node, `update Notes set body = 'b' where id = 'n2'`);
		expect(update.outlook).to.deep.equal(assured([{ transactionId: insert.transactionId, via: 'guard' }]));
		const listed = node.plugin.offline.entries().find(entry => entry.transactionId === update.transactionId);
		expect(listed?.status.kind === 'queued' ? listed.status.outlook : undefined, 'entries() lists the same outlook').to.deep.equal(update.outlook);
	});

	it('an insert under StampId() into a table with no fresh tag is assured: the write description says the key is fresh', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();
		// Inside an explicit transaction: in an autocommit statement StampId() is evaluated before the
		// write begins the bridge's transaction, and answers NULL.
		const insert = await queuedOutlook(node, `begin; insert into Memos (id, body) values (StampId(), 'a'); commit`);
		expect(insert.outlook).to.deep.equal(assured());
	});

	it('an insert under hex(randomblob(16)) into a table with no fresh tag is assured: a wide random source is fresh', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();
		const insert = await queuedOutlook(node, `insert into Memos (id, body) values (hex(randomblob(16)), 'a')`);
		expect(insert.outlook).to.deep.equal(assured());
	});

	it('a savepoint rollback discards the facts of the statements it discards: the id a rolled-back insert minted, inserted again as a literal, is exposed', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();
		await node.db.exec('begin');
		const id = await stampIdOf(node.db);
		await node.db.exec(`savepoint s; insert into Memos (id, body) values (StampId(), 'a'); rollback to s`);
		const literal = await queuedOutlook(node, `insert into Memos (id, body) values ('${id}', 'a'); commit`);
		expect(literal.outlook).to.deep.equal({
			kind: 'exposed',
			exposures: [{ table: 'main.Memos', rule: 'primary-key', key: [id] }],
			dependsOn: [],
			unchecked: 'not-computed',
		});
	});

	it('an update of a row an earlier queued transaction inserted under StampId(), with no fresh tag, depends on that transaction and is assured with it', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();
		await node.db.exec('begin');
		const id = await stampIdOf(node.db);
		const insert = await queuedOutlook(node, `insert into Memos (id, body) values (StampId(), 'a'); commit`);
		expect(insert.outlook).to.deep.equal(assured());

		const update = await queuedOutlook(node, `update Memos set body = 'b' where id = '${id}'`);
		expect(update.outlook).to.deep.equal(assured([{ transactionId: insert.transactionId, via: 'guard' }]));
	});

	it('an update of a row committed before going offline is exposed with the row\'s key', async () => {
		const node = await oneNode();
		await node.db.exec(`insert into Notes (id, body) values ('n3', 'a')`);
		node.plugin.offline.enter();

		const update = await queuedOutlook(node, `update Notes set body = 'b' where id = 'n3'`);
		expect(update.outlook).to.deep.equal({
			kind: 'exposed',
			exposures: [{ table: 'main.Notes', rule: 'row', key: ['n3'] }],
			dependsOn: [],
			unchecked: 'not-computed',
		});
	});

	it('an insert under a fresh key into a table with natural UNIQUE columns is exposed on each unique value, decoded under its column\'s type, and not on the key', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();

		const insert = await queuedOutlook(node, `insert into Accounts (id, email, badge) values ('a1', 'a@example.com', 42)`);
		expect(insert.outlook?.kind).to.equal('exposed');
		expect(insert.outlook?.dependsOn).to.deep.equal([]);
		expect(insert.outlook?.exposures).to.have.deep.members([
			{ table: 'main.Accounts', rule: 'unique', columns: ['email'], key: ['a@example.com'] },
			{ table: 'main.Accounts', rule: 'unique', columns: ['badge'], key: [42] },
		]);
	});

	it('CommitOutlook() answers the JSON outlook of what an open transaction has staged, and NULL outside one', async () => {
		const node = await oneNode();
		const outlookNow = async (): Promise<unknown> => (await queryAll(node.db, 'select CommitOutlook() as outlook'))[0]?.outlook;

		expect(await outlookNow(), 'outside a transaction').to.equal(null);
		await node.db.exec('begin');
		await node.db.exec(`insert into Users (name, bio) values ('bob', 'a')`);
		const answer = await outlookNow();
		await node.db.exec('rollback');
		expect(JSON.parse(String(answer))).to.deep.equal({
			kind: 'exposed',
			exposures: [{ table: 'main.Users', rule: 'primary-key', key: ['bob'] }],
			dependsOn: [],
			unchecked: 'not-computed',
		});
	});

	it('a transaction exposed only through an earlier one it depends on is told it is assured once that one commits, before it is sent', async () => {
		const { a, openGate } = await twoNodes(createPrefs);
		a.plugin.offline.enter();
		const insert = await queuedOutlook(a, `insert into Prefs (pref, choice) values ('theme', 'dark')`);
		expect(insert.outlook?.kind, 'a natural key is exposed').to.equal('exposed');
		const update = await queuedOutlook(a, `update Prefs set choice = 'light' where pref = 'theme'`);
		expect(update.outlook).to.deep.equal({
			kind: 'exposed',
			exposures: [],
			dependsOn: [{ transactionId: insert.transactionId, via: 'guard' }],
			unchecked: 'not-computed',
		});

		openGate();
		await a.plugin.offline.whenDrained();

		expect(a.statuses.filter(status => status.kind === 'outlook-changed'), 'one change, the update\'s').to.deep.equal([
			{ kind: 'outlook-changed', transactionId: update.transactionId, outlook: assured() },
		]);
		const timeline = timelineOf(a.statuses);
		const changedAt = timeline.indexOf(`outlook-changed:${update.transactionId}`);
		expect(changedAt, 'after the insert committed').to.be.greaterThan(timeline.indexOf(`committed:${insert.transactionId}`));
		expect(changedAt, 'before the update was sent').to.be.lessThan(timeline.indexOf(`submitting:${update.transactionId}`));
		expect(timeline, 'the update committed').to.include(`committed:${update.transactionId}`);
	});

	it('a false fresh tag: the transaction is reported assured, fails with constraint when a rival takes its key, and is logged and counted as an assured transaction that failed', async () => {
		const { a, b, openGate } = await twoNodes(createNotes);
		a.plugin.offline.enter();
		const insert = await queuedOutlook(a, `insert into Notes (id, body) values ('n9', 'from-a')`);
		expect(insert.outlook).to.deep.equal(assured());
		await b.db.exec(`insert into Notes (id, body) values ('n9', 'from-b')`);

		const lines = await captureTrace(async () => {
			openGate();
			await a.plugin.offline.whenDrained();
		});

		const failed = a.statuses.find((status): status is FailedStatus => status.kind === 'failed' && status.transactionId === insert.transactionId);
		expect(failed?.reason).to.equal('constraint');
		expectAssuredFailures(a.plugin, 1);
		const logged = lines.map(plain).filter(line => line.includes('offline:assured-entry-failed'));
		expect(logged).to.have.length(1);
		expect(logged[0]).to.include(`transaction=${insert.transactionId}`)
			.and.include('reason=constraint')
			.and.include('refusal=TreeKeyTakenError')
			.and.include('table=main.Notes')
			.and.include('key=["n9"]')
			.and.include('causedBy=none');
	});

	it('an assured transaction that fails because the one it depends on was discarded is neither re-judged on the way nor counted', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();
		const insert = await queuedOutlook(node, `insert into Notes (id, body) values ('n4', 'a')`);
		const update = await queuedOutlook(node, `update Notes set body = 'b' where id = 'n4'`);
		expect(update.outlook).to.deep.equal(assured([{ transactionId: insert.transactionId, via: 'guard' }]));

		node.plugin.offline.discard(insert.transactionId);
		await node.plugin.offline.whenDrained();

		const failed = node.statuses.find((status): status is FailedStatus => status.kind === 'failed' && status.transactionId === update.transactionId);
		expect(failed?.reason).to.equal('concurrent-modification');
		expect(failed?.causedBy).to.equal(insert.transactionId);
		expect(node.statuses.filter(status => status.kind === 'outlook-changed'), 'a failure is not a change of outlook').to.deep.equal([]);
		expectAssuredFailures(node.plugin, 0);
	});

	it('an assured transaction whose failure the queue attributes to a nearer failed one it never depended on is not counted when the one it did depend on failed', async () => {
		const node = await oneNode();
		node.plugin.offline.enter();
		const insert = await queuedOutlook(node, `begin; insert into Notes (id, body) values ('n5', 'a'); insert into Notes (id, body) values ('n6', 'a'); commit`);
		const first = await queuedOutlook(node, `update Notes set body = 'b' where id = 'n5'`);
		const second = await queuedOutlook(node, `update Notes set body = 'b' where id = 'n6'`);
		expect(second.outlook, 'depends on the insert alone').to.deep.equal(assured([{ transactionId: insert.transactionId, via: 'guard' }]));

		node.plugin.offline.discard(insert.transactionId);
		await node.plugin.offline.whenDrained();

		const failed = node.statuses.find((status): status is FailedStatus => status.kind === 'failed' && status.transactionId === second.transactionId);
		expect(failed?.reason).to.equal('concurrent-modification');
		expect(failed?.causedBy, 'the nearest failing transaction ahead of it').to.equal(first.transactionId);
		expectAssuredFailures(node.plugin, 0);
	});
});
