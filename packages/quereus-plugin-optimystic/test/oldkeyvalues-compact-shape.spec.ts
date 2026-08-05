/**
 * Reproduction + regression coverage for `UpdateArgs.oldKeyValues` being read as
 * a FULL ROW instead of the COMPACT key tuple the engine actually sends (see fix
 * ticket `bug-same-key-update-reports-unique-collision-with-itself`).
 *
 * quereus's contract (`vtab/table.ts`, `UpdateArgs.oldKeyValues`) is explicit:
 * "exactly one cell per `primaryKeyDefinition` entry, in that order — NOT a full
 * row indexed by column position. A vtab must address it as `keyValues[i]` for PK
 * column `i`, never `row[pkDef[i].index]`; the two agree only when the PK columns
 * happen to be the table's leading columns in PK order."
 *
 * The vtab used `rowCodec.extractPrimaryKey(oldKeyValues)`, which does exactly the
 * forbidden `row[pkDef[i].index]` addressing. When the PK columns are NOT the
 * leading columns in PK order, the derived `oldKey` is garbage, which:
 *   - makes a SAME-KEY update look like a PK move onto an occupied key, so the row
 *     is rejected as colliding with ITSELF ("UNIQUE constraint failed: …"), and
 *   - makes a DELETE clear a key that does not exist, so the row survives.
 *
 * Every table here therefore declares its PK columns off the leading positions;
 * `Revocation`-shaped `(TableName text, RowKey text, StampId text, …) primary key
 * (TableName, StampId)` is the real-world shape that surfaced this.
 *
 * Runs against the real `local` transactor over a real `FileRawStorage` directory,
 * so persistence + reopen are exercised, not a fake.
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

async function reopenScalar(dir: string, sql: string): Promise<SqlValue> {
	const { db, plugin } = createDb(dir);
	try {
		await plugin.hydrate(db);
		return await selectScalar(db, sql);
	} finally {
		db.close();
	}
}

describe('UpdateArgs.oldKeyValues compact-tuple shape (local/bootstrap transactor)', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-oldkeyvalues-shape', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('UPDATE of a non-key column on a composite PK whose columns are NOT leading updates in place', async () => {
		const uri = 'tree://oldkeyshape/revocation';
		const { db } = createDb(dir);
		try {
			// Revocation's real shape: PK columns sit at schema indices 0 and 2, so
			// the compact key tuple [TableName, StampId] and the full-row addressing
			// row[0]/row[2] disagree.
			await db.exec(
				`create table Revocation (
					TableName text,
					RowKey text not null,
					StampId text,
					ReissuedAt integer not null default 0,
					primary key (TableName, StampId)
				) using optimystic('${uri}')`,
			);
			await db.exec(
				`insert into Revocation (TableName, RowKey, StampId, ReissuedAt)
					values ('OwnerKey', 'K1', 'S1', 0)`,
			);

			// The PK is untouched; only the counter moves. This must NOT be reported
			// as a UNIQUE violation against the row's own key.
			await db.exec(
				`update Revocation set ReissuedAt = ReissuedAt + 1
					where TableName = 'OwnerKey' and StampId = 'S1'`,
			);

			expect(await selectCount(db, 'select count(*) as c from Revocation')).to.equal(1);
			expect(Number(await selectScalar(db,
				`select ReissuedAt from Revocation where TableName = 'OwnerKey' and StampId = 'S1'`,
			))).to.equal(1);
			// The rest of the row survived the in-place rewrite.
			expect(await selectScalar(db,
				`select RowKey from Revocation where TableName = 'OwnerKey' and StampId = 'S1'`,
			)).to.equal('K1');
		} finally {
			db.close();
		}

		expect(Number(await reopenScalar(dir,
			`select ReissuedAt from Revocation where TableName = 'OwnerKey' and StampId = 'S1'`,
		))).to.equal(1);
	});

	it('DELETE addressed by a non-leading composite PK removes the row', async () => {
		const uri = 'tree://oldkeyshape/delete';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table D (
					a text,
					filler text,
					b text,
					primary key (a, b)
				) using optimystic('${uri}')`,
			);
			await db.exec(`insert into D (a, filler, b) values ('x', 'f', 'y')`);
			expect(await selectCount(db, 'select count(*) as c from D')).to.equal(1);

			await db.exec(`delete from D where a = 'x' and b = 'y'`);
			expect(await selectCount(db, 'select count(*) as c from D')).to.equal(0);
		} finally {
			db.close();
		}

		expect(Number(await reopenScalar(dir, 'select count(*) as c from D'))).to.equal(0);
	});

	it('UPDATE that MOVES a non-leading composite PK leaves no stale row at the old key', async () => {
		const uri = 'tree://oldkeyshape/move';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table M (
					a text,
					filler text,
					b text,
					primary key (a, b)
				) using optimystic('${uri}')`,
			);
			await db.exec(`insert into M (a, filler, b) values ('x', 'f', 'y')`);

			await db.exec(`update M set b = 'z' where a = 'x' and b = 'y'`);

			// Exactly one row, at the NEW key. A wrong oldKey clears a slot nothing
			// occupies and leaves the original row behind -> count 2.
			expect(await selectCount(db, 'select count(*) as c from M')).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from M where b = 'z'`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from M where b = 'y'`)).to.equal(0);
		} finally {
			db.close();
		}

		expect(Number(await reopenScalar(dir, 'select count(*) as c from M'))).to.equal(1);
	});

	it('UPDATE of a non-key column on a single-column PK that is NOT the first column updates in place', async () => {
		const uri = 'tree://oldkeyshape/single';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table S (
					payload text,
					id integer primary key
				) using optimystic('${uri}')`,
			);
			await db.exec(`insert into S (payload, id) values ('p', 7)`);

			await db.exec(`update S set payload = 'q' where id = 7`);

			expect(await selectCount(db, 'select count(*) as c from S')).to.equal(1);
			expect(await selectScalar(db, 'select payload from S where id = 7')).to.equal('q');
		} finally {
			db.close();
		}

		expect(await reopenScalar(dir, 'select payload from S where id = 7')).to.equal('q');
	});
});
