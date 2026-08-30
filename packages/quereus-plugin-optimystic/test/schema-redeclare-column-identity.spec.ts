/**
 * A persisted index must keep pointing at the COLUMN it was declared on — not at the
 * POSITION that column happened to occupy — across a `CREATE TABLE` that re-declares
 * the same table with its columns in a different order (no `DROP TABLE` in between).
 *
 * The defect (tickets: bug-persisted-index-outlives-the-columns-it-points-at): the
 * catalog record stored an index column as a position into the table's column list,
 * and a re-declare replaces that list while the index list survives the write. After a
 * swap of `a` and `b`, "position 2" silently meant `a`:
 *   - `select * from t where a = 'aaa'` returned nothing for a row that exists;
 *   - a column declared UNIQUE admitted a duplicate, and rejected a legitimate value,
 *     because its enforcement tree was ALSO named by position (`_uniq_1`) and so read
 *     the other column's key space.
 *
 * Generalised rather than pinned to those two cases: one table with an indexed column,
 * a UNIQUE column and an indexed+ordinary column is re-declared under EVERY permutation
 * of its non-PK columns, and after each the oracle is (a) every indexed seek agrees
 * with a full scan (`expectIndexAgreesWithScan` — routing required, so a silent
 * full-scan fallback cannot pass it), (b) a duplicate in the UNIQUE column is rejected
 * while a fresh value is accepted. Any field that starts outliving its column list —
 * not only the two fixed — shows up here. A final hydrate-only session repeats the
 * oracle over the catalog as it was last written.
 *
 * Each permutation re-issues its `CREATE INDEX IF NOT EXISTS` siblings too, the way an
 * application's apply-schema does: the planner routes seeks from Quereus's in-memory
 * catalog, which a bare `CREATE TABLE` in a fresh session leaves index-less.
 *
 * The one case that is not a permutation — a re-declare that DROPS a column a persisted
 * index still covers — must be refused with an actionable message (it used to go
 * through silently and NULL-key every later row), and drop-then-recreate must still work.
 *
 * Single-process, in-memory (`MemoryRawStorage` shared across plugin instances, one
 * Database per "session") — the same harness as schema-catalog-index-durability.spec.ts.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { queryAll, expectIndexAgreesWithScan } from './query-helpers.js';

function buildSharedLocalTransactor(storage: MemoryRawStorage): ITransactor {
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
	return {
		async get(blockGets) { return await repo.get(blockGets); },
		async getStatus(_trxRefs) { throw new Error('getStatus not implemented in test transactor'); },
		async pend(request) { return await repo.pend(request); },
		async commit(request) { return await repo.commit(request); },
		async cancel(trxRef) { return await repo.cancel(trxRef); },
	} as ITransactor;
}

function registerWithSharedTransactor(db: Database, transactor: ITransactor) {
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	});
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return plugin;
}

/** Every ordering of `items` (n! of them; three columns here, so six). */
function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((head, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [head, ...rest]),
	);
}

/** Run `body` and return what it threw, failing the test if it resolved instead. */
async function captureFailure(body: () => Promise<unknown>, why: string): Promise<Error> {
	let caught: Error | undefined;
	try {
		await body();
	} catch (error) {
		caught = error as Error;
	}
	expect(caught, why).to.not.equal(undefined);
	return caught!;
}

/** Column declarations keyed by name; `b` carries the UNIQUE, `a` and `c` are indexed. */
const COLUMN_DDL: Record<string, string> = {
	a: 'a text',
	b: 'b text unique',
	c: 'c text',
};
const NON_PK_COLUMNS = ['a', 'b', 'c'] as const;
const URI = 'tree://redeclare/t';

function tableDdl(order: readonly string[]): string {
	return `create table t (id integer primary key, ${order.map(col => COLUMN_DDL[col]!).join(', ')}) using optimystic('${URI}')`;
}

const INDEX_DDL = [
	`create index if not exists idx_a on t (a)`,
	`create index if not exists idx_c on t (c)`,
];

/**
 * The oracle after any (re-)open: indexed seeks agree with the scan and route through
 * an index; the UNIQUE column still rejects a duplicate and accepts a fresh value.
 * `round` keeps the inserted rows distinct across sessions.
 */
async function expectColumnIdentityIntact(db: Database, round: number): Promise<void> {
	await expectIndexAgreesWithScan(db, 't', 'a');
	await expectIndexAgreesWithScan(db, 't', 'c');

	const scanned = await queryAll(db, `select * from t`);
	const viaB = await queryAll(db, `select * from t where b = 'b1'`);
	expect(viaB, `round ${round}: the seed row must be reachable through b`).to.deep.equal(
		scanned.filter(row => row['b'] === 'b1'),
	);
	expect(viaB, `round ${round}: exactly one row carries b='b1'`).to.have.lengthOf(1);

	const failure = await captureFailure(
		() => db.exec(`insert into t (id, a, b, c) values (${100 + round}, 'dup-a', 'b1', 'dup-c')`),
		`round ${round}: a duplicate in UNIQUE column b must be rejected`,
	);
	expect(failure.message).to.match(/UNIQUE constraint failed/);

	await db.exec(`insert into t (id, a, b, c) values (${10 + round}, 'a${10 + round}', 'b${10 + round}', 'c${10 + round}')`);
	expect(
		await queryAll(db, `select id from t where b = 'b${10 + round}'`),
		`round ${round}: a fresh value in UNIQUE column b must be accepted`,
	).to.deep.equal([{ id: 10 + round }]);
}

describe('Schema re-declare keeps index and UNIQUE column identity', function () {
	this.timeout(30_000);

	it('survives every permutation of the non-PK columns, then a hydrate-only open', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		// Round 0: the declaring session, in the canonical order.
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(tableDdl(NON_PK_COLUMNS));
			for (const ddl of INDEX_DDL) await dbA.exec(ddl);
			await dbA.exec(`insert into t (id, a, b, c) values (1, 'a1', 'b1', 'c1')`);
			await dbA.exec(`insert into t (id, a, b, c) values (2, 'a2', 'b2', 'c2')`);
			await expectColumnIdentityIntact(dbA, 0);
		} finally {
			dbA.close();
		}

		// Rounds 1..6: a fresh session re-declares the table in each column order — no
		// DROP, no hydrate (the CREATE TABLE really executes against the persisted
		// catalog) — then re-issues the index DDL as an apply-schema would.
		let round = 0;
		for (const order of permutations(NON_PK_COLUMNS)) {
			round++;
			const db = new Database();
			registerWithSharedTransactor(db, shared);
			try {
				await db.exec(tableDdl(order));
				for (const ddl of INDEX_DDL) await db.exec(ddl);
				await expectColumnIdentityIntact(db, round);
			} catch (error) {
				throw new Error(`column order (${order.join(', ')}), round ${round}: ${(error as Error).message}`);
			} finally {
				db.close();
			}
		}

		// Hydrate-only open over the catalog as the last permutation left it.
		const dbH = new Database();
		const pluginH = registerWithSharedTransactor(dbH, shared);
		try {
			const hydrated = await pluginH.hydrate(dbH);
			expect(hydrated.tables).to.equal(1);
			expect(hydrated.indexes, 'both declared indexes must survive every re-declare').to.equal(2);
			await expectColumnIdentityIntact(dbH, round + 1);
			// Two seed rows, plus one accepted insert per round 0..round+1.
			expect(await queryAll(dbH, `select count(*) as n from t`)).to.deep.equal([{ n: 2 + (round + 2) }]);
		} finally {
			dbH.close();
		}
	});

	it('refuses a re-declare that drops a column a persisted index covers, until the index or table is dropped', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		try {
			await dbA.exec(`create table s (id integer primary key, a text, b text) using optimystic('tree://redeclare/s')`);
			await dbA.exec(`create index idx_sb on s (b)`);
			await dbA.exec(`insert into s (id, a, b) values (1, 'aaa', 'bbb')`);
		} finally {
			dbA.close();
		}

		// Pre-fix this went through silently: the catalog kept idx_sb at "position 2"
		// over a two-column table, and every later row was indexed under the NULL key.
		const dbB = new Database();
		registerWithSharedTransactor(dbB, shared);
		try {
			const failure = await captureFailure(
				() => dbB.exec(`create table s (id integer primary key, a text) using optimystic('tree://redeclare/s')`),
				'a re-declare without an indexed column must be refused',
			);
			expect(failure.message).to.include(
				"Cannot re-declare table 's' without column 'b': persisted index 'idx_sb' covers it. Drop the index or the table first.",
			);
		} finally {
			dbB.close();
		}

		// The persisted record is untouched by the refused write.
		const dbC = new Database();
		const pluginC = registerWithSharedTransactor(dbC, shared);
		try {
			await pluginC.hydrate(dbC);
			expect(await queryAll(dbC, `select * from s where b = 'bbb'`)).to.deep.equal([{ id: 1, a: 'aaa', b: 'bbb' }]);

			// The way out the message names: drop the table (gravestoning its catalog
			// entry), then declare the narrower shape. DROP TABLE gravestones the CATALOG
			// entry only — the data tree at the URI keeps its rows — so the new row takes a
			// fresh primary key rather than colliding with the old row 1.
			//
			// This re-declare also has to clear the storage-adoption guard the drop arms
			// (see drop-table-orphan-rows.spec.ts): declaring over storage a gravestone
			// still describes is refused when it ADDS a column the stored rows cannot
			// supply, or changes the primary key those rows are keyed under. Neither
			// applies here — this shape only DROPS column `b` and keeps `id` as the key,
			// so every column it declares is still backed by real stored values and the
			// guard lets it through. Adding a column here, or re-keying on `a`, would now
			// be refused instead.
			await dbC.exec(`drop table s`);
			await dbC.exec(`create table s (id integer primary key, a text) using optimystic('tree://redeclare/s')`);
			await dbC.exec(`insert into s (id, a) values (2, 'fresh')`);
			expect(await queryAll(dbC, `select a from s where id = 2`)).to.deep.equal([{ a: 'fresh' }]);
		} finally {
			dbC.close();
		}
	});
});
