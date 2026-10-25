/**
 * Tickets: a-single-collection-write-defers-a-two-member-pends-delivery (GitHub #29),
 * a-transaction-pends-and-commits-its-collections-together (GitHub #42).
 *
 * How many cluster requests one SQL insert costs the other machine of a two-machine group. A write is a
 * pend (reserve) and a commit, each one consensus record: a promise round and a decision. The coordinating
 * machine holds the pend's decision back and sends it inside the commit's first request, and in a group
 * of two the commit needs no commit round, so a write costs three: the pend's promise round, the commit's
 * promise round carrying the pend's decision, and the commit's decision.
 *
 * Three holds however many collections the insert writes — a table and each of its indexes are separate
 * collections — because a transaction sends all of them in one pend record and one commit record. It holds
 * on every commit path an insert can take: the single-tree `sync()` of legacy mode, legacy mode's batched
 * commit of several trees, and a `TransactionCoordinator` commit in session mode. Before #42 each
 * collection was its own pair of records, at four requests per collection (24 for five indexes).
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
 * initialized the table and created its collections. `T` has `indexes` secondary indexes, one per
 * column besides the key. Node 0's transactor coordinates its own writes.
 */
async function requestsForOneInsert(mode: Mode, uri: string, indexes: number): Promise<number> {
	const { mesh, transactorFor } = await startMockMesh(2);
	const node = createMeshDbNode(transactorFor(0));
	const columns = Array.from({ length: Math.max(indexes, 1) }, (_, i) => `c${i}`);
	await node.db.exec(`create table T (id integer primary key, ${columns.map(c => `${c} text not null`).join(', ')}) using optimystic('${uri}')`);
	for (const column of columns.slice(0, indexes)) {
		await node.db.exec(`create index T_${column} on T (${column})`);
	}
	if (mode === 'session') await enableSessionMode(node, transactorFor(0));
	const insert = (id: number) => `insert into T (id, ${columns.join(', ')}) values (${id}, ${columns.map(c => `'${c}-${id}'`).join(', ')})`;
	await node.db.exec(insert(1));

	const otherId = mesh.nodes[1]!.peerId.toString();
	let requests = 0;
	mesh.failures.onClusterDelivery = (target) => { if (target === otherId) requests++; };
	await node.db.exec(insert(2));
	mesh.failures.onClusterDelivery = undefined;
	return requests;
}

describe('one SQL insert on a two-node mesh: cluster requests to the other node', function () {
	this.timeout(60_000);

	it('legacy mode: an insert into a table with no index costs three', async () => {
		expect(await requestsForOneInsert('legacy', 'tree://request-count/legacy-plain', 0)).to.equal(3);
	});

	it('session mode: an insert into a table with no index costs three', async () => {
		expect(await requestsForOneInsert('session', 'tree://request-count/session-plain', 0)).to.equal(3);
	});

	it('session mode: an insert into a table with an index costs three, its collections travelling together', async () => {
		expect(await requestsForOneInsert('session', 'tree://request-count/session-indexed', 1)).to.equal(3);
	});

	it('legacy mode: an insert into a table with five indexes costs three', async () => {
		expect(await requestsForOneInsert('legacy', 'tree://request-count/legacy-five-indexes', 5)).to.equal(3);
	});
});
