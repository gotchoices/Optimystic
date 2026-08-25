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
import debugFactory from 'debug';
import { format } from 'node:util';
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

/** A collection's id is its URI with the `tree://` scheme stripped (CollectionFactory.parseCollectionId). */
const collectionIdOf = (uri: string): string => uri.replace(/^tree:\/\//, '');
const TABLE_COLLECTION_ID = collectionIdOf(TABLE_URI);
const INDEX_COLLECTION_ID = collectionIdOf(INDEX_URI);

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

/**
 * Run `body` with the plugin's debug namespaces on, returning every line the
 * plugin emitted while it ran.
 *
 * `debug` is an external dependency of this package (tsup leaves `dependencies`
 * unbundled), so the instance imported here is the SAME one `src/logger.ts`
 * builds its loggers from — `enable()` therefore reaches loggers constructed at
 * dist-import time, and replacing `debugFactory.log` intercepts them before they
 * reach stderr. `log` is the fallback sink every instance uses
 * (`self.log || createDebug.log`) and it receives the RAW printf args, so the
 * `%s`/`%d` substitution node's default sink does via `util.format` is redone here.
 */
async function captureTrace(body: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const previousNamespaces = debugFactory.disable();
	const previousLog = debugFactory.log;
	debugFactory.log = (...args: unknown[]) => { lines.push(format(...args)); };
	debugFactory.enable('optimystic:quereus-plugin:*');
	try {
		await body();
	} finally {
		debugFactory.log = previousLog;
		debugFactory.enable(previousNamespaces);
	}
	return lines;
}

/** Strip ANSI colour codes so parsing does not depend on whether stderr is a TTY. */
const plain = (line: string): string => line.replace(new RegExp(String.fromCharCode(27) + '\[[0-9;]*m', 'g'), '');

interface CommitTrace {
	mode: string;
	/** The `count=` field as emitted — asserted against `ids.length` so a truncated list is caught. */
	count: number;
	ids: string[];
	state: Map<string, string>;
}

/** Parse every `commit:collections` line out of a capture. */
function commitTraces(lines: readonly string[]): CommitTrace[] {
	const traces: CommitTrace[] = [];
	for (const raw of lines) {
		const head = /commit:collections mode=(\S+) count=(\d+)(.*)$/.exec(plain(raw));
		if (!head) continue;
		const state = new Map<string, string>();
		// A trailing `+1ms` (or any other non-`id=state` token) is dropped by the shape filter.
		for (const token of head[3]!.trim().split(/\s+/)) {
			const entry = /^(\S+)=(staged|clean|unknown)$/.exec(token);
			if (entry) state.set(entry[1]!, entry[2]!);
		}
		traces.push({ mode: head[1]!, count: Number(head[2]), ids: [...state.keys()], state });
	}
	return traces;
}

interface IndexOpenTrace { table: string; index: string; uri: string; collection: string }

/** Parse every `index:tree-open` line out of a capture. */
function indexOpenTraces(lines: readonly string[]): IndexOpenTrace[] {
	const traces: IndexOpenTrace[] = [];
	for (const raw of lines) {
		const m = /index:tree-open table=(\S+) index=(\S+) uri=(\S+) collection=(\S+)/.exec(plain(raw));
		if (m) traces.push({ table: m[1]!, index: m[2]!, uri: m[3]!, collection: m[4]! });
	}
	return traces;
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
	// ---------------------------------------------------------------------------
	// Trace coverage. Not convergence assertions — these pin the two debug lines a
	// downstream operator reads to answer "did that write carry the index
	// collection, and did both machines mean the same index collection?". The
	// lines are only worth anything on the run that needs them, so a change that
	// silently stops emitting them has to fail here.
	// ---------------------------------------------------------------------------

	it('commit trace names the index collection alongside the table for an indexed insert', async () => {
		const { db: dbA } = createDb(transactorFor(0));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);

		const lines = await captureTrace(async () => {
			await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);
		});

		const traces = commitTraces(lines);
		expect(traces.length, 'the insert emitted at least one commit:collections line').to.be.greaterThan(0);

		const carrying = traces.find(t => t.ids.includes(TABLE_COLLECTION_ID));
		expect(carrying, `a commit carried the table collection '${TABLE_COLLECTION_ID}'; saw ${JSON.stringify(traces.map(t => t.ids))}`)
			.to.not.equal(undefined);
		expect(carrying!.ids, 'the SAME commit carried the index collection').to.include(INDEX_COLLECTION_ID);
		expect(carrying!.state.get(INDEX_COLLECTION_ID), 'the index collection had staged changes to push')
			.to.equal('staged');
		expect(carrying!.count, 'count= agrees with the ids actually listed').to.equal(carrying!.ids.length);
		expect(carrying!.mode, 'this harness wires no coordinator, so the commit is the legacy sweep')
			.to.equal('legacy');
	});

	it('both nodes resolve the same index collection id for the same logical index', async () => {
		const { db: dbA } = createDb(transactorFor(0));
		const { db: dbB } = createDb(transactorFor(1));

		const linesA = await captureTrace(async () => {
			await dbA.exec(createTableSql);
			await dbA.exec(createIndexSql);
			await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);
		});
		const linesB = await captureTrace(async () => {
			await dbB.exec(createTableSql);
			await dbB.exec(createIndexSql);
			await dbB.exec(`insert into FormationUsage (Id, Token) values (2, 'tok-b')`);
		});

		const opensA = indexOpenTraces(linesA);
		const opensB = indexOpenTraces(linesB);
		expect(opensA.length, 'node A emitted at least one index:tree-open line').to.be.greaterThan(0);
		expect(opensB.length, 'node B emitted at least one index:tree-open line').to.be.greaterThan(0);

		// Every open on a node must name the one index collection — a node that
		// resolved two different ids for one logical index is itself the bug.
		expect([...new Set(opensA.map(o => o.collection))], 'index collection ids node A resolved')
			.to.deep.equal([INDEX_COLLECTION_ID]);
		expect([...new Set(opensB.map(o => o.collection))], 'index collection ids node B resolved')
			.to.deep.equal([INDEX_COLLECTION_ID]);
		expect(opensA[0]!.uri, 'the URI the id was derived from').to.equal(INDEX_URI);
		expect(opensA[0]!.table).to.equal('FormationUsage');
		expect(opensA[0]!.index).to.equal('formation_usage_by_token');
	});
});
