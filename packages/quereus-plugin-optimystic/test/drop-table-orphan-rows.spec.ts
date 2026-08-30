/**
 * The rule under test (ticket slug `drop-leaves-storage-the-catalog-no-longer-describes`):
 *
 * > Storage must not outlive the catalog record that describes it. A table or index
 * > declared over storage whose describing record is gone must fail loudly rather
 * > than silently adopt that storage.
 *
 * `DROP TABLE` is definition-only — it gravestones the table's catalog entry and leaves
 * the data collection at the table's URI (and the secondary-index trees at
 * `<uri>/index/<name>`) untouched. The guards checked here make the NEXT declaration
 * over that leftover storage refuse when it contradicts what the gravestone says the
 * storage holds, while the deliberately-supported adoptions keep working:
 *
 *   REFUSED: a re-declare that ADDS a column the stored rows cannot supply; one that
 *   RE-TYPES a column they do carry; one that changes the PRIMARY KEY the stored rows
 *   are keyed under; a second live table
 *   declared over the same URI with a contradicting shape; a CREATE INDEX that would
 *   adopt a leftover non-empty index tree under a different column list.
 *
 *   STILL ALLOWED: an identical re-declare (the dropped rows come back — documented in
 *   the README); a NARROWER re-declare (every declared column is still backed by real
 *   stored values); a fresh index name; re-adopting an index tree on the same column it
 *   was built on; any re-declare over an EMPTY collection.
 *
 * Single-process, in-memory (`MemoryRawStorage` shared across plugin instances, one
 * Database per "session") — the same harness as schema-redeclare-column-identity.spec.ts.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { queryAll } from './query-helpers.js';

function buildSharedLocalTransactor(storage: MemoryRawStorage): ITransactor {
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
	return {
		async get(blockGets) { return await repo.get(blockGets); },
		async getStatus(_trxRefs) { throw new Error('getStatus not implemented in test transactor'); },
		async pend(request) { return await repo.pend(request); },
		async commit(request) { return await repo.commit(request); },
		async cancel(trxRef) { return await repo.cancel(trxRef); },
	} as ITransactor;
}

function registerWithSharedTransactor(db: Database, transactor: ITransactor) {
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	});
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return plugin;
}

/** Run `body` and return what it threw, failing the test if it resolved instead. */
async function captureFailure(body: () => Promise<unknown>, why: string): Promise<Error> {
	let caught: Error | undefined;
	try {
		await body();
	} catch (error) {
		caught = error as Error;
	}
	expect(caught, why).to.not.equal(undefined);
	return caught!;
}

/** Session A: create `t` at `uri`, optionally index one column, optionally write one row. */
async function seed(
	shared: ITransactor,
	uri: string,
	options: { indexOn?: string; row?: boolean } = {},
): Promise<void> {
	const db = new Database();
	registerWithSharedTransactor(db, shared);
	try {
		await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('${uri}')`);
		if (options.indexOn) {
			await db.exec(`create index ix on t (${options.indexOn})`);
		}
		if (options.row !== false) {
			await db.exec(`insert into t (id, a, b) values (1, 'aa', 'bb')`);
		}
	} finally {
		db.close();
	}
}

describe('Storage must not outlive the catalog record that describes it', () => {
	it('refuses a re-create at the same URI that ADDS a column the stored rows cannot supply', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/shape');

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			// `z` was never written by anyone; pre-guard, the surviving rows decoded it
			// as NULL even though Quereus defaults every column to NOT NULL.
			const failure = await captureFailure(
				() => db.exec(`create table t (id integer primary key, z integer) using optimystic('tree://scratch/shape')`),
				'a re-declare adding a column the stored rows cannot supply must be refused',
			);
			expect(failure.message).to.include(`Cannot create table 't' over 'tree://scratch/shape'`);
			expect(failure.message).to.include(`adds column 'z'`);
			expect(failure.message).to.include('a dropped table declared as (id, a, b)');

			// The way out the message names — re-declaring the columns the stored rows
			// were written under — must work on the very next statement (a refused
			// CREATE leaves no half-registered table behind).
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/shape')`);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});

	it('refuses a re-create at the same URI that RE-TYPES a column the stored rows carry', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/affinity');

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			// Same column names and same primary key, but `a` was written as TEXT. A row
			// is stored as untagged name-keyed JSON, so re-declaring `a` as BLOB makes
			// RowCodec base64-decode the stored string into bytes — neither what was
			// written nor an error.
			const failure = await captureFailure(
				() => db.exec(`create table t (id integer primary key, a blob, b text) using optimystic('tree://scratch/affinity')`),
				'a re-declare re-typing a column the stored rows carry must be refused',
			);
			expect(failure.message).to.include(`Cannot create table 't' over 'tree://scratch/affinity'`);
			expect(failure.message).to.include(`re-types column 'a' as BLOB where the stored rows were written as TEXT`);

			// The way out the message names works on the very next statement, and the
			// stored value comes back as the TEXT it was written as.
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/affinity')`);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});

	it('refuses a re-create at the same URI under a DIFFERENT primary key', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/pk');

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			// Same column set, but every stored row sits under a tree key computed from
			// `id` — a table keyed on `a` would never compute a key that reaches them.
			const failure = await captureFailure(
				() => db.exec(`create table t (id integer, a text primary key, b text) using optimystic('tree://scratch/pk')`),
				'a re-declare changing the primary key the stored rows are keyed under must be refused',
			);
			expect(failure.message).to.include(`Cannot create table 't' over 'tree://scratch/pk'`);
			expect(failure.message).to.include('keyed on (id)');
			expect(failure.message).to.include('keys on (a)');
		} finally {
			db.close();
		}
	});

	it('refuses a SECOND live table declared over the same URI with a contradicting shape', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());

		const db = new Database();
		registerWithSharedTransactor(db, shared);
		try {
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/shared-uri')`);
			await db.exec(`insert into t (id, a, b) values (1, 'aa', 'bb')`);
			// No DROP anywhere: the describing record is t's LIVE catalog entry.
			const failure = await captureFailure(
				() => db.exec(`create table t2 (id integer primary key, z integer) using optimystic('tree://scratch/shared-uri')`),
				'a second table over the same URI with a contradicting shape must be refused',
			);
			expect(failure.message).to.include(`Cannot create table 't2' over 'tree://scratch/shared-uri'`);
			expect(failure.message).to.include(`live table 't'`);
			// The refusal touches nothing: the first table keeps working.
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});

	it('still allows an identical re-declare — the dropped rows come back (README-documented)', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/same');

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/same')`);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});

	it('still allows any re-declare over an EMPTY collection (created, never written, dropped)', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/empty', { row: false });

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			// A different shape AND a different primary key: an empty collection cannot
			// mangle anything, so the guard lets it through.
			await db.exec(`create table t (id integer, z text primary key) using optimystic('tree://scratch/empty')`);
			await db.exec(`insert into t (id, z) values (7, 'zz')`);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 7, z: 'zz' }]);
		} finally {
			db.close();
		}
	});

	it('gravestones the catalog record even when the drop never touches the table', async () => {
		// The refusal tests above all drop straight after `hydrate()` without querying,
		// so the module holds no instance for the table when `destroy()` runs. The
		// catalog write has to happen anyway: otherwise the record outlives its own
		// DROP as a LIVE entry, and this is the half that shows it — a later session
		// hydrating the same storage must not see the table come back.
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/untouched');

		const dbDrop = new Database();
		const pluginDrop = registerWithSharedTransactor(dbDrop, shared);
		try {
			expect((await pluginDrop.hydrate(dbDrop)).tables).to.equal(1);
			await dbDrop.exec(`drop table t`);
		} finally {
			dbDrop.close();
		}

		const dbAfter = new Database();
		const pluginAfter = registerWithSharedTransactor(dbAfter, shared);
		try {
			expect(
				(await pluginAfter.hydrate(dbAfter)).tables,
				'a dropped table must not be resurrected by the next hydrate',
			).to.equal(0);
		} finally {
			dbAfter.close();
		}
	});

	it('refuses to re-adopt a leftover index tree under the same name on a DIFFERENT column', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/idx', { indexOn: 'b' });

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/idx')`);
			// The tree at tree://scratch/idx/index/ix still holds the dropped table's
			// entries, keyed on `b` values. Pre-guard this adopted that tree and every
			// seek through it answered empty — including for rows inserted AFTER the
			// adoption.
			const failure = await captureFailure(
				() => db.exec(`create index ix on t (a)`),
				'adopting a non-empty leftover index tree under a different column must be refused',
			);
			expect(failure.message).to.include(`Cannot create index 'ix' over 'tree://scratch/idx/index/ix'`);
			expect(failure.message).to.include('declared on (b), not (a)');
			// The way out the message names: a different index name works immediately.
			await db.exec(`create index ix2 on t (a)`);
			expect(await queryAll(db, `select * from t where a = 'aa'`)).to.deep.equal([
				{ id: 1, a: 'aa', b: 'bb' },
			]);
		} finally {
			db.close();
		}
	});

	it('still allows an index name storage has never seen', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/fresh-ix', { indexOn: 'b' });

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/fresh-ix')`);
			await db.exec(`create index freshix on t (a)`);
			expect(await queryAll(db, `select * from t where a = 'aa'`)).to.deep.equal([
				{ id: 1, a: 'aa', b: 'bb' },
			]);
		} finally {
			db.close();
		}
	});

	it('still allows re-adopting an index tree on the SAME column it was built on', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/same-ix', { indexOn: 'b' });

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/same-ix')`);
			// A peer that built the same index over the same columns produces a matching
			// record and is adopted exactly as before the guard — the multi-node
			// re-attach path depends on this.
			await db.exec(`create index ix on t (b)`);
			expect(await queryAll(db, `select * from t where b = 'bb'`)).to.deep.equal([
				{ id: 1, a: 'aa', b: 'bb' },
			]);
		} finally {
			db.close();
		}
	});
});
