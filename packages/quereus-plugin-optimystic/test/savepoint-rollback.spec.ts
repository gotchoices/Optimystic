/**
 * Regression coverage for REAL savepoints on the LOCAL / bootstrap transactor
 * (see fix ticket `optimystic-savepoint-noop-tracker-rollback`).
 *
 * Quereus uses savepoints internally for statement- and row-level atomicity: it
 * wraps every non-FAIL DML statement in a `__stmt_atomic` savepoint (rolled back
 * on any mid-statement violation) and every OR FAIL row in a `__or_fail` per-row
 * savepoint. It broadcasts create/rollback/release (by numeric depth) to every
 * registered connection. Previously the optimystic connection's savepoint methods
 * were no-ops, so a statement Quereus *thought* it rolled back left its staged rows
 * in the collection tracker — and they flushed at the next commit. The fix makes
 * the shared TransactionBridge implement savepoints as a depth-indexed stack of
 * collection snapshots (reusing snapshotPending/restorePending).
 *
 * These tests run against the real `local` transactor backed by a real
 * `FileRawStorage` directory, so they exercise persistence + reopen (legacy /
 * staged-tracker mode — the mode the savepoint fix targets). They FAIL on the
 * pre-fix no-op rollback (the discarded rows survived to commit).
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

/** Register the optimystic plugin against a fresh Database wired to the `local`
 * transactor over a host-supplied `FileRawStorage` rooted at `dir`. */
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

describe('Savepoint rollback (local/bootstrap transactor)', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-savepoint-rollback', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('statement-level ABORT unwinds partial rows but the transaction survives (primary repro)', async () => {
		const uri = 'tree://savepoint/abort';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table T (id integer primary key) using optimystic('${uri}')`);
			await db.exec('begin');
			await db.exec(`insert into T (id) values (1)`);

			// Row 2 stages first, then row 1 collides on the PK -> default ABORT:
			// the whole statement is undone but the transaction continues. Quereus
			// rolls back to __stmt_atomic; the fix must actually drop the staged row 2.
			await expectThrows(() => db.exec(`insert into T (id) values (2), (1)`));

			await db.exec('commit');

			// BUG (pre-fix): row 2 survived -> count 2. Fixed: only row 1 remains.
			expect(await selectCount(db, 'select count(*) as c from T')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from T where id = 1')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from T where id = 2')).to.equal(0);
		} finally {
			db.close();
		}

		// Reopen: the discarded row never reached storage.
		expect(await reopenCount(dir, 'select count(*) as c from T')).to.equal(1);
		expect(await reopenCount(dir, 'select count(*) as c from T where id = 2')).to.equal(0);
	});

	it('statement-level ABORT in autocommit (no explicit transaction) leaves nothing partial', async () => {
		const uri = 'tree://savepoint/autoabort';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table A (id integer primary key) using optimystic('${uri}')`);
			await db.exec(`insert into A (id) values (1)`);

			// Same shape as the primary repro but with no surrounding BEGIN: the
			// autocommit statement savepoint must still discard the staged row 2.
			await expectThrows(() => db.exec(`insert into A (id) values (2), (1)`));

			expect(await selectCount(db, 'select count(*) as c from A')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from A where id = 2')).to.equal(0);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from A where id = 2')).to.equal(0);
	});

	it('INSERT OR FAIL keeps earlier rows and does not clobber them when a later row fails', async () => {
		const uri = 'tree://savepoint/orfail';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table F (id integer primary key) using optimystic('${uri}')`);
			await db.exec(`insert into F (id) values (1)`);

			await db.exec('begin');
			// Row 2 stages ok, then row 1 collides -> OR FAIL aborts the statement but
			// PRESERVES prior rows (row 2). Row 1 gets its own __or_fail savepoint;
			// rolling it back must NOT clobber the already-staged row 2.
			await expectThrows(() => db.exec(`insert or fail into F (id) values (2), (1), (3)`));
			await db.exec('commit');

			// Row 2 kept; failing row 1 not double-inserted; row 3 never reached.
			expect(await selectCount(db, 'select count(*) as c from F')).to.equal(2);
			expect(await selectCount(db, 'select count(*) as c from F where id = 2')).to.equal(1);
			expect(await selectCount(db, 'select count(*) as c from F where id = 3')).to.equal(0);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from F')).to.equal(2);
		expect(await reopenCount(dir, 'select count(*) as c from F where id = 3')).to.equal(0);
	});

	it('nested user SAVEPOINT / ROLLBACK TO drops the inner and post-savepoint changes', async () => {
		const uri = 'tree://savepoint/nested';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table S (id integer primary key) using optimystic('${uri}')`);
			await db.exec('begin');
			await db.exec(`insert into S (id) values (1)`);
			await db.exec('savepoint sp1');
			await db.exec(`insert into S (id) values (2)`);
			await db.exec('savepoint sp2');
			await db.exec(`insert into S (id) values (3)`);

			// Roll back to sp1: both the nested sp2 scope (row 3) AND the row staged
			// after sp1 (row 2) must be discarded, leaving only row 1.
			await db.exec('rollback to sp1');
			await db.exec(`insert into S (id) values (4)`);
			await db.exec('commit');

			expect(await selectCount(db, 'select count(*) as c from S')).to.equal(2);
			expect(await selectCount(db, 'select count(*) as c from S where id in (1, 4)')).to.equal(2);
			expect(await selectCount(db, 'select count(*) as c from S where id in (2, 3)')).to.equal(0);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from S')).to.equal(2);
		expect(await reopenCount(dir, 'select count(*) as c from S where id in (2, 3)')).to.equal(0);
	});

	it('user RELEASE SAVEPOINT absorbs the inner changes into the enclosing transaction', async () => {
		const uri = 'tree://savepoint/release';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table R (id integer primary key) using optimystic('${uri}')`);
			await db.exec('begin');
			await db.exec(`insert into R (id) values (1)`);
			await db.exec('savepoint sp1');
			await db.exec(`insert into R (id) values (2)`);
			// RELEASE keeps row 2 staged (does NOT flush, does NOT discard).
			await db.exec('release sp1');
			await db.exec('commit');

			expect(await selectCount(db, 'select count(*) as c from R')).to.equal(2);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from R')).to.equal(2);
	});

	it('ROLLBACK TO a savepoint twice is idempotent (savepoint preserved)', async () => {
		const uri = 'tree://savepoint/twice';
		const { db } = createDb(dir);
		try {
			await db.exec(`create table W (id integer primary key) using optimystic('${uri}')`);
			await db.exec('begin');
			await db.exec(`insert into W (id) values (1)`);
			await db.exec('savepoint sp1');
			await db.exec(`insert into W (id) values (2)`);
			await db.exec('rollback to sp1');
			// Rolling back to the SAME savepoint again must be a clean no-op (the
			// savepoint remains open per SQL standard), then more work can proceed.
			await db.exec('rollback to sp1');
			await db.exec(`insert into W (id) values (3)`);
			await db.exec('commit');

			expect(await selectCount(db, 'select count(*) as c from W')).to.equal(2);
			expect(await selectCount(db, 'select count(*) as c from W where id in (1, 3)')).to.equal(2);
			expect(await selectCount(db, 'select count(*) as c from W where id = 2')).to.equal(0);
		} finally {
			db.close();
		}
	});

	it('a savepoint spanning a still-clean index tree reverts that tree to clean', async () => {
		const uri = 'tree://savepoint/index';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(`create table I (id integer primary key, cat text) using optimystic('${uri}')`);
			await db.exec(`create index idx_i_cat on I (cat)`);
			await db.exec(`insert into I (id, cat) values (1, 'a')`);

			// Row 2 stages a main-table row AND an index entry, then row 1 collides
			// -> statement ABORT. Both the main row and its index entry must revert.
			await db.exec('begin');
			await expectThrows(() => db.exec(`insert into I (id, cat) values (2, 'b'), (1, 'z')`));
			await db.exec('commit');

			expect(await selectCount(db, 'select count(*) as c from I')).to.equal(1);
			// Query via the index: the discarded row's index entry must be gone.
			expect(await selectCount(db, `select count(*) as c from I where cat = 'b'`)).to.equal(0);
			expect(await selectCount(db, `select count(*) as c from I where cat = 'a'`)).to.equal(1);
		} finally {
			void plugin;
			db.close();
		}

		expect(await reopenCount(dir, `select count(*) as c from I where cat = 'b'`)).to.equal(0);
	});
});
