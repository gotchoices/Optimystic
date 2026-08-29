/**
 * Reproduction + regression coverage for primary-key uniqueness on the LOCAL /
 * bootstrap transactor (see fix ticket
 * `optimystic-insert-pk-uniqueness-not-enforced`).
 *
 * An INSERT whose primary key already exists must be REJECTED (SQL INSERT
 * semantics), not silently upserted. The vtab stages `[[key, [key, row]]]`
 * into the collection B-tree; staging a key that already exists OVERWRITES the
 * existing entry. Because the operation is classified as 'insert' (not
 * 'update'), an `InsertOnly` guard never fires either — so a duplicate-key
 * insert used to silently overwrite the prior row.
 *
 * These tests run against the real `local` transactor backed by a real
 * `FileRawStorage` directory so they exercise persistence + reopen, not a fake.
 * They would FAIL on the pre-fix code (the duplicate insert resolved and
 * overwrote the original row).
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function createDb(dir: string): { db: Database; plugin: ReturnType<typeof register> } {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => new FileRawStorage(dir),
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

async function selectScalar(db: Database, sql: string): Promise<SqlValue> {
	for await (const row of db.eval(sql)) {
		const values = Object.values(row as Record<string, SqlValue>);
		return values[0] as SqlValue;
	}
	throw new Error('query returned no rows');
}

async function selectCount(db: Database, sql: string): Promise<number> {
	return Number(await selectScalar(db, sql));
}

/** Assert that `fn` rejects; fail loudly if it unexpectedly resolves. */
async function expectThrows(fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch {
		return;
	}
	throw new Error('expected operation to throw, but it resolved');
}

/** Assert that `fn` rejects and return the thrown error's message for inspection. */
async function captureThrowMessage(fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
	throw new Error('expected operation to throw, but it resolved');
}

/**
 * Reopen the storage dir in a fresh Database and return the scalar `sql` yields.
 *
 * Every `Database` in this file releases its read-cache lease (`plugin.dispose()`) when it closes.
 * The cache is shared per directory for as long as any lease is held, so a skipped release would
 * make this reopen read the previous `Database`'s still-warm cache instead of the on-disk bytes
 * these tests exist to check.
 */
async function reopenScalar(dir: string, sql: string): Promise<SqlValue> {
	const { db, plugin } = createDb(dir);
	try {
		await plugin.hydrate(db);
		return await selectScalar(db, sql);
	} finally {
		db.close();
		await plugin.dispose();
	}
}

describe('INSERT primary-key uniqueness (local/bootstrap transactor)', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-insert-pk-uniqueness', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('rejects a duplicate-key INSERT in a separate transaction and leaves the original row intact (in-session + reopen)', async () => {
		const uri = 'tree://pkuniq/consumed';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table ConsumedInvite (invite text primary key, member text)
					using optimystic('${uri}')`,
			);
			await db.exec(`insert into ConsumedInvite (invite, member) values ('I', 'B')`);
			expect(await selectScalar(db, `select member from ConsumedInvite where invite = 'I'`)).to.equal('B');

			// Re-consuming the same invite for a different member must be rejected,
			// NOT silently overwrite I -> C.
			await expectThrows(() =>
				db.exec(`insert into ConsumedInvite (invite, member) values ('I', 'C')`),
			);

			// In-session: original row unchanged, still exactly one row.
			expect(await selectCount(db, 'select count(*) as c from ConsumedInvite')).to.equal(1);
			expect(await selectScalar(db, `select member from ConsumedInvite where invite = 'I'`)).to.equal('B');
		} finally {
			db.close();
			await plugin.dispose();
		}

		// Reopen: the overwrite never reached storage.
		expect(await reopenScalar(dir, `select member from ConsumedInvite where invite = 'I'`)).to.equal('B');
	});

	it('rejects a duplicate-key INSERT staged earlier in the SAME transaction without overwriting it', async () => {
		const uri = 'tree://pkuniq/sametxn';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);

			await db.exec('begin');
			await db.exec(`insert into T (id, v) values (1, 'a')`);
			// Same key, same (uncommitted) transaction — the duplicate must be
			// rejected against the row staged a statement earlier, not upserted.
			await expectThrows(() => db.exec(`insert into T (id, v) values (1, 'b')`));
			// SQL semantics: a constraint failure aborts the offending STATEMENT,
			// not the whole transaction. The first row is still valid, so commit
			// succeeds and persists it with its original value (not 'b').
			await db.exec('commit');

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('rejects a duplicate key within a single multi-row INSERT', async () => {
		const uri = 'tree://pkuniq/multirow';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table M (id integer primary key, v text) using optimystic('${uri}')`,
			);
			// One statement inserting two rows with the same key must reject wholesale.
			await expectThrows(() =>
				db.exec(`insert into M (id, v) values (1, 'a'), (1, 'b')`),
			);
			expect(await selectCount(db, 'select count(*) as c from M')).to.equal(0);
		} finally {
			db.close();
			await plugin.dispose();
		}
	});
});

/**
 * Conflict-resolution coverage (see fix ticket
 * `optimystic-vtab-onconflict-not-honored`).
 *
 * The vtab's INSERT path used to THROW a ConstraintError on a duplicate PK,
 * which bypassed the engine's conflict-resolution branches: every one of
 * `INSERT OR IGNORE`, `INSERT OR REPLACE`, `ON CONFLICT DO NOTHING`, and
 * `ON CONFLICT DO UPDATE` errored instead of doing what the SQL asked. The fix
 * returns a STRUCTURED UpdateResult (status 'ok' for IGNORE/REPLACE, status
 * 'constraint' + existingRow for ABORT/upsert) so the engine drives the right
 * behavior. These run against the real `local` / FileRawStorage transactor.
 */
describe('INSERT conflict resolution (local/bootstrap transactor)', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-insert-onconflict', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('INSERT OR IGNORE on a duplicate key skips the row and preserves the original', async () => {
		const uri = 'tree://onconflict/ignore';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			// Must NOT throw and must NOT overwrite — the original 'a' survives.
			await db.exec(`insert or ignore into T (id, v) values (1, 'b')`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('INSERT OR REPLACE on a duplicate key overwrites the row and persists across reopen', async () => {
		const uri = 'tree://onconflict/replace';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			// Must NOT throw and must overwrite — the new 'b' wins, still one row.
			await db.exec(`insert or replace into T (id, v) values (1, 'b')`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('b');
		} finally {
			db.close();
			await plugin.dispose();
		}

		// The overwrite reached storage.
		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('b');
	});

	it('ON CONFLICT (pk) DO NOTHING preserves the original row without throwing', async () => {
		const uri = 'tree://onconflict/donothing';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			await db.exec(
				`insert into T (id, v) values (1, 'b') on conflict (id) do nothing`,
			);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('ON CONFLICT (pk) DO UPDATE applies the update clause to the existing row', async () => {
		const uri = 'tree://onconflict/doupdate';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			await db.exec(
				`insert into T (id, v) values (1, 'b') on conflict (id) do update set v = 'updated'`,
			);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('updated');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('updated');
	});

	it('ON CONFLICT (pk) DO UPDATE can reference the proposed row via excluded.*', async () => {
		const uri = 'tree://onconflict/excluded';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			// `excluded.v` is the value of the row that failed to insert ('b').
			// The vtab only hands the engine `existingRow`; the engine resolves
			// `excluded` from the proposed row, so this proves the interplay.
			await db.exec(
				`insert into T (id, v) values (1, 'b') on conflict (id) do update set v = excluded.v`,
			);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('b');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('b');
	});

	it('surfaces a SQLite-style "UNIQUE constraint failed: <table>.<pkCol>" message on a default-ABORT duplicate', async () => {
		const uri = 'tree://onconflict/message';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			// The structured constraint result's `message` is what the engine
			// rethrows; assert the column-qualified wording reaches the client.
			const message = await captureThrowMessage(() =>
				db.exec(`insert into T (id, v) values (1, 'b')`),
			);
			expect(message).to.contain('UNIQUE constraint failed: T.id');
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	it('INSERT OR REPLACE keeps a secondary index consistent (indexed lookup returns the new value)', async () => {
		const uri = 'tree://onconflict/replace-index';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, cat text, v text) using optimystic('${uri}')`,
			);
			await db.exec(`create index idx_cat on T (cat)`);
			await db.exec(`insert into T (id, cat, v) values (1, 'x', 'a')`);

			// Replace moves the indexed column from 'x' to 'y' and changes v.
			await db.exec(`insert or replace into T (id, cat, v) values (1, 'y', 'b')`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			// Old index key 'x' no longer resolves; new key 'y' returns the new row.
			expect(await selectCount(db, `select count(*) as c from T where cat = 'x'`)).to.equal(0);
			expect(await selectScalar(db, `select v from T where cat = 'y'`)).to.equal('b');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, `select v from T where cat = 'y'`)).to.equal('b');
	});
});

/**
 * Conflict-resolution coverage for PK-MOVING UPDATEs (see fix ticket
 * `optimystic-update-pk-move-onconflict-not-honored`).
 *
 * When an UPDATE changes a row's primary key onto a key a *different* row
 * already occupies, the vtab used to THROW an ad-hoc ConstraintError that
 * bypassed the engine's conflict-resolution machinery. The fix replaces the
 * throw with a STRUCTURED UpdateResult (status 'constraint' + existingRow for
 * ABORT; status 'ok' + replacedRow for REPLACE; status 'ok' for IGNORE),
 * mirroring the INSERT path and the engine's UpdateResult contract.
 *
 * REACHABILITY: Quereus has no `UPDATE OR REPLACE` / `UPDATE OR IGNORE`
 * grammar (the parser jumps straight from `UPDATE` to the table name —
 * `update or replace …` raises "Expected table name"), and the planner
 * hard-codes `onConflict = undefined` for every UPDATE — so no STATEMENT-level
 * spelling reaches the IGNORE/REPLACE branches. They ARE reachable through the
 * CONSTRAINT-level spelling (`primary key … on conflict <action>`), which the
 * vtab resolves when the statement declares nothing; the 'Declared PK conflict
 * actions' suite below drives both branches end-to-end that way. This suite
 * keeps the default-ABORT coverage.
 *
 * These run against the real `local` / FileRawStorage transactor so they
 * exercise persistence + reopen.
 */
describe('UPDATE PK-move conflict resolution (local/bootstrap transactor)', function () {
	// The secondary-index cases here each drive a real FileRawStorage tree under
	// os.tmpdir(); warm they run ~1.7s, but on a loaded/cold machine the same
	// cases have been measured 10x slower. Budget for that rather than reporting
	// a wall-clock stall as a conflict-resolution failure.
	this.timeout(60000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-update-pkmove-onconflict', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('default UPDATE moving a PK onto an occupied key is rejected with a SQLite-style message and leaves both rows intact', async () => {
		const uri = 'tree://update-pkmove/abort';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`); // A
			await db.exec(`insert into T (id, v) values (2, 'b')`); // B

			// Move A onto B's occupied key. The vtab now RETURNS a structured
			// constraint result instead of throwing its old ad-hoc string; the
			// engine rethrows it with the column-qualified wording. Pre-fix the
			// message was `… primary key '2'`, so asserting `T.id` is a genuine
			// regression guard that the new structured path is in effect.
			const message = await captureThrowMessage(() =>
				db.exec(`update T set id = 2 where id = 1`),
			);
			expect(message).to.contain('UNIQUE constraint failed: T.id');

			// The rejected move staged nothing — both original rows are intact.
			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(2);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
			expect(await selectScalar(db, 'select v from T where id = 2')).to.equal('b');
		} finally {
			db.close();
			await plugin.dispose();
		}

		// Nothing reached storage; both rows survive a reopen.
		expect(await reopenScalar(dir, 'select count(*) as c from T')).to.equal(2);
		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('a default UPDATE PK-move onto an UNOCCUPIED key still succeeds (control: only the collision branch changed)', async () => {
		// Guards that the non-collision PK-move path is untouched — it falls
		// through to the shared delete-old/insert-new + updateIndexEntries
		// staging exactly as before the fix.
		const uri = 'tree://update-pkmove/no-collision';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			// id=2 is unoccupied, so the move resolves normally.
			await db.exec(`update T set id = 2 where id = 1`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from T where id = 1')).to.equal(0);
			expect(await selectScalar(db, 'select v from T where id = 2')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 2')).to.equal('a');
	});

	it('UPDATE moving a PK onto an occupied key under a declared `on conflict ignore` is swallowed (both rows intact)', async () => {
		const uri = 'tree://update-pkmove/declared-ignore';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key on conflict ignore, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);
			await db.exec(`insert into T (id, v) values (2, 'b')`);

			// The planner passes no statement-level action for UPDATE, so the
			// constraint-level declaration is what resolves the collision — first
			// SQL-reachable path into this branch.
			await db.exec(`update T set id = 2 where id = 1`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(2);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
			expect(await selectScalar(db, 'select v from T where id = 2')).to.equal('b');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('UPDATE moving a PK onto an occupied key under a declared `on conflict replace` displaces the occupying row', async () => {
		const uri = 'tree://update-pkmove/declared-replace';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key on conflict replace, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);
			await db.exec(`insert into T (id, v) values (2, 'b')`);

			await db.exec(`update T set id = 2 where id = 1`);

			// Row 2 is displaced; row 1's payload now lives at id = 2.
			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from T where id = 1')).to.equal(0);
			expect(await selectScalar(db, 'select v from T where id = 2')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 2')).to.equal('a');
	});

	it('a default UPDATE PK-move collision with a secondary index rejects and leaves the index intact', async () => {
		// The collision is rejected before any index staging, so the displaced
		// row's index entry must still resolve and no entry should appear at the
		// would-be-moved value.
		const uri = 'tree://update-pkmove/abort-index';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, cat text) using optimystic('${uri}')`,
			);
			await db.exec(`create index idx_cat on T (cat)`);
			await db.exec(`insert into T (id, cat) values (1, 'x')`); // A
			await db.exec(`insert into T (id, cat) values (2, 'y')`); // B

			await expectThrows(() => db.exec(`update T set id = 2 where id = 1`));

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(2);
			// Both index entries still resolve to their original rows.
			expect(await selectScalar(db, `select id from T where cat = 'x'`)).to.equal(1);
			expect(await selectScalar(db, `select id from T where cat = 'y'`)).to.equal(2);
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, `select id from T where cat = 'x'`)).to.equal(1);
		expect(await reopenScalar(dir, `select id from T where cat = 'y'`)).to.equal(2);
	});

	// The PK move and the secondary UNIQUE constraints are two decisions over the
	// same write, and the first one's outcome changes what the second should see:
	// the row a REPLACE displaces at the target key is on its way out and must not
	// count as a live secondary collision, and a swallowed/rejected move must not be
	// preempted by a secondary hit. These pin that ordering (all three cases
	// previously mis-resolved once the declared PK action became reachable).

	it('UPDATE PK-move REPLACE is not blocked by a secondary UNIQUE collision with the row it displaces', async () => {
		const uri = 'tree://update-pkmove/displaced-not-a-collision';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key on conflict replace, s text not null unique) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, s) values (1, 'a')`);
			await db.exec(`insert into T (id, s) values (2, 'b')`);

			// Row 1 moves onto id 2 AND takes row 2's 's' value. The only row holding
			// 'b' is the one the move displaces, so the (default-ABORT) UNIQUE is not
			// actually violated by the post-write state.
			await db.exec(`update T set id = 2, s = 'b' where id = 1`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, `select id from T where s = 'b'`)).to.equal(2);
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, `select id from T where s = 'b'`)).to.equal(2);
	});

	it('UPDATE PK-move REPLACE is not swallowed by a declared-IGNORE secondary UNIQUE on the row it displaces', async () => {
		const uri = 'tree://update-pkmove/displaced-not-swallowed';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key on conflict replace, s text not null unique on conflict ignore) `
				+ `using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, s) values (1, 'a')`);
			await db.exec(`insert into T (id, s) values (2, 'b')`);

			// Same shape, but the secondary declares IGNORE — a stale probe would
			// swallow the whole UPDATE silently, which is worse than rejecting it.
			await db.exec(`update T set id = 2, s = 'b' where id = 1`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from T where id = 1')).to.equal(0);
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, `select id from T where s = 'b'`)).to.equal(2);
	});

	it('a swallowed UPDATE PK-move (declared IGNORE) is not preempted by a secondary UNIQUE violation', async () => {
		const uri = 'tree://update-pkmove/ignore-wins-over-secondary';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key on conflict ignore, s text not null unique) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, s) values (1, 'a')`);
			await db.exec(`insert into T (id, s) values (2, 'b')`);
			await db.exec(`insert into T (id, s) values (3, 'c')`);

			// The move onto the occupied id 2 is swallowed, so the row never takes
			// 'c' and row 3's UNIQUE is never actually violated — no error.
			await db.exec(`update T set id = 2, s = 'c' where id = 1`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(3);
			expect(await selectScalar(db, 'select s from T where id = 1')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, 'select s from T where id = 1')).to.equal('a');
	});

	it('an UPDATE that both displaces at the target PK and evicts a third row on a declared-REPLACE UNIQUE keeps the table unique', async () => {
		const uri = 'tree://update-pkmove/displace-plus-evict';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key on conflict replace, s text not null unique on conflict replace) `
				+ `using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, s) values (1, 'a')`);
			await db.exec(`insert into T (id, s) values (2, 'b')`);
			await db.exec(`insert into T (id, s) values (3, 'c')`);

			// Displaces row 2 at the target PK (replacedRow channel) and evicts row 3
			// for 's' (evictedRows channel) — two removals, one write.
			await db.exec(`update T set id = 2, s = 'c' where id = 1`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, `select id from T where s = 'c'`)).to.equal(2);
		} finally {
			db.close();
			await plugin.dispose();
		}

		expect(await reopenScalar(dir, `select id from T where s = 'c'`)).to.equal(2);
	});
});

/**
 * Constraint-level PK conflict actions (see fix ticket
 * `optimystic-honor-declared-conflict-action`): a `primary key … on conflict
 * <action>` declared on the TABLE (`primary key (id) on conflict X`) or on the
 * COLUMN (`id integer primary key on conflict X`) must drive a duplicate-PK
 * INSERT when the statement carries no OR clause. Precedence: statement-level
 * OR > declared action > ABORT. FAIL and ROLLBACK are honoured as ABORT when
 * resolved from the vtab's structured constraint result (parity with the
 * engine's in-memory module), so all three rejecting actions assert the same
 * observable outcome.
 */
describe('Declared PK conflict actions (local/bootstrap transactor)', function () {
	this.timeout(20000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-pk-declared-onconflict', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	const outcomes = {
		ignore: 'ignored',
		replace: 'replaced',
		abort: 'rejected',
		fail: 'rejected',
		rollback: 'rejected',
	} as const;

	for (const spelling of ['table-level', 'column-level'] as const) {
		for (const [action, outcome] of Object.entries(outcomes)) {
			it(`${spelling} primary key on conflict ${action}: duplicate-PK insert is ${outcome}`, async () => {
				const uri = `tree://pkdeclared/${spelling}-${action}`;
				const { db, plugin } = createDb(dir);
				try {
					const ddl = spelling === 'table-level'
						? `create table T (id integer, v text, primary key (id) on conflict ${action}) using optimystic('${uri}')`
						: `create table T (id integer primary key on conflict ${action}, v text) using optimystic('${uri}')`;
					await db.exec(ddl);
					await db.exec(`insert into T (id, v) values (1, 'a')`);

					if (outcome === 'rejected') {
						await expectThrows(() => db.exec(`insert into T (id, v) values (1, 'b')`));
						expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
					} else if (outcome === 'ignored') {
						await db.exec(`insert into T (id, v) values (1, 'b')`);
						expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
					} else {
						await db.exec(`insert into T (id, v) values (1, 'b')`);
						expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('b');
					}
					expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
				} finally {
					db.close();
					await plugin.dispose();
				}
			});
		}
	}

	it('statement-level OR wins over the declared PK action (or ignore beats declared replace)', async () => {
		const uri = 'tree://pkdeclared/precedence';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key on conflict replace, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			// Declared REPLACE would overwrite; the statement-level IGNORE must win.
			await db.exec(`insert or ignore into T (id, v) values (1, 'b')`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	it('statement-level or fail / or rollback on a duplicate PK reject and preserve the row', async () => {
		const uri = 'tree://pkdeclared/stmt-fail-rollback';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			await expectThrows(() => db.exec(`insert or fail into T (id, v) values (1, 'b')`));
			await expectThrows(() => db.exec(`insert or rollback into T (id, v) values (1, 'c')`));

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
		} finally {
			db.close();
			await plugin.dispose();
		}
	});
});
