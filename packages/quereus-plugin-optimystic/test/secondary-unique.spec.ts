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
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';

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
		// {ignore, replace, abort, fail, rollback} × {statement-level, constraint-level}.
		// Precedence under test: statement-level `insert or <action>` > the action the
		// constraint itself declares (`unique on conflict <action>`) > ABORT. FAIL and
		// ROLLBACK are honoured as ABORT when they resolve from the vtab's structured
		// constraint result (parity with the engine's in-memory module — see
		// resolveConflictAction in optimystic-module.ts), so all three rejecting
		// actions assert the same observable outcome: statement rejected, table
		// unchanged.
		const outcomes = {
			ignore: 'ignored',
			replace: 'replaced',
			abort: 'rejected',
			fail: 'rejected',
			rollback: 'rejected',
		} as const;

		for (const spelling of ['statement', 'constraint'] as const) {
			for (const [action, outcome] of Object.entries(outcomes)) {
				it(`${spelling}-level ${action} on a secondary-UNIQUE collision is ${outcome}`, async () => {
					const { db } = createDb();
					try {
						const declared = spelling === 'constraint' ? ` on conflict ${action}` : '';
						await db.exec(`
							create table T (Id integer primary key, Stamp text not null unique${declared})
								using optimystic('tree://uniq/matrix-${spelling}-${action}')
						`);
						await db.exec(`insert into T (Id, Stamp) values (1, 'dup')`);
						const collide = spelling === 'statement'
							? `insert or ${action} into T (Id, Stamp) values (2, 'dup')`
							: `insert into T (Id, Stamp) values (2, 'dup')`;

						if (outcome === 'rejected') {
							await expectThrows(() => db.exec(collide), /UNIQUE constraint failed/);
							expect(await scalar(db, `select Id as v from T where Stamp = 'dup'`)).to.equal(1);
						} else if (outcome === 'ignored') {
							await db.exec(collide);
							expect(await scalar(db, `select Id as v from T where Stamp = 'dup'`)).to.equal(1);
						} else {
							// REPLACE against a secondary UNIQUE evicts the colliding row at
							// its own (different) PK; the new row owns the value.
							await db.exec(collide);
							expect(await scalar(db, `select Id as v from T where Stamp = 'dup'`)).to.equal(2);
							expect(await scalar(db, `select count(*) as v from T where Id = 1`)).to.equal(0);
						}
						expect(await scalar(db, `select count(*) as v from T`)).to.equal(1);
					} finally {
						db.close();
					}
				});
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
		} finally {
			db.close();
		}
	});
});
