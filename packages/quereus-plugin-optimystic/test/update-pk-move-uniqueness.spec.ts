/**
 * Reproduction + regression coverage for primary-key uniqueness on the UPDATE
 * path (see fix ticket `optimystic-update-pk-move-silent-overwrite`).
 *
 * `UPDATE t SET pk = <pk already used by a DIFFERENT row>` must be REJECTED as a
 * uniqueness conflict, NOT silently overwrite the row that already lives at the
 * new key. The vtab stages a PK change as delete-old + insert-new; staging into
 * the collection B-tree is an upsert, so `[[newKey, [newKey, row]]]` clobbers
 * whatever already occupies `newKey` — quiet data loss. This is the same class
 * of bug `optimystic-insert-pk-uniqueness-not-enforced` fixed for INSERT, but
 * the UPDATE-moves-onto-occupied-PK case was never covered.
 *
 * These tests run against the real `local` transactor backed by a real
 * `FileRawStorage` directory so they exercise persistence + reopen, not a fake.
 * They FAIL on the pre-fix code (the move resolved and overwrote the target row).
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

async function reopenScalar(dir: string, sql: string): Promise<SqlValue> {
	const { db, plugin } = createDb(dir);
	try {
		await plugin.hydrate(db);
		return await selectScalar(db, sql);
	} finally {
		db.close();
	}
}

describe('UPDATE primary-key move uniqueness (local/bootstrap transactor)', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-update-pk-move', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('rejects an UPDATE that moves a row onto an existing PK and leaves both rows intact (in-session + reopen)', async () => {
		const uri = 'tree://pkmove/collide';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);
			await db.exec(`insert into T (id, v) values (2, 'b')`);

			// Moving row 1 onto id=2 must be rejected, NOT overwrite row 2.
			await expectThrows(() => db.exec(`update T set id = 2 where id = 1`));

			// In-session: both rows survive unchanged.
			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(2);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
			expect(await selectScalar(db, 'select v from T where id = 2')).to.equal('b');
		} finally {
			db.close();
		}

		// Reopen: the overwrite never reached storage.
		expect(await reopenScalar(dir, 'select v from T where id = 2')).to.equal('b');
		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('aborts the offending PK-move statement inside a transaction but lets the txn commit, both rows surviving', async () => {
		const uri = 'tree://pkmove/txn';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);
			await db.exec(`insert into T (id, v) values (2, 'b')`);

			await db.exec('begin');
			// Offending statement: a constraint failure aborts the STATEMENT, not
			// the whole transaction.
			await expectThrows(() => db.exec(`update T set id = 2 where id = 1`));
			await db.exec('commit');

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(2);
			expect(await selectScalar(db, 'select v from T where id = 1')).to.equal('a');
			expect(await selectScalar(db, 'select v from T where id = 2')).to.equal('b');
		} finally {
			db.close();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 2')).to.equal('b');
		expect(await reopenScalar(dir, 'select v from T where id = 1')).to.equal('a');
	});

	it('allows a PK-move to a genuinely unused key (regression guard)', async () => {
		const uri = 'tree://pkmove/free';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table T (id integer primary key, v text) using optimystic('${uri}')`,
			);
			await db.exec(`insert into T (id, v) values (1, 'a')`);

			// 99 is unused — the move must succeed and carry the row's value.
			await db.exec(`update T set id = 99 where id = 1`);

			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from T where id = 1')).to.equal(0);
			expect(await selectScalar(db, 'select v from T where id = 99')).to.equal('a');
		} finally {
			db.close();
		}

		expect(await reopenScalar(dir, 'select v from T where id = 99')).to.equal('a');
	});
});
