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
});
