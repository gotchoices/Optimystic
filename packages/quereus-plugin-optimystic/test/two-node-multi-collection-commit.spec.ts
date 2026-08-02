/**
 * Two-node, multi-collection LEGACY commit — the shape the sereus
 * `control-db-two-node-convergence` scenario actually drives.
 *
 * `fix/cross-node-convergence-sereus-signature-not-reproducible` refuted the reported
 * cause (a `Collection.updateInternal` that re-reads its own staged header) and showed
 * that a single Tree over two nodes converges on both the mock mesh and real sockets.
 * What none of those tests covered is the plugin's own commit path: one SQL statement
 * dirties the DATA tree, its UNIQUE-index sub-collection AND the plugin-global schema
 * catalog, and `TransactionBridge.commitDirtyTreesLegacy` flushes each with its own
 * independent pend+commit. Sereus's stack lands exactly there, and its three reported
 * stale-revision signatures name exactly those three collection kinds:
 *
 *   optimystic/schema                 at rev 1, requested rev 1
 *   default/Member/index/_uniq_1      at rev 2, requested rev 1
 *   default/CadrePeer                 at rev 3, requested rev 1
 *
 * Two Databases share one 2-node mock mesh (each bound to its own node's transactor),
 * both declare the SAME table, and the second node writes after the first has already
 * advanced every one of those collections. A node whose revision context cannot advance
 * fails here with `SyncRetryExhaustedError: … stale revision: … requested rev 1`.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '@optimystic/db-p2p/testing';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;

const TABLE_URI = 'tree://default/CadrePeer';

const createTableSql = `
	create table CadrePeer (
		Id integer primary key,
		PeerKey text not null unique,
		Label text
	) using optimystic('${TABLE_URI}')
`;

function createDb(transactor: ITransactor): Database {
	const db = new Database();
	const config = {
		default_transactor: 'shared',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	// The factory keys its transactor cache on `${transactor}:${keyNetwork}`, so registering
	// under `shared:test` makes every collection this Database opens ride THIS node's stack.
	plugin.collectionFactory.registerTransactor('shared:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return db;
}

async function collect(db: Database, sql: string): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row as Row);
	}
	return rows;
}

describe('Two-node multi-collection legacy commit (data tree + unique index + schema catalog)', function () {
	this.timeout(120_000);

	let mesh: Mesh;
	let transactors: Map<string, ITransactor>;

	beforeEach(async () => {
		mesh = await createMesh(2, {
			responsibilityK: 2,
			clusterSize: 2,
			superMajorityThreshold: 0.67,
		});
		transactors = buildNetworkTransactors(mesh);
	});

	const transactorFor = (index: number): ITransactor => {
		const peerId = mesh.nodes[index]!.peerId.toString();
		const t = transactors.get(peerId);
		if (!t) throw new Error(`No transactor for peer ${peerId}`);
		return t;
	};

	it('node B writes after node A advanced all three collections', async () => {
		const dbA = createDb(transactorFor(0));
		const dbB = createDb(transactorFor(1));

		await dbA.exec(createTableSql);
		// Three separate transactions → three commits on the data tree AND its unique-index
		// sub-collection, so the cluster sits well ahead of a rev-1 requester.
		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (1, 'key-1', 'a1')`);
		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (2, 'key-2', 'a2')`);
		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (3, 'key-3', 'a3')`);

		// B joins a collection set the cluster has already advanced.
		await dbB.exec(createTableSql);
		await dbB.exec(`insert into CadrePeer (Id, PeerKey, Label) values (10, 'key-10', 'b1')`);

		const onB = await collect(dbB, `select Id, Label from CadrePeer order by Id`);
		expect(onB.map(r => r.Id)).to.deep.equal([1, 2, 3, 10]);

		const onA = await collect(dbA, `select Id, Label from CadrePeer order by Id`);
		expect(onA.map(r => r.Id)).to.deep.equal([1, 2, 3, 10]);
	});

	it('both nodes declare the table before either writes, then both write', async () => {
		// Bootstrap-burst ordering: both nodes invent the data tree, the index tree and the
		// schema catalog before anything is committed, so every collection has two rival
		// creators — the invention race, but three collections wide and through the plugin.
		const dbA = createDb(transactorFor(0));
		const dbB = createDb(transactorFor(1));

		await dbA.exec(createTableSql);
		await dbB.exec(createTableSql);

		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (1, 'key-1', 'a1')`);
		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (2, 'key-2', 'a2')`);
		await dbB.exec(`insert into CadrePeer (Id, PeerKey, Label) values (10, 'key-10', 'b1')`);

		const onA = await collect(dbA, `select Id from CadrePeer order by Id`);
		expect(onA.map(r => r.Id)).to.deep.equal([1, 2, 10]);

		const onB = await collect(dbB, `select Id from CadrePeer order by Id`);
		expect(onB.map(r => r.Id)).to.deep.equal([1, 2, 10]);
	});

	it('a multi-statement transaction on B flushes all dirty trees after A advanced them', async () => {
		// One commit, three trees: `commitDirtyTreesLegacy` sweeps data tree, unique-index
		// sub-collection and (if dirtied) the schema catalog in sequence. A split here
		// surfaces as PartialCommitError rather than a stale-revision exhaustion.
		const dbA = createDb(transactorFor(0));
		const dbB = createDb(transactorFor(1));

		await dbA.exec(createTableSql);
		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (1, 'key-1', 'a1')`);
		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (2, 'key-2', 'a2')`);
		await dbA.exec(`insert into CadrePeer (Id, PeerKey, Label) values (3, 'key-3', 'a3')`);

		await dbB.exec(createTableSql);
		await dbB.exec(`
			begin;
			insert into CadrePeer (Id, PeerKey, Label) values (10, 'key-10', 'b1');
			insert into CadrePeer (Id, PeerKey, Label) values (11, 'key-11', 'b2');
			commit;
		`);

		const onB = await collect(dbB, `select Id from CadrePeer order by Id`);
		expect(onB.map(r => r.Id)).to.deep.equal([1, 2, 3, 10, 11]);
	});
});
