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
import { captureTrace, collectionIdOf, commitTraces, indexOpenTraces, indexSeekTraces } from './trace-helpers.js';
import { expectIndexAgreesWithScan } from './query-helpers.js';

type Row = Record<string, SqlValue>;
type Plugin = ReturnType<typeof register>;

const TABLE_URI = 'tree://default/FormationUsage';
const INDEX_URI = `${TABLE_URI}/index/formation_usage_by_token`;

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
		// The trailing `revs=` field is the discriminator two nodes' lines are compared on
		// — the id cannot differ (it IS the header block id), so a line without a revision
		// per collection cannot answer the question it exists for.
		expect(carrying!.rev.get(TABLE_COLLECTION_ID), 'the table collection named a revision')
			.to.match(/^(\d+|none)$/);
		expect(carrying!.rev.get(INDEX_COLLECTION_ID), 'the index collection named a revision')
			.to.match(/^(\d+|none)$/);
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

	it('index seek trace names the revision each side of the read descended', async () => {
		const { db: dbA } = createDb(transactorFor(0));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);

		const lines = await captureTrace(async () => {
			const rows = await collect(dbA, `select Id from FormationUsage where Token = 'tok-a'`);
			expect(rows.map(r => r.Id), 'the seek this trace describes actually found the row')
				.to.deep.equal([1]);
		});

		const seeks = indexSeekTraces(lines);
		expect(seeks.length, 'the index-routed select emitted at least one index:seek line')
			.to.be.greaterThan(0);
		const seek = seeks[0]!;
		expect(seek.table).to.equal('FormationUsage');
		expect(seek.index).to.equal('formation_usage_by_token');
		// Joins against commit:collections and index:tree-open, which print the same id.
		expect(seek.collection, 'the seek names the index collection by the id the other two lines print')
			.to.equal(INDEX_COLLECTION_ID);
		expect(seek.main, 'and names the main table collection, so one line covers both trees')
			.to.equal(TABLE_COLLECTION_ID);
		expect(seek.arm, 'a plain select is a live read, so it refreshed both trees first')
			.to.equal('live');
		// A framed key was actually built — `unset` would mean the scan returned before
		// framing one, and an equality seek must never look like the whole-index prefix.
		expect(seek.seek, 'the seek names the framed key it bracketed on').to.not.equal('unset');
		expect(seek.seek, 'an equality seek is not the whole-index prefix').to.not.equal('');
		// This is the whole point of the line: a healthy run states BOTH revisions, so a
		// failing run's gap between them is readable as a number rather than inferred.
		expect(seek.rev, "the index collection's revision").to.match(/^(\d+|none)$/);
		expect(seek.mainRev, "the main collection's revision").to.match(/^(\d+|none)$/);
		expect(seek.matched, 'one index entry matched the seek key').to.equal(1);
	});

	it('index seek trace names both collections, the framed key, and a count that matches the rows', async () => {
		const { db: dbA } = createDb(transactorFor(0));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (2, 'tok-a')`);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (3, 'tok-b')`);

		let rows: Row[] = [];
		const lines = await captureTrace(async () => {
			rows = await collect(dbA, `select Id from FormationUsage where Token = 'tok-a' order by Id`);
		});
		expect(rows.map(r => r.Id), 'the seek this trace describes found both tok-a rows')
			.to.deep.equal([1, 2]);

		const seeks = indexSeekTraces(lines);
		expect(seeks.length, 'the index-routed select emitted at least one index:seek line')
			.to.be.greaterThan(0);
		const seek = seeks[0]!;

		// Both collections named on ONE line: the failing production shape is "the index
		// tree is behind the table tree", which is unreadable if the line names only one.
		expect(seek.collection, 'the index collection id').to.equal(INDEX_COLLECTION_ID);
		expect(seek.main, 'the main table collection id').to.equal(TABLE_COLLECTION_ID);

		// The framed key is what two nodes compare to rule out "the framing diverged".
		// Non-empty because this seek is constrained; the escaping must leave it a single
		// whitespace-free token or the line stops parsing at all.
		expect(seek.seek, 'the framed seek key was recorded').to.not.equal('unset');
		expect(seek.seek, 'a constrained seek frames a non-empty key').to.not.equal('');
		expect(seek.seek, 'the escaped key is one whitespace-free token').to.match(/^\S+$/);

		// The count is DERIVED, not hard-coded: three rows exist, two match, so a line
		// reporting the whole index (or nothing) fails here rather than looking plausible.
		expect(seek.matched, 'index entries matched equals the rows the seek returned')
			.to.equal(rows.length);
	});

	it('two converged nodes report the same index collection revision and the same framed key', async () => {
		const { db: dbA } = createDb(transactorFor(0));
		const { db: dbB } = createDb(transactorFor(1));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);
		await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);

		await dbB.exec(createTableSql);
		await dbB.exec(createIndexSql);

		// Both arms are LIVE reads, so each refreshed its own trees immediately before
		// descending — the revisions below are what each node had actually adopted.
		let rowsA: Row[] = [];
		const linesA = await captureTrace(async () => {
			rowsA = await collect(dbA, `select Id from FormationUsage where Token = 'tok-a'`);
		});
		let rowsB: Row[] = [];
		const linesB = await captureTrace(async () => {
			rowsB = await collect(dbB, `select Id from FormationUsage where Token = 'tok-a'`);
		});

		expect(rowsA.map(r => r.Id), "the writer's own seek finds the row").to.deep.equal([1]);
		expect(rowsB.map(r => r.Id), "the sibling's seek finds the writer's row").to.deep.equal([1]);

		const seekA = indexSeekTraces(linesA).find(t => t.collection === INDEX_COLLECTION_ID);
		const seekB = indexSeekTraces(linesB).find(t => t.collection === INDEX_COLLECTION_ID);
		expect(seekA, 'node A emitted an index:seek line for the index collection').to.not.equal(undefined);
		expect(seekB, 'node B emitted an index:seek line for the index collection').to.not.equal(undefined);

		// THE pin this line exists for. A run where the sibling cannot find the row is
		// supposed to be readable as either "forked/stale lineage" (revisions differ) or
		// "converged but empty" (revisions equal, matched=0). A converged run must
		// therefore show equal revisions AND a matching count — if a future change makes
		// the two nodes' revisions disagree on a run that CONVERGES, the diagnostic has
		// started lying and every reading taken from it downstream is wrong.
		expect(seekA!.rev, "node A's index collection revision is a real revision").to.match(/^\d+$/);
		expect(seekB!.rev, "both nodes descended the same index collection revision")
			.to.equal(seekA!.rev);
		expect(seekB!.seek, 'both nodes framed the same seek key for the same SQL value')
			.to.equal(seekA!.seek);
		expect(seekB!.matched, "the sibling's seek matched the row it returned")
			.to.equal(rowsB.length);
		expect(seekA!.arm, 'a plain select is a live read').to.equal('live');
		expect(seekB!.arm, 'a plain select is a live read').to.equal('live');
	});

	// The two lines are read TOGETHER, and the only thing that makes that legal is knowing
	// how the write-side number relates to the read-side one. `commit:collections` is
	// emitted before the flush, so it prints the revision the commit SUPERSEDES; the commit
	// lands at that plus one (`none` counting as 0). An operator who reads the printed
	// number as the landing revision inverts the decision rule in `docs/debugging.md`:
	// a converged reader looks one revision stale, and a reader that IS one revision stale
	// looks converged and gets diagnosed as "the index action did not survive commit".
	// Pinned here so the +1 cannot silently become +0 or +2 under a commit-path change.
	it("the revision a commit lands at is the commit line's revision plus one", async () => {
		const { db: dbA } = createDb(transactorFor(0));

		await dbA.exec(createTableSql);
		await dbA.exec(createIndexSql);

		// Capture the INSERT's own commit line — the pre-flush revision of each collection.
		const commitLines = await captureTrace(async () => {
			await dbA.exec(`insert into FormationUsage (Id, Token) values (1, 'tok-a')`);
		});
		const carrying = commitTraces(commitLines).find(t => t.state.get(INDEX_COLLECTION_ID) === 'staged');
		expect(carrying, 'the insert emitted a commit line carrying the index collection')
			.to.not.equal(undefined);

		// `none` means "no committed revision yet", which the next commit turns into 1.
		const landedAt = (printed: string | undefined): number => {
			expect(printed, 'the commit line named a revision for this collection').to.match(/^(\d+|none)$/);
			return (printed === 'none' ? 0 : Number(printed)) + 1;
		};
		const indexLanded = landedAt(carrying!.rev.get(INDEX_COLLECTION_ID));
		const tableLanded = landedAt(carrying!.rev.get(TABLE_COLLECTION_ID));

		// Now read the row back and compare what the seek descended against those.
		let rows: Row[] = [];
		const seekLines = await captureTrace(async () => {
			rows = await collect(dbA, `select Id from FormationUsage where Token = 'tok-a'`);
		});
		expect(rows.map(r => r.Id), 'the read this trace describes found the committed row')
			.to.deep.equal([1]);

		const seek = indexSeekTraces(seekLines).find(t => t.collection === INDEX_COLLECTION_ID);
		expect(seek, 'the read emitted an index:seek line for the index collection').to.not.equal(undefined);
		expect(Number(seek!.rev), 'the index collection now reads at the revision the insert landed at')
			.to.equal(indexLanded);
		expect(Number(seek!.mainRev), 'and the table collection likewise')
			.to.equal(tableLanded);
	});
});
