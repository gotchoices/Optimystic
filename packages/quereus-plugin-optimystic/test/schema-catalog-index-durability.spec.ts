/**
 * The persisted schema catalog's `indexes` list must be durable across nodes.
 *
 * Every table's shape lives as one record in the plugin-global catalog
 * (`tree://optimystic/schema`). Two silent loss modes are pinned here
 * (tickets/implement/schema-catalog-index-list-is-lossy):
 *
 * - CLOBBER: a node whose catalog READ yields nothing (which can still mean
 *   "unreadable", not just "absent" — a provably indeterminate read throws
 *   BlockUnavailableError since repo-reports-unavailable-vs-absent landed, but a
 *   silently-empty cohort answer reads as absent) re-persists its local CREATE
 *   TABLE shape. A bare CREATE TABLE never carries its CREATE INDEX siblings, so
 *   without a guard that write lands `indexes: []` over a real persisted index
 *   list. The guard is SchemaManager.storeStoredSchema's write-time union: the
 *   write path re-reads the catalog entry and never shrinks its index list.
 *
 * - LOST UPDATE: each SchemaManager instance caches its first read of a table's
 *   schema forever, and addIndex used to write back the WHOLE record from that
 *   possibly-stale copy — dropping an index a sibling instance added in between.
 *   Guarded twice: addIndex now reads the catalog fresh (getSchemaFresh), and
 *   the write-time union catches whatever the fresh read still missed.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { mergeIndexLists } from '../dist/index.js';

/** Build a `local`-style transactor over the supplied raw storage, shared across
 * plugin instances so trees opened by either side see the other's writes (same
 * harness as catalog-hydration.spec.ts). */
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
	getSchema: (name: string) => Promise<{ indexes: { name: string; unique?: boolean }[] } | undefined>;
	getSchemaFresh: (name: string) => Promise<{ indexes: { name: string; unique?: boolean }[] } | undefined>;
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

/** What a brand-new session (fresh plugin, fresh caches) reads from storage. */
async function persistedIndexNames(transactor: ITransactor, tableName: string): Promise<string[]> {
	const db = new Database();
	const plugin = registerWithSharedTransactor(db, transactor);
	await plugin.hydrate(db);
	const stored = await sharedSchemaManager(plugin).getSchema(tableName);
	expect(stored, `table '${tableName}' should be persisted`).to.not.equal(undefined);
	return stored!.indexes.map(i => i.name);
}

describe('Optimystic schema catalog index durability', function () {
	this.timeout(20_000);

	it('a CREATE TABLE whose catalog read came back empty does not clobber persisted indexes', async () => {
		// Site A (clobber). Session 1 persists a table WITH an index. Session 2's
		// catalog READ path is made to report the catalog as absent — simulating
		// the residual undetectable case where an unreadable catalog collapses to
		// "absent" (a silently-empty cohort answer) — while the WRITE path still
		// reaches storage. Re-running the bare CREATE TABLE must not shrink the
		// persisted index list.
		const storage = new MemoryRawStorage();
		const sharedTransactor = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, sharedTransactor);
		await dbA.exec(`
			CREATE TABLE gizmos (
				id INTEGER PRIMARY KEY,
				category TEXT NOT NULL
			) USING optimystic('tree://index-durability/gizmos')
		`);
		await dbA.exec(`CREATE INDEX idx_gizmos_category ON gizmos(category)`);
		expect(await persistedIndexNames(sharedTransactor, 'gizmos')).to.deep.equal(['idx_gizmos_category']);

		// Session 2: intercept the read-path factory entry point so every open of
		// the schema catalog reports "absent". The write path (createOrGetCollection)
		// is left untouched — the failure mode under test is precisely "could not
		// read, but the write went through".
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, sharedTransactor);
		const factory = pluginB.collectionFactory as unknown as {
			getCollection: (options: { collectionUri?: string }, txnState?: unknown) => Promise<unknown>;
		};
		const originalGet = factory.getCollection.bind(factory);
		factory.getCollection = async (options, txnState) => {
			if (options?.collectionUri === 'tree://optimystic/schema') {
				return undefined;
			}
			return originalGet(options, txnState);
		};

		await dbB.exec(`
			CREATE TABLE gizmos (
				id INTEGER PRIMARY KEY,
				category TEXT NOT NULL
			) USING optimystic('tree://index-durability/gizmos')
		`);

		// Pre-fix this read returned [] — the CREATE TABLE above had overwritten
		// the catalog record with an index-free schema.
		expect(
			await persistedIndexNames(sharedTransactor, 'gizmos'),
			'persisted index list must survive a CREATE TABLE whose catalog read failed',
		).to.deep.equal(['idx_gizmos_category']);
	});

	it('two sessions each adding an index end with BOTH indexes persisted', async () => {
		// Site B (lost update). Both sessions cache the table's schema at CREATE
		// TABLE time (no indexes yet). A then adds idx_a, B adds idx_b. Pre-fix,
		// B's addIndex read its stale cached copy (no idx_a) and wrote the whole
		// record back — persisting [idx_b] and dropping idx_a.
		const storage = new MemoryRawStorage();
		const sharedTransactor = buildSharedLocalTransactor(storage);

		const ddl = `
			CREATE TABLE parts (
				id INTEGER PRIMARY KEY,
				vendor TEXT NOT NULL,
				sku TEXT NOT NULL
			) USING optimystic('tree://index-durability/parts')
		`;

		const dbA = new Database();
		registerWithSharedTransactor(dbA, sharedTransactor);
		await dbA.exec(ddl);

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, sharedTransactor);
		await dbB.exec(ddl);

		await dbA.exec(`CREATE INDEX idx_parts_vendor ON parts(vendor)`);

		// B's CACHED copy predates idx_parts_vendor — that staleness is the
		// documented cost of the read-path cache (see SchemaManager.getSchema),
		// and exactly why the mutating path below must not read through it.
		// (This read is a cache hit and refreshes nothing.)
		const cachedAtB = await sharedSchemaManager(pluginB).getSchema('parts');
		expect(
			cachedAtB!.indexes.map(i => i.name),
			'precondition: B\'s cached copy must be the stale pre-index one',
		).to.deep.equal([]);

		// B's addIndex must reach the catalog (getSchemaFresh), not the stale
		// cache above — otherwise its whole-record write-back drops idx_parts_vendor.
		await dbB.exec(`CREATE INDEX idx_parts_sku ON parts(sku)`);

		expect(
			(await persistedIndexNames(sharedTransactor, 'parts')).sort(),
			'both sessions\' indexes must survive',
		).to.deep.equal(['idx_parts_sku', 'idx_parts_vendor']);

		// And the fresh-read API B's mutating path used now reports both.
		const freshFromB = await sharedSchemaManager(pluginB).getSchemaFresh('parts');
		expect(
			freshFromB!.indexes.map(i => i.name).sort(),
			'a fresh read from B must see both persisted indexes',
		).to.deep.equal(['idx_parts_sku', 'idx_parts_vendor']);
	});

	describe('mergeIndexLists', () => {
		const idx = (name: string, unique?: boolean, predicate?: unknown) => ({
			name,
			columns: [{ index: 0 }],
			...(unique ? { unique: true as const } : {}),
			...(predicate !== undefined ? { predicate } : {}),
		});

		it('keeps incoming order and appends persisted-only indexes', () => {
			const merged = mergeIndexLists([idx('b'), idx('c')], [idx('a'), idx('b')]);
			expect(merged.map(i => i.name)).to.deep.equal(['b', 'c', 'a']);
		});

		it('never shrinks: an empty incoming list preserves everything persisted', () => {
			const merged = mergeIndexLists([], [idx('a'), idx('b', true)]);
			expect(merged.map(i => i.name)).to.deep.equal(['a', 'b']);
			expect(merged[1]!.unique).to.equal(true);
		});

		it('never downgrades uniqueness, and carries the unique side\'s predicate', () => {
			const merged = mergeIndexLists([idx('u')], [idx('u', true, { op: 'notnull' })]);
			expect(merged).to.have.lengthOf(1);
			expect(merged[0]!.unique).to.equal(true);
			expect(merged[0]!.predicate).to.deep.equal({ op: 'notnull' });
		});

		it('incoming unique upgrade wins over a persisted non-unique copy', () => {
			const merged = mergeIndexLists([idx('u', true, { op: 'gt' })], [idx('u')]);
			expect(merged).to.have.lengthOf(1);
			expect(merged[0]!.unique).to.equal(true);
			expect(merged[0]!.predicate).to.deep.equal({ op: 'gt' });
		});
	});
});
