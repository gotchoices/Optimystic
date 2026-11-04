/**
 * An `order by` served by walking a secondary index (GitHub #52): the rows come out of the index
 * tree in order, forwards or backwards, and a `limit` stops the walk after the rows it needs.
 *
 * The suite is differential: every statement runs against an Optimystic table and a Quereus
 * memory table holding the same rows, and the two must return the same rows in the same order.
 * The memory table is the engine's own definition of the right order — in particular for text
 * where the tree's UTF-16 code-unit order and the engine's code-point order disagree (an emoji
 * against `～`), which `inEngineOrder` in `src/schema/index-walk.ts` repairs at read time.
 *
 * Single-node and in-memory (`default_transactor: 'test'`): the read path under test knows
 * nothing about meshes.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { stageNewEntryOnly, withIndexStagingPatched } from './index-staging-patch.js';
import { captureTrace, indexSeekTraces } from './trace-helpers.js';

type SqlRow = Record<string, SqlValue>;
type Plugin = ReturnType<typeof register>;

const collectRows = async (iter: AsyncIterable<SqlRow>): Promise<SqlRow[]> => {
	const rows: SqlRow[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

function openDatabase(): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	});
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

interface PlanSummary {
	ops: (SqlValue | undefined)[];
	described: string;
}

async function planOf(db: Database, query: string): Promise<PlanSummary> {
	const steps = await collectRows(db.eval('select op, detail from query_plan(?)', [query]));
	return { ops: steps.map(s => s.op), described: steps.map(s => `${s.op}: ${s.detail}`).join('\n') };
}

/** The statement is served in index order: the index is walked or sought, and nothing sorts above it. */
async function expectOrderFromIndex(db: Database, query: string): Promise<void> {
	const plan = await planOf(db, query);
	expect(plan.ops, plan.described).to.not.include('SORT');
	expect(plan.ops.some(op => op === 'INDEXSCAN' || op === 'INDEXSEEK'), plan.described).to.equal(true);
}

/** The statement is NOT served in index order: the engine keeps its Sort. */
async function expectEngineSort(db: Database, query: string): Promise<void> {
	const plan = await planOf(db, query);
	expect(plan.ops, plan.described).to.include('SORT');
}

const COLUMNS = '(id text primary key, t text, g text, u text null, n integer)';

/**
 * Text that exercises the walk's order: values that are prefixes of one another, values holding
 * a NUL (`\x00`, which the key framing escapes), the empty string, CJK below the surrogate range,
 * and the pairs on which code-unit and code-point order disagree — an emoji (a surrogate pair,
 * code units in D800–DFFF) against text at or above U+E000 (`～` is U+FF5E, `` the first
 * private-use character) — plus lone surrogates, which a SQL TEXT value may legally hold.
 */
const TEXTS: readonly string[] = [
	'a', 'ab', 'a\x00', 'a\x00b', 'a\x01', '', 'b', '中', 'z',
	'😀', '～', '', 'a😀', 'a～', 'a', 'a😀b', 'a～b',
	'\uD83D', '\uDC00', 'x\uD83D', 'x\uFFFF',
];

/** Every text twice, under two primary keys, so equal index values are ordered by the key. */
const ROWS: readonly (readonly SqlValue[])[] = TEXTS.flatMap((t, i) => [
	[`r${String(i).padStart(2, '0')}a`, t, i % 2 === 0 ? 'x' : 'y', i % 3 === 0 ? null : `u${t}`, i % 4],
	[`r${String(i).padStart(2, '0')}b`, t, i % 2 === 0 ? 'y' : 'x', i % 3 === 1 ? null : `u${t}`, (i + 1) % 4],
]);

describe('An index walk serves order by', () => {
	let db: Database;
	let plugin: Plugin;

	/** The rows of `select id, t from <table> <clause>`, as returned. */
	const rowsOf = async (table: string, clause: string, params: SqlValue[] = []): Promise<SqlRow[]> =>
		await collectRows(db.eval(`select id, t from ${table} ${clause}`, params));

	/** Both tables answer `clause` with the same rows in the same order. */
	const expectSameOrder = async (clause: string, params: SqlValue[] = []): Promise<SqlRow[]> => {
		const walked = await rowsOf('walked', clause, params);
		const model = await rowsOf('model', clause, params);
		expect(walked, clause).to.deep.equal(model);
		return walked;
	};

	before(async () => {
		({ db, plugin } = openDatabase());
		await db.exec(`create table walked ${COLUMNS} using optimystic('tree://test/walk_main')`);
		await db.exec('create index idx_t on walked(t)');
		await db.exec('create index idx_gt on walked(g, t)');
		await db.exec('create index idx_u on walked(u)');
		await db.exec(`create table model ${COLUMNS} using memory`);
		for (const row of ROWS) {
			await db.exec('insert into walked (id, t, g, u, n) values (?, ?, ?, ?, ?)', [...row]);
			await db.exec('insert into model (id, t, g, u, n) values (?, ?, ?, ?, ?)', [...row]);
		}
	});

	it('walks the index forward for an ascending ordering over the index column and the primary key', async () => {
		const query = 'select id, t from walked order by t, id';
		await expectOrderFromIndex(db, query);
		const rows = await expectSameOrder('order by t, id');
		expect(rows).to.have.length(ROWS.length);
	});

	it('walks the index backward for a descending ordering', async () => {
		await expectOrderFromIndex(db, 'select id, t from walked order by t desc, id desc');
		await expectSameOrder('order by t desc, id desc');
	});

	it('orders within an equality seek, in both directions', async () => {
		await expectOrderFromIndex(db, `select id, t from walked where g = 'x' order by t, id`);
		await expectSameOrder(`where g = 'x' order by t, id`);
		await expectOrderFromIndex(db, `select id, t from walked where g = 'x' order by t desc, id desc`);
		await expectSameOrder(`where g = 'x' order by t desc, id desc`);
	});

	it('leaves a filter on an unindexed column as a residual above the walk', async () => {
		const query = 'select id, t from walked where n = 1 order by t, id';
		const plan = await planOf(db, query);
		expect(plan.ops, plan.described).to.include('FILTER');
		expect(plan.ops, plan.described).to.include('INDEXSCAN');
		expect(plan.ops, plan.described).to.not.include('SORT');
		await expectSameOrder('where n = 1 order by t, id');
	});

	/**
	 * How many index entries a walk from the top reads before it can yield its first row: the texts
	 * that sort highest in code-unit order all hold a unit at or above U+D800, so `inEngineOrder`
	 * holds and sorts them as one run (every text is stored under two keys) and yields them only on
	 * reaching the first pivot below them (`'中'`, U+4E2D). A walk from the bottom reads no such
	 * run: `''` and `'a'` are pivots and come out as they are read.
	 */
	const TOP_RUN_ENTRIES = (() => {
		const byCodeUnitsDescending = [...TEXTS].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
		const runLength = byCodeUnitsDescending.findIndex(t => !/[\uD800-\uFFFF]/.test(t));
		return runLength * 2 + 1;
	})();

	/** The one `index:seek` line a statement over `idx_t` emits while `body` runs. */
	const traceOf = async (body: () => Promise<void>): Promise<ReturnType<typeof indexSeekTraces>[number]> => {
		const lines = await captureTrace(body);
		const [trace] = indexSeekTraces(lines).filter(t => t.index === 'idx_t');
		expect(trace, 'the walk emits one index:seek line').to.not.equal(undefined);
		return trace!;
	};

	it('plans the newest-page query as a limit over a backward walk', async () => {
		const query = 'select id, t from walked order by t desc, id desc limit 3';
		const plan = await planOf(db, query);
		expect(plan.ops, plan.described).to.include('LIMITOFFSET');
		expect(plan.ops, plan.described).to.include('INDEXSCAN');
		expect(plan.ops, plan.described).to.not.include('SORT');
		expect(plan.described, 'the index is walked backwards').to.match(/INDEXSCAN: .*idx_t.*DESC/);

		let rows: SqlRow[] = [];
		const trace = await traceOf(async () => { rows = await rowsOf('walked', 'order by t desc, id desc limit 3'); });
		expect(rows).to.deep.equal(await rowsOf('model', 'order by t desc, id desc limit 3'));
		expect(trace.dir).to.equal('desc');
		expect(trace.seek, 'the whole-index prefix').to.equal('');
		expect(trace.matched, 'the surrogate-range run at the top is read whole before the first row').to.equal(TOP_RUN_ENTRIES);
	});

	it('stops a bounded walk after the rows the limit needs', async () => {
		let rows: SqlRow[] = [];
		const trace = await traceOf(async () => { rows = await rowsOf('walked', 'order by t, id limit 3'); });
		expect(rows).to.deep.equal(await rowsOf('model', 'order by t, id limit 3'));
		expect(trace.dir).to.equal('asc');
		expect(trace.matched, 'three entries, not the whole index').to.equal(3);
	});

	it('answers min and max from the ends of the index', async () => {
		for (const [aggregate, dir, entries] of [['min', 'asc', 1], ['max', 'desc', TOP_RUN_ENTRIES]] as const) {
			const query = `select ${aggregate}(t) as v from walked`;
			const plan = await planOf(db, query);
			expect(plan.ops, plan.described).to.include('INDEXSCAN');
			expect(plan.ops, plan.described).to.include('LIMITOFFSET');
			expect(plan.ops, plan.described).to.not.include('SORT');

			let value: SqlValue | undefined;
			const trace = await traceOf(async () => {
				const [row] = await collectRows(db.eval(query));
				value = row?.v;
			});
			const [expected] = await collectRows(db.eval(`select ${aggregate}(t) as v from model`));
			expect(value, aggregate).to.equal(expected?.v);
			expect(trace.dir, aggregate).to.equal(dir);
			expect(trace.matched, `${aggregate} reads the end of the index`).to.equal(entries);
		}
	});

	it('keeps the engine sort over a nullable column, and walks it under a NULL-excluding filter', async () => {
		await expectEngineSort(db, 'select id, t from walked order by u, id');
		await expectSameOrder('order by u, id');
		await expectEngineSort(db, 'select id, t from walked order by u desc, id desc');
		await expectSameOrder('order by u desc, id desc');

		await expectOrderFromIndex(db, 'select id, t from walked where u is not null order by u, id');
		await expectSameOrder('where u is not null order by u, id');
		await expectOrderFromIndex(db, 'select id, t from walked where u is not null order by u desc, id desc');
		await expectSameOrder('where u is not null order by u desc, id desc');
	});

	it('keeps the engine sort over a list on the ordered column, and over mixed directions', async () => {
		await expectEngineSort(db, `select id, t from walked where g in ('x', 'y') order by t, id`);
		await expectSameOrder(`where g in ('x', 'y') order by t, id`);
		await expectEngineSort(db, 'select id, t from walked order by t, id desc');
		await expectSameOrder('order by t, id desc');
	});

	it('sees rows staged in the open transaction, in order', async () => {
		await db.exec('begin');
		try {
			for (const table of ['walked', 'model']) {
				await db.exec(`insert into ${table} (id, t, g, u, n) values ('s1', 'aa', 'x', 'uaa', 9), ('s2', 'a～a', 'y', null, 9)`);
				await db.exec(`delete from ${table} where id = 'r01a'`);
			}
			const rows = await expectSameOrder('order by t, id');
			expect(rows.map(r => r.id)).to.include('s1').and.include('s2').and.not.include('r01a');
			await expectSameOrder('order by t desc, id desc');
		} finally {
			await db.exec('rollback');
		}
	});

	it('returns a row whose old index entry was left behind once, in its new place', async () => {
		// A writer that was not maintaining the index moved the row off its value: the stale entry
		// still resolves to the live row, which the walk rejects (rowImpliesEntry), so the row
		// comes out under its new entry only.
		await withIndexStagingPatched(plugin, 'walked', 'updateIndexEntries', stageNewEntryOnly, async () => {
			await db.exec(`update walked set t = 'moved' where id = 'r06a'`);
		});
		await db.exec(`update model set t = 'moved' where id = 'r06a'`);

		let rows: SqlRow[] = [];
		const lines = await captureTrace(async () => { rows = await rowsOf('walked', 'order by t, id'); });
		expect(rows).to.deep.equal(await rowsOf('model', 'order by t, id'));
		expect(rows.filter(r => r.id === 'r06a')).to.have.length(1);
		const [trace] = indexSeekTraces(lines).filter(t => t.index === 'idx_t');
		expect(trace!.rejected, 'the stale entry is rejected rather than returned').to.equal(1);
	});
});

describe('An index walk serves order by through a committed read', () => {
	it('answers max over committed.<Table> from the pre-transaction view', async () => {
		// `max(t)` plans as a limit over a backward walk; through `committed.marks_src` it must read
		// the pinned pre-transaction view, so a row staged in the same transaction — including one
		// that would be the new maximum — is not seen, and the index is read through the committed
		// arm rather than falling through to a scan in primary-key order.
		const { db } = openDatabase();
		await db.exec(`create table marks_src (id text primary key, t text) using optimystic('tree://test/walk_committed_src')`);
		await db.exec('create index idx_src_t on marks_src(t)');
		await db.exec(`insert into marks_src (id, t) values ('1', 'b'), ('2', 'c'), ('3', 'a')`);
		await db.exec(`
			create table marks (k integer primary key, top text,
				constraint Top check (top = (select max(t) from committed.marks_src))
			) using optimystic('tree://test/walk_committed_marks')
		`);

		await db.exec('begin');
		try {
			await db.exec(`insert into marks_src (id, t) values ('4', 'zz')`);
			await db.exec(`insert into marks (k, top) values (1, 'c')`);
			await db.exec('commit');
		} catch (error) {
			await db.exec('rollback');
			throw error;
		}

		const rows = await collectRows(db.eval('select top from marks'));
		expect(rows.map(r => r.top)).to.deep.equal(['c']);
	});
});
