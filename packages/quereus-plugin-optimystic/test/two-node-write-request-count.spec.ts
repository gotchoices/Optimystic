/**
 * Ticket: a-single-collection-write-defers-a-two-member-pends-delivery (GitHub #29).
 *
 * How many cluster requests one SQL insert costs the other machine of a two-machine group. A write is a
 * pend (reserve) and a commit, each a promise round and a decision. An insert that writes one collection
 * — a table with no index — lets the coordinating machine hold the pend's decision back and send it
 * inside the commit's first request, so it costs three. That holds on both commit paths a plain insert
 * can take: the single-tree `sync()` of legacy mode and a one-collection `TransactionCoordinator`
 * commit in session mode. An insert that writes several collections — a table and its index — keeps four
 * per collection, because a late refusal of one collection's pend could surface after another's commit
 * landed.
 */
import { expect } from 'chai';
import { TransactionCoordinator } from '@optimystic/db-core';
import { QuereusEngine } from '../dist/index.js';
import { createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';

type Mode = 'legacy' | 'session';

/** Commit through a `TransactionCoordinator` over the bridge's live collection registry, as a host wires session mode. */
async function enableSessionMode(node: MeshDbNode, coordinatorTransactor: ConstructorParameters<typeof TransactionCoordinator>[0]): Promise<void> {
	const coordinator = new TransactionCoordinator(coordinatorTransactor, node.plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(node.db, coordinator);
	// Warmed outside any statement: the provider runs while a statement holds the exec lock.
	await engine.getSchemaHash();
	node.plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
}

/**
 * The cluster requests node 1 receives while node 0 runs one insert into `T`, after a first insert has
 * initialized the table and created its collections. Node 0's transactor coordinates its own writes.
 */
async function requestsForOneInsert(mode: Mode, uri: string, withIndex: boolean): Promise<number> {
	const { mesh, transactorFor } = await startMockMesh(2);
	const node = createMeshDbNode(transactorFor(0));
	await node.db.exec(`create table T (id integer primary key, g text not null) using optimystic('${uri}')`);
	if (withIndex) await node.db.exec('create index T_g on T (g)');
	if (mode === 'session') await enableSessionMode(node, transactorFor(0));
	await node.db.exec(`insert into T (id, g) values (1, 'a')`);

	const otherId = mesh.nodes[1]!.peerId.toString();
	let requests = 0;
	mesh.failures.onClusterDelivery = (target) => { if (target === otherId) requests++; };
	await node.db.exec(`insert into T (id, g) values (2, 'b')`);
	mesh.failures.onClusterDelivery = undefined;
	return requests;
}

describe('one SQL insert on a two-node mesh: cluster requests to the other node', function () {
	this.timeout(60_000);

	it('legacy mode: an insert into a table with no index costs three', async () => {
		expect(await requestsForOneInsert('legacy', 'tree://request-count/legacy-plain', false)).to.equal(3);
	});

	it('session mode: an insert into a table with no index costs three', async () => {
		expect(await requestsForOneInsert('session', 'tree://request-count/session-plain', false)).to.equal(3);
	});

	it('session mode: an insert into a table with an index costs four per collection it writes', async () => {
		const collections = 2;
		expect(await requestsForOneInsert('session', 'tree://request-count/session-indexed', true)).to.equal(4 * collections);
	});
});
