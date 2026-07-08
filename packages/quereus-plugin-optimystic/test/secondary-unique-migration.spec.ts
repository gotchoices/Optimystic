/**
 * Migration coverage for the index-backed secondary-UNIQUE probe
 * (see ticket `optimystic-unique-probe-index-backed`).
 *
 * The probe enforces a plain secondary UNIQUE by point-probing a synthesized
 * `_uniq_<cols>` index tree. A table CREATED under this build maintains that tree from
 * the first insert, so it is always in sync. The danger is a table whose rows were
 * written by an OLDER build that never maintained such a tree: the tree is EMPTY while
 * the main table is populated, so a naive probe would find no collision and silently
 * admit a duplicate. The vtab guards this with a one-time backfill of the unique tree
 * from the existing rows before the first probe trusts it.
 *
 * This test simulates the migration: build 1 creates the table WITHOUT a UNIQUE
 * constraint (so no unique tree is ever created) and inserts rows into a persistent
 * FileRawStorage-backed collection. Build 2 opens the SAME collection URI with the
 * UNIQUE constraint declared — its unique tree starts empty over a populated table — and
 * must reject a duplicate of a pre-existing value.
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

function createDb(dir: string): { db: Database } {
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
	return { db };
}

async function scalar(db: Database, sql: string): Promise<SqlValue> {
	for await (const row of db.eval(sql)) {
		const values = Object.values(row as Record<string, SqlValue>);
		return values[0] as SqlValue;
	}
	throw new Error('query returned no rows');
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

describe('Secondary-UNIQUE migration: backfill an empty unique tree over pre-existing rows', function () {
	this.timeout(20000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-uniq-migration', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('rejects a duplicate of a pre-existing value on a fresh instance whose unique tree started empty', async () => {
		const uri = 'tree://uniqmig/x';

		// Build 1: NO unique constraint — rows land in the main collection with no unique
		// tree ever created. This is the "older build" state.
		{
			const { db } = createDb(dir);
			try {
				await db.exec(
					`create table T (Id integer primary key, Stamp text not null) using optimystic('${uri}')`,
				);
				await db.exec(`insert into T (Id, Stamp) values (1, 'a')`);
				await db.exec(`insert into T (Id, Stamp) values (2, 'b')`);
				await db.exec(`insert into T (Id, Stamp) values (3, 'c')`);
			} finally {
				db.close();
			}
		}

		// Build 2: SAME collection URI, now WITH the UNIQUE constraint. The `_uniq_1`
		// tree is empty while the main table already holds 3 rows. The one-time backfill
		// must populate it before the first probe, so a duplicate of a pre-existing value
		// is rejected.
		{
			const { db } = createDb(dir);
			try {
				await db.exec(
					`create table T (Id integer primary key, Stamp text not null unique) using optimystic('${uri}')`,
				);
				// 'a' already exists (from build 1) — must be rejected by the backfilled probe.
				await expectThrows(
					() => db.exec(`insert into T (Id, Stamp) values (4, 'a')`),
					/UNIQUE constraint failed/,
				);
				// A genuinely new value inserts fine.
				await db.exec(`insert into T (Id, Stamp) values (5, 'd')`);
				expect(Number(await scalar(db, `select count(*) as v from T`))).to.equal(4);
				expect(Number(await scalar(db, `select count(*) as v from T where Stamp = 'a'`))).to.equal(1);
			} finally {
				db.close();
			}
		}
	});
});
