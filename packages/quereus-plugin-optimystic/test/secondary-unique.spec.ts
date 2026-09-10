/**
 * Coverage for SECONDARY UNIQUE constraint enforcement on the optimystic vtab
 * (see ticket `control-db-network-backed`).
 *
 * Optimystic stores each table as a B-tree keyed by its PRIMARY KEY, so PK uniqueness
 * is structural. Every OTHER declared UNIQUE constraint (`col … unique`, table-level
 * `unique (cols)`) is the vtab's responsibility — the in-memory vtab enforces them,
 * and the CadreControl schema's single-use anti-replay columns (`StampId`, nullable
 * `MemberPrivateKey`) rely on that enforcement. Network-backing the control DB surfaced
 * that the optimystic vtab previously ignored secondary UNIQUE constraints; these tests
 * pin the added enforcement (a duplicate of a unique value is rejected with a
 * `UNIQUE constraint failed` result), independent of cadre-core.
 *
 * Runs against the in-memory `test` transactor.
 */

import { expect } from 'chai';
import { ConstraintError, Database, StatusCode } from '@quereus/quereus';
import type { DatabaseDataChangeEvent, SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';
import { expectIndexAgreesWithScan } from './query-helpers.js';

function createDb(): { db: Database } {
	const db = new Database();
	const config = {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db };
}

async function scalar(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return Number((row as { v: number }).v);
	}
	throw new Error('scalar query returned no rows');
}

async function expectThrows(fn: () => Promise<unknown>, match?: RegExp): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (match) {
			const message = e instanceof Error ? e.message : String(e);
			expect(message).to.match(match);
		}
		return;
	}
	throw new Error('expected operation to throw, but it resolved');
}

/** Every row `sql` returns as a positional tuple (bigints as numbers), so a whole
 *  surviving row set compares with one deep-equal. */
async function rowsOf(db: Database, sql: string): Promise<unknown[][]> {
	const out: unknown[][] = [];
	for await (const row of db.eval(sql)) {
		out.push(Object.values(row as Record<string, SqlValue>).map(v => typeof v === 'bigint' ? Number(v) : v));
	}
	return out;
}

/**
 * Assert `fn` is rejected as the engine's own constraint violation — a
 * `ConstraintError` carrying `StatusCode.CONSTRAINT` (19) — with a message matching
 * `match`. Matching the message alone is not enough: a concurrency-guard refusal
 * rendered with the same `UNIQUE constraint failed` wording surfaced as a bare `Error`
 * (no code) and passed a message-only assertion unnoticed.
 */
async function expectConstraintError(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
	let caught: unknown;
	try {
		await fn();
	} catch (e) {
		caught = e;
	}
	if (caught === undefined) throw new Error('expected operation to be rejected, but it resolved');
	const detail = caught instanceof Error
		? `${caught.name} (code=${(caught as { code?: unknown }).code}): ${caught.message}`
		: String(caught);
	expect(caught, `expected the engine's ConstraintError, got ${detail}`).to.be.instanceOf(ConstraintError);
	expect((caught as ConstraintError).code, detail).to.equal(StatusCode.CONSTRAINT);
	expect((caught as Error).message).to.match(match);
}

describe('Secondary UNIQUE constraint enforcement on the optimystic vtab', function () {
	this.timeout(20000);

	it('rejects a duplicate of a non-PK UNIQUE column (different PK, same value)', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniq/basic')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);

			// Different PK, same Stamp → only the secondary UNIQUE can reject it.
			await expectThrows(
				() => db.exec(`insert into T (Id, Stamp) values (2, 'a')`),
				/UNIQUE constraint failed/,
			);
			// A distinct Stamp inserts fine; the rejected row never landed.
			await db.exec(`insert into T (Id, Stamp) values (3, 'b')`);
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(2);
			expect(await scalar(db, `select count(*) as v from T where Stamp = 'a'`)).to.equal(1);
		} finally {
			db.close();
		}
	});

	it('allows multiple NULLs in a nullable UNIQUE column but rejects duplicate non-nulls', async () => {
		const { db } = createDb();
		try {
			// `text null unique` mirrors the control schema's nullable Strand.MemberPrivateKey
			// (Quereus columns are NOT NULL unless `null` is explicit).
			await db.exec(`
				create table N (Id integer primary key, Tag text null unique)
					using optimystic('tree://uniq/nullable')
			`);
			// SQL UNIQUE does not constrain NULLs — several NULL rows coexist.
			await db.exec(`insert into N (Id, Tag) values (1, null)`);
			await db.exec(`insert into N (Id, Tag) values (2, null)`);
			expect(await scalar(db, `select count(*) as v from N`)).to.equal(2);

			// Non-null duplicates are still rejected.
			await db.exec(`insert into N (Id, Tag) values (3, 'x')`);
			await expectThrows(
				() => db.exec(`insert into N (Id, Tag) values (4, 'x')`),
				/UNIQUE constraint failed/,
			);
			expect(await scalar(db, `select count(*) as v from N`)).to.equal(3);
		} finally {
			db.close();
		}
	});

	it('insert or ignore swallows a secondary-UNIQUE collision without adding a row', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniq/ignore')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'dup')`);
			await db.exec(`insert or ignore into T (Id, Stamp) values (2, 'dup')`);
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(1);
			expect(await scalar(db, `select Id as v from T where Stamp = 'dup'`)).to.equal(1);
		} finally {
			db.close();
		}
	});

	it('rejects two rows sharing a unique value staged in ONE transaction', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniq/intxn')
			`);
			// The probe reads staged-this-transaction rows, so the second insert sees the
			// first's staged Stamp and collides before commit.
			await db.exec('begin');
			await db.exec(`insert into T (Id, Stamp) values (1, 'same')`);
			await expectThrows(
				() => db.exec(`insert into T (Id, Stamp) values (2, 'same')`),
				/UNIQUE constraint failed/,
			);
			// The aborted statement's row never persists; the first row commits.
			await db.exec('commit');
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(1);
		} finally {
			db.close();
		}
	});

	it('enforces a composite table-level UNIQUE (a,b) but allows a partial-overlap', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table C (Id integer primary key, A text, B text, unique (A, B))
					using optimystic('tree://uniq/composite')
			`);
			await db.exec(`insert into C (Id, A, B) values (1, 'x', 'y')`);
			// Same (A,B) → rejected.
			await expectThrows(
				() => db.exec(`insert into C (Id, A, B) values (2, 'x', 'y')`),
				/UNIQUE constraint failed/,
			);
			// Same A but different B → allowed (the pair differs).
			await db.exec(`insert into C (Id, A, B) values (3, 'x', 'z')`);
			expect(await scalar(db, `select count(*) as v from C`)).to.equal(2);
		} finally {
			db.close();
		}
	});

	it('bulk-inserts many distinct unique values then rejects a duplicate (index-backed probe, not O(N^2) scan)', async () => {
		// At N=300 an O(N^2) full-scan probe does ~45k row decodes; the index-backed
		// probe does one point range per insert. This asserts CORRECTNESS at a size
		// that would be painfully slow under the old scan; it is a floor, not a strict
		// probe-count assertion.
		const N = 300;
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniq/bulk')
			`);
			await db.exec('begin');
			for (let i = 0; i < N; i++) {
				await db.exec(`insert into T (Id, Stamp) values (${i}, 's${i}')`);
			}
			await db.exec('commit');
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(N);

			// A duplicate of a value buried in the middle is still caught by the probe.
			await expectThrows(
				() => db.exec(`insert into T (Id, Stamp) values (${N}, 's150')`),
				/UNIQUE constraint failed/,
			);
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(N);
		} finally {
			db.close();
		}
	});

	it('UPDATE that moves a row onto another row\'s unique value is rejected; self-value and free moves allowed', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniq/updatemove')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
			await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);

			// Moving row 1's Stamp onto row 2's value collides.
			await expectThrows(
				() => db.exec(`update T set Stamp = 'b' where Id = 1`),
				/UNIQUE constraint failed/,
			);
			// Setting row 1's Stamp to its OWN current value must NOT self-collide
			// (excludeKey skips the row's own index entry).
			await db.exec(`update T set Stamp = 'a' where Id = 1`);
			// Moving onto a genuinely free value succeeds.
			await db.exec(`update T set Stamp = 'c' where Id = 1`);

			expect(await scalar(db, `select count(*) as v from T`)).to.equal(2);
			expect(await scalar(db, `select Id as v from T where Stamp = 'c'`)).to.equal(1);
			expect(await scalar(db, `select Id as v from T where Stamp = 'b'`)).to.equal(2);
		} finally {
			db.close();
		}
	});

	it('rollback frees a rolled-back insert\'s unique value (no orphaned index entry)', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniq/rollback')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);

			// Stage an insert of Stamp 'b' inside a transaction, then roll it back. The
			// synthesized unique tree is snapshotted before staging and restored on
			// rollback, so 'b' must be free afterwards.
			await db.exec('begin');
			await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);
			await db.exec('rollback');

			// If the rolled-back row left an orphaned unique-index entry, this insert
			// would be wrongly rejected.
			await db.exec(`insert into T (Id, Stamp) values (3, 'b')`);
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(2);
			expect(await scalar(db, `select Id as v from T where Stamp = 'b'`)).to.equal(3);
		} finally {
			db.close();
		}
	});

	describe('declared conflict-action matrix (secondary UNIQUE)', () => {
		// {ignore, replace, abort, fail, rollback} × {statement-level, constraint-level},
		// generalized over the two INSERT write shapes that reach a secondary-UNIQUE
		// decision and over the two kinds of enforcing tree, so every arm stays covered
		// as the write paths are edited.
		//
		// Precedence under test: statement-level `insert or <action>` > the action the
		// constraint itself declares (`unique on conflict <action>`) > ABORT. FAIL and
		// ROLLBACK are honoured as ABORT when they resolve from the vtab's structured
		// constraint result (parity with the engine's in-memory module — see
		// resolveConflictAction in optimystic-module.ts), so all three rejecting
		// actions assert the same observable outcome: statement rejected with the
		// engine's ConstraintError, table unchanged.
		//
		// Write shapes:
		//  - 'fresh insert' — the new row's PK is free; only the secondary UNIQUE collides.
		//  - 'replace on existing PK' — the new row's PK is held by another row and that
		//    collision resolves REPLACE, so the replacement must still clear the secondary
		//    UNIQUE against the rival holding the value at a DIFFERENT PK. Statement-level
		//    spelling is `insert or <action>`, which resolves the PK collision too — so
		//    only REPLACE reaches the secondary decision, while IGNORE and the rejecting
		//    actions settle on the PK itself (hence the `T.Id` message there).
		//    Constraint-level spelling declares the PK `on conflict replace` and writes a
		//    plain insert — the only way a rejecting or ignoring secondary action is
		//    reached through this branch.
		//
		// Enforcing trees:
		//  - 'synthesized' — the column-level `unique` alone, enforced through the
		//    `_uniq_` tree the vtab builds for it;
		//  - 'declared' — plus a plain `create index` over the same column, which becomes
		//    the enforcing tree AND lets `where Stamp = …` route through an index seek
		//    (checked against a full scan by expectIndexAgreesWithScan).
		const outcomes = {
			ignore: 'ignored',
			replace: 'replaced',
			abort: 'rejected',
			fail: 'rejected',
			rollback: 'rejected',
		} as const;

		for (const shape of ['fresh insert', 'replace on existing PK'] as const) {
			for (const tree of ['synthesized', 'declared'] as const) {
				for (const spelling of ['statement', 'constraint'] as const) {
					for (const [action, outcome] of Object.entries(outcomes)) {
						it(`${shape}, ${tree} tree: ${spelling}-level ${action} on a secondary-UNIQUE collision is ${outcome}`, async () => {
							const { db } = createDb();
							try {
								const replaceShape = shape === 'replace on existing PK';
								const pkDeclared = replaceShape && spelling === 'constraint' ? ' on conflict replace' : '';
								const ucDeclared = spelling === 'constraint' ? ` on conflict ${action}` : '';
								const slug = `${replaceShape ? 'pkreplace' : 'fresh'}-${tree}-${spelling}-${action}`;
								await db.exec(`
									create table T (Id integer primary key${pkDeclared}, Stamp text not null unique${ucDeclared})
										using optimystic('tree://uniq/matrix-${slug}')
								`);
								if (tree === 'declared') await db.exec(`create index ix_stamp on T (Stamp)`);
								// Row 1 holds the contested value; on the replace shape row 2 is the
								// row being replaced, holding a value of its own.
								await db.exec(`insert into T (Id, Stamp) values (1, 'dup')`);
								if (replaceShape) await db.exec(`insert into T (Id, Stamp) values (2, 'own')`);
								const allRows = `select Id, Stamp from T order by Id`;
								const before = await rowsOf(db, allRows);

								const collide = spelling === 'statement'
									? `insert or ${action} into T (Id, Stamp) values (2, 'dup')`
									: `insert into T (Id, Stamp) values (2, 'dup')`;

								if (outcome === 'rejected') {
									const violated = replaceShape && spelling === 'statement' ? 'Id' : 'Stamp';
									await expectConstraintError(
										() => db.exec(collide),
										new RegExp(`^UNIQUE constraint failed: T\\.${violated}$`),
									);
									expect(await rowsOf(db, allRows)).to.deep.equal(before);
								} else if (outcome === 'ignored') {
									await db.exec(collide);
									expect(await rowsOf(db, allRows)).to.deep.equal(before);
								} else {
									// REPLACE evicts the rival at its own (different) PK; on the
									// replace shape the write also overwrites row 2 in place.
									await db.exec(collide);
									expect(await rowsOf(db, allRows)).to.deep.equal([[2, 'dup']]);
								}

								if (tree === 'declared') await expectIndexAgreesWithScan(db, 'T', 'Stamp');

								// The enforcing tree must hold exactly the owner's entry for 'dup':
								// once that owner is deleted the value is free, so a plain insert
								// under a fresh PK lands. An entry an eviction left behind would make
								// the unique guard refuse it; a second live owner would survive the
								// delete's predicate only if the index missed it.
								await db.exec(`delete from T where Stamp = 'dup'`);
								await db.exec(`insert into T (Id, Stamp) values (99, 'dup')`);
								expect(await rowsOf(db, `select Id from T where Stamp = 'dup'`)).to.deep.equal([[99]]);
							} finally {
								db.close();
							}
						});
					}
				}
			}
		}

		it('statement-level OR wins over the constraint-declared action (or ignore beats declared replace)', async () => {
			const { db } = createDb();
			try {
				await db.exec(`
					create table P (Id integer primary key, Stamp text not null unique on conflict replace)
						using optimystic('tree://uniq/matrix-precedence')
				`);
				await db.exec(`insert into P (Id, Stamp) values (1, 'dup')`);
				// Declared REPLACE would evict row 1; the statement-level IGNORE must win
				// and swallow the write instead.
				await db.exec(`insert or ignore into P (Id, Stamp) values (2, 'dup')`);
				expect(await scalar(db, `select count(*) as v from P`)).to.equal(1);
				expect(await scalar(db, `select Id as v from P where Stamp = 'dup'`)).to.equal(1);
			} finally {
				db.close();
			}
		});
	});

	describe('insert or replace on an existing primary key (secondary UNIQUE)', () => {
		// The replacement is a new row image at an occupied PK. It must clear every
		// secondary UNIQUE against OTHER rows exactly as a fresh insert does, while the
		// row it overwrites — on its way out — never counts as a collision.
		for (const tree of ['synthesized', 'declared'] as const) {
			async function stampTable(db: Database, uri: string, columns: string): Promise<void> {
				await db.exec(`create table T (${columns}) using optimystic('${uri}')`);
				if (tree === 'declared') await db.exec(`create index ix_stamp on T (Stamp)`);
				await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
				await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);
			}
			const checkIndex = async (db: Database) => {
				if (tree === 'declared') await expectIndexAgreesWithScan(db, 'T', 'Stamp');
			};

			it(`${tree} tree: a value-preserving replacement (same PK, same unique value, another column changed) is admitted`, async () => {
				const { db } = createDb();
				try {
					await stampTable(db, `tree://uniq/pkreplace-${tree}-preserve`,
						'Id integer primary key, Stamp text not null unique, W text null');
					// Statement-level REPLACE: the row's own entry for 'a' must not be
					// probed up as a collision (it would self-evict or refuse).
					await db.exec(`insert or replace into T (Id, Stamp, W) values (1, 'a', 'y')`);
					expect(await rowsOf(db, `select Id, Stamp, W from T order by Id`))
						.to.deep.equal([[1, 'a', 'y'], [2, 'b', null]]);
					await checkIndex(db);
					// The value is still owned — by row 1 only.
					await expectConstraintError(
						() => db.exec(`insert into T (Id, Stamp) values (3, 'a')`),
						/^UNIQUE constraint failed: T\.Stamp$/,
					);
				} finally {
					db.close();
				}
			});

			it(`${tree} tree: a PK declared on conflict replace preserves its own value under a default-ABORT UNIQUE`, async () => {
				const { db } = createDb();
				try {
					// The ABORT-resolving shape: a plain insert whose PK collision resolves
					// REPLACE from the PK's declaration. Excluding the replaced row keeps
					// the replacement from rejecting itself.
					await stampTable(db, `tree://uniq/pkreplace-${tree}-preserve-declared`,
						'Id integer primary key on conflict replace, Stamp text not null unique, W text null');
					await db.exec(`insert into T (Id, Stamp, W) values (1, 'a', 'y')`);
					expect(await rowsOf(db, `select Id, Stamp, W from T order by Id`))
						.to.deep.equal([[1, 'a', 'y'], [2, 'b', null]]);
					await checkIndex(db);
				} finally {
					db.close();
				}
			});

			it(`${tree} tree: a PK declared on conflict replace is rejected as a ConstraintError when its new value belongs to another row`, async () => {
				const { db } = createDb();
				try {
					await stampTable(db, `tree://uniq/pkreplace-${tree}-abort-default`,
						'Id integer primary key on conflict replace, Stamp text not null unique');
					// Previously refused by the index tree's concurrency guard at staging
					// time: a bare Error with no code, so a client catching ConstraintError
					// did not recognise it.
					await expectConstraintError(
						() => db.exec(`insert into T (Id, Stamp) values (1, 'b')`),
						/^UNIQUE constraint failed: T\.Stamp$/,
					);
					expect(await rowsOf(db, `select Id, Stamp from T order by Id`)).to.deep.equal([[1, 'a'], [2, 'b']]);
					await checkIndex(db);
				} finally {
					db.close();
				}
			});

			it(`${tree} tree: a replacement moving to a free unique value drops the old entry and adds the new one`, async () => {
				const { db } = createDb();
				try {
					await stampTable(db, `tree://uniq/pkreplace-${tree}-free`,
						'Id integer primary key, Stamp text not null unique');
					await db.exec(`insert or replace into T (Id, Stamp) values (1, 'c')`);
					expect(await rowsOf(db, `select Id, Stamp from T order by Id`)).to.deep.equal([[1, 'c'], [2, 'b']]);
					await checkIndex(db);
					// 'a' is free again; 'c' is now taken.
					await db.exec(`insert into T (Id, Stamp) values (3, 'a')`);
					await expectConstraintError(
						() => db.exec(`insert into T (Id, Stamp) values (4, 'c')`),
						/^UNIQUE constraint failed: T\.Stamp$/,
					);
					expect(await rowsOf(db, `select Id, Stamp from T order by Id`))
						.to.deep.equal([[1, 'c'], [2, 'b'], [3, 'a']]);
				} finally {
					db.close();
				}
			});

			it(`${tree} tree: a rival staged earlier in the same open transaction is evicted`, async () => {
				const { db } = createDb();
				try {
					await db.exec(`create table T (Id integer primary key, Stamp text not null unique)
						using optimystic('tree://uniq/pkreplace-${tree}-intxn')`);
					if (tree === 'declared') await db.exec(`create index ix_stamp on T (Stamp)`);
					await db.exec('begin');
					await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
					await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);
					await db.exec(`insert or replace into T (Id, Stamp) values (1, 'b')`);
					await db.exec('commit');
					expect(await rowsOf(db, `select Id, Stamp from T order by Id`)).to.deep.equal([[1, 'b']]);
					await checkIndex(db);
				} finally {
					db.close();
				}
			});
		}

		it('a UNIQUE declared by CREATE UNIQUE INDEX is resolved the same way', async () => {
			const { db } = createDb();
			try {
				await db.exec(`create table S (Id integer primary key, Stamp text not null)
					using optimystic('tree://uniq/pkreplace-unique-index')`);
				await db.exec(`create unique index ux_stamp on S (Stamp)`);
				await db.exec(`insert into S (Id, Stamp) values (1, 'a')`);
				await db.exec(`insert into S (Id, Stamp) values (2, 'b')`);
				await db.exec(`insert or replace into S (Id, Stamp) values (1, 'b')`);
				expect(await rowsOf(db, `select Id, Stamp from S order by Id`)).to.deep.equal([[1, 'b']]);
				await expectIndexAgreesWithScan(db, 'S', 'Stamp');
			} finally {
				db.close();
			}
		});

		it('a composite table-level UNIQUE (X, Y) is resolved the same way', async () => {
			const { db } = createDb();
			try {
				await db.exec(`create table C (Id integer primary key, X text not null, Y text not null, unique (X, Y))
					using optimystic('tree://uniq/pkreplace-composite')`);
				await db.exec(`insert into C (Id, X, Y) values (1, 'x', 'y')`);
				await db.exec(`insert into C (Id, X, Y) values (2, 'x', 'z')`);
				await db.exec(`insert or replace into C (Id, X, Y) values (2, 'x', 'y')`);
				expect(await rowsOf(db, `select Id, X, Y from C order by Id`)).to.deep.equal([[2, 'x', 'y']]);
				await expectConstraintError(
					() => db.exec(`insert into C (Id, X, Y) values (3, 'x', 'y')`),
					/^UNIQUE constraint failed: C\.X, C\.Y$/,
				);
			} finally {
				db.close();
			}
		});

		it('one replacement overwrites its own PK slot and evicts a different row per violated constraint', async () => {
			const { db } = createDb();
			try {
				await db.exec(`create table M (Id integer primary key, A text not null unique, B text not null unique)
					using optimystic('tree://uniq/pkreplace-multi')`);
				await db.exec(`insert into M (Id, A, B) values (1, 'a1', 'b1')`);
				await db.exec(`insert into M (Id, A, B) values (2, 'a2', 'b2')`);
				await db.exec(`insert into M (Id, A, B) values (3, 'a3', 'b3')`);
				// Replaces row 3 in place, evicts row 1 (A) and row 2 (B).
				await db.exec(`insert or replace into M (Id, A, B) values (3, 'a1', 'b2')`);
				expect(await rowsOf(db, `select Id, A, B from M order by Id`)).to.deep.equal([[3, 'a1', 'b2']]);
				// Both evicted values' old owners left no entries behind.
				await db.exec(`insert into M (Id, A, B) values (4, 'a2', 'b1')`);
				expect(await rowsOf(db, `select Id from M order by Id`)).to.deep.equal([[3], [4]]);
			} finally {
				db.close();
			}
		});

		it('reports the evicted row so the engine runs its delete pipeline (a delete event for the rival, an update event for the replaced row)', async () => {
			const { db } = createDb();
			try {
				await db.exec(`create table T (Id integer primary key, Stamp text not null unique)
					using optimystic('tree://uniq/pkreplace-events')`);
				await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
				await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);

				const events: DatabaseDataChangeEvent[] = [];
				const unsubscribe = db.onDataChange(event => { events.push(event); });
				try {
					await db.exec(`insert or replace into T (Id, Stamp) values (1, 'b')`);
				} finally {
					unsubscribe();
				}

				// Optimystic raises no native data events, so each of these comes from
				// the DML executor: the delete only if the vtab reported the eviction in
				// `evictedRows`, the update from `replacedRow`.
				expect(events.map(e => [e.type, (e.key ?? []).map(Number)]))
					.to.deep.equal([['delete', [2]], ['update', [1]]]);
			} finally {
				db.close();
			}
		});
	});

	it('insert or replace colliding with a secondary UNIQUE evicts through the DECLARED unique index (indexed lookup sees only the new owner)', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table S (Id integer primary key, Stamp text not null)
					using optimystic('tree://uniq/replace-declared')
			`);
			await db.exec(`create unique index ux_stamp on S (Stamp)`);
			await db.exec(`insert into S (Id, Stamp) values (1, 'a')`);

			// Previously raised `UNIQUE constraint failed`: statement-level REPLACE
			// only special-cased the PK, and a secondary collision fell through to
			// the constraint result (third defect in the fix ticket).
			await db.exec(`insert or replace into S (Id, Stamp) values (2, 'a')`);

			// Query THROUGH the indexed column (index-driven seek), not just count(*):
			// the evicted row must be gone from the table and the index must resolve
			// 'a' to the new owner only.
			expect(await scalar(db, `select Id as v from S where Stamp = 'a'`)).to.equal(2);
			expect(await scalar(db, `select count(*) as v from S where Stamp = 'a'`)).to.equal(1);
			expect(await scalar(db, `select count(*) as v from S`)).to.equal(1);
			expect(await scalar(db, `select count(*) as v from S where Id = 1`)).to.equal(0);

			// The value's new owner still collides for a plain insert, and deleting it
			// frees the value — the index tree carries exactly one live entry for 'a'.
			await expectThrows(
				() => db.exec(`insert into S (Id, Stamp) values (3, 'a')`),
				/UNIQUE constraint failed/,
			);
			await db.exec(`delete from S where Id = 2`);
			await db.exec(`insert into S (Id, Stamp) values (4, 'a')`);
			expect(await scalar(db, `select Id as v from S where Stamp = 'a'`)).to.equal(4);

			// Generalized close-out over the DECLARED unique index: after the eviction,
			// delete and re-insert, the index-routed seek and a full scan must agree for
			// every Stamp value present.
			await expectIndexAgreesWithScan(db, 'S', 'Stamp');
		} finally {
			db.close();
		}
	});

	it('one REPLACE write can evict a different row per violated constraint (keeps scanning after an eviction)', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table M (Id integer primary key, A text not null unique on conflict replace, B text not null unique on conflict replace)
					using optimystic('tree://uniq/replace-multi')
			`);
			await db.exec(`insert into M (Id, A, B) values (1, 'a1', 'b1')`);
			await db.exec(`insert into M (Id, A, B) values (2, 'a2', 'b2')`);

			// Collides with row 1 on A and with row 2 on B — one write evicts both.
			await db.exec(`insert into M (Id, A, B) values (3, 'a1', 'b2')`);
			expect(await scalar(db, `select count(*) as v from M`)).to.equal(1);
			expect(await scalar(db, `select Id as v from M where A = 'a1'`)).to.equal(3);
			expect(await scalar(db, `select Id as v from M where B = 'b2'`)).to.equal(3);
		} finally {
			db.close();
		}
	});

	it('UPDATE moving onto an occupied value under `unique on conflict ignore` is swallowed (row keeps its old value)', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique on conflict ignore)
					using optimystic('tree://uniq/update-ignore')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
			await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);

			// Quereus has no `update or ignore` grammar and its planner passes no
			// statement-level action for UPDATE, so the constraint-level declaration
			// is the ONLY way to reach this branch.
			await db.exec(`update T set Stamp = 'b' where Id = 1`);

			expect(await scalar(db, `select count(*) as v from T`)).to.equal(2);
			expect(await scalar(db, `select Id as v from T where Stamp = 'a'`)).to.equal(1);
			expect(await scalar(db, `select Id as v from T where Stamp = 'b'`)).to.equal(2);
		} finally {
			db.close();
		}
	});

	it('a swallowing IGNORE discards the evictions an earlier REPLACE constraint had pending (nothing changes at all)', async () => {
		const { db } = createDb();
		try {
			// Degenerate mixed-action shape: A resolves REPLACE (collides with row 1),
			// B resolves IGNORE (collides with row 2). Constraints are decided in
			// declared order and NOTHING is staged until every decision is in, so the
			// IGNORE swallows the write with row 1 still intact.
			//
			// This is the one deliberate divergence from the engine's memory module,
			// which deletes the REPLACE collision first and then swallows — and whose
			// executor skips the delete pipeline for evictions on a row-less result,
			// leaving that delete untracked. See resolveSecondaryUniqueDecision.
			await db.exec(`
				create table X (Id integer primary key,
					A text not null unique on conflict replace,
					B text not null unique on conflict ignore)
					using optimystic('tree://uniq/replace-then-ignore')
			`);
			await db.exec(`insert into X (Id, A, B) values (1, 'a1', 'b1')`);
			await db.exec(`insert into X (Id, A, B) values (2, 'a2', 'b2')`);

			await db.exec(`insert into X (Id, A, B) values (3, 'a1', 'b2')`);

			expect(await scalar(db, `select count(*) as v from X`)).to.equal(2);
			expect(await scalar(db, `select Id as v from X where A = 'a1'`)).to.equal(1);
			expect(await scalar(db, `select Id as v from X where B = 'b2'`)).to.equal(2);
		} finally {
			db.close();
		}
	});

	it('rolling back a transaction restores a row evicted by a declared REPLACE (main table and index)', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique on conflict replace)
					using optimystic('tree://uniq/evict-rollback')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);

			await db.exec(`begin`);
			await db.exec(`insert into T (Id, Stamp) values (2, 'a')`);
			expect(await scalar(db, `select Id as v from T where Stamp = 'a'`)).to.equal(2);
			await db.exec(`rollback`);

			// markDirtyTrees runs before the eviction is staged, so the rollback
			// snapshot covers it — the evicted row is back, in the table AND resolvable
			// through the enforcing index tree.
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(1);
			expect(await scalar(db, `select Id as v from T where Stamp = 'a'`)).to.equal(1);
			expect(await scalar(db, `select count(*) as v from T where Id = 2`)).to.equal(0);
		} finally {
			db.close();
		}
	});

	it('honours a declared action on a COMPOSITE secondary UNIQUE', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table C (Id integer primary key, X text not null, Y text not null,
					unique (X, Y) on conflict replace)
					using optimystic('tree://uniq/composite-replace')
			`);
			await db.exec(`insert into C (Id, X, Y) values (1, 'x', 'y')`);
			// Only a full (X, Y) match binds the constraint: a partial overlap inserts.
			await db.exec(`insert into C (Id, X, Y) values (2, 'x', 'z')`);
			await db.exec(`insert into C (Id, X, Y) values (3, 'x', 'y')`);

			expect(await scalar(db, `select count(*) as v from C`)).to.equal(2);
			expect(await scalar(db, `select count(*) as v from C where Id = 1`)).to.equal(0);
			expect(await scalar(db, `select Id as v from C where X = 'x' and Y = 'y'`)).to.equal(3);
		} finally {
			db.close();
		}
	});

	it('UPDATE moving onto an occupied value under `unique on conflict replace` evicts the occupying row', async () => {
		const { db } = createDb();
		try {
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null unique on conflict replace)
					using optimystic('tree://uniq/update-replace')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
			await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);

			await db.exec(`update T set Stamp = 'b' where Id = 1`);

			expect(await scalar(db, `select count(*) as v from T`)).to.equal(1);
			expect(await scalar(db, `select Id as v from T where Stamp = 'b'`)).to.equal(1);
			expect(await scalar(db, `select count(*) as v from T where Id = 2`)).to.equal(0);
		} finally {
			db.close();
		}
	});

	it('enforces a UNIQUE derived from CREATE UNIQUE INDEX via the declared index tree (no duplicate tree)', async () => {
		const { db } = createDb();
		try {
			// No column-level UNIQUE at CREATE TABLE; the constraint arrives via a later
			// CREATE UNIQUE INDEX, whose derived uniqueConstraint must be enforced through
			// the index tree that CREATE INDEX built — not a second synthesized tree.
			await db.exec(`
				create table T (Id integer primary key, Stamp text not null)
					using optimystic('tree://uniq/createindex')
			`);
			await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
			await db.exec(`create unique index ux_stamp on T (Stamp)`);

			// A duplicate of an already-present value is rejected (the index was
			// populated from existing rows at CREATE INDEX time).
			await expectThrows(
				() => db.exec(`insert into T (Id, Stamp) values (2, 'a')`),
				/UNIQUE constraint failed/,
			);
			// A duplicate of a newly-inserted value is rejected too.
			await db.exec(`insert into T (Id, Stamp) values (3, 'b')`);
			await expectThrows(
				() => db.exec(`insert into T (Id, Stamp) values (4, 'b')`),
				/UNIQUE constraint failed/,
			);
			expect(await scalar(db, `select count(*) as v from T`)).to.equal(2);

			// The index was built over a table that already had rows: the pre-existing row
			// and the later insert must BOTH be reachable through it, not just the one the
			// duplicate probe happened to touch.
			await expectIndexAgreesWithScan(db, 'T', 'Stamp');
		} finally {
			db.close();
		}
	});
});
