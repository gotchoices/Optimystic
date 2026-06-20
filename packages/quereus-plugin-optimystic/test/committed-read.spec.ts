/**
 * Regression coverage for Quereus's `_readCommitted` contract on the optimystic
 * vtab (see ticket `control-db-network-backed`).
 *
 * A deferred CHECK that references `committed.<Table>` must read the PRE-transaction
 * snapshot of that table — committed rows only, EXCLUDING any rows the in-flight
 * transaction has staged. Quereus signals this by connecting the `committed.*`
 * reference with `_readCommitted: true`. The in-memory vtab honours it (an
 * unregistered connection that always scans the committed layer); previously the
 * optimystic vtab discarded the flag and scanned the live collection tracker, which
 * merges this transaction's staged inserts over committed data — so a `committed.*`
 * count/max wrongly counted the row being inserted.
 *
 * The canonical victim is a `Monotonic`-style constraint
 *   `new.UseNumber = coalesce((select max(UseNumber) from committed.T where ...), 0) + 1`
 * which is unsatisfiable if `committed.T` already shows the in-flight row (max would
 * equal new.UseNumber, demanding `N = N + 1`). These tests therefore PASS only when
 * the vtab correctly excludes the in-flight row from a committed read; they FAIL with
 * `CHECK constraint failed: Monotonic` against the pre-fix code. This is the workspace
 * -local anchor for the fix, independent of cadre-core's consent suite.
 *
 * Runs against the in-memory `test` transactor (legacy, non-session commit) — the same
 * staged-then-flush path the network transactor uses for a single-cohort commit.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '../dist/plugin.js';

/**
 * Fresh Database wired to the in-memory `test` transactor with the optimystic plugin
 * registered. Collection caching is disabled to match the other deferred-constraint
 * specs; the vtab still holds its collection for the table's lifetime.
 */
function createDb(): { db: Database; plugin: ReturnType<typeof register> } {
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
	return { db, plugin };
}

async function scalar(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return Number((row as { v: number }).v);
	}
	throw new Error('scalar query returned no rows');
}

/** Assert that `fn` rejects (and that the message mentions the named constraint). */
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

/** Create the Monotonic `Usage` table (PK (Token, UseNumber)) on a fresh db. */
async function createUsage(db: Database, uri: string): Promise<void> {
	await db.exec(`
		create table Usage (
			Token text,
			UseNumber integer,
			primary key (Token, UseNumber),
			constraint Monotonic check (
				new.UseNumber = coalesce((select max(UseNumber) from committed.Usage U where U.Token = new.Token), 0) + 1
			)
		) using optimystic('${uri}')
	`);
}

describe('Committed-read semantics (_readCommitted) on the optimystic vtab', function () {
	this.timeout(20000);

	it('a single auto-commit insert excludes its own in-flight row from committed.*', async () => {
		const { db } = createDb();
		try {
			await createUsage(db, 'tree://committed/single');

			// committed.Usage is empty → max is null → coalesce 0 → UseNumber must be 1.
			// On the pre-fix vtab the in-flight (t,1) row is visible to the deferred CHECK,
			// so max = 1 and the constraint demands UseNumber = 2 → throws.
			await db.exec(`insert into Usage (Token, UseNumber) values ('t', 1)`);

			expect(await scalar(db, `select count(*) as v from Usage`)).to.equal(1);
			expect(await scalar(db, `select max(UseNumber) as v from Usage where Token = 't'`)).to.equal(1);
		} finally {
			db.close();
		}
	});

	it('cross-transaction inserts read the committed max and increment monotonically', async () => {
		const { db } = createDb();
		try {
			await createUsage(db, 'tree://committed/sequential');

			// Each auto-commit sees the prior committed rows via committed.* → 1,2,3.
			await db.exec(`insert into Usage (Token, UseNumber) values ('t', 1)`);
			await db.exec(`insert into Usage (Token, UseNumber) values ('t', 2)`);
			await db.exec(`insert into Usage (Token, UseNumber) values ('t', 3)`);

			expect(await scalar(db, `select count(*) as v from Usage`)).to.equal(3);
			expect(await scalar(db, `select max(UseNumber) as v from Usage where Token = 't'`)).to.equal(3);

			// A non-sequential number (committed max is 3, so only 4 is valid) trips the
			// deferred Monotonic CHECK — proving the committed read sees the 3 prior rows.
			await expectThrows(
				() => db.exec(`insert into Usage (Token, UseNumber) values ('t', 5)`),
				/Monotonic/,
			);
			// Re-using an existing (Token, UseNumber) is a PK duplicate — caught by the
			// unique-key check at staging, before the deferred Monotonic CHECK runs.
			await expectThrows(
				() => db.exec(`insert into Usage (Token, UseNumber) values ('t', 3)`),
				/UNIQUE/,
			);

			// A different token starts its own sequence at 1.
			await db.exec(`insert into Usage (Token, UseNumber) values ('other', 1)`);
			expect(await scalar(db, `select max(UseNumber) as v from Usage where Token = 'other'`)).to.equal(1);
		} finally {
			db.close();
		}
	});

	it('two distinct tokens each at use #1 in ONE transaction both pass (committed.* hides both in-flight rows)', async () => {
		const { db } = createDb();
		try {
			await createUsage(db, 'tree://committed/multitoken');

			// One explicit transaction staging two rows. Each token's committed max is 0, so
			// both rows want UseNumber = 1. The deferred Monotonic CHECK drains at commit while
			// BOTH rows are staged; only a correct committed read (excluding the in-flight rows)
			// lets both pass. The pre-fix vtab sees (a,1) live when checking it → max 1 → throws.
			await db.exec('begin');
			await db.exec(`insert into Usage (Token, UseNumber) values ('a', 1)`);
			await db.exec(`insert into Usage (Token, UseNumber) values ('b', 1)`);
			await db.exec('commit');

			expect(await scalar(db, `select count(*) as v from Usage`)).to.equal(2);
			expect(await scalar(db, `select max(UseNumber) as v from Usage where Token = 'a'`)).to.equal(1);
			expect(await scalar(db, `select max(UseNumber) as v from Usage where Token = 'b'`)).to.equal(1);
		} finally {
			db.close();
		}
	});

	it('a committed.* count-based deferred CHECK ignores the in-flight insert', async () => {
		const { db } = createDb();
		try {
			// Seq must equal the number of ALREADY-committed rows + 1 — i.e. committed.* must
			// NOT include the row being inserted. This is the same exclusion the Monotonic
			// constraint relies on, expressed as a count for an independent angle.
			await db.exec(`
				create table Ledger (
					Id integer primary key,
					Seq integer,
					constraint SeqMatchesCommitted check (
						new.Seq = (select count(*) from committed.Ledger) + 1
					)
				) using optimystic('tree://committed/ledger')
			`);

			await db.exec(`insert into Ledger (Id, Seq) values (1, 1)`); // committed count 0 → Seq 1
			await db.exec(`insert into Ledger (Id, Seq) values (2, 2)`); // committed count 1 → Seq 2
			expect(await scalar(db, `select count(*) as v from Ledger`)).to.equal(2);

			// Seq 2 here would only validate if committed.* (wrongly) counted the in-flight row.
			await expectThrows(
				() => db.exec(`insert into Ledger (Id, Seq) values (3, 2)`),
				/SeqMatchesCommitted/,
			);
		} finally {
			db.close();
		}
	});
});
