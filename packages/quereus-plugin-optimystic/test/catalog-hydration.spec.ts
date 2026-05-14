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

	it('doInitialize skips storeSchema when local DDL matches the persisted schema', async () => {
		// Regression guard for the doInitialize short-circuit. After hydrate
		// populates the catalog with the persisted column shape, a subsequent
		// connect()/initialize() must NOT re-write the byte-identical schema —
		// the post-hydrate cold-start cost is exactly the thing being avoided.
		const storage = new MemoryRawStorage();
		const sharedTransactor = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, sharedTransactor);
		await dbA.exec(`
			CREATE TABLE widgets (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				price REAL
			) USING optimystic('tree://hydrate-test/widgets')
		`);

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, sharedTransactor);
		await pluginB.hydrate(dbB);

		// Wrap storeSchema on the shared SchemaManager so we can count calls
		// during the post-hydrate query path. Reaching into the module's
		// internal `schemaManagers` Map is fine here because the whole point
		// of the change under test is that hydrate and per-table init share
		// the same SchemaManager instance.
		const optimysticModule = pluginB.vtables[0]!.module as unknown as {
			schemaManagers: Map<string, { storeSchema: (...args: any[]) => Promise<void> }>;
		};
		const managers = [...optimysticModule.schemaManagers.values()];
		expect(managers, 'hydrate should have populated the shared SchemaManager map').to.have.lengthOf(1);
		const manager = managers[0]!;
		let storeCalls = 0;
		const originalStore = manager.storeSchema.bind(manager);
		manager.storeSchema = async (...args: any[]) => {
			storeCalls++;
			return originalStore(...args);
		};

		// First query: triggers connect() → doInitialize() against the hydrated
		// schema. The candidate StoredTableSchema built from the local columns
		// must match the persisted bytes, so the write-then-read-back path is
		// skipped entirely.
		await collectRows(dbB.eval('SELECT id, name FROM widgets'));
		expect(storeCalls, 'storeSchema should not be called when persisted schema matches').to.equal(0);

		// Second query against the same table: still no writes — the table is
		// already initialized, so doInitialize doesn't even rerun.
		await collectRows(dbB.eval('SELECT id, name FROM widgets'));
		expect(storeCalls, 'subsequent queries should not trigger schema writes').to.equal(0);
	});

	it('doInitialize preserves persisted indexes when local DDL has none', async () => {
		// Reproduction for tickets/fix/doinitialize-shortcircuit-clobbers-persisted-indexes.md.
		//
		// `apply schema App;` dispatches `CREATE TABLE foo (...)` BEFORE the
		// matching `CREATE INDEX` statements, so when xCreate/xConnect fires
		// the local TableSchema has columns but `indexes: []`. The old
		// short-circuit compared that against persisted (which already had
		// indexes from a prior session), found them unequal, and fell through
		// to `storeSchema(this.tableSchema)` — writing `indexes: []` over the
		// persisted list. Every subsequent `addIndex()` then lost its dedupe
		// and re-created its index tree from scratch.
		const storage = new MemoryRawStorage();
		const sharedTransactor = buildSharedLocalTransactor(storage);

		// --- Session 1: create the table AND its index, so the persisted
		// schema has a non-empty `indexes` array.
		const dbA = new Database();
		registerWithSharedTransactor(dbA, sharedTransactor);
		await dbA.exec(`
			CREATE TABLE gadgets (
				id INTEGER PRIMARY KEY,
				category TEXT NOT NULL,
				weight REAL
			) USING optimystic('tree://hydrate-test/gadgets')
		`);
		await dbA.exec(`CREATE INDEX idx_gadgets_category ON gadgets(category)`);

		// --- Session 2: fresh Database, fresh plugin, shared storage. Skip
		// hydrate() and re-execute the bare CREATE TABLE — this mirrors the
		// `apply schema` codepath, where the differ sees an empty catalog
		// (no hydrate) and emits CREATE TABLE before CREATE INDEX. The
		// resulting `module.create()` constructs a vtab whose tableSchema
		// has `indexes: []` and runs doInitialize against the persisted
		// schema (with its index).
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, sharedTransactor);

		const optimysticModule = pluginB.vtables[0]!.module as unknown as {
			schemaManagers: Map<string, {
				storeSchema: (...args: any[]) => Promise<void>;
				storeStoredSchema: (...args: any[]) => Promise<void>;
				getSchema: (name: string) => Promise<{ indexes: { name: string }[] } | undefined>;
			}>;
		};

		await dbB.exec(`
			CREATE TABLE gadgets (
				id INTEGER PRIMARY KEY,
				category TEXT NOT NULL,
				weight REAL
			) USING optimystic('tree://hydrate-test/gadgets')
		`);

		// The plugin must have used the same SchemaManager (per-fingerprint
		// caching). Wrap both write entrypoints AFTER the CREATE TABLE has
		// already wired up the manager, so we measure subsequent writes.
		const managers = [...optimysticModule.schemaManagers.values()];
		expect(managers, 'create() should have populated the shared SchemaManager map').to.have.lengthOf(1);
		const manager = managers[0]!;

		// Sanity check: the persisted schema still has the index. Without the
		// fix, the CREATE TABLE above would already have clobbered it to [].
		const persisted = await manager.getSchema('gadgets');
		expect(persisted, 'persisted schema should still exist after CREATE TABLE').to.not.equal(undefined);
		expect(
			persisted!.indexes.map(i => i.name),
			'persisted indexes must survive the CREATE TABLE in session 2',
		).to.deep.equal(['idx_gadgets_category']);

		// Now wrap the write entrypoints and re-issue CREATE INDEX IF NOT
		// EXISTS — addIndex() should find the index already present (because
		// it WASN'T clobbered) and short-circuit without writing.
		let storeCalls = 0;
		let storeStoredCalls = 0;
		const originalStore = manager.storeSchema.bind(manager);
		const originalStoreStored = manager.storeStoredSchema.bind(manager);
		manager.storeSchema = async (...args: any[]) => {
			storeCalls++;
			return originalStore(...args);
		};
		manager.storeStoredSchema = async (...args: any[]) => {
			storeStoredCalls++;
			return originalStoreStored(...args);
		};

		await dbB.exec(`CREATE INDEX IF NOT EXISTS idx_gadgets_category ON gadgets(category)`);

		expect(storeCalls, 'storeSchema should not fire — addIndex dedupe must hit').to.equal(0);
		expect(storeStoredCalls, 'storeStoredSchema should not fire either').to.equal(0);

		// And the persisted index list is unchanged.
		const after = await manager.getSchema('gadgets');
		expect(
			after!.indexes.map(i => i.name),
			'persisted indexes unchanged after re-issuing CREATE INDEX',
		).to.deep.equal(['idx_gadgets_category']);
	});
});
