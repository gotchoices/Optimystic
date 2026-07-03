/**
 * Regression test for composite-PK point-lookup key assembly.
 *
 * A row lookup by a multi-column primary key was returning nothing because
 * `executePointLookup` only used the first key column and dropped the rest,
 * building a key like "M1" while rows are stored under "M1\x00P1". The fix
 * passes ALL seek args to `RowCodec.createPrimaryKey` so the assembled byte
 * string matches the stored key.
 *
 * These tests run against the `local` transactor backed by `FileRawStorage`
 * so they exercise the real seek path with no mocking.
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

describe('composite-PK point-lookup key assembly', function () {
	this.timeout(15000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-composite-pk-lookup', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('finds a row by composite primary key (two-column PK point lookup)', async () => {
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table MemberPeer (MemberKey text, PeerId text, note text,
					primary key (MemberKey, PeerId))
					using optimystic('tree://test/memberpeer')`,
			);
			await db.exec(`insert into MemberPeer (MemberKey, PeerId, note) values ('M1', 'P1', 'hello')`);

			// Full table scan must see the row
			expect(await selectCount(db, 'select count(1) from MemberPeer')).to.equal(1);

			// Composite-PK point lookup must also find it (pre-fix: returned undefined)
			expect(
				await selectScalar(db, `select note from MemberPeer where MemberKey = 'M1' and PeerId = 'P1'`),
			).to.equal('hello');
		} finally {
			db.close();
		}
	});

	it('composite-PK point lookup does not regress single-column PK', async () => {
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table T (id text primary key, v text) using optimystic('tree://test/single')`,
			);
			await db.exec(`insert into T (id, v) values ('x', 'value-x')`);

			expect(await selectCount(db, 'select count(1) from T')).to.equal(1);
			expect(await selectScalar(db, `select v from T where id = 'x'`)).to.equal('value-x');
		} finally {
			db.close();
		}
	});

	it('finds the row when the WHERE predicates are written in non-PK column order', async () => {
		// The fix relies on Quereus delivering seek args in PK-definition order
		// (seekColumnIndexes = [...pkColumns]) regardless of the textual order of the
		// WHERE predicates. createPrimaryKey maps args positionally to the PK columns,
		// so if that contract ever changed the assembled key would silently flip to
		// "P1\x00M1" and miss. This locks the contract in.
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table MemberPeer (MemberKey text, PeerId text, note text,
					primary key (MemberKey, PeerId))
					using optimystic('tree://test/memberpeer-rev')`,
			);
			await db.exec(`insert into MemberPeer (MemberKey, PeerId, note) values ('M1', 'P1', 'hello')`);

			// PeerId listed before MemberKey — opposite of PK definition order.
			expect(
				await selectScalar(db, `select note from MemberPeer where PeerId = 'P1' and MemberKey = 'M1'`),
			).to.equal('hello');
		} finally {
			db.close();
		}
	});

	it('pk-range-filter: range predicate on TEXT PK returns matching subset, not full table', async () => {
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table R (id text primary key, v text) using optimystic('tree://test/pkrange')`,
			);
			for (const k of ['a', 'b', 'c', 'd', 'e']) {
				await db.exec(`insert into R (id, v) values ('${k}', 'val-${k}')`);
			}
			expect(await selectCount(db, 'select count(1) from R')).to.equal(5);

			// id > 'c' → 'd', 'e' → 2 rows
			expect(await selectCount(db, `select count(1) from R where id > 'c'`)).to.equal(2);

			// id > 'a' AND id < 'e' → 'b', 'c', 'd' → 3 rows
			expect(await selectCount(db, `select count(1) from R where id > 'a' and id < 'e'`)).to.equal(3);
		} finally {
			db.close();
		}
	});

	it('finds a row by a three-column composite primary key', async () => {
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table Triple (a text, b text, c text, note text,
					primary key (a, b, c))
					using optimystic('tree://test/triple')`,
			);
			await db.exec(`insert into Triple (a, b, c, note) values ('A', 'B', 'C', 'tri')`);
			await db.exec(`insert into Triple (a, b, c, note) values ('A', 'B', 'X', 'other')`);

			expect(await selectCount(db, 'select count(1) from Triple')).to.equal(2);
			// Full three-column seek must isolate exactly the matching row, not its
			// shared-prefix sibling ('A','B','X').
			expect(
				await selectScalar(db, `select note from Triple where a = 'A' and b = 'B' and c = 'C'`),
			).to.equal('tri');
		} finally {
			db.close();
		}
	});
});
