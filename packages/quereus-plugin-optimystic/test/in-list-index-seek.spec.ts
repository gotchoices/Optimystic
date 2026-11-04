/**
 * An `in (…)` list on an indexed column, served as one seek per value (GitHub #44), and the rule
 * `=` and `in` now share for which columns may be sought at all.
 *
 * The index and primary-key trees compare raw bytes, and the engine does not re-check a filter a
 * module claims, so a claimed seek must find every row the predicate would. The differential suite
 * therefore runs each statement against a table with the indexes and an identical one without:
 * the second is a scan the engine filters itself, so it says what the right answer is.
 */

import { expect } from 'chai';
import { COST_PRESETS, Database, TEXT_TYPE, buildColumnIndexMap } from '@quereus/quereus';
import type { BestAccessPlanResult, ColumnSchema, ColumnStatistics, OrderingSpec, PredicateConstraint, SqlValue, TableIndexSchema, TableSchema } from '@quereus/quereus';
import { OptimysticModule } from '../dist/index.js';
import register from '../dist/plugin.js';

type SqlRow = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<SqlRow>): Promise<SqlRow[]> => {
	const rows: SqlRow[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

function openDatabase(config: Record<string, SqlValue> = {}): { db: Database; module: OptimysticModule } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
		...config,
	});
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, module: plugin.vtables[0]!.module };
}

interface PlanSummary {
	steps: SqlRow[];
	ops: (SqlValue | undefined)[];
	described: string;
}

async function planOf(db: Database, query: string): Promise<PlanSummary> {
	const steps = await collectRows(db.eval('select op, detail from query_plan(?)', [query]));
	return { steps, ops: steps.map(s => s.op), described: steps.map(s => `${s.op}: ${s.detail}`).join('\n') };
}

const seeksThrough = (plan: PlanSummary, name: string): boolean =>
	plan.steps.some(s => s.op === 'INDEXSEEK' && String(s.detail).includes(name));

// --- the reported query -----------------------------------------------------

describe('The reported in-list join (GitHub #44)', () => {
	const ENTRY_IDS = Array.from({ length: 40 }, (_, i) => `e${i}`);
	const LISTED = ENTRY_IDS.slice(3, 34);
	const QUERY = `
		select lei.entry_id, i.id as item_id, i.name as item_name, c.id as category_id, c.name as category_name, lei.source_bundle_id, b.name as bundle_name
		from log_entry_items lei
		join items i on i.id = lei.item_id
		join categories c on c.id = i.category_id
		left join bundles b on b.id = lei.source_bundle_id
		where lei.entry_id in (${LISTED.map(() => '?').join(', ')})
		order by i.name asc`;

	async function seedReportedTables(db: Database): Promise<void> {
		await db.exec(`create table categories (id text primary key, name text) using optimystic('tree://test/in_categories')`);
		await db.exec(`create table items (id text primary key, name text, category_id text) using optimystic('tree://test/in_items')`);
		await db.exec(`create table bundles (id text primary key, name text) using optimystic('tree://test/in_bundles')`);
		await db.exec(`
			create table log_entry_items (
				entry_id text,
				item_id text,
				source_bundle_id text null,
				primary key (entry_id, item_id)
			) using optimystic('tree://test/in_lei')
		`);
		await db.exec('create index idx_lei_entry on log_entry_items(entry_id)');

		await db.exec(`insert into categories (id, name) values ('c0', 'cat 0'), ('c1', 'cat 1')`);
		const items = Array.from({ length: 12 }, (_, i) => `('i${i}', 'item ${String(i).padStart(2, '0')}', 'c${i % 2}')`);
		await db.exec(`insert into items (id, name, category_id) values ${items.join(', ')}`);
		await db.exec(`insert into bundles (id, name) values ('b0', 'bundle 0')`);
		const rows = ENTRY_IDS.flatMap((entry, e) => [0, 1].map(k => {
			const bundle = k === 0 ? `'b0'` : 'null';
			return `('${entry}', 'i${(e + k) % 12}', ${bundle})`;
		}));
		await db.exec(`insert into log_entry_items (entry_id, item_id, source_bundle_id) values ${rows.join(', ')}`);
	}

	const profiles: [string, Record<string, SqlValue>][] = [['default', {}], ['distributed', { cost_profile: 'distributed' }]];
	for (const [profile, config] of profiles) {
		it(`seeks the index and hash-joins under the ${profile} cost profile, returning the listed entries' rows`, async () => {
			const { db, module } = openDatabase(config);
			if (profile === 'distributed') expect(module.costProfile).to.equal(COST_PRESETS.distributed);
			await seedReportedTables(db);

			const plan = await planOf(db, QUERY);
			expect(seeksThrough(plan, 'idx_lei_entry'), plan.described).to.equal(true);
			expect(plan.ops, plan.described).to.include('HASHJOIN');
			expect(plan.ops, plan.described).to.not.include('JOIN');
			expect(plan.ops, plan.described).to.not.include('FILTER');
			expect(plan.steps.some(s => s.op === 'SEQSCAN' && /log_entry_items/.test(String(s.detail))), plan.described).to.equal(false);

			const rows = await collectRows(db.eval(QUERY, LISTED));
			expect(rows).to.have.length(LISTED.length * 2);
			expect(new Set(rows.map(r => r.entry_id))).to.deep.equal(new Set(LISTED));
			const names = rows.map(r => String(r.item_name));
			expect(names).to.deep.equal([...names].sort());
			expect(rows.filter(r => r.bundle_name === 'bundle 0')).to.have.length(LISTED.length);
		});
	}
});

// --- differential -----------------------------------------------------------

interface SeekCase {
	name: string;
	where: string;
	params?: SqlValue[];
	/** The index the statement must plan an INDEXSEEK through. */
	seeks?: string;
}

const NUL_VALUE = 'a\x00b';

const CASES: SeekCase[] = [
	{ name: 'a repeated bound value', where: 'a in (?, ?)', params: ['a', 'a'], seeks: 'idx_a' },
	{ name: 'a repeated literal value', where: `a in ('a', 'a')`, seeks: 'idx_a' },
	{ name: 'numerically equal literals', where: 'n in (1, 1.0)', seeks: 'idx_n' },
	{ name: 'a number and a bigint of one value', where: 'n in (?, ?)', params: [1, 1n], seeks: 'idx_n' },
	{ name: 'a literal null in the list', where: `a in ('a', null)`, seeks: 'idx_a' },
	{ name: 'a bound null in the list', where: 'a in (?, ?)', params: ['a', null], seeks: 'idx_a' },
	{ name: 'only literal nulls', where: 'a in (null, null)' },
	{ name: 'only bound nulls', where: 'a in (?, ?)', params: [null, null], seeks: 'idx_a' },
	{ name: 'a value that prefixes another', where: 'a in (?, ?)', params: ['a', 'ab'], seeks: 'idx_a' },
	{ name: 'a value that alone is a prefix of stored values', where: 'a in (?, ?)', params: ['a', 'nothing'], seeks: 'idx_a' },
	{ name: 'a value containing a NUL', where: 'a in (?, ?)', params: [NUL_VALUE, 'b'], seeks: 'idx_a' },
	{ name: 'the empty string', where: 'a in (?, ?)', params: ['', 'b'], seeks: 'idx_a' },
	{ name: 'values absent from the table', where: 'a in (?, ?)', params: ['nope', 'nada'], seeks: 'idx_a' },
	{ name: 'the leading column of a two-column index', where: `b in ('x', 'y')`, seeks: 'idx_bc' },
	{ name: 'a leading in with a bound trailing =', where: 'b in (?, ?) and c = ?', params: ['x', 'y', 'p'], seeks: 'idx_bc' },
	{ name: 'a bound = with a trailing literal in', where: `b = ? and c in ('p', 'q')`, params: ['x'], seeks: 'idx_bc' },
	{ name: 'a bound = with a trailing bound in', where: 'b = ? and c in (?, ?)', params: ['x', 'p', 'q'], seeks: 'idx_bc' },
	{ name: '= ahead of in on one column', where: `a = 'a' and a in ('a', 'ab')`, seeks: 'idx_a' },
	{ name: 'in ahead of = on one column', where: `a in ('a', 'ab') and a = 'a'`, seeks: 'idx_a' },
	{ name: 'a single-element in', where: 'a in (?)', params: ['a'], seeks: 'idx_a' },
	{ name: 'a primary-key list', where: 'id in (?, ?)', params: ['r1', 'r5'], seeks: 'primary' },
	{ name: 'a primary-key list with a repeat', where: 'id in (?, ?, ?)', params: ['r1', 'r1', 'r5'], seeks: 'primary' },
	{ name: 'a primary-key list with a null', where: 'id in (?, ?)', params: ['r1', null], seeks: 'primary' },
	{ name: 'a primary-key list of nulls', where: 'id in (?, ?)', params: [null, null], seeks: 'primary' },
	{ name: 'a primary-key list of absent keys', where: 'id in (?, ?)', params: ['nope', 'nada'], seeks: 'primary' },
];

const ROWS: readonly (readonly SqlValue[])[] = [
	['r1', 'a', 'x', 'p', 1],
	['r2', 'ab', 'x', 'q', 2],
	['r3', 'a', 'y', 'p', 1],
	['r4', '', 'y', 'q', 3],
	['r5', NUL_VALUE, 'x', 'r', 4],
	['r6', null, null, null, null],
	['r7', 'b', 'x', 'p', 2],
];

describe('in-list seeks agree with a scan of the same rows', () => {
	let db: Database;

	const idsOf = async (table: string, where: string, params: SqlValue[] = []): Promise<SqlValue[]> => {
		const rows = await collectRows(db.eval(`select id from ${table} where ${where}`, params));
		return rows.map(r => r.id!).sort();
	};

	const insertBoth = async (row: readonly SqlValue[], seq: number): Promise<void> => {
		await db.exec('insert into sought (id, a, b, c, n) values (?, ?, ?, ?, ?)', [...row]);
		await db.exec('insert into scanned (seq, id, a, b, c, n) values (?, ?, ?, ?, ?, ?)', [seq, ...row]);
	};

	before(async () => {
		db = openDatabase().db;
		await db.exec(`
			create table sought (id text primary key, a text null, b text null, c text null, n integer null)
			using optimystic('tree://test/in_sought')
		`);
		await db.exec('create index idx_a on sought(a)');
		await db.exec('create index idx_bc on sought(b, c)');
		await db.exec('create index idx_n on sought(n)');
		await db.exec(`
			create table scanned (seq integer primary key, id text, a text null, b text null, c text null, n integer null)
			using optimystic('tree://test/in_scanned')
		`);
		for (const [i, row] of ROWS.entries()) await insertBoth(row, i);
	});

	for (const { name, where, params, seeks } of CASES) {
		it(name, async () => {
			if (seeks !== undefined) {
				const plan = await planOf(db, `select id from sought where ${where}`);
				expect(seeksThrough(plan, seeks), plan.described).to.equal(true);
			}
			expect(await idsOf('sought', where, params)).to.deep.equal(await idsOf('scanned', where, params));
		});
	}

	it('finds staged inserts and not staged deletes inside an open transaction', async () => {
		await db.exec('begin');
		try {
			await insertBoth(['r8', 'a', 'z', 'p', 9], 100);
			await db.exec(`delete from sought where id = 'r3'`);
			await db.exec(`delete from scanned where id = 'r3'`);
			for (const where of [`a in ('a', 'ab')`, `id in ('r3', 'r8')`]) {
				const sought = await idsOf('sought', where);
				expect(sought, where).to.include('r8');
				expect(sought, where).to.not.include('r3');
				expect(sought, where).to.deep.equal(await idsOf('scanned', where));
			}
		} finally {
			await db.exec('rollback');
		}
	});

	// Quereus requires a multi-seek to emit in key order, never in the order the list was written.
	it('emits rows in key order whatever order the list is written in', async () => {
		const byIndex = await collectRows(db.eval('select a from sought where a in (?, ?, ?)', ['b', 'ab', 'a']));
		expect(byIndex.map(r => r.a)).to.deep.equal(['a', 'a', 'ab', 'b']);

		const byPrimaryKey = await collectRows(db.eval('select id from sought where id in (?, ?, ?)', ['r7', 'r1', 'r4']));
		expect(byPrimaryKey.map(r => r.id)).to.deep.equal(['r1', 'r4', 'r7']);
	});

	it('keeps the sort over a list on the ordered column', async () => {
		const query = `select a from sought where a in ('b', 'a', 'ab') order by a`;
		const plan = await planOf(db, query);
		expect(plan.ops, plan.described).to.include('SORT');
		const rows = await collectRows(db.eval(query));
		expect(rows.map(r => r.a)).to.deep.equal(['a', 'a', 'ab', 'b']);
	});
});

// --- columns where equal values can have different bytes ---------------------

describe('Columns no seek can serve stay residual filters over a scan', () => {
	const expectIds = async (db: Database, query: string, ids: SqlValue[]): Promise<void> => {
		const plan = await planOf(db, query);
		expect(plan.ops, plan.described).to.not.include('INDEXSEEK');
		const rows = await collectRows(db.eval(query));
		expect(rows.map(r => r.id).sort(), query).to.deep.equal(ids);
	};

	it('a nocase indexed column returns every case variant', async () => {
		const { db } = openDatabase();
		await db.exec(`create table cities (id text primary key, city text collate nocase) using optimystic('tree://test/in_cities')`);
		await db.exec('create index idx_city on cities(city)');
		await db.exec(`insert into cities (id, city) values ('1', 'ABC'), ('2', 'abc'), ('3', 'other')`);

		await expectIds(db, `select id from cities where city = 'abc'`, ['1', '2']);
		await expectIds(db, `select id from cities where city in ('abc', 'zzz')`, ['1', '2']);
	});

	it('a nocase primary key finds a row stored in another case', async () => {
		const { db } = openDatabase();
		await db.exec(`create table codes (id text collate nocase primary key, note text null) using optimystic('tree://test/in_codes')`);
		await db.exec(`insert into codes (id) values ('ABC'), ('other')`);

		await expectIds(db, `select id from codes where id = 'abc'`, ['ABC']);
		await expectIds(db, `select id from codes where id in ('abc', 'zzz')`, ['ABC']);
	});

	it('a timespan column finds an equal duration written differently', async () => {
		const { db } = openDatabase();
		await db.exec(`create table spans (id text primary key, d timespan) using optimystic('tree://test/in_spans')`);
		await db.exec('create index idx_d on spans(d)');
		await db.exec(`insert into spans (id, d) values ('1', 'PT1H'), ('2', 'PT2H')`);

		await expectIds(db, `select id from spans where d = 'PT60M'`, ['1']);
		await expectIds(db, `select id from spans where d in ('PT60M', 'PT3H')`, ['1']);
	});
});

// --- an update whose rows move between listed values --------------------------

describe('An update over an in-list seek', () => {
	it('changes each row once, even one that moves to a later listed value', async () => {
		const { db } = openDatabase();
		await db.exec(`create table moves (id text primary key, c text, n integer) using optimystic('tree://test/in_moves')`);
		await db.exec('create index idx_c on moves(c)');
		await db.exec(`insert into moves (id, c, n) values ('1', 'a', 0), ('2', 'a', 0), ('3', 'b', 0), ('4', 'z', 0)`);

		const update = `update moves set c = 'b', n = n + 1 where c in ('a', 'b')`;
		const plan = await planOf(db, update);
		expect(seeksThrough(plan, 'idx_c'), plan.described).to.equal(true);
		await db.exec(update);

		const rows = await collectRows(db.eval('select id, c, n from moves order by id'));
		expect(rows).to.deep.equal([
			{ id: '1', c: 'b', n: 1 },
			{ id: '2', c: 'b', n: 1 },
			{ id: '3', c: 'b', n: 1 },
			{ id: '4', c: 'z', n: 0 },
		]);
	});
});

// --- planner ----------------------------------------------------------------

const ID = 0, CATEGORY = 1, NAME = 2;
const TABLE_ROWS = 1000;
const SEEK_COST = Math.log2(TABLE_ROWS) * 2;

function textColumn(name: string, pkOrder = 0): ColumnSchema {
	return {
		name,
		logicalType: TEXT_TYPE,
		notNull: true,
		primaryKey: pkOrder > 0,
		pkOrder,
		defaultValue: null,
		collation: 'BINARY',
		generated: false,
	};
}

function makeTable(
	indexes: TableIndexSchema[],
	columnStats: Record<string, ColumnStatistics> = {},
	primaryKey: { index: number }[] = [{ index: ID }],
): TableSchema {
	const columns = [textColumn('id', 1), textColumn('category'), textColumn('name')];
	return {
		name: 't',
		schemaName: 'main',
		columns,
		columnIndexMap: buildColumnIndexMap(columns),
		primaryKeyDefinition: primaryKey,
		checkConstraints: [],
		vtabModuleName: 'optimystic',
		isView: false,
		indexes,
		statistics: { rowCount: TABLE_ROWS, columnStats: new Map(Object.entries(columnStats)) },
	};
}

const eq = (columnIndex: number): PredicateConstraint => ({ columnIndex, op: '=', usable: true });

/** A written list of `count` values; only its length means anything at plan time. */
const inList = (columnIndex: number, count: number): PredicateConstraint => ({
	columnIndex,
	op: 'IN',
	usable: true,
	value: Array.from({ length: count }) as unknown as SqlValue,
});

function plan(table: TableSchema, filters: PredicateConstraint[], requiredOrdering?: OrderingSpec[]): BestAccessPlanResult {
	const mod = new OptimysticModule({} as never, {} as never);
	return mod.getBestAccessPlan({} as never, table, { columns: [], filters, estimatedRows: TABLE_ROWS, requiredOrdering });
}

const stats = (distinctCount: number): ColumnStatistics => ({ distinctCount, nullCount: 0 });
const idxCategory: TableIndexSchema = { name: 'idx_category', columns: [{ index: CATEGORY }] };
const idxCatName: TableIndexSchema = { name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] };

const expectUnclaimed = (result: BestAccessPlanResult): void => {
	expect(result.indexName).to.equal(undefined);
	expect(result.handledFilters.some(Boolean)).to.equal(false);
};

describe('Access plan for an in-list (getBestAccessPlan)', () => {
	it('prices a single-element in exactly as an =', () => {
		const single = plan(makeTable([idxCategory]), [inList(CATEGORY, 1)]);
		const equal = plan(makeTable([idxCategory]), [eq(CATEGORY)]);
		expect(single.cost).to.equal(equal.cost);
		expect(single.rows).to.equal(equal.rows);
		expect(single.indexName).to.equal('idx_category');
	});

	it('claims a list that beats a scan and leaves one that does not, without statistics', () => {
		const claimed = plan(makeTable([idxCategory]), [inList(CATEGORY, 31)]);
		expect(claimed.indexName).to.equal('idx_category');
		expect(claimed.handledFilters).to.deep.equal([true]);
		expect(claimed.cost).to.be.closeTo(31 * SEEK_COST + 100, 1e-9);
		expect(claimed.rows).to.equal(TABLE_ROWS);

		expectUnclaimed(plan(makeTable([idxCategory]), [inList(CATEGORY, 60)]));
	});

	it('charges a measured row count per key, so a list near the distinct count costs out as a scan', () => {
		const small = plan(makeTable([idxCategory], { category: stats(1000) }), [inList(CATEGORY, 5)]);
		expect(small.indexName).to.equal('idx_category');
		expect(small.cost).to.be.closeTo(5 * SEEK_COST + 5, 1e-9);
		expect(small.rows).to.equal(5);

		expectUnclaimed(plan(makeTable([idxCategory], { category: stats(40) }), [inList(CATEGORY, 39)]));
	});

	it('ranks a list above an = on equal terms', () => {
		const idxName: TableIndexSchema = { name: 'idx_name', columns: [{ index: NAME }] };
		const result = plan(makeTable([idxCategory, idxName]), [inList(CATEGORY, 2), eq(NAME)]);
		expect(result.indexName).to.equal('idx_name');
		expect(result.handledFilters).to.deep.equal([false, true]);
	});

	it('reports a multi-seek as neither a set nor ordered', () => {
		const unique: TableIndexSchema = { name: 'idx_unique', columns: [{ index: CATEGORY }], unique: true };
		const ordering: OrderingSpec[] = [{ columnIndex: CATEGORY, desc: false }];
		const result = plan(makeTable([unique]), [inList(CATEGORY, 3)], ordering);
		expect(result.indexName).to.equal('idx_unique');
		expect(result.rows).to.equal(3);
		expect(result.isSet).to.equal(false);
		expect(result.providesOrdering).to.equal(undefined);
	});

	it('never claims a list through a partial index, or a runtime set at all', () => {
		const partial: TableIndexSchema = { ...idxCategory, predicate: { type: 'literal', value: 1 } as TableIndexSchema['predicate'] };
		expectUnclaimed(plan(makeTable([partial]), [inList(CATEGORY, 2)]));

		const runtimeSet: PredicateConstraint = { columnIndex: CATEGORY, op: 'IN', usable: true, runtimeSet: { maxCount: 2 } };
		expectUnclaimed(plan(makeTable([idxCategory]), [runtimeSet]));
		expectUnclaimed(plan(makeTable([]), [{ ...runtimeSet, columnIndex: ID }]));
	});

	it('claims the first of two equality-role filters on a column, as the engine seeks on the first', () => {
		const listFirst = plan(makeTable([idxCategory]), [inList(CATEGORY, 2), eq(CATEGORY)]);
		expect(listFirst.handledFilters).to.deep.equal([true, false]);
		expect(listFirst.cost).to.be.closeTo(2 * SEEK_COST + 100, 1e-9);

		const equalFirst = plan(makeTable([idxCategory]), [eq(CATEGORY), inList(CATEGORY, 2)]);
		expect(equalFirst.handledFilters).to.deep.equal([true, false]);
		expect(equalFirst.cost).to.be.closeTo(SEEK_COST + 100, 1e-9);
	});

	it('seeks a multi-value in only as the sole column of a composite index', () => {
		const leading = plan(makeTable([idxCatName]), [inList(CATEGORY, 2), eq(NAME)]);
		expect(leading.seekColumnIndexes).to.deep.equal([CATEGORY]);
		expect(leading.handledFilters).to.deep.equal([true, false]);

		const trailing = plan(makeTable([idxCatName]), [eq(CATEGORY), inList(NAME, 2)]);
		expect(trailing.seekColumnIndexes).to.deep.equal([CATEGORY]);
		expect(trailing.handledFilters).to.deep.equal([true, false]);

		const single = plan(makeTable([idxCatName]), [eq(CATEGORY), inList(NAME, 1)]);
		expect(single.seekColumnIndexes).to.deep.equal([CATEGORY, NAME]);
		expect(single.handledFilters).to.deep.equal([true, true]);
	});

	it('competes a primary-key list on cost, against a scan and a secondary index', () => {
		const short = plan(makeTable([]), [inList(ID, 2)]);
		expect(short.indexName).to.equal('_primary_');
		expect(short.cost).to.be.closeTo(2 * SEEK_COST, 1e-9);
		expect(short.rows).to.equal(2);
		expect(short.isSet).to.equal(false);

		expectUnclaimed(plan(makeTable([]), [inList(ID, 60)]));

		const lost = plan(makeTable([idxCategory], { category: stats(1000) }), [inList(ID, 40), eq(CATEGORY)]);
		expect(lost.indexName).to.equal('idx_category');
		expect(lost.handledFilters).to.deep.equal([false, true]);
	});

	it('leaves a composite primary key\'s list to a scan, and point-seeks one fully bound by = and single-element in', () => {
		const composite = [{ index: ID }, { index: CATEGORY }];
		expectUnclaimed(plan(makeTable([], {}, composite), [inList(ID, 2), eq(CATEGORY)]));

		const bound = plan(makeTable([], {}, composite), [inList(ID, 1), eq(CATEGORY)]);
		expect(bound.indexName).to.equal('_primary_');
		expect(bound.isSet).to.equal(true);
		expect(bound.rows).to.equal(1);
	});
});
