/**
 * A range predicate on an indexed column served by seeking the index (GitHub #52): `t > ?` on a
 * TEXT column walks the index tree from the bound, in either direction, instead of reading the
 * whole table and discarding most of it.
 *
 * The suite is differential: every statement runs against an Optimystic table and a Quereus
 * memory table holding the same rows, and the two must return the same rows — in the same order
 * where the statement orders them. The memory table is the engine's own definition of which rows a
 * predicate admits, in particular for the bounds the tree cannot apply itself (a value holding a
 * UTF-16 unit at or above U+D800, a number bound against a text column), which `indexRangeScan` in
 * `src/schema/index-walk.ts` turns into a test on each row.
 *
 * Single-node and in-memory (`default_transactor: 'test'`): the read path under test knows
 * nothing about meshes.
 */

import { expect } from 'chai';
import { Database, IndexConstraintOp } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { indexRangeScan } from '../src/schema/index-walk.js';
import { indexKeyFromValues } from '../src/schema/index-manager.js';
import { KEY_PREFIX_END, KEY_PRESENT_START } from '../src/schema/key-encoding.js';
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
	steps: SqlRow[];
	ops: (SqlValue | undefined)[];
	described: string;
}

async function planOf(db: Database, query: string): Promise<PlanSummary> {
	const steps = await collectRows(db.eval('select op, detail from query_plan(?)', [query]));
	return { steps, ops: steps.map(s => s.op), described: steps.map(s => `${s.op}: ${s.detail}`).join('\n') };
}

/** The statement seeks `index` and reads the table through nothing else. */
async function expectRangeSeek(db: Database, query: string, index: string): Promise<PlanSummary> {
	const plan = await planOf(db, query);
	expect(plan.steps.some(s => s.op === 'INDEXSEEK' && String(s.detail).includes(index)), plan.described).to.equal(true);
	expect(plan.ops, plan.described).to.not.include('SEQSCAN');
	return plan;
}

const COLUMNS = '(id text primary key, t text, g text, u text null, n integer)';

/**
 * Text that exercises the bounds: values that are prefixes of one another (`a`, `ab`, `a\x00`,
 * `a\x01` — where `> 'a'` must keep every longer value and `<= 'a'` none of them), the empty
 * string, CJK below the surrogate range, and the pairs on which code-unit and code-point order
 * disagree — an emoji (a surrogate pair) against text at or above U+E000 — plus lone surrogates.
 */
const TEXTS: readonly string[] = [
	'a', 'ab', 'a\x00', 'a\x00b', 'a\x01', '', 'b', '中', 'z',
	'😀', '～', '', 'a😀', 'a～', 'a', 'a😀b', 'a～b',
	'\uD83D', '\uDC00', 'x\uD83D', 'x￿',
];

/** Every text twice, under two primary keys, so equal index values are ordered by the key. */
const ROWS: readonly (readonly SqlValue[])[] = TEXTS.flatMap((t, i) => [
	[`r${String(i).padStart(2, '0')}a`, t, i % 2 === 0 ? 'x' : 'y', i % 3 === 0 ? null : `u${t}`, i % 4],
	[`r${String(i).padStart(2, '0')}b`, t, i % 2 === 0 ? 'y' : 'x', i % 3 === 1 ? null : `u${t}`, (i + 1) % 4],
]);

/** Bounds to range on: values present in the table, values between them, and values past both ends. */
const BOUNDS: readonly string[] = ['a', 'ab', 'a\x00', 'a\x01', '', 'b', '中', 'z', 'aa', 'a\x00a', 'ba', '\x01', 'zz'];

const OPS = ['>', '>=', '<', '<='] as const;

const byId = (rows: SqlRow[]): SqlRow[] => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

describe('A secondary index serves range predicates', () => {
	let db: Database;

	/** The rows of `select id, t, u from <table> <clause>`, as returned. */
	const rowsOf = async (table: string, clause: string, params: SqlValue[] = []): Promise<SqlRow[]> =>
		await collectRows(db.eval(`select id, t, u from ${table} ${clause}`, params));

	/** Both tables answer `clause` with the same rows in the same order. */
	const expectSameOrder = async (clause: string, params: SqlValue[] = []): Promise<SqlRow[]> => {
		const seeked = await rowsOf('ranged', clause, params);
		const model = await rowsOf('model', clause, params);
		expect(seeked, `${clause} ${JSON.stringify(params)}`).to.deep.equal(model);
		return seeked;
	};

	/** Both tables answer `clause` with the same rows, in whatever order. */
	const expectSameRows = async (clause: string, params: SqlValue[] = []): Promise<SqlRow[]> => {
		const seeked = await rowsOf('ranged', clause, params);
		const model = await rowsOf('model', clause, params);
		expect(byId(seeked), `${clause} ${JSON.stringify(params)}`).to.deep.equal(byId(model));
		return seeked;
	};

	/** The one `index:seek` line a statement over `index` emits while `body` runs. */
	const traceOf = async (index: string, body: () => Promise<void>): Promise<ReturnType<typeof indexSeekTraces>[number]> => {
		const lines = await captureTrace(body);
		const [trace] = indexSeekTraces(lines).filter(t => t.index === index);
		expect(trace, `the seek emits one index:seek line for ${index}`).to.not.equal(undefined);
		return trace!;
	};

	before(async () => {
		({ db } = openDatabase());
		await db.exec(`create table ranged ${COLUMNS} using optimystic('tree://test/range_main')`);
		await db.exec('create index idx_t on ranged(t)');
		await db.exec('create index idx_gt on ranged(g, t)');
		await db.exec('create index idx_u on ranged(u)');
		await db.exec(`create table model ${COLUMNS} using memory`);
		for (const row of ROWS) {
			await db.exec('insert into ranged (id, t, g, u, n) values (?, ?, ?, ?, ?)', [...row]);
			await db.exec('insert into model (id, t, g, u, n) values (?, ?, ?, ?, ?)', [...row]);
		}
	});

	describe('one bound, on every value present, between and past the ends', () => {
		for (const op of OPS) {
			it(`t ${op} ? seeks the index, forwards and backwards, and agrees with the memory table`, async () => {
				await expectRangeSeek(db, `select id, t, u from ranged where t ${op} ? order by t, id`, 'idx_t');
				await expectRangeSeek(db, `select id, t, u from ranged where t ${op} ? order by t desc, id desc`, 'idx_t');
				await expectRangeSeek(db, `select id, t, u from ranged where t ${op} ?`, 'idx_t');
				for (const bound of BOUNDS) {
					await expectSameOrder(`where t ${op} ? order by t, id`, [bound]);
					await expectSameOrder(`where t ${op} ? order by t desc, id desc`, [bound]);
					await expectSameRows(`where t ${op} ?`, [bound]);
				}
			});
		}

		it('seeks on a literal bound as it does on a parameter', async () => {
			await expectRangeSeek(db, `select id, t, u from ranged where t > 'a' order by t, id`, 'idx_t');
			await expectSameOrder(`where t > 'a' order by t, id`);
			await expectSameOrder(`where t <= 'ab' order by t desc, id desc`);
		});
	});

	describe('two bounds', () => {
		const PAIRS: readonly (readonly [string, string])[] = [
			['a', 'b'], ['a', 'a'], ['', 'z'], ['a\x00', 'ab'], ['a', 'a\x01'], ['中', 'zz'], ['b', 'a'],
		];

		for (const lower of ['>', '>='] as const) {
			for (const upper of ['<', '<='] as const) {
				it(`t ${lower} ? and t ${upper} ? seeks between the two, forwards and backwards`, async () => {
					await expectRangeSeek(db, `select id, t, u from ranged where t ${lower} ? and t ${upper} ? order by t, id`, 'idx_t');
					for (const [low, high] of PAIRS) {
						await expectSameOrder(`where t ${lower} ? and t ${upper} ? order by t, id`, [low, high]);
						await expectSameOrder(`where t ${lower} ? and t ${upper} ? order by t desc, id desc`, [low, high]);
					}
				});
			}
		}

		it('returns nothing, without error, for a range whose ends cross', async () => {
			await expectRangeSeek(db, `select id, t, u from ranged where t > 'z' and t < 'a'`, 'idx_t');
			expect(await expectSameRows(`where t > 'z' and t < 'a'`)).to.deep.equal([]);
		});

		it('claims both halves of a between from one expression, leaving nothing to filter', async () => {
			const query = `select id, t, u from ranged where t between 'a' and 'b' order by t, id`;
			const plan = await expectRangeSeek(db, query, 'idx_t');
			expect(plan.ops, plan.described).to.not.include('FILTER');
			expect(plan.ops, plan.described).to.not.include('SORT');
			await expectSameOrder(`where t between 'a' and 'b' order by t, id`);
		});

		it('prints the two tree keys it walked between as low:high on the index:seek line', async () => {
			// `> 'a'` starts past every entry of 'a' (the framed value, then KEY_PREFIX_END);
			// `< 'b'` ends at the framed 'b' itself, exclusive.
			const trace = await traceOf('idx_t', async () => { await rowsOf('ranged', `where t > 'a' and t < 'b'`); });
			expect(trace.seek).to.equal('%02a%00%03:%02b%00');
			expect(trace.dir).to.equal('asc');
		});
	});

	describe('bounds the tree cannot apply', () => {
		it('seeks nothing for a bound of NULL', async () => {
			let rows: SqlRow[] = [];
			const trace = await traceOf('idx_t', async () => { rows = await rowsOf('ranged', 'where t > ?', [null]); });
			expect(rows).to.deep.equal([]);
			expect(trace.seek, 'nothing sought').to.equal('unset');
			expect(trace.matched).to.equal(0);
			expect(await rowsOf('model', 'where t > ?', [null])).to.deep.equal([]);
		});

		it('answers a number bound to a text column as the memory table does', async () => {
			// The engine types a parameter from the value first bound to it and plans a mixed-type
			// comparison as a cast of the column (`cast(t as numeric) > 5`), which is not a
			// constraint, so neither a number literal nor a number parameter reaches this module as
			// a bound: both tables scan, and they agree. The module's own answer for such a bound,
			// should one ever arrive, is pinned at the function level below.
			for (const op of OPS) {
				await expectSameRows(`where t ${op} ?`, [5]);
			}
		});

		it('tests each row against a bound holding a surrogate or a unit at or above U+E000', async () => {
			for (const bound of ['😀', '～', '', 'a😀', 'a～', '\uD83D', 'x￿']) {
				for (const op of OPS) {
					await expectSameOrder(`where t ${op} ? order by t, id`, [bound]);
					await expectSameOrder(`where t ${op} ? order by t desc, id desc`, [bound]);
				}
			}
			const trace = await traceOf('idx_t', async () => { await rowsOf('ranged', 'where t > ? and t < ?', ['😀', 'z']); });
			expect(trace.seek, 'the lower end is open in the tree and the upper is applied by it').to.equal('%02:%02z%00');
		});
	});

	describe('with a prefix, an ordering, residuals and a collation', () => {
		it('seeks the range after an equality prefix, backwards, for the newest-page query', async () => {
			const query = `select id, t, u from ranged where g = ? and t > ? order by t desc, id desc limit 10`;
			const plan = await expectRangeSeek(db, query, 'idx_gt');
			expect(plan.ops, plan.described).to.not.include('SORT');
			expect(plan.ops, plan.described).to.include('LIMITOFFSET');
			expect(plan.described, 'the index is walked backwards').to.match(/INDEXSEEK: .*idx_gt.*DESC/);

			let rows: SqlRow[] = [];
			const trace = await traceOf('idx_gt', async () => {
				rows = await rowsOf('ranged', `where g = ? and t > ? order by t desc, id desc limit 10`, ['x', 'a']);
			});
			expect(rows).to.deep.equal(await rowsOf('model', `where g = ? and t > ? order by t desc, id desc limit 10`, ['x', 'a']));
			expect(trace.dir).to.equal('desc');
			expect(trace.seek, 'both keys carry the framed prefix').to.equal('%02x%00%02a%00%03:%02x%00%03');
			await expectSameOrder(`where g = ? and t <= ? order by t, id`, ['y', 'a～']);
		});

		it('claims the first of two bounds on one side and leaves the second as a residual', async () => {
			const query = `select id, t, u from ranged where t > ? and t > ? order by t, id`;
			const plan = await expectRangeSeek(db, query, 'idx_t');
			expect(plan.ops, plan.described).to.include('FILTER');
			await expectSameOrder(`where t > ? and t > ? order by t, id`, ['a', 'b']);
			await expectSameOrder(`where t > ? and t > ? order by t, id`, ['b', 'a']);
		});

		it('leaves a range under another collation to the engine, over a scan', async () => {
			const query = `select id, t, u from ranged where t collate nocase > ? order by t, id`;
			const plan = await planOf(db, query);
			expect(plan.ops, plan.described).to.not.include('INDEXSEEK');
			expect(plan.ops, plan.described).to.include('FILTER');
			await expectSameOrder(`where t collate nocase > ? order by t, id`, ['A']);
		});

		it('never returns a NULL-keyed row for an upper bound on a nullable column', async () => {
			await expectRangeSeek(db, `select id, t, u from ranged where u < ? order by u, id`, 'idx_u');
			const rows = await expectSameOrder(`where u < ? order by u, id`, ['uz']);
			expect(rows.length, 'rows were returned').to.be.greaterThan(0);
			expect(rows.every(row => row.u !== null), 'none of them NULL').to.equal(true);
			await expectSameRows(`where u <= ?`, ['u中']);
		});

		it('sees rows staged in the open transaction', async () => {
			await db.exec('begin');
			try {
				for (const table of ['ranged', 'model']) {
					await db.exec(`insert into ${table} (id, t, g, u, n) values ('s1', 'aa', 'x', 'uaa', 9), ('s2', 'a～a', 'y', null, 9)`);
					await db.exec(`delete from ${table} where id = 'r01a'`);
				}
				const rows = await expectSameOrder(`where t > 'a' order by t, id`);
				expect(rows.map(r => r.id)).to.include('s1').and.include('s2').and.not.include('r01a');
			} finally {
				await db.exec('rollback');
			}
		});
	});
});

describe('indexRangeScan: a bound of another type than the column\'s', () => {
	// Unreachable through SQL today (above), so pinned here: the tree brackets every present value
	// on that side, and each row is tested by the engine's own ranking, a number below any text.
	it('leaves the bound out of the tree and tests each row, failing a NULL', () => {
		const column = 1;
		const scan = indexRangeScan(indexKeyFromValues([]), column, { op: IndexConstraintOp.GT, value: 5 }, { op: IndexConstraintOp.LT, value: 'b' }, false);
		expect(scan, 'a range is built').to.not.equal(undefined);
		expect(scan!.low, 'every present value, from the lowest').to.equal(KEY_PRESENT_START);
		expect(scan!.high, 'the upper bound the tree applies').to.equal(indexKeyFromValues(['b']));
		expect(scan!.rowTest, 'the lower bound is tested on the rows').to.not.equal(undefined);
		expect(scan!.rowTest!(['r1', 'a'])).to.equal(true);
		expect(scan!.rowTest!(['r2', ''])).to.equal(true);
		expect(scan!.rowTest!(['r3', null])).to.equal(false);
		expect(indexRangeScan(indexKeyFromValues([]), column, undefined, { op: IndexConstraintOp.LE, value: 5 }, false)!.high, 'open above')
			.to.equal(KEY_PREFIX_END);
	});
});
