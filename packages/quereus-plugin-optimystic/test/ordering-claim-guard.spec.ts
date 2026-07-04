/**
 * Regression tests for the ordering-claim guard.
 *
 * The Optimystic index tree is opened with a raw lexicographic string comparator
 * and iterated forward only, so it can only *deliver* an ASC, BINARY, TEXT
 * ordering. `getBestAccessPlan` must therefore only set `providesOrdering` (which
 * tells the Quereus engine it may skip its own sort) for that envelope. Promising
 * a DESC, numeric, or non-BINARY ordering makes the engine trust the vtab and
 * return genuinely mis-ordered rows.
 *
 * The `getBestAccessPlan` tests below are the deterministic reproduction: they
 * feed `requiredOrdering` straight into the planner, so they do NOT depend on how
 * the optimizer shapes an ORDER BY clause. Before the guard each asserted-absent
 * `providesOrdering` was present (the old helper only compared desc flags); after
 * the guard it is undefined and the engine sorts.
 *
 * The SQL-level `describe` at the bottom is an end-to-end correctness guard: it
 * asserts the user-visible row order is right. Whether it *reproduces* the bug
 * depends on the optimizer passing the compound ORDER BY through to the vtab; the
 * planner-level tests are the ones that guarantee fail-before / pass-after.
 */

import { expect } from 'chai';
import { OptimysticModule } from '../dist/index.js';
import { PhysicalType } from '@quereus/quereus';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';

// --- planner-level fixtures -------------------------------------------------

/** Column-index constants for the synthetic table used by the planner tests. */
const ID = 0, CATEGORY = 1, PRICE = 2, NAME = 3, CITY = 4;

function makeColumn(name: string, physicalType: PhysicalType, collation = 'BINARY'): any {
	return {
		name,
		logicalType: { name, physicalType },
		notNull: false,
		primaryKey: name === 'id',
		pkOrder: name === 'id' ? 1 : 0,
		defaultValue: null,
		collation,
		generated: false,
	};
}

/** A table: id INTEGER PK, category TEXT, price REAL, name TEXT, city TEXT NOCASE. */
function makeTableInfo(indexes: Array<{ name: string; columns: Array<{ index: number; desc?: boolean }> }>): any {
	const columns = [
		makeColumn('id', PhysicalType.INTEGER),
		makeColumn('category', PhysicalType.TEXT),
		makeColumn('price', PhysicalType.REAL),
		makeColumn('name', PhysicalType.TEXT),
		makeColumn('city', PhysicalType.TEXT, 'NOCASE'),
	];
	return {
		name: 't',
		schemaName: 'main',
		columns,
		columnIndexMap: new Map(columns.map((c, i) => [c.name.toLowerCase(), i])),
		primaryKeyDefinition: [{ index: ID }],
		checkConstraints: [],
		vtabModule: {},
		vtabModuleName: 'optimystic',
		isView: false,
		indexes,
		estimatedRows: 1_000_000,
	};
}

function eqFilter(columnIndex: number): any {
	return { columnIndex, op: '=', usable: true, value: 'x' };
}

function plan(
	tableInfo: any,
	filters: any[],
	requiredOrdering: Array<{ columnIndex: number; desc: boolean }>
): any {
	const mod = new OptimysticModule({} as any, {} as any);
	return mod.getBestAccessPlan({} as any, tableInfo, { columns: [], filters, requiredOrdering } as any);
}

// --- SQL harness ------------------------------------------------------------

type SqlRow = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<SqlRow>): Promise<SqlRow[]> => {
	const rows: SqlRow[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

describe('Ordering-claim guard (getBestAccessPlan.providesOrdering)', () => {
	it('promises ordering for an ASC + BINARY + TEXT prefix (safe case still pushed down)', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] }]);
		const result = plan(
			tableInfo,
			[eqFilter(CATEGORY)],
			[{ columnIndex: CATEGORY, desc: false }, { columnIndex: NAME, desc: false }]
		);
		expect(result.indexName, 'index seek chosen').to.equal('idx_cat_name');
		expect(result.providesOrdering, 'ASC/BINARY/TEXT ordering is provided').to.not.be.undefined;
		expect(result.providesOrdering).to.deep.equal([
			{ columnIndex: CATEGORY, desc: false },
			{ columnIndex: NAME, desc: false },
		]);
	});

	it('does NOT promise ordering when a suffix column is numeric (REAL price)', () => {
		// Tree keys the REAL price via toExponential(15), which is not order-preserving
		// (10, 100, 2, 5 sort ahead of one another wrongly). The engine must sort.
		const tableInfo = makeTableInfo([{ name: 'idx_cat_price', columns: [{ index: CATEGORY }, { index: PRICE }] }]);
		const result = plan(
			tableInfo,
			[eqFilter(CATEGORY)],
			[{ columnIndex: CATEGORY, desc: false }, { columnIndex: PRICE, desc: false }]
		);
		expect(result.indexName, 'index seek still chosen (only the ordering claim is dropped)').to.equal('idx_cat_price');
		expect(result.providesOrdering, 'numeric ordering must NOT be promised').to.be.undefined;
	});

	it('does NOT promise ordering for a DESC column (forward-only tree cannot reverse)', () => {
		// name is TEXT + BINARY, so only the DESC direction disqualifies it.
		const tableInfo = makeTableInfo([{ name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME, desc: true }] }]);
		const result = plan(
			tableInfo,
			[eqFilter(CATEGORY)],
			[{ columnIndex: CATEGORY, desc: false }, { columnIndex: NAME, desc: true }]
		);
		expect(result.indexName).to.equal('idx_cat_name');
		expect(result.providesOrdering, 'DESC ordering must NOT be promised').to.be.undefined;
	});

	it('does NOT promise ordering for a non-BINARY (NOCASE) column', () => {
		// The tree compares raw code units (BINARY); a NOCASE column would order differently.
		const tableInfo = makeTableInfo([{ name: 'idx_cat_city', columns: [{ index: CATEGORY }, { index: CITY }] }]);
		const result = plan(
			tableInfo,
			[eqFilter(CATEGORY)],
			[{ columnIndex: CATEGORY, desc: false }, { columnIndex: CITY, desc: false }]
		);
		expect(result.indexName).to.equal('idx_cat_city');
		expect(result.providesOrdering, 'non-BINARY ordering must NOT be promised').to.be.undefined;
	});

	it('does NOT promise a single-column DESC ordering on the leading index column', () => {
		const tableInfo = makeTableInfo([{ name: 'idx_cat', columns: [{ index: CATEGORY }] }]);
		const result = plan(tableInfo, [eqFilter(CATEGORY)], [{ columnIndex: CATEGORY, desc: true }]);
		expect(result.indexName).to.equal('idx_cat');
		expect(result.providesOrdering).to.be.undefined;
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
