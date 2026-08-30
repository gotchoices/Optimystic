/**
 * CHARACTERIZATION of a known defect — ticket slug
 * `drop-leaves-storage-the-catalog-no-longer-describes`.
 *
 * `DROP TABLE` tombstones the table's catalog entry and leaves the data collection at
 * the table's URI — and the secondary-index trees at `<uri>/index/<name>` — untouched.
 * Nothing then describes that storage, so the next `CREATE TABLE` over the same URI
 * adopts it silently.
 *
 * EVERY assertion below pins CURRENT, WRONG behaviour so the fix has a before/after.
 * When the declaration guard lands, these cases become refusals and this file's
 * assertions must be replaced with the refusal messages (that replacement is a TODO on
 * the implement ticket). Do not read a passing run here as "this works".
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

/** Session A: create `t` at `uri`, optionally index one column, and write one row. */
async function seed(
	shared: ITransactor,
	uri: string,
	options: { indexOn?: string } = {},
): Promise<void> {
	const db = new Database();
	registerWithSharedTransactor(db, shared);
	try {
		await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('${uri}')`);
		if (options.indexOn) {
			await db.exec(`create index ix on t (${options.indexOn})`);
		}
		await db.exec(`insert into t (id, a, b) values (1, 'aa', 'bb')`);
	} finally {
		db.close();
	}
}

describe('DROP TABLE leaves storage the catalog no longer describes', () => {
	it('re-creating at the same URI under a DIFFERENT column list serves rows the declaration says are impossible', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/shape');

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			// `z` was never written by anyone. Quereus defaults a column to NOT NULL, so a
			// NULL `z` is a value this table's own declaration forbids.
			await db.exec(`create table t (id integer primary key, z integer) using optimystic('tree://scratch/shape')`);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, z: null }]);
		} finally {
			db.close();
		}
	});

	it('re-creating at the same URI under the SAME column list brings every dropped row back', async () => {
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

	it('a secondary-index tree survives DROP and, re-adopted under the same name on a DIFFERENT column, answers every seek empty', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/idx', { indexOn: 'b' });

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/idx')`);
			// The tree at tree://scratch/idx/index/ix still holds the dropped table's
			// entries, keyed on `b` values. `ix` is absent from the (tombstoned) catalog
			// entry, so this takes addIndex's build path and adopts that tree.
			await db.exec(`create index ix on t (a)`);
			await db.exec(`insert into t (id, a, b) values (2, 'zz', 'yy')`);

			// A full scan sees both rows...
			expect(await queryAll(db, `select * from t`)).to.deep.equal([
				{ id: 1, a: 'aa', b: 'bb' },
				{ id: 2, a: 'zz', b: 'yy' },
			]);
			// ...while every seek routed through the adopted tree answers empty — including
			// for the row inserted AFTER the adoption, so this is not merely stale entries.
			expect(await queryAll(db, `select * from t where a = 'aa'`)).to.deep.equal([]);
			expect(await queryAll(db, `select * from t where a = 'zz'`)).to.deep.equal([]);
		} finally {
			db.close();
		}
	});

	it('control: the same sequence under an index name storage has never seen answers correctly', async () => {
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

	it('control: re-adopting an index tree on the SAME column it was built on answers correctly', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		await seed(shared, 'tree://scratch/same-ix', { indexOn: 'b' });

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, shared);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://scratch/same-ix')`);
			await db.exec(`create index ix on t (b)`);
			expect(await queryAll(db, `select * from t where b = 'bb'`)).to.deep.equal([
				{ id: 1, a: 'aa', b: 'bb' },
			]);
		} finally {
			db.close();
		}
	});
});
