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
