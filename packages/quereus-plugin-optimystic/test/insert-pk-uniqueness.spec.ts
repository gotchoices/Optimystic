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

async function reopenScalar(dir: string, sql: string): Promise<SqlValue> {
	const { db, plugin } = createDb(dir);
	try {
		await plugin.hydrate(db);
		return await selectScalar(db, sql);
	} finally {
		db.close();
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
		const { db } = createDb(dir);
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
		}

		// Reopen: the overwrite never reached storage.
		expect(await reopenScalar(dir, `select member from ConsumedInvite where invite = 'I'`)).to.equal('B');
	});

	it('rejects a duplicate-key INSERT staged earlier in the SAME transaction without overwriting it', async () => {
		const uri = 'tree://pkuniq/sametxn';
		const { db } = createDb(dir);
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
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('rejects a duplicate key within a single multi-row INSERT', async () => {
		const uri = 'tree://pkuniq/multirow';
		const { db } = createDb(dir);
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
		const { db } = createDb(dir);
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
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('INSERT OR REPLACE on a duplicate key overwrites the row and persists across reopen', async () => {
		const uri = 'tree://onconflict/replace';
		const { db } = createDb(dir);
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
		}

		// The overwrite reached storage.
		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('b');
	});

	it('ON CONFLICT (pk) DO NOTHING preserves the original row without throwing', async () => {
		const uri = 'tree://onconflict/donothing';
		const { db } = createDb(dir);
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
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('ON CONFLICT (pk) DO UPDATE applies the update clause to the existing row', async () => {
		const uri = 'tree://onconflict/doupdate';
		const { db } = createDb(dir);
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
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('updated');
	});

	it('ON CONFLICT (pk) DO UPDATE can reference the proposed row via excluded.*', async () => {
		const uri = 'tree://onconflict/excluded';
		const { db } = createDb(dir);
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
		}

		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('b');
	});

	it('surfaces a SQLite-style "UNIQUE constraint failed: <table>.<pkCol>" message on a default-ABORT duplicate', async () => {
		const uri = 'tree://onconflict/message';
		const { db } = createDb(dir);
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
		}
	});

	it('INSERT OR REPLACE keeps a secondary index consistent (indexed lookup returns the new value)', async () => {
		const uri = 'tree://onconflict/replace-index';
		const { db } = createDb(dir);
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
 * REACHABILITY: only the default ABORT mode is reachable through Quereus SQL
 * today, so only it is asserted end-to-end here. Quereus has no
 * `UPDATE OR REPLACE` / `UPDATE OR IGNORE` grammar (the parser jumps straight
 * from `UPDATE` to the table name — `update or replace …` raises "Expected
 * table name"), and the planner hard-codes `onConflict = undefined` for every
 * UPDATE ("UPDATE has no statement-level OR clause"). optimystic resolves
 * `args.onConflict ?? ABORT` and reads no per-constraint conflict default, so a
 * PK-moving UPDATE always arrives as ABORT. The REPLACE/IGNORE branches are
 * correct-by-construction — they reuse the exact staging / index / statistics
 * primitives already exercised by the passing `INSERT OR REPLACE` /
 * `INSERT OR IGNORE` tests above — but cannot be driven from SQL until the
 * engine supplies a non-ABORT onConflict for updates. See the review handoff
 * for the full analysis and the recommended follow-up.
 *
 * These run against the real `local` / FileRawStorage transactor so they
 * exercise persistence + reopen.
 */
describe('UPDATE PK-move conflict resolution (local/bootstrap transactor)', function () {
	this.timeout(15000);

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
		const { db } = createDb(dir);
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
		const { db } = createDb(dir);
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
		}

		expect(await reopenScalar(dir, 'select v from T where id = 2')).to.equal('a');
	});

	it('a default UPDATE PK-move collision with a secondary index rejects and leaves the index intact', async () => {
		// The collision is rejected before any index staging, so the displaced
		// row's index entry must still resolve and no entry should appear at the
		// would-be-moved value.
		const uri = 'tree://update-pkmove/abort-index';
		const { db } = createDb(dir);
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
		}

		expect(await reopenScalar(dir, `select id from T where cat = 'x'`)).to.equal(1);
		expect(await reopenScalar(dir, `select id from T where cat = 'y'`)).to.equal(2);
	});
});
