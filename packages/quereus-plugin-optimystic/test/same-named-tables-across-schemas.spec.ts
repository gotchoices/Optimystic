/**
 * Two tables with the same name in different engine schemas of one database — a built-in
 * `strand.Member` and an app's own `app.Member` — must be two tables in storage too.
 *
 * A table declared without an explicit `using optimystic('<uri>')` gets its storage location
 * from the plugin's default rule, and its catalog record is keyed by the same identity. Both
 * used to leave the engine schema out (`tree://default/<table>`, catalog key `<table>`), so the
 * two `Member` tables opened ONE collection and shared ONE catalog record: rows mixed, one
 * table's insert read back through the other, and a warm restart could not tell the two
 * definitions apart. Both now carry the schema (`tree://default/<schema>/<table>`, catalog key
 * framed from `(schema, table)`).
 *
 * Harness: the `local` transactor over one `MemoryRawStorage`, shared by every `Database` in a
 * case so a fresh `Database` plus `hydrate` proves what actually reached storage — the pattern
 * from `catalog-hydration.spec.ts`.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { defaultCollectionUri } from '../dist/index.js';
import { catalogKey, namesOfCatalogKey } from '../src/schema/table-identity.js';
import { queryAll } from './query-helpers.js';

type PluginHandle = ReturnType<typeof register>;

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

async function openSession(transactor: ITransactor): Promise<{ db: Database; plugin: PluginHandle }> {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>);
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	await db.exec(`pragma default_vtab_module='optimystic'`);
	return { db, plugin };
}

/** The built-in table: integer id, a name, and an index named like the app's. */
const STRAND_DECLARATION = `
	declare schema strand {
		table Member { id integer primary key, name text }
		index member_by_name on Member (name)
	}
	apply schema strand;
`;

/** The app's table of the same name: a different key, different columns, a same-named index. */
const APP_DECLARATION = `
	declare schema app {
		table Member { member_id text primary key, nick text, joined integer }
		index member_by_name on Member (nick)
	}
	apply schema app;
`;

/** The module's live instance for `schema.table` — for its resolved collection URI. */
function collectionUriOf(plugin: PluginHandle, schemaName: string, tableName: string): string {
	const module = plugin.vtables.find(v => v.name === 'optimystic')!.module as unknown as {
		tables: Map<string, { options: { collectionUri: string } }>;
	};
	const table = module.tables.get(`${schemaName}.${tableName}`.toLowerCase());
	expect(table, `an instance for ${schemaName}.${tableName}`).to.not.equal(undefined);
	return table!.options.collectionUri;
}

/** The SchemaManager every default-configured table of this plugin shares. */
interface CatalogProbe {
	getSchema(schemaName: string, tableName: string): Promise<{ schemaName: string; columns: { name: string }[] } | undefined>;
	getDroppedSchemaRecord(schemaName: string, tableName: string): Promise<{ droppedAt?: string } | undefined>;
}
function catalogOf(plugin: PluginHandle): CatalogProbe {
	const module = plugin.vtables.find(v => v.name === 'optimystic')!.module as unknown as {
		createSchemaManager(options: unknown): CatalogProbe;
		deriveDefaultOptions(config: Record<string, SqlValue>): unknown;
	};
	return module.createSchemaManager(module.deriveDefaultOptions({ default_transactor: 'local', default_key_network: 'test' }));
}

async function seedBoth(db: Database): Promise<void> {
	await db.exec(STRAND_DECLARATION);
	await db.exec(APP_DECLARATION);
	await db.exec(`insert into strand.Member (id, name) values (1, 'alice'), (2, 'bea')`);
	await db.exec(`insert into app.Member (member_id, nick, joined) values ('m-1', 'bob', 5)`);
}

async function expectOwnRows(db: Database): Promise<void> {
	expect(await queryAll(db, 'select id, name from strand.Member order by id')).to.deep.equal([
		{ id: 1, name: 'alice' },
		{ id: 2, name: 'bea' },
	]);
	expect(await queryAll(db, 'select member_id, nick, joined from app.Member')).to.deep.equal([
		{ member_id: 'm-1', nick: 'bob', joined: 5 },
	]);
	// Through each table's same-named secondary index: each sees only its own entries.
	expect(await queryAll(db, `select id from strand.Member where name = 'alice'`)).to.deep.equal([{ id: 1 }]);
	expect(await queryAll(db, `select id from strand.Member where name = 'bob'`)).to.deep.equal([]);
	expect(await queryAll(db, `select member_id from app.Member where nick = 'bob'`)).to.deep.equal([{ member_id: 'm-1' }]);
	expect(await queryAll(db, `select member_id from app.Member where nick = 'alice'`)).to.deep.equal([]);
}

describe('Same-named tables in two schemas of one database', function () {
	this.timeout(20_000);

	it('the default storage location includes the schema', () => {
		expect(defaultCollectionUri('strand', 'Member')).to.equal('tree://default/strand/Member');
		expect(defaultCollectionUri('main', 'Member')).to.equal('tree://default/main/Member');
		expect(defaultCollectionUri('strand', 'Member')).to.not.equal(defaultCollectionUri('app', 'Member'));
	});

	it('the catalog key names a (schema, table) pair injectively and decodes back to it', () => {
		expect(catalogKey('strand', 'Member')).to.not.equal(catalogKey('app', 'Member'));
		// A plain `schema.table` join would file these two under one record.
		expect(catalogKey('a.b', 'c')).to.not.equal(catalogKey('a', 'b.c'));
		expect(namesOfCatalogKey(catalogKey('a.b', 'c'))).to.deep.equal({ schemaName: 'a.b', tableName: 'c' });
		expect(namesOfCatalogKey(catalogKey('main', 'we\x00ird'))).to.deep.equal({ schemaName: 'main', tableName: 'we\x00ird' });
		// A record filed under a bare table name (the old key) names no (schema, table).
		expect(namesOfCatalogKey('Member')).to.equal(undefined);
		expect(namesOfCatalogKey(catalogKey('main', 'Member') + catalogKey('x', 'y'))).to.equal(undefined);
	});

	it('each table reads back only its own rows, through its own storage and its own index', async () => {
		const transactor = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db, plugin } = await openSession(transactor);
		await seedBoth(db);

		const strandUri = collectionUriOf(plugin, 'strand', 'Member');
		const appUri = collectionUriOf(plugin, 'app', 'Member');
		expect(strandUri).to.equal(defaultCollectionUri('strand', 'Member'));
		expect(appUri).to.equal(defaultCollectionUri('app', 'Member'));
		expect(strandUri).to.not.equal(appUri);

		await expectOwnRows(db);

		const catalog = catalogOf(plugin);
		const strand = await catalog.getSchema('strand', 'Member');
		const app = await catalog.getSchema('app', 'Member');
		expect(strand?.columns.map(c => c.name)).to.deep.equal(['id', 'name']);
		expect(app?.columns.map(c => c.name)).to.deep.equal(['member_id', 'nick', 'joined']);
	});

	it('index-free tables whose columns overlap do not read each other\'s rows', async () => {
		// The shape that reached a device: no index to trip the re-declare refusal, so the
		// second declaration silently took over the first one's catalog record and storage.
		const transactor = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db } = await openSession(transactor);
		await db.exec(`declare schema strand { table Member { id integer primary key, name text } } apply schema strand;`);
		await db.exec(`declare schema app { table Member { member_id text primary key, name text } } apply schema app;`);
		await db.exec(`insert into strand.Member (id, name) values (1, 'alice')`);
		await db.exec(`insert into app.Member (member_id, name) values ('m-1', 'bob')`);

		expect(await queryAll(db, 'select id, name from strand.Member')).to.deep.equal([{ id: 1, name: 'alice' }]);
		expect(await queryAll(db, 'select member_id, name from app.Member')).to.deep.equal([{ member_id: 'm-1', name: 'bob' }]);
	});

	it('a fresh process over the same storage hydrates each table into its own schema with its own columns', async () => {
		const transactor = buildSharedLocalTransactor(new MemoryRawStorage());
		const first = await openSession(transactor);
		await seedBoth(first.db);

		const { db, plugin } = await openSession(transactor);
		const hydrated = await plugin.hydrate(db);
		expect(hydrated).to.deep.equal({ tables: 2, indexes: 2 });

		expect(db.schemaManager.findTable('Member', 'strand')?.columns.map(c => c.name)).to.deep.equal(['id', 'name']);
		expect(db.schemaManager.findTable('Member', 'app')?.columns.map(c => c.name)).to.deep.equal(['member_id', 'nick', 'joined']);
		expect(db.schemaManager.findTable('Member', 'main'), 'nothing hydrates into main').to.equal(undefined);

		await expectOwnRows(db);

		// Re-applying both declarations after hydrate is a no-op, not a clash.
		await db.exec(STRAND_DECLARATION);
		await db.exec(APP_DECLARATION);
		await expectOwnRows(db);
	});

	it('dropping one leaves the other untouched, and a re-declare is judged against its own gravestone only', async () => {
		const transactor = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db, plugin } = await openSession(transactor);
		await seedBoth(db);

		await db.exec('drop table app.Member');

		const catalog = catalogOf(plugin);
		expect(await catalog.getSchema('app', 'Member'), 'the dropped table is gone').to.equal(undefined);
		expect((await catalog.getDroppedSchemaRecord('app', 'Member'))?.droppedAt, 'its gravestone').to.be.a('string');
		expect(await catalog.getDroppedSchemaRecord('strand', 'Member'), 'the other table has no gravestone').to.equal(undefined);
		expect((await catalog.getSchema('strand', 'Member'))?.columns.map(c => c.name)).to.deep.equal(['id', 'name']);
		expect(await queryAll(db, 'select id, name from strand.Member order by id')).to.deep.equal([
			{ id: 1, name: 'alice' },
			{ id: 2, name: 'bea' },
		]);

		// A contradicting re-declare over the app table's own leftover rows is refused by the
		// app table's own gravestone...
		let refused: unknown;
		try {
			await db.exec(`create table app.Member (member_id text primary key, nick text, joined integer, avatar text not null)`);
		} catch (error) {
			refused = error;
		}
		expect(refused, 'a re-declare that adds a column its stored rows cannot supply').to.be.instanceOf(Error);
		const message = (refused as Error).message;
		expect(message).to.include(`Cannot create table 'Member' over '${defaultCollectionUri('app', 'Member')}'`);
		expect(message).to.include(`adds column 'avatar'`);
		expect(message).to.include('a dropped table declared as (member_id, nick, joined)');

		// ...while re-declaring its original shape adopts its own rows, not the strand table's.
		await db.exec(`create table app.Member (member_id text primary key, nick text, joined integer)`);
		expect(await queryAll(db, 'select member_id, nick, joined from app.Member')).to.deep.equal([
			{ member_id: 'm-1', nick: 'bob', joined: 5 },
		]);
		expect(await queryAll(db, 'select id, name from strand.Member order by id')).to.have.lengthOf(2);
	});

	it("one schema's gravestone does not judge a same-named table declared in another schema", async () => {
		const transactor = buildSharedLocalTransactor(new MemoryRawStorage());
		const { db, plugin } = await openSession(transactor);
		await db.exec(STRAND_DECLARATION);
		await db.exec(`insert into strand.Member (id, name) values (1, 'alice')`);
		await db.exec('drop table strand.Member');
		expect((await catalogOf(plugin).getDroppedSchemaRecord('strand', 'Member'))?.droppedAt).to.be.a('string');

		// A first-ever app.Member with a shape the strand gravestone contradicts: nothing
		// describes ITS storage, so it is declared freely and starts empty.
		await db.exec(APP_DECLARATION);
		expect(await queryAll(db, 'select member_id from app.Member')).to.deep.equal([]);
		await db.exec(`insert into app.Member (member_id, nick, joined) values ('m-1', 'bob', 5)`);
		expect(await queryAll(db, 'select member_id, nick, joined from app.Member')).to.deep.equal([
			{ member_id: 'm-1', nick: 'bob', joined: 5 },
		]);
	});
});
