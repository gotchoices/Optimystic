/**
 * Two-node secondary-index convergence over the in-process mock mesh — the
 * regression coverage half of ticket
 * `index-maintenance-must-track-the-declared-index-set` (Phase 1).
 *
 * The originating production report
 * (`fix/secondary-index-update-never-reaches-the-sibling`) was a row that
 * replicated fine while every index-driven lookup for it came back empty on
 * both the writer and its sibling. The investigation could not reproduce that
 * on the mock mesh — every two-node shape converged — so these specs land as
 * standing regression cover: if a change to index maintenance, the legacy
 * commit sweep, or addIndex's dedupe ever re-opens the gap, the committed
 * entry-count assertions here (taken through FRESH trees, not the vtabs'
 * trackers) catch it.
 *
 * Harness mirrors two-node-multi-collection-commit.spec.ts: two Databases,
 * each bound to its own node's transactor over one 2-node mesh.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import type { ITransactor } from '@optimystic/db-core';
import { KeyRange } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactors, type Mesh } from '@optimystic/db-p2p/testing';
import register from '../dist/plugin.js';
import { expectIndexAgreesWithScan } from './query-helpers.js';

type Row = Record<string, SqlValue>;
type Plugin = ReturnType<typeof register>;

const TABLE_URI = 'tree://default/FormationUsage';
const INDEX_URI = `${TABLE_URI}/index/formation_usage_by_token`;

const createTableSql = `
	create table FormationUsage (
		Id integer primary key,
		Token text
	) using optimystic('${TABLE_URI}')
`;
const createIndexSql = `create index formation_usage_by_token on FormationUsage(Token)`;

function createDb(transactor: ITransactor): { db: Database; plugin: Plugin } {
	const db = new Database();
	const config = {
		default_transactor: 'shared',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	plugin.collectionFactory.registerTransactor('shared:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

async function collect(db: Database, sql: string): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row as Row);
	}
	return rows;
}

/** Count committed entries at `collectionUri` through a FRESH Tree on this
 * node's transactor — what consensus persisted, not what a vtab staged. */
async function countTreeEntries(plugin: Plugin, collectionUri: string): Promise<number> {
	const tree = await plugin.collectionFactory.createOrGetCollection({
		collectionUri,
		transactor: 'shared',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
	});
	await tree.update();
	let n = 0;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) n++;
	}
	return n;
}

describe('Two-node secondary-index convergence (write on one node, index-seek on the other)', function () {
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

	it('A declares and inserts; B re-declares and index-seeks A\'s rows', async () => {
		const { db: dbA, plugin: pluginA } = createDb(transactorFor(0));
		const { db: dbB, plugin: pluginB } = createDb(transactorFor(1));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (2, 'tok-b')`);

		// B joins storage the cluster already advanced: its vtab initializes from
		// the persisted schema (which carries the index) and its CREATE INDEX takes
		// addIndex's already-persisted early return.
		await dbB.exec(createTableSql);
		await dbB.exec(createIndexSql);

		const onB = await collect(dbB, `select Id from FormationUsage where Token = 'tok-b'`);
		expect(onB.map(r => r.Id), "B's index seek finds A's row").to.deep.equal([2]);

		// B writes through the same (re-declared) index; both nodes must see it.
		await dbB.exec(`insert into FormationUsage (Id, Token) values (10, 'tok-b')`);
		const onA = await collect(dbA, `select Id from FormationUsage where Token = 'tok-b' order by Id`);
		expect(onA.map(r => r.Id), "A's index seek finds both rows").to.deep.equal([2, 10]);

		// The committed index tree itself holds one entry per row, from both
		// nodes' viewpoints — the assertion that catches a silent write-side skip
		// even when query results happen to look right.
		expect(await countTreeEntries(pluginA, INDEX_URI), 'index entries seen from node A').to.equal(3);
		expect(await countTreeEntries(pluginB, INDEX_URI), 'index entries seen from node B').to.equal(3);

		// Generalized close-out: for EVERY Token value present, the index-routed seek must
		// return exactly the full scan's rows — on both nodes.
		await expectIndexAgreesWithScan(dbA, 'FormationUsage', 'Token');
		await expectIndexAgreesWithScan(dbB, 'FormationUsage', 'Token');
	});

	it('both nodes declare table + index before either writes, then both write and both index-seek', async () => {
		const { db: dbA, plugin: pluginA } = createDb(transactorFor(0));
		const { db: dbB, plugin: pluginB } = createDb(transactorFor(1));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);
		await dbB.exec(createTableSql);
		await dbB.exec(createIndexSql);

		await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (2, 'tok-b')`);
		await dbB.exec(`insert into FormationUsage (Id, Token) values (10, 'tok-a')`);

		const aOnA = await collect(dbA, `select Id from FormationUsage where Token = 'tok-a' order by Id`);
		expect(aOnA.map(r => r.Id), "A's seek sees both writers' rows").to.deep.equal([1, 10]);
		const aOnB = await collect(dbB, `select Id from FormationUsage where Token = 'tok-a' order by Id`);
		expect(aOnB.map(r => r.Id), "B's seek sees both writers' rows").to.deep.equal([1, 10]);
		const bOnB = await collect(dbB, `select Id from FormationUsage where Token = 'tok-b'`);
		expect(bOnB.map(r => r.Id)).to.deep.equal([2]);

		expect(await countTreeEntries(pluginA, INDEX_URI), 'index entries seen from node A').to.equal(3);
		expect(await countTreeEntries(pluginB, INDEX_URI), 'index entries seen from node B').to.equal(3);

		await expectIndexAgreesWithScan(dbA, 'FormationUsage', 'Token');
		await expectIndexAgreesWithScan(dbB, 'FormationUsage', 'Token');
	});
});
