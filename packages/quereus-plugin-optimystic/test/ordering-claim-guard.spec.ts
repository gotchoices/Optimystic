/**
 * The ordering-claim contract of `getBestAccessPlan` (`providesOrdering`, `orderingIndexName`,
 * `indexDescriptor.reverse`), decided by `walkDelivering` in `src/schema/index-walk.ts`.
 *
 * An index tree is ordered by the raw code units of `frame(indexValues) ‖ frame(primaryKey)` and
 * can be walked either way, so it delivers an `order by` over a prefix of that key — the index
 * columns, then the primary key — in either direction, for columns whose stored bytes order as the
 * engine orders their values: TEXT, BINARY on both the column and the key column, not compared by
 * meaning. A column pinned by an equality filter is constant and skipped. No NULL may reach an
 * ordered column, because the engine loses an explicit `nulls first`/`nulls last` before the
 * request reaches a module (blocked ticket
 * `quereus-explicit-nulls-placement-is-lost-when-an-index-serves-order-by`), so a nullable ordered
 * column is claimed only under a NULL-excluding filter. Claiming anything else makes the engine
 * skip its Sort and return genuinely mis-ordered rows.
 *
 * The planner-level tests feed `requiredOrdering` straight into the planner, so they do NOT depend
 * on how the optimizer shapes an ORDER BY clause. The SQL-level tests at the bottom are end-to-end
 * correctness guards on the row order the user sees; `index-ordered-walk.spec.ts` covers the walk
 * itself against a memory table.
 */

import { expect } from 'chai';
import { OptimysticModule } from '../dist/index.js';
import { PhysicalType, TIMESPAN_TYPE } from '@quereus/quereus';
import { Database } from '@quereus/quereus';
import type { BestAccessPlanResult, SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';

// --- planner-level fixtures -------------------------------------------------

interface ColumnSpec {
	name: string;
	type: PhysicalType;
	/** Declared collation; BINARY when omitted. */
	collation?: string;
	/** Columns are NOT NULL by default in Quereus; set for the nullable cases. */
	nullable?: boolean;
	/** The logical type's name, when it is not the physical type's (`timespan`). */
	logicalName?: string;
	/** A `timespan`-like type: TEXT that compares by meaning. */
	semantic?: boolean;
}

interface IndexSpec {
	name: string;
	columns: Array<{ index: number; desc?: boolean; collation?: string }>;
	unique?: boolean;
	predicate?: unknown;
}

function makeColumn(spec: ColumnSpec, primaryKey: boolean, pkOrder: number): any {
	const logicalType = spec.semantic
		? { ...TIMESPAN_TYPE, name: spec.logicalName ?? TIMESPAN_TYPE.name }
		: { name: spec.logicalName ?? spec.type, physicalType: spec.type };
	return {
		name: spec.name,
		logicalType,
		notNull: !spec.nullable,
		primaryKey,
		pkOrder,
		defaultValue: null,
		collation: spec.collation ?? 'BINARY',
		generated: false,
	};
}

/** A table over `columns`, keyed by the named primary-key columns, with `indexes`. */
function makeTable(columns: ColumnSpec[], primaryKey: string[], indexes: IndexSpec[]): any {
	const built = columns.map(spec => {
		const pkOrder = primaryKey.indexOf(spec.name) + 1;
		return makeColumn(spec, pkOrder > 0, pkOrder);
	});
	return {
		name: 't',
		schemaName: 'main',
		columns: built,
		columnIndexMap: new Map(built.map((c, i) => [c.name.toLowerCase(), i])),
		primaryKeyDefinition: primaryKey.map(name => ({ index: columns.findIndex(c => c.name === name) })),
		checkConstraints: [],
		vtabModule: {},
		vtabModuleName: 'optimystic',
		isView: false,
		indexes,
	};
}

/**
 * id INTEGER PK, category TEXT, price REAL, name TEXT, city TEXT NOCASE, span TIMESPAN,
 * s TEXT NULL, data BLOB — the default fixture. Positions are the constants below.
 */
const ID = 0, CATEGORY = 1, PRICE = 2, NAME = 3, CITY = 4, SPAN = 5, S = 6, DATA = 7;
const COLUMNS: ColumnSpec[] = [
	{ name: 'id', type: PhysicalType.INTEGER },
	{ name: 'category', type: PhysicalType.TEXT },
	{ name: 'price', type: PhysicalType.REAL },
	{ name: 'name', type: PhysicalType.TEXT },
	{ name: 'city', type: PhysicalType.TEXT, collation: 'NOCASE' },
	{ name: 'span', type: PhysicalType.TEXT, semantic: true },
	{ name: 's', type: PhysicalType.TEXT, nullable: true },
	{ name: 'data', type: PhysicalType.BLOB },
];

function makeTableInfo(indexes: IndexSpec[]): any {
	return makeTable(COLUMNS, ['id'], indexes);
}

/**
 * The table size the planner hands the module.
 *
 * It rides on the REQUEST, not on the schema: quereus 4.19 retired
 * `TableSchema.estimatedRows`, and `rule-select-access-path` now passes the catalog's count
 * down as `BestAccessPlanRequest.estimatedRows`. Stating it here rather than leaving it
 * `undefined` is what keeps these cases exercising a SUPPLIED row count rather than the
 * module's fallback for an un-analyzed table.
 */
const TABLE_ROWS = 1_000_000;

function eqFilter(columnIndex: number): any {
	return { columnIndex, op: '=', usable: true, value: 'x' };
}

function inFilter(columnIndex: number, values: SqlValue[]): any {
	return { columnIndex, op: 'IN', usable: true, value: values };
}

function notNullFilter(columnIndex: number): any {
	return { columnIndex, op: 'IS NOT NULL', usable: true };
}

type Ordering = Array<{ columnIndex: number; desc: boolean }>;

const asc = (...columns: number[]): Ordering => columns.map(columnIndex => ({ columnIndex, desc: false }));
const desc = (...columns: number[]): Ordering => columns.map(columnIndex => ({ columnIndex, desc: true }));

function plan(
	tableInfo: any,
	filters: any[],
	requiredOrdering: Ordering,
	extra: { limit?: number; offset?: number } = {},
): BestAccessPlanResult {
	const mod = new OptimysticModule({} as any, {} as any);
	return mod.getBestAccessPlan(
		{} as any,
		tableInfo,
		{ columns: [], filters, requiredOrdering, estimatedRows: TABLE_ROWS, ...extra } as any
	);
}

/** Assert the plan delivers `ordering` by walking `indexName` in the given direction. */
function expectWalk(result: BestAccessPlanResult, indexName: string, ordering: Ordering, reverse: boolean, why: string): void {
	expect(result.providesOrdering, `${why}: the ordering is claimed`).to.deep.equal(ordering);
	expect(result.orderingIndexName, `${why}: the ordering names its index`).to.equal(indexName);
	expect(result.indexDescriptor?.name, `${why}: the descriptor names the index`).to.equal(indexName);
	expect(result.indexDescriptor?.reverse ?? false, `${why}: the walk's direction`).to.equal(reverse);
	expect(result.indexDescriptor?.keyColumns.every(column => column.desc === false), `${why}: the tree is ascending in its bytes`).to.equal(true);
}

/** Assert the plan leaves the ordering to the engine's Sort. */
function expectSorted(result: BestAccessPlanResult, why: string): void {
	expect(result.providesOrdering, `${why}: no ordering may be claimed`).to.be.undefined;
	expect(result.orderingIndexName, `${why}: no ordering index`).to.be.undefined;
	expect(result.indexDescriptor, `${why}: no descriptor`).to.be.undefined;
}

// --- SQL harness ------------------------------------------------------------

type SqlRow = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<SqlRow>): Promise<SqlRow[]> => {
	const rows: SqlRow[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

describe('Ordering claims of an equality seek (getBestAccessPlan.providesOrdering)', () => {
	it('claims an ASC + BINARY + TEXT ordering within the sought prefix', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] }]);
		const result = plan(tableInfo, [eqFilter(CATEGORY)], asc(CATEGORY, NAME));
		expect(result.indexName, 'index seek chosen').to.equal('idx_cat_name');
		expect(result.seekColumnIndexes).to.deep.equal([CATEGORY]);
		expectWalk(result, 'idx_cat_name', asc(CATEGORY, NAME), false, 'a seek on category walks name forward');
	});

	it('claims a DESC ordering within the sought prefix by walking the prefix backwards', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] }]);
		const result = plan(tableInfo, [eqFilter(CATEGORY)], [...asc(CATEGORY), ...desc(NAME)]);
		expect(result.indexName).to.equal('idx_cat_name');
		expectWalk(result, 'idx_cat_name', [...asc(CATEGORY), ...desc(NAME)], true, 'category is pinned, so only name sets the direction');
	});

	it('claims an ordering made entirely of pinned columns, forwards', () => {
		// Every surviving row has one category, so any order of them is the requested order.
		const tableInfo = makeTableInfo([{ name: 'idx_cat', columns: [{ index: CATEGORY }] }]);
		const result = plan(tableInfo, [eqFilter(CATEGORY)], desc(CATEGORY));
		expect(result.indexName).to.equal('idx_cat');
		expectWalk(result, 'idx_cat', desc(CATEGORY), false, 'nothing is left to order');
	});

	it('does NOT claim ordering when a suffix column is numeric (REAL price)', () => {
		// Tree keys the REAL price via toExponential(15), which is not order-preserving
		// (10, 100, 2, 5 sort ahead of one another wrongly). The engine must sort.
		const tableInfo = makeTableInfo([{ name: 'idx_cat_price', columns: [{ index: CATEGORY }, { index: PRICE }] }]);
		const result = plan(tableInfo, [eqFilter(CATEGORY)], asc(CATEGORY, PRICE));
		expect(result.indexName, 'index seek still chosen (only the ordering claim is dropped)').to.equal('idx_cat_price');
		expectSorted(result, 'numeric ordering');
	});

	it('does NOT claim ordering for a non-BINARY (NOCASE) column', () => {
		// The tree compares raw code units (BINARY); a NOCASE column would order differently.
		const tableInfo = makeTableInfo([{ name: 'idx_cat_city', columns: [{ index: CATEGORY }, { index: CITY }] }]);
		const result = plan(tableInfo, [eqFilter(CATEGORY)], asc(CATEGORY, CITY));
		expect(result.indexName).to.equal('idx_cat_city');
		expectSorted(result, 'non-BINARY ordering');
	});

	it('does NOT claim an ordering a multi-seek would break', () => {
		// `category in (x, y)` visits the index key by key, so name is ordered only within each key.
		const tableInfo = makeTableInfo([{ name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] }]);
		const result = plan(tableInfo, [inFilter(CATEGORY, ['x', 'y'])], asc(NAME));
		expect(result.indexName).to.equal('idx_cat_name');
		expectSorted(result, 'a multi-seek');
	});

	it('does NOT skip a pinned column whose equal values can have different bytes', () => {
		// `where city = ?` keeps 'X' and 'x' under NOCASE, which sit in separate groups of the
		// tree, so name is ordered only within each group: the engine must sort.
		const tableInfo = makeTableInfo([{ name: 'idx_city_name', columns: [{ index: CITY, collation: 'NOCASE' }, { index: NAME }] }]);
		const result = plan(tableInfo, [eqFilter(CITY)], asc(NAME));
		expect(result.indexName, 'a nocase column is never sought').to.be.undefined;
		expectSorted(result, 'a nocase pin');
	});

	it('does NOT keep the ordering claim of an index that lost to a cheaper one', () => {
		// idx_cat_name could deliver (category, name), but with these statistics the seek pinning
		// category AND price matches far fewer rows, and they come in no particular name order.
		const tableInfo = {
			...makeTableInfo([
				{ name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] },
				{ name: 'idx_cat_price', columns: [{ index: CATEGORY }, { index: PRICE }] },
			]),
			statistics: {
				rowCount: TABLE_ROWS,
				columnStats: new Map([
					['category', { distinctCount: 2, nullCount: 0 }],
					['price', { distinctCount: 100, nullCount: 0 }],
				]),
			},
		};
		const result = plan(tableInfo, [eqFilter(CATEGORY), eqFilter(PRICE)], asc(CATEGORY, NAME));
		expect(result.indexName).to.equal('idx_cat_price');
		expectSorted(result, 'the losing index');
	});
});

describe('Ordering claims of an index walk (getBestAccessPlan.providesOrdering)', () => {
	const walkOf = (indexName: string, ordering: Ordering, reverse: boolean, result: BestAccessPlanResult, why: string): void => {
		expect(result.indexName, `${why}: a walk names no seek index`).to.be.undefined;
		expect(result.seekColumnIndexes, `${why}: a walk seeks nothing`).to.be.undefined;
		expect(result.handledFilters.some(handled => handled), `${why}: a walk claims no filter`).to.equal(false);
		expectWalk(result, indexName, ordering, reverse, why);
	};

	it('walks a TEXT index forward for an ascending ordering, and backward for a descending one', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_name', columns: [{ index: NAME }] }]);
		walkOf('idx_name', asc(NAME), false, plan(tableInfo, [], asc(NAME)), 'ascending');
		walkOf('idx_name', desc(NAME), true, plan(tableInfo, [], desc(NAME)), 'descending');
	});

	it('walks backward for a descending ordering even over an index declared DESC, since the tree is ascending', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_name_desc', columns: [{ index: NAME, desc: true }] }]);
		walkOf('idx_name_desc', desc(NAME), true, plan(tableInfo, [], desc(NAME)), 'declared desc, wanted desc');
		walkOf('idx_name_desc', asc(NAME), false, plan(tableInfo, [], asc(NAME)), 'declared desc, wanted asc');
	});

	it('delivers the primary key after the index columns when the key is TEXT, and not when it is numeric', () => {
		const textKey = makeTable(
			[{ name: 'id', type: PhysicalType.TEXT }, { name: 't', type: PhysicalType.TEXT }],
			['id'],
			[{ name: 'idx_t', columns: [{ index: 1 }] }],
		);
		walkOf('idx_t', asc(1, 0), false, plan(textKey, [], asc(1, 0)), 'a text primary key orders rows with equal index values');
		walkOf('idx_t', desc(1, 0), true, plan(textKey, [], desc(1, 0)), 'and in reverse');

		const tableInfo = makeTableInfo([{ name: 'idx_name', columns: [{ index: NAME }] }]);
		expectSorted(plan(tableInfo, [], asc(NAME, ID)), 'an INTEGER primary key is stored as its decimal text');
	});

	it('walks an index not every ordered column is in only when the rest are pinned', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_name', columns: [{ index: NAME }] }]);
		walkOf('idx_name', asc(CATEGORY, NAME), false, plan(tableInfo, [eqFilter(CATEGORY)], asc(CATEGORY, NAME)), 'category is pinned by a residual filter');
		expectSorted(plan(tableInfo, [], asc(CATEGORY, NAME)), 'category is not pinned');
	});

	it('does NOT walk an index for an ordering every column of which is pinned', () => {
		// Any access path delivers it; reading the table through the index would buy nothing.
		const tableInfo = makeTableInfo([{ name: 'idx_name', columns: [{ index: NAME }] }]);
		expectSorted(plan(tableInfo, [eqFilter(CATEGORY)], asc(CATEGORY)), 'nothing left to order');
	});

	it('does NOT walk for mixed directions', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] }]);
		expectSorted(plan(tableInfo, [], [...asc(CATEGORY), ...desc(NAME)]), 'asc then desc');
	});

	it('does NOT walk over a nullable column in either direction, except under a NULL-excluding filter', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_s', columns: [{ index: S }] }]);
		expectSorted(plan(tableInfo, [], asc(S)), 'nullable, ascending');
		expectSorted(plan(tableInfo, [], desc(S)), 'nullable, descending');
		walkOf('idx_s', asc(S), false, plan(tableInfo, [notNullFilter(S)], asc(S)), '`s is not null` keeps every NULL out of the walk');
		walkOf('idx_s', desc(S), true, plan(tableInfo, [notNullFilter(S)], desc(S)), 'and descending');
	});

	it('does NOT walk a column whose bytes do not order as its values', () => {
		for (const [column, why] of [[PRICE, 'numeric'], [CITY, 'nocase column'], [SPAN, 'timespan compares by elapsed time'], [DATA, 'blob']] as const) {
			const tableInfo = makeTableInfo([{ name: 'idx_c', columns: [{ index: column }] }]);
			expectSorted(plan(tableInfo, [], asc(column)), why);
		}
		const nocaseIndex = makeTableInfo([{ name: 'idx_name_nocase', columns: [{ index: NAME, collation: 'NOCASE' }] }]);
		expectSorted(plan(nocaseIndex, [], asc(NAME)), 'nocase on the index column');
	});

	it('never walks a partial index', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_name_part', columns: [{ index: NAME }], predicate: { type: 'literal' } }]);
		expectSorted(plan(tableInfo, [], asc(NAME)), 'a partial index holds only the rows its predicate admits');
	});

	it('loses to a selective seek on another index that leaves a small sort', () => {
		const tableInfo = {
			...makeTableInfo([
				{ name: 'idx_name', columns: [{ index: NAME }] },
				{ name: 'idx_cat', columns: [{ index: CATEGORY }] },
			]),
			statistics: {
				rowCount: TABLE_ROWS,
				columnStats: new Map([['category', { distinctCount: 100_000, nullCount: 0 }]]),
			},
		};
		const result = plan(tableInfo, [eqFilter(CATEGORY)], asc(NAME));
		expect(result.indexName, 'ten rows sorted beat a million fetched in order').to.equal('idx_cat');
		expectSorted(result, 'the seek index does not order name');
	});

	it('beats the same seek when the seek matches most of the table', () => {
		// One category: the seek fetches every row and the engine then sorts a million of them,
		// which costs more than walking a million index entries into the required order.
		const tableInfo = {
			...makeTableInfo([
				{ name: 'idx_name', columns: [{ index: NAME }] },
				{ name: 'idx_cat', columns: [{ index: CATEGORY }] },
			]),
			statistics: {
				rowCount: TABLE_ROWS,
				columnStats: new Map([['category', { distinctCount: 1, nullCount: 0 }]]),
			},
		};
		const result = plan(tableInfo, [eqFilter(CATEGORY)], asc(NAME));
		expect(result.handledFilters, 'the category filter stays a residual above the walk').to.deep.equal([false]);
		walkOf('idx_name', asc(NAME), false, result, 'walk plus residual');
	});

	it('beats a scan the engine would sort, with a filter on an unindexed column left as a residual', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_name', columns: [{ index: NAME }] }]);
		const result = plan(tableInfo, [eqFilter(PRICE)], asc(NAME));
		expect(result.handledFilters).to.deep.equal([false]);
		walkOf('idx_name', asc(NAME), false, result, 'walk plus residual');
	});

	it('prices a plan-time limit as the rows it stops after', () => {
		// Only `rule-minmax-index-boundary` sends one today; a user's LIMIT never reaches the module.
		const tableInfo = makeTableInfo([{ name: 'idx_name', columns: [{ index: NAME }] }]);
		const whole = plan(tableInfo, [], desc(NAME));
		const one = plan(tableInfo, [], desc(NAME), { limit: 1, offset: 0 });
		walkOf('idx_name', desc(NAME), true, one, 'a bounded walk is still the walk');
		expect(one.cost, 'one entry read is priced far below the whole index').to.be.below(whole.cost / 1000);
		expect(one.rows, 'rows stays the table size: the engine applies the limit').to.equal(whole.rows);
	});
});

describe('Ordering-claim guard (end-to-end SQL)', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
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
	});

	it('returns ASC + BINARY + TEXT rows correctly ordered when the guard DOES push the ordering down', async () => {
		// Positive control: this is the one envelope the guard promises (ASC/BINARY/TEXT), so
		// `providesOrdering` is set and the engine skips its own sort — trusting the tree to
		// deliver order. If the tree ever mis-delivered a promised ordering, only an end-to-end
		// assertion like this would catch it (the planner tests only prove the promise is made).
		await db.exec(`
			CREATE TABLE prods_text (
				id INTEGER PRIMARY KEY,
				category TEXT,
				name TEXT
			) USING optimystic('tree://test/ord_text')
		`);
		await db.exec('CREATE INDEX idx_cat_name ON prods_text(category, name)');
		await db.exec(`
			INSERT INTO prods_text (id, category, name) VALUES
				(1, 'A', 'cherry'),
				(2, 'A', 'apple'),
				(3, 'A', 'banana')
		`);

		const rows = await collectRows(db.eval("SELECT name FROM prods_text WHERE category = 'A' ORDER BY category, name"));
		expect(rows.map(r => r.name)).to.deep.equal(['apple', 'banana', 'cherry']);
	});

	it('returns numeric-suffix rows in true ascending order across an exponent-10 boundary', async () => {
		// Prices 2, 5, 10, 100 in one category. The tree's toExponential(15) keying would
		// yield 10, 100, 2, 5; a correct result must be 2, 5, 10, 100.
		await db.exec(`
			CREATE TABLE prods_num (
				id INTEGER PRIMARY KEY,
				category TEXT,
				price REAL
			) USING optimystic('tree://test/ord_num')
		`);
		await db.exec('CREATE INDEX idx_cat_price ON prods_num(category, price)');
		await db.exec(`
			INSERT INTO prods_num (id, category, price) VALUES
				(1, 'A', 10),
				(2, 'A', 100),
				(3, 'A', 2),
				(4, 'A', 5)
		`);

		const rows = await collectRows(db.eval("SELECT price FROM prods_num WHERE category = 'A' ORDER BY category, price"));
		expect(rows.map(r => r.price)).to.deep.equal([2, 5, 10, 100]);
	});

	it('returns DESC-ordered text rows in true descending order', async () => {
		// Served by a backward walk of the sought prefix now, where the engine used to sort.
		await db.exec(`
			CREATE TABLE prods_desc (
				id INTEGER PRIMARY KEY,
				category TEXT,
				name TEXT
			) USING optimystic('tree://test/ord_desc')
		`);
		await db.exec('CREATE INDEX idx_cat_name ON prods_desc(category, name DESC)');
		await db.exec(`
			INSERT INTO prods_desc (id, category, name) VALUES
				(1, 'A', 'apple'),
				(2, 'A', 'cherry'),
				(3, 'A', 'banana')
		`);

		const rows = await collectRows(db.eval("SELECT name FROM prods_desc WHERE category = 'A' ORDER BY category, name DESC"));
		expect(rows.map(r => r.name)).to.deep.equal(['cherry', 'banana', 'apple']);
	});
});
