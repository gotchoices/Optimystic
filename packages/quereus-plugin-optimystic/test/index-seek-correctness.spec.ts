/**
 * The property behind every index seek: a row an index-routed seek returns must satisfy the
 * seek, and no primary key may come back twice.
 *
 * That is not a nicety, it is what the module PROMISES. `getBestAccessPlan` reports the
 * equality filters it matched as `handledFilters[i] === true`, and quereus drops the residual
 * predicate for every constraint the seek then consumes (`reattachUnconsumedConstraints` in
 * `@quereus/quereus/src/planner/rules/access/rule-select-access-path.ts` reattaches only the
 * ones it did not). So whatever `executeIndexScan` yields is the answer — nothing downstream
 * re-checks it.
 *
 * Four separate wrong answers were observed before the seek verified its entries, and they
 * were four instances of this one property failing: a row that had moved off the indexed
 * value came back for its old value; a NULL-bound parameter matched the NULL-keyed row
 * although `x = NULL` is UNKNOWN under SQL three-valued logic; a seek on the leading column
 * of a composite index returned one row twice, once per entry; and the whole-index framing
 * had no reachable caller to say so. This spec pins the PROPERTY rather than those four
 * instances, over a matrix of index shapes (single-column text, single-column integer,
 * composite `(text, integer null)`) and seek forms (literal, bound parameter, full-width,
 * partial prefix, NULL-valued), so the next instance is caught without anyone having to
 * think of it.
 *
 * Each shape runs twice: over a healthy index, and over one deliberately left holding an
 * entry its row moved off — the state a writer that was not maintaining the index produces
 * (`withIndexStagingPatched` with `stageNewEntryOnly`). The leftover's presence is asserted
 * before the seeks run, so a patch that stopped working could not make this pass vacuously.
 *
 * Single-node and in-memory (`default_transactor: 'test'`): the read path under test knows
 * nothing about meshes.
 */

import { expect } from 'chai';
import { Database, type SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { countIndexScans, queryAll, readIndexIntegrity } from './query-helpers.js';
import { stageNewEntryOnly, withIndexStagingPatched } from './index-staging-patch.js';
import { captureTrace, indexSeekTraces } from './trace-helpers.js';

type Plugin = ReturnType<typeof register>;
type QueryRow = Record<string, SqlValue>;

/** One equality seek: the leading index columns it constrains, and the value of each. */
interface Seek {
	columns: string[];
	values: SqlValue[];
}

/** One index shape, its rows, and every seek the matrix runs against it. */
interface Shape {
	table: string;
	/** Column list for CREATE TABLE, primary key `Id` first. */
	columns: string;
	index: string;
	indexColumns: string[];
	inserts: string[];
	/** Moves one row off its indexed value; run with index staging patched to leave the old entry. */
	move: string;
	seeks: Seek[];
}

const SHAPES: Shape[] = [
	{
		table: 'SeekText',
		columns: 'Id integer primary key, Token text null',
		index: 'seektext_by_token',
		indexColumns: ['Token'],
		inserts: [
			`insert into SeekText (Id, Token) values (1, 'tok-a')`,
			`insert into SeekText (Id, Token) values (2, 'tok-a')`,
			`insert into SeekText (Id, Token) values (3, 'tok-b')`,
			`insert into SeekText (Id, Token) values (4, null)`,
		],
		move: `update SeekText set Token = 'tok-z' where Id = 3`,
		seeks: [
			// A value two rows share, so under-reporting changes a row SET rather than emptying it.
			{ columns: ['Token'], values: ['tok-a'] },
			// The value row 3 moves off: still held before the move, held by nobody after it.
			{ columns: ['Token'], values: ['tok-b'] },
			// The value row 3 moves to: held by nobody before, by row 3 after.
			{ columns: ['Token'], values: ['tok-z'] },
			// NULL: a row really is stored under the NULL tag, and `Token = NULL` must still
			// match nothing.
			{ columns: ['Token'], values: [null] },
		],
	},
	{
		table: 'SeekNum',
		columns: 'Id integer primary key, Num integer null',
		index: 'seeknum_by_num',
		indexColumns: ['Num'],
		inserts: [
			`insert into SeekNum (Id, Num) values (1, 10)`,
			`insert into SeekNum (Id, Num) values (2, 10)`,
			`insert into SeekNum (Id, Num) values (3, 20)`,
			`insert into SeekNum (Id, Num) values (4, null)`,
		],
		move: `update SeekNum set Num = 99 where Id = 3`,
		seeks: [
			{ columns: ['Num'], values: [10] },
			{ columns: ['Num'], values: [20] },
			{ columns: ['Num'], values: [99] },
			{ columns: ['Num'], values: [null] },
		],
	},
	{
		table: 'SeekPair',
		columns: 'Id integer primary key, C text, D integer null',
		index: 'seekpair_by_cd',
		indexColumns: ['C', 'D'],
		inserts: [
			`insert into SeekPair (Id, C, D) values (1, 'x', 1)`,
			`insert into SeekPair (Id, C, D) values (2, 'x', 2)`,
			`insert into SeekPair (Id, C, D) values (3, 'y', null)`,
			// A NULL in a TRAILING, unconstrained index column is ordinary and must keep
			// matching a prefix seek on C.
			`insert into SeekPair (Id, C, D) values (4, 'x', null)`,
		],
		move: `update SeekPair set D = 9 where Id = 2`,
		seeks: [
			// Partial prefix — shorter than the index. After the move, BOTH of row 2's entries
			// prefix-match 'x', so a check that only compared the constrained prefix would
			// return row 2 twice.
			{ columns: ['C'], values: ['x'] },
			{ columns: ['C'], values: ['y'] },
			// Full width.
			{ columns: ['C', 'D'], values: ['x', 1] },
			{ columns: ['C', 'D'], values: ['x', 2] },
			{ columns: ['C', 'D'], values: ['x', 9] },
			// NULL in the constrained trailing column: UNKNOWN, so no row — not even row 4,
			// whose entry really is keyed under the NULL tag.
			{ columns: ['C', 'D'], values: ['x', null] },
		],
	},
];

/** SQL `=` between a returned cell and a seek value: NULL equals nothing, and a number
 *  compares numerically whichever of `number`/`bigint` the engine handed back. */
function sqlEqual(cell: SqlValue | undefined, value: SqlValue): boolean {
	if (cell === null || cell === undefined || value === null) return false;
	if (typeof cell === 'number' || typeof cell === 'bigint') {
		return (typeof value === 'number' || typeof value === 'bigint') && Number(cell) === Number(value);
	}
	return cell === value;
}

/** A value as it reads in a failure message. */
function render(value: SqlValue | undefined): string {
	if (value === null || value === undefined) return 'null';
	return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** A value as a SQL literal. Only called for non-NULL values (see {@link seekForms}). */
function renderLiteral(value: SqlValue): string {
	return typeof value === 'string' ? `'${value.replace(/'/g, `''`)}'` : String(value);
}

/** Column-order-independent, type-tagged rendering, so two row sets compare as multisets. */
function canonicalRow(row: QueryRow): string {
	return JSON.stringify(Object.keys(row).sort().map(name => {
		const value = row[name];
		if (value === null || value === undefined) return [name, 'null'];
		if (typeof value === 'number' || typeof value === 'bigint') return [name, `n:${value}`];
		return [name, `${typeof value}:${String(value)}`];
	}));
}

/** The statement forms this seek is exercised through. */
interface SeekForm {
	sql: string;
	params?: SqlValue[];
}

/**
 * A seek runs as a bound parameter always, and as inline literals too when it constrains no
 * NULL. A LITERAL null is deliberately excluded: quereus folds `col = null` to an empty
 * result at plan time (`isLiteralNullEquality`), so the statement never reaches a seek and
 * the routing assertion below would fail for the right reason but the wrong test. The
 * dynamic form is the one the engine leaves to the module, and is the one that matters here.
 */
function seekForms(shape: Shape, seek: Seek): SeekForm[] {
	const bound = seek.columns.map(column => `${column} = ?`).join(' and ');
	const forms: SeekForm[] = [
		{ sql: `select * from ${shape.table} where ${bound}`, params: [...seek.values] },
	];
	if (!seek.values.some(value => value === null)) {
		const literal = seek.columns
			.map((column, i) => `${column} = ${renderLiteral(seek.values[i]!)}`)
			.join(' and ');
		forms.push({ sql: `select * from ${shape.table} where ${literal}` });
	}
	return forms;
}

/**
 * Run every seek of `shape` in every form and assert the property of each: it was answered
 * through the index, every row it returned satisfies it, no primary key came back twice, and
 * the row set is exactly what a full scan says matches.
 *
 * The last assertion is the strongest and subsumes the first two for a healthy table, but all
 * three are kept: the first two are the property the `handledFilters` claim promises, and they
 * name what is wrong directly instead of as a set difference.
 */
async function expectEverySeekSound(db: Database, shape: Shape): Promise<void> {
	const scanned = await queryAll(db, `select * from ${shape.table}`) as QueryRow[];

	for (const seek of shape.seeks) {
		const predicate = seek.columns
			.map((column, i) => `${column} = ${render(seek.values[i])}`)
			.join(' and ');
		const expected = scanned.filter(row => seek.columns.every((column, i) => sqlEqual(row[column], seek.values[i]!)));

		for (const form of seekForms(shape, seek)) {
			let rows: QueryRow[] = [];
			const scans = await countIndexScans(async () => {
				rows = await queryAll(db, form.sql, form.params) as QueryRow[];
			});
			const where = `${form.params === undefined ? 'literal' : 'parameter'} seek ${predicate}`;

			expect(scans, `${where}: must be answered through an index seek, not a full scan`)
				.to.be.greaterThan(0);

			for (const row of rows) {
				for (const [i, column] of seek.columns.entries()) {
					expect(
						sqlEqual(row[column], seek.values[i]!),
						`${where}: returned a row that does not satisfy it — ` +
						`${column} is ${render(row[column])} in row ${canonicalRow(row)}`,
					).to.equal(true);
				}
			}

			const ids = rows.map(row => String(row['Id']));
			expect(
				new Set(ids).size,
				`${where}: returned a primary key more than once (Ids ${ids.join(', ')})`,
			).to.equal(ids.length);

			expect(
				rows.map(canonicalRow).sort(),
				`${where}: must return exactly the rows a full scan says match`,
			).to.deep.equal(expected.map(canonicalRow).sort());
		}
	}
}

/** A fresh in-memory database holding `shape`'s table, index and rows. */
async function openShape(shape: Shape): Promise<{ db: Database; plugin: Plugin }> {
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
	await db.exec(
		`create table ${shape.table} (${shape.columns}) ` +
		`using optimystic('tree://seek-correctness/${shape.table}')`,
	);
	await db.exec(`create index ${shape.index} on ${shape.table}(${shape.indexColumns.join(', ')})`);
	for (const insert of shape.inserts) await db.exec(insert);
	return { db, plugin };
}

describe('an index-routed seek returns only rows that satisfy it', () => {
	for (const shape of SHAPES) {
		describe(`${shape.table}, index on (${shape.indexColumns.join(', ')})`, () => {
			let db: Database;
			let plugin: Plugin;

			beforeEach(async () => {
				({ db, plugin } = await openShape(shape));
			});

			afterEach(() => db.close());

			it('over an index that accounts for every row', async () => {
				await expectEverySeekSound(db, shape);
			});

			it('over an index still holding an entry its row moved off', async () => {
				await withIndexStagingPatched(plugin, shape.table, 'updateIndexEntries', stageNewEntryOnly,
					() => db.exec(shape.move));

				// Without this the run below could pass over a perfectly clean index and prove
				// nothing about the damaged case.
				const orphans = (await readIndexIntegrity(db, shape.table)).flatMap(report => report.orphaned);
				expect(orphans.map(orphan => orphan.reason), 'the move must leave exactly one entry behind')
					.to.deep.equal(['stale-value']);

				await expectEverySeekSound(db, shape);
			});
		});
	}
});

/**
 * The verification corrects the answer silently — which is the point, but it would leave an
 * operator with no way to tell a healthy index from one the seek is compensating for. The
 * `rejected=` field of the `index:seek` trace line is that signal, so it is pinned here: a
 * healthy seek must report zero, and a seek over a leftover entry must report it.
 */
describe('the index:seek trace reports what the seek verification rejected', () => {
	const shape = SHAPES[0]!;
	let db: Database;
	let plugin: Plugin;

	beforeEach(async () => {
		({ db, plugin } = await openShape(shape));
	});

	afterEach(() => db.close());

	/** `[matched, rejected]` for every seek of this shape's index during `body`. */
	async function seekCounts(body: () => Promise<unknown>): Promise<number[][]> {
		const lines = await captureTrace(async () => { await body(); });
		return indexSeekTraces(lines)
			.filter(trace => trace.index === shape.index)
			.map(trace => [trace.matched, trace.rejected]);
	}

	it('counts an entry its row moved off, and counts nothing on a healthy index', async () => {
		expect(
			await seekCounts(() => queryAll(db, `select Id from SeekText where Token = 'tok-b'`)),
			'a healthy index: one entry, none rejected',
		).to.deep.equal([[1, 0]]);

		await withIndexStagingPatched(plugin, shape.table, 'updateIndexEntries', stageNewEntryOnly,
			() => db.exec(shape.move));

		expect(
			await seekCounts(() => queryAll(db, `select Id from SeekText where Token = 'tok-b'`)),
			'the leftover entry: still produced by the descent, and rejected against its row',
		).to.deep.equal([[1, 1]]);
	});
});
