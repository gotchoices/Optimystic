/**
 * A table first written while offline joins the copy another machine created meanwhile
 * (docs/offline-sync.md §Invented collections). Node A — the joiner — declares a table it has never
 * read, so its tree invents a header that was never committed; it goes offline and inserts. Node B —
 * the founder — creates the same table and commits a row. When A's queued transaction drains, its
 * opening refresh finds B's header, adopts B's collection and replays the queued row onto it: one
 * header, one log, both rows. A row that collides with the founder's is refused by that replay,
 * before anything of it is sent.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`), both responsible for every block. Node B
 * is made unreachable for cluster rounds addressed to it (`mesh.failures.failingPeers`): A's commits
 * then fall short of the cohort, while B's own commits still gather A's vote and land on both nodes.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import { ConstraintError } from '@quereus/quereus';
import { waitFor } from '@optimystic/db-core/test';
import type { Mesh } from '@optimystic/db-p2p/testing';
import type { QueuedTransactionStatus } from '../dist/index.js';
import { createMeshDbNode, openFreshTree, startMockMesh, type MeshDbNode, type Plugin } from './mesh-node-harness.js';
import { queryAll } from './query-helpers.js';

type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

const NOTES_URI = 'tree://offline-joiner/notes';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;

interface TwoNodes {
	mesh: Mesh;
	joiner: MeshDbNode;
	founder: MeshDbNode;
	statuses: QueuedTransactionStatus[];
}

/** The joiner declares `Notes` (its catalog record lands; its data collection stays uncommitted), goes
 * offline with node B cut off, and queues `insert`; the founder then declares the table and commits
 * `founderInsert`. */
async function joinerQueuesWhileFounderWrites(insert: string, founderInsert: string): Promise<TwoNodes> {
	const { mesh, transactorFor } = await startMockMesh(2);
	const joiner = createMeshDbNode(transactorFor(0), { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>);
	const founder = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	joiner.plugin.offline.onStatus(status => { statuses.push(status); });

	await joiner.db.exec(createNotes);
	mesh.failures.failingPeers = new Set([mesh.nodes[1]!.peerId.toString()]);
	joiner.plugin.offline.enter();
	await joiner.db.exec(insert);
	await waitFor(() => statuses.some(s => s.kind === 'queued' && s.waitingFor === 'cohort'),
		{ description: 'the joiner\'s transaction waiting for the cohort' });

	await founder.db.exec(createNotes);
	await founder.db.exec(founderInsert);
	return { mesh, joiner, founder, statuses };
}

/** The log entries a fresh handle on `Notes` walks from node `plugin`'s storage, one per commit. */
async function committedLogEntries(plugin: Plugin): Promise<number> {
	const tree = await openFreshTree(plugin, NOTES_URI);
	let entries = 0;
	for await (const _action of tree.getCollection().selectLog()) entries++;
	return entries;
}

describe('Offline mode: a table first written offline joins the copy another machine created', function () {
	this.timeout(60_000);

	it('the joiner\'s queued row lands in the founder\'s collection: both rows on both nodes, one log of two entries', async () => {
		const { mesh, joiner, founder, statuses } = await joinerQueuesWhileFounderWrites(
			`insert into Notes (id, body) values (1, 'joiner')`,
			`insert into Notes (id, body) values (2, 'founder')`);

		mesh.failures.failingPeers = undefined;
		await joiner.plugin.offline.whenDrained();
		expect(statuses.at(-1)?.kind, 'the joiner\'s transaction committed').to.equal('committed');

		const both = [{ id: 1, body: 'joiner' }, { id: 2, body: 'founder' }];
		expect(await queryAll(founder.db, 'select id, body from Notes order by id'), 'the founder reads both rows').to.deep.equal(both);
		expect(await queryAll(joiner.db, 'select id, body from Notes order by id'), 'and so does the joiner').to.deep.equal(both);
		expect(await committedLogEntries(founder.plugin), 'one log: the founder\'s commit, then the joiner\'s').to.equal(2);
	});

	it('a joiner\'s row at the founder\'s key fails with constraint, decided by the refresh while the cohort is still cut off, and leaves the founder\'s row', async () => {
		const { joiner, founder, statuses } = await joinerQueuesWhileFounderWrites(
			`insert into Notes (id, body) values (1, 'joiner')`,
			`insert into Notes (id, body) values (1, 'founder')`);

		await waitFor(() => statuses.some(s => s.kind === 'failed'), { description: 'the joiner\'s transaction failed' });
		const failed = statuses.find((s): s is FailedStatus => s.kind === 'failed')!;
		expect(failed.reason).to.equal('constraint');
		expect(failed.error).to.be.instanceOf(ConstraintError);
		expect(await queryAll(joiner.db, 'select id, body from Notes'), 'the joiner reads the founder\'s row').to.deep.equal([{ id: 1, body: 'founder' }]);
		expect(await queryAll(founder.db, 'select id, body from Notes'), 'and the founder its own').to.deep.equal([{ id: 1, body: 'founder' }]);
		expect(await committedLogEntries(founder.plugin), 'nothing of the joiner\'s was committed').to.equal(1);
	});
});
