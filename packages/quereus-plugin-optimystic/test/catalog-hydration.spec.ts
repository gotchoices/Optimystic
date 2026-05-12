/**
 * Verifies the plugin's `hydrate(db)` entrypoint populates Quereus's
 * in-memory catalog from persisted vtab schemas at startup.
 *
 * Without hydration, opening a fresh `Database` against existing storage and
 * running `apply schema` (or even `CREATE TABLE IF NOT EXISTS`) makes Quereus
 * diff against an empty catalog and re-emit a CREATE for every table — each
 * one round-tripping through the schema tree even though no row data
 * changes. After hydration the catalog already lists those tables, so the
 * diff sees them and emits nothing.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

/** Build a `local`-style transactor over the supplied raw storage. Constructed
 * once so both plugin instances can share a single transactor and Trees opened
 * by either side see the other's writes. (CollectionFactory normally caches
 * transactors per-instance, so two plugin instances would otherwise build two
 * transactors with two independent trackers.) */
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
	// Inject the shared transactor under the cache key the plugin will look up
	// when it parses `default_transactor: 'local'` (`getTransactorKey` →
	// `${transactor}:${keyNetwork}`).
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return plugin;
}

describe('Optimystic plugin catalog hydration', function () {
	this.timeout(15_000);

	it('populates Quereus catalog from persisted vtab schemas before any DDL', async () => {
		const storage = new MemoryRawStorage();
		const sharedTransactor = buildSharedLocalTransactor(storage);

		// --- Session 1: create + populate
		const dbA = new Database();
		registerWithSharedTransactor(dbA, sharedTransactor);
		await dbA.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT NULL
			) USING optimystic('tree://hydrate-test/users')
		`);
		await dbA.exec(`INSERT INTO users (id, name, email) VALUES (1, 'alice', 'a@x')`);

		// --- Session 2: fresh Database, fresh plugin, SHARED transactor + storage
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, sharedTransactor);

		// Catalog is empty before hydration.
		expect(dbB.schemaManager.findTable('users', 'main')).to.equal(undefined);

		const result = await pluginB.hydrate(dbB);
		expect(result.tables).to.equal(1);

		// After hydration the table is in the catalog with its full column shape.
		const hydrated = dbB.schemaManager.findTable('users', 'main');
		expect(hydrated, 'users table should be in catalog after hydrate').to.not.equal(undefined);
		expect(hydrated!.columns.map(c => c.name)).to.deep.equal(['id', 'name', 'email']);
		expect(hydrated!.vtabModuleName).to.equal('optimystic');

		// Re-hydrating is a no-op (idempotent).
		const second = await pluginB.hydrate(dbB);
		expect(second.tables).to.equal(0);

		// And queries against the hydrated table actually reach the underlying
		// data through module.connect() — so the round-trip works end-to-end.
		const rows = await collectRows(dbB.eval('SELECT id, name, email FROM users WHERE id = 1'));
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]).to.deep.include({ id: 1, name: 'alice', email: 'a@x' });
	});

	it('hydrate is a no-op against empty storage (cold start)', async () => {
		const storage = new MemoryRawStorage();
		const transactor = buildSharedLocalTransactor(storage);
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, transactor);

		const result = await plugin.hydrate(db);
		expect(result).to.deep.equal({ tables: 0, indexes: 0 });
	});
});
