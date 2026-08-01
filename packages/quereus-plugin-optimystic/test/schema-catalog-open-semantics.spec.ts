/**
 * Read paths through the plugin's table catalog must OPEN it, never invent it.
 *
 * The catalog is a single distributed tree (`tree://optimystic/schema`) listing every
 * table this database knows about. Before this behaviour existed, a read that could not
 * find the catalog quietly staged a brand-new empty one in memory, so "I could not reach
 * the catalog" and "this database has no tables" produced the same answer. These tests
 * pin the distinction: a read finds nothing and reports nothing, without bringing a
 * catalog into existence; a write still creates it on demand.
 *
 * The companion case that must NOT change: a table that was declared but never written to
 * has no stored data at all, and selecting from it must return zero rows rather than fail.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;

/** Collection id the schema catalog tree resolves to (`tree://` prefix stripped). */
const SchemaCollectionId = 'optimystic/schema';

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

/** A `local`-style transactor over the supplied raw storage, shared across plugin
 * instances so trees opened by either side see the other's writes (same harness as
 * catalog-hydration.spec.ts). */
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

interface SchemaManagerLike {
	listTables: () => Promise<string[]>;
	getSchema: (name: string) => Promise<unknown | undefined>;
}

/** Reach the plugin's shared catalog manager (populated by hydrate/create). */
function sharedSchemaManager(plugin: ReturnType<typeof registerWithSharedTransactor>): SchemaManagerLike {
	const optimysticModule = plugin.vtables[0]!.module as unknown as {
		schemaManagers: Map<string, SchemaManagerLike>;
	};
	const managers = [...optimysticModule.schemaManagers.values()];
	expect(managers, 'plugin should have exactly one shared catalog manager').to.have.lengthOf(1);
	return managers[0]!;
}

/** Whether the catalog tree's header block has actually been committed to storage. */
async function catalogExists(transactor: ITransactor): Promise<boolean> {
	const result = await transactor.get({ blockIds: [SchemaCollectionId] });
	return result[SchemaCollectionId]?.block !== undefined;
}

describe('Optimystic plugin schema catalog open-vs-create semantics', function () {
	this.timeout(15_000);

	it('lists zero tables on a genuinely empty network without creating a catalog', async () => {
		const storage = new MemoryRawStorage();
		const transactor = buildSharedLocalTransactor(storage);
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, transactor);

		// hydrate() is the cold-start entry point; it goes through listTables().
		expect(await plugin.hydrate(db)).to.deep.equal({ tables: 0, indexes: 0 });

		const manager = sharedSchemaManager(plugin);
		expect(await manager.listTables()).to.deep.equal([]);
		expect(await manager.getSchema('nope')).to.equal(undefined);

		// The reads must not have brought the catalog into existence.
		expect(await catalogExists(transactor), 'reads must not create the schema catalog').to.equal(false);
	});

	it('lists a table once CREATE TABLE has persisted it', async () => {
		const storage = new MemoryRawStorage();
		const transactor = buildSharedLocalTransactor(storage);
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, transactor);

		await plugin.hydrate(db);
		const manager = sharedSchemaManager(plugin);
		expect(await manager.listTables()).to.deep.equal([]);

		await db.exec(`
			CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)
			USING optimystic('tree://catalog-open/t')
		`);

		// The write path creates the catalog on demand, and the read path now sees it.
		expect(await catalogExists(transactor), 'CREATE TABLE must persist the schema catalog').to.equal(true);
		expect(await manager.listTables()).to.deep.equal(['t']);
	});

	it('reads a created-but-never-written table as zero rows, not as an error', async () => {
		// This is the case that keeps create-on-missing on the DATA tree: a table declared
		// but never inserted into has no committed header block of its own, so "absent" and
		// "empty" really are the same thing there.
		const storage = new MemoryRawStorage();
		const transactor = buildSharedLocalTransactor(storage);
		const db = new Database();
		registerWithSharedTransactor(db, transactor);

		await db.exec(`
			CREATE TABLE empty_t (id INTEGER PRIMARY KEY, name TEXT)
			USING optimystic('tree://catalog-open/empty_t')
		`);

		expect(await collectRows(db.eval('SELECT id, name FROM empty_t'))).to.deep.equal([]);
		const counted = await collectRows(db.eval('SELECT count(*) AS c FROM empty_t'));
		expect(Number(counted[0]!['c'])).to.equal(0);
	});

	it('sees a table created after an earlier empty read (no negative caching)', async () => {
		// `getCollection` must never cache a miss: the catalog created a moment later in the
		// same session has to become visible, not stay hidden behind a cached `undefined`.
		const storage = new MemoryRawStorage();
		const transactor = buildSharedLocalTransactor(storage);
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, transactor);

		await plugin.hydrate(db);
		const manager = sharedSchemaManager(plugin);
		expect(await manager.listTables()).to.deep.equal([]);

		await db.exec(`
			CREATE TABLE later (id INTEGER PRIMARY KEY)
			USING optimystic('tree://catalog-open/later')
		`);
		await db.exec(`INSERT INTO later (id) VALUES (7)`);

		expect(await manager.listTables()).to.deep.equal(['later']);
		const rows = await collectRows(db.eval('SELECT id FROM later'));
		expect(rows.map(r => Number(r['id']))).to.deep.equal([7]);
	});

	it('hydrates a second session from a catalog the first session created', async () => {
		const storage = new MemoryRawStorage();
		const transactor = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, transactor);
		await dbA.exec(`
			CREATE TABLE carried (id INTEGER PRIMARY KEY, name TEXT NOT NULL)
			USING optimystic('tree://catalog-open/carried')
		`);
		await dbA.exec(`INSERT INTO carried (id, name) VALUES (1, 'alice')`);

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, transactor);
		expect(await pluginB.hydrate(dbB)).to.deep.include({ tables: 1 });
		expect(await sharedSchemaManager(pluginB).listTables()).to.deep.equal(['carried']);
	});
});
