/**
 * The outlook of a queued transaction (docs/offline-sync.md §Predicting whether an entry will commit),
 * judged from the checks its staged actions carry and the queue ahead of it: delivered on the `queued`
 * status before `commit` resolves, and answered for an open transaction by `CommitOutlook()`.
 *
 * One node on the in-process mesh, with a reachability gate that never opens, so every offline commit
 * stays queued and the queue ahead of each case is exactly what it built.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import type { CommitOutlook, QueuedTransactionStatus } from '../dist/index.js';
import { createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { queryAll } from './query-helpers.js';

type QueuedStatus = Extract<QueuedTransactionStatus, { kind: 'queued' }>;

const offlineConfig = { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>;

/** Fresh primary key: the application generates `id` unique per write. */
const createNotes = `create table Notes (id text primary key with tags ("optimystic.fresh" = true), body text) using optimystic('tree://outlook/notes')`;
/** Natural primary key: two machines can pick the same name. */
const createUsers = `create table Users (name text primary key, bio text) using optimystic('tree://outlook/users')`;
/** Fresh primary key, natural UNIQUE columns of two affinities. */
const createAccounts = `create table Accounts (id text primary key with tags ("optimystic.fresh" = true), email text unique, badge integer unique) using optimystic('tree://outlook/accounts')`;

interface Node extends MeshDbNode {
	/** The `queued` statuses the plugin reported, in order. */
	queued: QueuedStatus[];
}

async function oneNode(): Promise<Node> {
	const { transactorFor } = await startMockMesh(1);
	const node = createMeshDbNode(transactorFor(0), offlineConfig);
	node.plugin.collectionFactory.registerCohortReachability('shared:test', { reachable: () => Promise.resolve(false) });
	const queued: QueuedStatus[] = [];
	node.plugin.offline.onStatus(status => { if (status.kind === 'queued') queued.push(status); });
	for (const sql of [createNotes, createUsers, createAccounts]) await node.db.exec(sql);
	return { ...node, queued };
}

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
});
