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
