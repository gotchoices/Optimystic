/**
 * Read-path pull mechanism (ticket `optimystic-vtab-count-read-no-network-pull`).
 *
 * The invariant under test: EVERY read served by the Optimystic vtab first
 * reconciles to the latest committed network state by calling
 * `collection.update()` (a network pull) before serving rows. The three vtab
 * read methods — executeTableScan / executePointLookup / executeIndexScan — each
 * `await this.collection.update()` first, so the property holds for ordinary row
 * reads. The fix ticket's hypothesis (H1) is that `select count(*)` is answered
 * by Quereus WITHOUT opening a cursor on the vtab (`query()` is never invoked),
 * so no pull happens and a count-only consumer never observes a peer's appends.
 *
 * This suite is harness-independent: a SINGLE node is enough to prove the
 * *mechanism* (does a given read shape reach `query()` → `update()`), which is
 * the crux. It does not need two peers — convergence is a downstream consequence
 * of the pull firing.
 *
 * Strategy: spy on `OptimysticVirtualTable.prototype.{query,executeTableScan,
 * executePointLookup,executeIndexScan}` and on `Tree.prototype.update` (the
 * network pull). Run each read shape and compare how many times the vtab read
 * path / pull was invoked. A `count(*)` that pulls 0 times while `select Id`
 * pulls is the gap.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import { OptimysticVirtualTable } from '../dist/index.js';
import { Tree } from '@optimystic/db-core';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

interface ReadProbe {
	query: number;
	tableScan: number;
	pointLookup: number;
	indexScan: number;
	/** `Tree.update()` calls — the network pull. Counts ALL trees (main + index +
	 * schema), so use it for relative comparison after reset(), not as an absolute. */
	treeUpdate: number;
	/** Per-query() filterInfo capture so we can see the plan Quereus emitted. */
	plans: Array<{ idxNum: number; idxStr: string | null; argc: number }>;
	reset(): void;
	restore(): void;
}

/** Monkeypatch the shared vtab + Tree prototypes to count read-path invocations.
 * The dist re-exports both classes from one shared chunk, so the prototype we
 * patch is exactly the one the registered plugin instantiates. */
function installReadProbe(): ReadProbe {
	const proto = OptimysticVirtualTable.prototype as any;
	const treeProto = Tree.prototype as any;
	const orig = {
		query: proto.query,
		executeTableScan: proto.executeTableScan,
		executePointLookup: proto.executePointLookup,
		executeIndexScan: proto.executeIndexScan,
		update: treeProto.update,
	};

	const probe: ReadProbe = {
		query: 0,
		tableScan: 0,
		pointLookup: 0,
		indexScan: 0,
		treeUpdate: 0,
		plans: [],
		reset() {
			this.query = 0;
			this.tableScan = 0;
			this.pointLookup = 0;
			this.indexScan = 0;
			this.treeUpdate = 0;
			this.plans = [];
		},
		restore() {
			proto.query = orig.query;
			proto.executeTableScan = orig.executeTableScan;
			proto.executePointLookup = orig.executePointLookup;
			proto.executeIndexScan = orig.executeIndexScan;
			treeProto.update = orig.update;
		},
	};

	proto.query = async function* (this: any, filterInfo: any) {
		probe.query++;
		probe.plans.push({
			idxNum: filterInfo?.idxNum,
			idxStr: filterInfo?.idxStr ?? null,
			argc: filterInfo?.args?.length ?? 0,
		});
		yield* orig.query.call(this, filterInfo);
	};
	proto.executeTableScan = async function* (this: any, ...args: any[]) {
		probe.tableScan++;
		yield* orig.executeTableScan.apply(this, args);
	};
	proto.executePointLookup = async function* (this: any, ...args: any[]) {
		probe.pointLookup++;
		yield* orig.executePointLookup.apply(this, args);
	};
	proto.executeIndexScan = async function* (this: any, ...args: any[]) {
		probe.indexScan++;
		yield* orig.executeIndexScan.apply(this, args);
	};
	treeProto.update = async function (this: any, ...args: any[]) {
		probe.treeUpdate++;
		return orig.update.apply(this, args);
	};

	return probe;
}

function createDb(dir: string): { db: Database; plugin: ReturnType<typeof register> } {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => new FileRawStorage(dir),
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

async function evalCount(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		const values = Object.values(row as Record<string, SqlValue>);
		return Number(values[0]);
	}
	throw new Error('count query returned no rows');
}

async function drain(db: Database, sql: string): Promise<number> {
	let n = 0;
	for await (const _row of db.eval(sql)) n++;
	return n;
}

describe('Read-path pull mechanism (single node, harness-independent)', function () {
	this.timeout(20000);

	let dir: string;
	let probe: ReadProbe;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-read-pull', randomUUID());
		await fs.mkdir(dir, { recursive: true });
		probe = installReadProbe();
	});

	afterEach(async () => {
		probe.restore();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('compares read-path invocation across count(*) / full-scan / point-lookup', async () => {
		const uri = 'tree://read-pull/probe';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
			for (let i = 1; i <= 5; i++) {
				await db.exec(`insert into T (id, v) values (${i}, 'v${i}')`);
			}

			// --- count(*) ---
			probe.reset();
			const c = await evalCount(db, 'select count(*) as c from T');
			const countSnap = { ...probe, plans: [...probe.plans] };
			expect(c, 'count returns all rows').to.equal(5);

			// --- full scan (select id) ---
			probe.reset();
			const scanned = await drain(db, 'select id from T');
			const scanSnap = { ...probe, plans: [...probe.plans] };
			expect(scanned).to.equal(5);

			// --- point lookup ---
			probe.reset();
			const pointRows = await drain(db, 'select v from T where id = 3');
			const pointSnap = { ...probe, plans: [...probe.plans] };
			expect(pointRows).to.equal(1);

			// Surface the measured behavior so the implement-stage agent can read it
			// straight from the test output (min reporter still prints console logs).
			// eslint-disable-next-line no-console
			console.log('[read-pull] count(*) :', JSON.stringify(countSnap));
			// eslint-disable-next-line no-console
			console.log('[read-pull] scan     :', JSON.stringify(scanSnap));
			// eslint-disable-next-line no-console
			console.log('[read-pull] point    :', JSON.stringify(pointSnap));

			// Baseline expectations that must hold regardless of the count(*) finding:
			expect(scanSnap.query, 'select id reaches query()').to.be.greaterThan(0);
			expect(scanSnap.tableScan, 'select id runs a table scan').to.be.greaterThan(0);
			expect(scanSnap.treeUpdate, 'select id pulls from network').to.be.greaterThan(0);

			expect(pointSnap.query, 'point lookup reaches query()').to.be.greaterThan(0);
			expect(pointSnap.treeUpdate, 'point lookup pulls from network').to.be.greaterThan(0);

			// THE invariant the ticket asserts: a count read must reconcile to the
			// latest committed network state, exactly like every other read.
			expect(countSnap.query, 'count(*) reaches OptimysticVirtualTable.query()').to.be.greaterThan(0);
			expect(countSnap.treeUpdate, 'count(*) pulls latest from network').to.be.greaterThan(0);
		} finally {
			db.close();
		}
	});

	it('every count(*) shape pulls (bare alias, db.get, PK-predicate) — rules out H1/H2/H3', async () => {
		const uri = 'tree://read-pull/shapes';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
			for (let i = 1; i <= 4; i++) {
				await db.exec(`insert into T (id, v) values (${i}, 'v${i}')`);
			}

			// (a) bare count(*) with no alias, via db.eval
			probe.reset();
			let bare = 0;
			for await (const row of db.eval('select count(*) from T')) {
				bare = Number(Object.values(row as Record<string, SqlValue>)[0]);
			}
			const bareSnap = { ...probe };

			// (b) count(*) via db.get (single-row API — the ticket's H3)
			probe.reset();
			const got = await db.get('select count(*) as c from T');
			const getValue = got ? Number(Object.values(got)[0]) : NaN;
			const getSnap = { ...probe };

			// (c) count(*) with a primary-key predicate (routes through point lookup)
			probe.reset();
			const pkCount = await evalCount(db, 'select count(*) as c from T where id = 2');
			const pkSnap = { ...probe };

			// eslint-disable-next-line no-console
			console.log('[shapes] bare count(*) =', bare, JSON.stringify(bareSnap));
			// eslint-disable-next-line no-console
			console.log('[shapes] db.get count  =', getValue, JSON.stringify(getSnap));
			// eslint-disable-next-line no-console
			console.log('[shapes] count where pk=', pkCount, JSON.stringify(pkSnap));

			expect(bare, 'bare count(*) value').to.equal(4);
			expect(getValue, 'db.get count value').to.equal(4);
			expect(pkCount, 'count where id=2').to.equal(1);

			// All three shapes reconcile to network state before counting.
			expect(bareSnap.query, 'bare count reaches query()').to.be.greaterThan(0);
			expect(bareSnap.treeUpdate, 'bare count pulls').to.be.greaterThan(0);
			expect(getSnap.query, 'db.get count reaches query()').to.be.greaterThan(0);
			expect(getSnap.treeUpdate, 'db.get count pulls').to.be.greaterThan(0);
			expect(pkSnap.query, 'pk-predicate count reaches query()').to.be.greaterThan(0);
			expect(pkSnap.treeUpdate, 'pk-predicate count pulls').to.be.greaterThan(0);
		} finally {
			db.close();
		}
	});

	it('count(*) observes a second writer\'s committed appends (cross-writer convergence)', async () => {
		// Truest single-process two-peer model: two independent Databases wired to
		// the SAME on-disk FileRawStorage dir. Peer B's SQL inserts commit to the
		// shared store; peer A's collection instance is separate, so peer A only
		// sees them if its read path pulls (collection.update()). This is the
		// blind-write scenario the originating convergence test exercises, minus
		// the cross-repo cadre harness.
		const uri = 'tree://read-pull/cross';
		const peerA = createDb(dir);
		try {
			await peerA.db.exec(`create table T (id integer primary key, v text) using optimystic('${uri}')`);
			await peerA.db.exec(`insert into T (id, v) values (1, 'a')`);
			expect(await evalCount(peerA.db, 'select count(*) as c from T')).to.equal(1);

			// Peer B: a separate Database over the same dir appends two rows.
			const peerB = createDb(dir);
			try {
				await peerB.plugin.hydrate(peerB.db);
				await peerB.db.exec(`insert into T (id, v) values (2, 'b')`);
				await peerB.db.exec(`insert into T (id, v) values (3, 'c')`);
				expect(await evalCount(peerB.db, 'select count(*) as c from T')).to.equal(3);
			} finally {
				peerB.db.close();
			}

			// Peer A re-reads. If count(*) reconciles to the committed store it sees 3.
			probe.reset();
			const countAfter = await evalCount(peerA.db, 'select count(*) as c from T');
			const countSnap = { ...probe, plans: [...probe.plans] };

			probe.reset();
			const scanAfter = await drain(peerA.db, 'select id from T');
			const scanSnap = { ...probe };

			// eslint-disable-next-line no-console
			console.log('[cross-writer] peerA count after B appends =', countAfter, JSON.stringify(countSnap));
			// eslint-disable-next-line no-console
			console.log('[cross-writer] peerA scan  after B appends =', scanAfter, JSON.stringify(scanSnap));

			expect(countSnap.treeUpdate, 'count(*) issued a network pull').to.be.greaterThan(0);
			expect(scanAfter, 'select id sees both writers\' rows').to.equal(3);
			expect(countAfter, 'count(*) sees both writers\' rows').to.equal(3);
		} finally {
			peerA.db.close();
		}
	});

	it('adversarial shapes (empty table, secondary-index predicate, distinct/sum/group-by) all pull', async () => {
		// The shapes the ticket flagged as the most likely places a pull could be
		// skipped: an empty table (a fast-path could short-circuit the cursor), a
		// count routed through executeIndexScan rather than executeTableScan, and
		// non-count aggregates. Each must still reach query() and issue a pull —
		// otherwise the "pull-on-read is shape-independent" invariant is false.

		// (a) empty-table count(*) — no fast path may bypass query()/update().
		{
			const { db } = createDb(dir);
			try {
				await db.exec(`create table E (id integer primary key, v text) using optimystic('tree://read-pull/empty')`);
				probe.reset();
				const c = await evalCount(db, 'select count(*) as c from E');
				// eslint-disable-next-line no-console
				console.log('[adversarial] empty count =', c, JSON.stringify({ ...probe, plans: [...probe.plans] }));
				expect(c, 'empty count is 0').to.equal(0);
				expect(probe.query, 'empty count reaches query()').to.be.greaterThan(0);
				expect(probe.treeUpdate, 'empty count pulls').to.be.greaterThan(0);
			} finally {
				db.close();
			}
		}

		// (b) count routed through a secondary index, plus non-count aggregates.
		{
			const { db } = createDb(dir);
			try {
				await db.exec(`create table A (id integer primary key, cat text, n integer) using optimystic('tree://read-pull/agg')`);
				await db.exec(`create index idx_cat on A (cat)`);
				for (let i = 1; i <= 6; i++) {
					await db.exec(`insert into A (id, cat, n) values (${i}, '${i % 2 === 0 ? 'even' : 'odd'}', ${i})`);
				}

				// count(*) with a secondary-index predicate → executeIndexScan, which pulls.
				probe.reset();
				const secCount = await evalCount(db, `select count(*) as c from A where cat = 'even'`);
				// eslint-disable-next-line no-console
				console.log('[adversarial] count where cat=even =', secCount, JSON.stringify({ ...probe, plans: [...probe.plans] }));
				expect(secCount, 'count over secondary index').to.equal(3);
				expect(probe.query, 'secondary count reaches query()').to.be.greaterThan(0);
				expect(probe.indexScan, 'secondary count routes through index scan').to.be.greaterThan(0);
				expect(probe.treeUpdate, 'secondary count pulls').to.be.greaterThan(0);

				// Non-count aggregates stream from the same fullscan source, so they pull too.
				for (const sql of [
					'select count(distinct cat) as c from A',
					'select sum(n) as c from A',
					'select cat, count(*) as c from A group by cat',
				]) {
					probe.reset();
					let rows = 0;
					for await (const _row of db.eval(sql)) rows++;
					// eslint-disable-next-line no-console
					console.log('[adversarial] agg', JSON.stringify(sql), 'rows=', rows, JSON.stringify({ query: probe.query, tableScan: probe.tableScan, treeUpdate: probe.treeUpdate }));
					expect(rows, `${sql} yielded rows`).to.be.greaterThan(0);
					expect(probe.query, `${sql} reaches query()`).to.be.greaterThan(0);
					expect(probe.treeUpdate, `${sql} pulls`).to.be.greaterThan(0);
				}
			} finally {
				db.close();
			}
		}
	});
});
