/**
 * The row counts `getBestAccessPlan` reports, and the join plan they produce (GitHub #44).
 *
 * Quereus costs a join from two numbers it gets from different places: an index seek's row count
 * from this module's answer, a sequential scan's from the catalog. When the module's fallback
 * for an un-analyzed table differed from the engine's, the filtered side of a join was counted
 * a thousand times larger than the unfiltered side and the join planned as a nested loop — one
 * seek per outer row. The estimates below follow Quereus's memory module, so the two backends
 * plan alike.
 */

import { expect } from 'chai';
import { Database, TEXT_TYPE, buildColumnIndexMap } from '@quereus/quereus';
import type { BestAccessPlanResult, ColumnSchema, ColumnStatistics, PredicateConstraint, SqlValue, TableIndexSchema, TableSchema } from '@quereus/quereus';
import { OptimysticModule } from '../dist/index.js';
import register from '../dist/plugin.js';

// --- planner-level fixtures -------------------------------------------------

const CATEGORY = 1, NAME = 2;
const TABLE_ROWS = 1000;

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

/** A table `(id text primary key, category text, name text)` with the given indexes and statistics. */
function makeTable(indexes: TableIndexSchema[], columnStats: Record<string, ColumnStatistics>): TableSchema {
	const columns = [textColumn('id', 1), textColumn('category'), textColumn('name')];
	return {
		name: 't',
		schemaName: 'main',
		columns,
		columnIndexMap: buildColumnIndexMap(columns),
		primaryKeyDefinition: [{ index: 0 }],
		checkConstraints: [],
		vtabModuleName: 'optimystic',
		isView: false,
		indexes,
		statistics: { rowCount: TABLE_ROWS, columnStats: new Map(Object.entries(columnStats)) },
	};
}

function eq(columnIndex: number): PredicateConstraint {
	return { columnIndex, op: '=', usable: true, value: 'x' };
}

function plan(table: TableSchema, filters: PredicateConstraint[]): BestAccessPlanResult {
	const mod = new OptimysticModule({} as never, {} as never);
	return mod.getBestAccessPlan({} as never, table, { columns: [], filters, estimatedRows: TABLE_ROWS });
}

const stats = (distinctCount: number): ColumnStatistics => ({ distinctCount, nullCount: 0 });
const idxCategory: TableIndexSchema = { name: 'idx_category', columns: [{ index: CATEGORY }] };

describe('Access-plan row estimates (getBestAccessPlan)', () => {
	it('sizes an indexed equality from the column\'s distinct count', () => {
		const result = plan(makeTable([idxCategory], { category: stats(4) }), [eq(CATEGORY)]);
		expect(result.indexName).to.equal('idx_category');
		expect(result.rows).to.equal(TABLE_ROWS / 4);
	});

	it('falls back to a tenth of the table when the column has no statistics', () => {
		const result = plan(makeTable([idxCategory], { name: stats(4) }), [eq(CATEGORY)]);
		expect(result.indexName).to.equal('idx_category');
		expect(result.rows).to.equal(TABLE_ROWS * 0.1);
	});

	it('reports one row, as a set, for an equality on every column of a unique index', () => {
		const unique: TableIndexSchema = { name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }], unique: true };
		const result = plan(makeTable([unique], {}), [eq(CATEGORY), eq(NAME)]);
		expect(result.indexName).to.equal('idx_cat_name');
		expect(result.rows).to.equal(1);
		expect(result.isSet).to.equal(true);
	});

	it('never plans through a partial index, unique or not: it holds only the rows its predicate admits', () => {
		const partial: TableIndexSchema = {
			name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }], unique: true,
			predicate: { type: 'literal', value: 1 } as TableIndexSchema['predicate'],
		};
		const result = plan(makeTable([partial], {}), [eq(CATEGORY), eq(NAME)]);
		expect(result.indexName).to.equal(undefined);
		expect(result.handledFilters).to.deep.equal([false, false]);
		expect(result.isSet).to.equal(false);
	});

	it('prefers the longer equality match when statistics leave the two estimates tied', () => {
		const idxCatName: TableIndexSchema = { name: 'idx_cat_name', columns: [{ index: CATEGORY }, { index: NAME }] };
		const result = plan(makeTable([idxCategory, idxCatName], {}), [eq(CATEGORY), eq(NAME)]);
		expect(result.indexName).to.equal('idx_cat_name');
		expect(result.handledFilters).to.deep.equal([true, true]);
	});
});

// --- SQL harness ------------------------------------------------------------

type SqlRow = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<SqlRow>): Promise<SqlRow[]> => {
	const rows: SqlRow[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

describe('Join plan over un-analyzed Optimystic tables (GitHub #44)', () => {
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

	it('hash-joins the scan to a seek on the filtered side\'s index, as memory tables do', async () => {
		await db.exec(`create table bundles (id text primary key, type_id text, name text) using optimystic('tree://test/plan_bundles')`);
		await db.exec('create index idx_bundles_type on bundles(type_id)');
		await db.exec(`
			create table log_entry_items (
				entry_id text,
				item_id text,
				source_bundle_id text null,
				primary key (entry_id, item_id)
			) using optimystic('tree://test/plan_items')
		`);
		await db.exec('create index idx_lei_source on log_entry_items(source_bundle_id)');

		const bundles = Array.from({ length: 20 }, (_, i) => `('b${i}', 't${i % 4}', 'bundle ${i}')`);
		await db.exec(`insert into bundles (id, type_id, name) values ${bundles.join(', ')}`);
		const items = Array.from({ length: 60 }, (_, i) => `('e${i % 6}', 'i${i}', 'b${i % 20}')`);
		await db.exec(`insert into log_entry_items (entry_id, item_id, source_bundle_id) values ${items.join(', ')}`);

		const query = `
			select lei.source_bundle_id as id, count(*) as n
			from log_entry_items lei join bundles b on b.id = lei.source_bundle_id
			where b.type_id = 't1' group by lei.source_bundle_id`;
		const steps = await collectRows(db.eval('select op, detail from query_plan(?)', [query]));
		const ops = steps.map(s => s.op);
		const described = steps.map(s => `${s.op}: ${s.detail}`).join('\n');

		expect(ops, described).to.include('HASHJOIN');
		expect(ops, described).to.not.include('JOIN');
		expect(steps.some(s => s.op === 'INDEXSEEK' && /bundles/.test(String(s.detail)) && /idx_bundles_type/.test(String(s.detail))), described)
			.to.equal(true);
	});
});
