/**
 * Regression coverage for deferred-constraint atomicity on the LOCAL / bootstrap
 * transactor (see fix ticket
 * `optimystic-deferred-constraint-rejection-not-rolled-back`).
 *
 * A deferred (subquery-bearing) CHECK constraint is evaluated by Quereus at
 * COMMIT — after the vtab has already applied the row. Previously the vtab's DML
 * path persisted (updateAndSync) each mutation inline at DML time, so when a
 * deferred CHECK threw at commit the optimystic rollback could only clear local
 * bookkeeping: the violating row was left committed in storage (in-session AND
 * after reopen). The fix STAGES vtab DML into the collection tracker at DML time
 * and flushes only at transaction commit, discarding staged mutations on
 * rollback — making cross-table (subquery-gated) constraint enforcement atomic.
 *
 * These tests run against the real `local` transactor backed by a real
 * `FileRawStorage` directory so they exercise persistence + reopen, not a fake.
 * They would FAIL on the pre-fix code (the rejected rows survived).
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { KeyRange } from '@optimystic/db-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/**
 * Register the optimystic plugin against a fresh Database wired to the `local`
 * transactor over a host-supplied `FileRawStorage` rooted at `dir`. A new
 * Database+plugin over the same `dir` reads the same persisted blocks, which is
 * how the reopen assertions verify on-disk state.
 */
function createDb(dir: string): { db: Database; plugin: ReturnType<typeof register> } {
	const db = new Database();
	// `rawStorageFactory` is a function reference, not a SqlValue — it is read
	// back via a `typeof === 'function'` guard in the plugin, so the cast is safe.
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

async function selectCount(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return Number((row as { c: number }).c);
	}
	throw new Error('count query returned no rows');
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

/**
 * Count the entries materialised in the tree at `collectionUri` by opening a
 * fresh Tree on the SAME cached transactor the vtab used (so it reflects
 * committed storage). Used to prove a rejected insert leaves NO orphaned
 * secondary-index entry behind.
 */
async function countTreeEntries(
	plugin: ReturnType<typeof register>,
	dir: string,
	collectionUri: string,
): Promise<number> {
	const tree = await plugin.collectionFactory.createOrGetCollection({
		collectionUri,
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json',
		rawStorageFactory: () => new FileRawStorage(dir),
	});
	await tree.update();
	let n = 0;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) n++;
	}
	return n;
}

/** Reopen the storage dir in a fresh Database and return the row count of `sql`. */
async function reopenCount(dir: string, countSql: string): Promise<number> {
	const { db, plugin } = createDb(dir);
	try {
		await plugin.hydrate(db);
		return await selectCount(db, countSql);
	} finally {
		db.close();
	}
}

describe('Deferred-constraint rollback (local/bootstrap transactor)', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-deferred-rollback', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('rejected INSERT under a deferred CHECK leaves the table unchanged (in-session + reopen)', async () => {
		const uri = 'tree://deferred/widget';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table Widget (id integer primary key, v text,
					check ((select count(*) from Widget) <= 1))
					using optimystic('${uri}')`,
			);
			await db.exec(`insert into Widget (id, v) values (1, 'a')`);
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);

			// Second insert: the deferred CHECK sees count = 2 at commit and throws.
			await expectThrows(() => db.exec(`insert into Widget (id, v) values (2, 'b')`));

			// In-session: the violating row must have been rolled back.
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);
		} finally {
			db.close();
		}

		// Reopen: the rejected row never reached storage.
		expect(await reopenCount(dir, 'select count(*) as c from Widget')).to.equal(1);
	});

	it('rejected UPDATE under a deferred CHECK reverts the row (in-session + reopen)', async () => {
		const uri = 'tree://deferred/flagrow';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table FlagRow (id integer primary key, flag integer,
					check ((select count(*) from FlagRow where flag = 1) = 0))
					using optimystic('${uri}')`,
			);
			await db.exec(`insert into FlagRow (id, flag) values (1, 0)`);

			// Flipping flag to 1 would make the deferred CHECK count = 1 → rejected.
			await expectThrows(() => db.exec(`update FlagRow set flag = 1 where id = 1`));

			expect(await selectCount(db, 'select count(*) as c from FlagRow')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from FlagRow where flag = 1')).to.equal(0);
			expect(await selectCount(db, 'select count(*) as c from FlagRow where flag = 0')).to.equal(1);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from FlagRow where flag = 0')).to.equal(1);
	});

	it('rejected PK-changing UPDATE discards both index halves (in-session + reopen)', async () => {
		const uri = 'tree://deferred/pkrow';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table PkRow (id integer primary key, v text,
					check ((select count(*) from PkRow where id >= 100) = 0))
					using optimystic('${uri}')`,
			);
			await db.exec(`insert into PkRow (id, v) values (1, 'a')`);

			// Changing the PK to 200 exercises the delete-old/insert-new staging path;
			// the deferred CHECK (id >= 100) rejects it at commit.
			await expectThrows(() => db.exec(`update PkRow set id = 200 where id = 1`));

			expect(await selectCount(db, 'select count(*) as c from PkRow')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from PkRow where id = 1')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from PkRow where id = 200')).to.equal(0);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from PkRow where id = 1')).to.equal(1);
		expect(await reopenCount(dir, 'select count(*) as c from PkRow where id = 200')).to.equal(0);
	});

	it('a deferred-constraint failure also discards a staged DELETE in the same transaction (in-session + reopen)', async () => {
		const uri = 'tree://deferred/delrow';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table DelRow (id integer primary key, v text,
					check ((select count(*) from DelRow where id >= 100) = 0))
					using optimystic('${uri}')`,
			);
			await db.exec(`insert into DelRow (id, v) values (1, 'a')`);

			// One explicit transaction that stages a DELETE then an INSERT that the
			// deferred CHECK rejects at commit. The rollback must discard BOTH —
			// proving the staged delete is not silently committed.
			await db.exec('begin');
			await db.exec(`delete from DelRow where id = 1`);
			await db.exec(`insert into DelRow (id, v) values (200, 'b')`);
			await expectThrows(() => db.exec('commit'));

			expect(await selectCount(db, 'select count(*) as c from DelRow')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from DelRow where id = 1')).to.equal(1);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from DelRow where id = 1')).to.equal(1);
	});

	it('rejected INSERT leaves no orphaned secondary-index entry', async () => {
		const uri = 'tree://deferred/item';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(
				`create table Item (id integer primary key, cat text,
					check ((select count(*) from Item) <= 1))
					using optimystic('${uri}')`,
			);
			await db.exec(`create index idx_item_cat on Item (cat)`);
			await db.exec(`insert into Item (id, cat) values (1, 'a')`);

			// Rejected at commit (count would be 2). The index entry for the
			// discarded row must never reach the index tree.
			await expectThrows(() => db.exec(`insert into Item (id, cat) values (2, 'b')`));

			expect(await selectCount(db, 'select count(*) as c from Item')).to.equal(1);
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_item_cat`)).to.equal(1);
		} finally {
			db.close();
		}
	});

	it('regression: an immediate (no-subquery) CHECK rejection still leaves no row', async () => {
		const uri = 'tree://deferred/imm';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table Imm (id integer primary key, v text,
					check (v <> 'bad'))
					using optimystic('${uri}')`,
			);
			await db.exec(`insert into Imm (id, v) values (1, 'ok')`);

			// Immediate CHECK fires at row time, before the vtab stages anything.
			await expectThrows(() => db.exec(`insert into Imm (id, v) values (2, 'bad')`));

			expect(await selectCount(db, 'select count(*) as c from Imm')).to.equal(1);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from Imm')).to.equal(1);
	});
});
