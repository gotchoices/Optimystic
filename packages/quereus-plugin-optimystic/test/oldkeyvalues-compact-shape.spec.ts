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
import type { SqlValue, Row } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

type Plugin = ReturnType<typeof register>;

/** Minimal surface needed to drive a table's write path by hand, bypassing the
 * SQL engine's own transaction orchestration (which begins a connection's
 * transaction before ever calling `update`). */
interface HandDrivenTable {
	ensureConnectionRegistered(): Promise<{
		begin(): Promise<void>;
		commit(): Promise<void>;
		rollback(): Promise<void>;
	}>;
	update(args: {
		operation: 'update' | 'delete';
		values: Row | undefined;
		oldKeyValues?: Row;
	}): Promise<unknown>;
}

interface ConnectableModule {
	connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: Record<string, unknown>,
	): Promise<HandDrivenTable>;
}

function moduleOf(plugin: Plugin): ConnectableModule {
	return plugin.vtables[0]!.module as unknown as ConnectableModule;
}

/** Open a live (non-committed) connect on the plugin's module by hand — this
 * resolves to the SAME cached table instance the SQL engine itself writes
 * through, so a hand-driven `update()` call shares the real collection. */
async function connectTable(db: Database, plugin: Plugin, tableName: string): Promise<HandDrivenTable> {
	return moduleOf(plugin).connect(db, null, 'optimystic', 'main', tableName, {});
}

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

/**
 * Drive one hand-written `update()` against a table whose only row has already
 * been deleted, and assert it throws rather than fabricating a pre-write image.
 *
 * Going around `db.exec()` means replicating the transaction lifecycle the engine
 * would otherwise run (begin before the write, rollback on a failed DML) — the
 * engine never commits a transaction whose DML threw, so neither does this.
 */
async function expectMissingPreWriteRowThrow(
	dir: string,
	uri: string,
	args: { operation: 'update' | 'delete'; values: Row | undefined; oldKeyValues: Row },
): Promise<void> {
	const { db, plugin } = createDb(dir);
	try {
		await db.exec(
			`create table Missing (
				a text,
				filler text,
				b text,
				primary key (a, b)
			) using optimystic('${uri}')`,
		);
		await db.exec(`insert into Missing (a, filler, b) values ('x', 'f', 'y')`);
		await db.exec(`delete from Missing where a = 'x' and b = 'y'`);

		// The row is gone from the collection. Drive `update()` by hand with the
		// same (now-stale) compact key tuple a caller who still believed the row
		// existed would pass — simulating the engine and the collection
		// disagreeing about what exists (see ticket
		// bug-same-key-update-reports-unique-collision-with-itself, arm 1).
		const table = await connectTable(db, plugin, 'Missing');
		const conn = await table.ensureConnectionRegistered();
		await conn.begin();
		let thrown: unknown;
		try {
			await table.update(args);
		} catch (err) {
			thrown = err;
		} finally {
			await conn.rollback();
		}

		expect(thrown, 'update() should have thrown for a missing pre-write row').to.be.an('Error');
		expect((thrown as Error).message).to.match(/could not find the pre-write row/i);
		// The logical key values, not the control-character-framed encoded key.
		expect((thrown as Error).message).to.include(`("x", "y")`);

		// The rejected write must leave nothing behind — no resurrected row, and
		// no half-written state that a later read could trip over.
		expect(await selectCount(db, 'select count(*) as c from Missing')).to.equal(0);
	} finally {
		db.close();
	}
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

	/**
	 * The blind spot the arity guards CANNOT see.
	 *
	 * Every other case here relies on the two shapes having different lengths, which
	 * `extractPrimaryKey`'s full-row length check turns into a loud error. When EVERY
	 * table column is part of the primary key, a full row and a key tuple are the same
	 * length — here both are 2 — so no length check can tell them apart. Declaring the
	 * PK in the reverse of column order (`primary key (b, a)` over `(a, b)`) makes the
	 * two shapes disagree on CONTENT while agreeing on length: read as a row, the tuple
	 * `[b, a]` yields `frame(a, b)` instead of `frame(b, a)`.
	 *
	 * This passes on the already-fixed code — it documents the residual hole that the
	 * nominal key-tuple types close at compile time (see src/schema/key-tuples.ts and
	 * test/key-tuple-types.spec.ts), and pins it against a future regression.
	 */
	it('UPDATE and DELETE stay correct when EVERY column is in the PK and PK order is rotated', async () => {
		const uri = 'tree://oldkeyshape/rotated';
		const { db } = createDb(dir);
		try {
			await db.exec(
				`create table R (
					a text,
					b text,
					primary key (b, a)
				) using optimystic('${uri}')`,
			);
			await db.exec(`insert into R (a, b) values ('a1', 'b1')`);

			// Move a KEY column. A wrong oldKey clears a slot nothing occupies, leaving
			// the original row behind (count 2) — or makes the move look like a
			// collision with itself.
			await db.exec(`update R set a = 'a2' where a = 'a1' and b = 'b1'`);

			expect(await selectCount(db, 'select count(*) as c from R')).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from R where a = 'a2' and b = 'b1'`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from R where a = 'a1'`)).to.equal(0);
		} finally {
			db.close();
		}

		// Exactly one row survives the reopen, at the NEW key — the strongest signal
		// that the stored key bytes are the ones the read path rebuilds.
		expect(Number(await reopenScalar(dir, 'select count(*) as c from R'))).to.equal(1);
		expect(Number(await reopenScalar(dir,
			`select count(*) as c from R where a = 'a2' and b = 'b1'`,
		))).to.equal(1);

		// And the DELETE half, addressed by the same rotated tuple.
		const { db: db2, plugin } = createDb(dir);
		try {
			await plugin.hydrate(db2);
			await db2.exec(`delete from R where a = 'a2' and b = 'b1'`);
			expect(await selectCount(db2, 'select count(*) as c from R')).to.equal(0);
		} finally {
			db2.close();
		}

		expect(Number(await reopenScalar(dir, 'select count(*) as c from R'))).to.equal(0);
	});

	it('UPDATE throws (rather than fabricating an old row image) when the pre-write row is missing', async () => {
		await expectMissingPreWriteRowThrow(dir, 'tree://oldkeyshape/update-missing', {
			operation: 'update',
			values: ['x', 'f2', 'y'],
			oldKeyValues: ['x', 'y'],
		});
	});

	it('DELETE throws (rather than fabricating an old row image) when the pre-write row is missing', async () => {
		await expectMissingPreWriteRowThrow(dir, 'tree://oldkeyshape/delete-missing', {
			operation: 'delete',
			values: undefined,
			oldKeyValues: ['x', 'y'],
		});
	});
});
