/**
 * A table rebuilt by `plugin.hydrate(db)` must be indistinguishable from the table the SAME
 * declaration creates in the current session — every field of Quereus's `TableSchema`, not only
 * its columns — and it must reach storage the way THIS session does, not the way the session
 * that wrote it did.
 *
 * Why: `hydrate` puts each persisted table back into its own engine schema, so a later
 * `apply schema` diffs the declaration against the rebuilt copy. Anything the copy lacks (the
 * declared type spelling, `with context` variables, CHECKs, expression defaults, generated
 * columns, foreign keys, tags) either surfaces as a spurious ALTER the module cannot run, or is
 * silently absent for the rest of the process: a hydrated table with a generated column and no
 * generation order stores nothing in that column, and one without its CHECKs accepts every row.
 * And a copy still carrying the writer's transactor and network name opens the table through a
 * previous era's connection.
 *
 * Harness: sessions are fresh `Database`s over one shared `MemoryRawStorage` through the `local`
 * transactor (see `shared-local-transactor.ts`). Each session sets its own `default_vtab_args`
 * — its "era" — so a hydrated table's binding can be told from the writer's.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue, TableSchema } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { buildSharedLocalTransactor, countingTransactor } from './shared-local-transactor.js';
import { captureThrowMessage, queryAll } from './query-helpers.js';

type PluginHandle = ReturnType<typeof register>;

/** The session-level vtab args an "era" runs with: how THIS process reaches storage. */
function eraArgs(era: string): Record<string, SqlValue> {
	return { transactor: 'local', keyNetwork: era, networkName: era };
}

/**
 * A session of `era`: its plugin config and its `default_vtab_args` both name the era, and every
 * `local:<key>` transactor in `transactors` is registered so a table can be observed reaching
 * storage through one key or another.
 */
async function openSession(era: string, transactors: Record<string, ITransactor>): Promise<{ db: Database; plugin: PluginHandle }> {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: era,
		enable_cache: false,
	} as unknown as Record<string, SqlValue>);
	for (const [key, transactor] of Object.entries(transactors)) {
		plugin.collectionFactory.registerTransactor(key, transactor);
	}
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	await db.exec(`pragma default_vtab_module = 'optimystic'`);
	await db.exec(`pragma default_vtab_args = '${JSON.stringify(eraArgs(era))}'`);
	return { db, plugin };
}

/** One era over one store: the common case where only the era's own key is registered. */
async function openEra(era: string, shared: ITransactor): Promise<{ db: Database; plugin: PluginHandle }> {
	return openSession(era, { [`local:${era}`]: shared });
}

/**
 * A `TableSchema` reduced to what the declaration determines: the module instance and its aux
 * data are per-process handles (ignored); parser positions (`loc`) depend on whitespace, not
 * meaning; Maps become entry lists so they compare structurally. Everything else — including
 * any field Quereus adds to `TableSchema` later — is compared, so a new field a DDL-created
 * table carries fails this until hydrate carries it too.
 */
function declarationView(schema: TableSchema): unknown {
	const { vtabModule: _module, vtabAuxData: _aux, ...rest } = schema;
	return JSON.parse(JSON.stringify(rest, (key, value: unknown) => {
		if (key === 'loc') return undefined;
		if (value instanceof Map) return [...value.entries()];
		if (typeof value === 'bigint') return `${value}n`;
		return value;
	}));
}

function tableOf(db: Database, schemaName: string, tableName: string): TableSchema {
	const table = db.schemaManager.findTable(tableName, schemaName);
	expect(table, `${schemaName}.${tableName} in the engine catalog`).to.not.equal(undefined);
	return table!;
}

/**
 * One table exercising every declaration feature the catalog record has to carry: a non-`main`
 * schema, alias type spellings, a column collation, literal and expression defaults, named and
 * unnamed CHECKs, a stored generated column, a foreign key with an action, column and table
 * tags, a table-level UNIQUE, a `with context` variable, a partial index and a partial unique
 * index.
 */
const EVERY_FEATURE_DECLARE = `
	declare schema app {
		table Managers { Id text primary key }
		table Every {
			Id int primary key,
			Name varchar(20) not null collate nocase,
			Big bigint null default 0,
			Score integer not null default (1 + 1),
			Note text null default 'n/a' with tags (kind = 'memo'),
			Qty integer not null check (Qty > 0),
			Total integer generated always as (Qty * 2) stored,
			ManagerId text null references Managers (Id) on delete cascade,
			constraint BigNonNegative check (Big >= 0),
			unique (Name)
		} with context (ManagerKey text null) with tags (owner = 'app')
		index ByBig on Every (Big) where Big > 0
		unique index ByNote on Every (Note) where Note is not null
	}
`;
const EVERY_FEATURE = `${EVERY_FEATURE_DECLARE} apply schema app;`;

/** The same shape spelled with canonical type names only — the form `diff schema` must find empty. */
const EVERY_FEATURE_CANONICAL_DECLARE = EVERY_FEATURE_DECLARE
	.replace('Id int primary key', 'Id integer primary key')
	.replace('Name varchar(20) not null', 'Name text not null')
	.replace('Big bigint null', 'Big integer null');
const EVERY_FEATURE_CANONICAL = `${EVERY_FEATURE_CANONICAL_DECLARE} apply schema app;`;

async function seedEvery(db: Database): Promise<void> {
	await db.exec(`insert into app.Managers (Id) values ('m1')`);
	await db.exec(`insert into app.Every (Id, Name, Big, Qty, Note, ManagerId) values (1, 'alpha', 5, 3, 'n1', 'm1')`);
}

const SEEDED_ROW = { Id: 1, Name: 'alpha', Big: 5, Score: 2, Note: 'n1', Qty: 3, Total: 6, ManagerId: 'm1' };
const EVERY_COLUMNS = 'Id, Name, Big, Score, Note, Qty, Total, ManagerId';

/** What a session must be able to do with `app.Every` whether it declared the table or hydrated it. */
async function expectEveryBehaves(db: Database): Promise<void> {
	expect(await queryAll(db, `select ${EVERY_COLUMNS} from app.Every order by Id`)).to.deep.equal([SEEDED_ROW]);

	// Literal and expression defaults apply, and the generated column is computed.
	await db.exec(`insert into app.Every (Id, Name, Qty, Note) values (2, 'beta', 4, 'n2')`);
	expect(await queryAll(db, `select ${EVERY_COLUMNS} from app.Every where Id = 2`)).to.deep.equal([
		{ Id: 2, Name: 'beta', Big: 0, Score: 2, Note: 'n2', Qty: 4, Total: 8, ManagerId: null },
	]);
	await db.exec(`insert into app.Every (Id, Name, Qty) values (3, 'gamma', 1)`);
	expect(await queryAll(db, `select Note, Total from app.Every where Id = 3`)).to.deep.equal([{ Note: 'n/a', Total: 2 }]);

	// Both CHECKs are enforced.
	expect(await captureThrowMessage(() => db.exec(`insert into app.Every (Id, Name, Qty, Note) values (4, 'delta', 0, 'n4')`)))
		.to.match(/check/i);
	expect(await captureThrowMessage(() => db.exec(`insert into app.Every (Id, Name, Big, Qty, Note) values (5, 'eps', -1, 1, 'n5')`)))
		.to.include('BigNonNegative');

	// The table-level UNIQUE is enforced. An exact-case duplicate on purpose: the plugin's
	// uniqueness probe honours neither the column's `collate nocase` nor a partial unique
	// index's predicate even on a freshly declared table (Quereus's memory tables reject
	// both) — pre-existing gaps in enforcement, not in what hydrate restores; see
	// `tickets/backlog/bug-optimystic-unique-ignores-collation-and-partial-predicate`.
	expect(await captureThrowMessage(() => db.exec(`insert into app.Every (Id, Name, Qty, Note) values (6, 'alpha', 1, 'n6')`)))
		.to.match(/unique/i);
	await db.exec(`insert into app.Every (Id, Name, Qty, Note) values (8, 'theta', 1, null)`);
	await db.exec(`insert into app.Every (Id, Name, Qty, Note) values (9, 'iota', 1, null)`);
}

describe('Warm restart: a hydrated table is the table its declaration creates', function () {
	this.timeout(30_000);

	it('equals, field by field, the table the same declaration creates in this session', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openEra('era1', shared);
		await writer.db.exec(EVERY_FEATURE);
		await seedEvery(writer.db);

		// A later era over the SAME storage, hydrating; and the same era over EMPTY storage,
		// declaring — the latter is what "the table this session's declaration creates" means.
		const hydrated = await openEra('era2', shared);
		expect(await hydrated.plugin.hydrate(hydrated.db)).to.deep.equal({ tables: 2, indexes: 2 });
		const created = await openEra('era2', buildSharedLocalTransactor(new MemoryRawStorage()));
		await created.db.exec(EVERY_FEATURE);

		expect(declarationView(tableOf(hydrated.db, 'app', 'Every')))
			.to.deep.equal(declarationView(tableOf(created.db, 'app', 'Every')));
		expect(declarationView(tableOf(hydrated.db, 'app', 'Managers')))
			.to.deep.equal(declarationView(tableOf(created.db, 'app', 'Managers')));

		// The shape holds up in use, with no re-declaration at all.
		await expectEveryBehaves(hydrated.db);
	});

	it('after hydrate, diff schema is empty and re-applying changes nothing (canonical type names)', async () => {
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openEra('era1', shared);
		await writer.db.exec(EVERY_FEATURE_CANONICAL);
		await seedEvery(writer.db);

		const { db, plugin } = await openEra('era2', shared);
		await plugin.hydrate(db);
		const before = declarationView(tableOf(db, 'app', 'Every'));

		await db.exec(EVERY_FEATURE_CANONICAL_DECLARE);
		expect(await queryAll(db, 'diff schema app'), 'the declaration already matches the hydrated catalog').to.deep.equal([]);
		await db.exec('apply schema app');
		expect(declarationView(tableOf(db, 'app', 'Every')), 're-applying replaced nothing').to.deep.equal(before);
		await expectEveryBehaves(db);
	});

	it('restores the declared type spelling of every column', async () => {
		// The shape behind sereus's `SET DATA TYPE int` failures. The differ compares the
		// declaration's spelling against the live column, so the rebuilt column must carry the
		// spelling the DDL used, not the canonical name the storage affinity is filed under.
		// Whether re-applying such a declaration is then a no-op is decided in Quereus
		// (`tickets/blocked/quereus-differ-treats-type-aliases-as-a-retype`), so this spec
		// deliberately does not assert on the re-apply.
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openEra('era1', shared);
		await writer.db.exec(`
			declare schema CadreControl {
				table CadrePeer { PeerId text primary key, UpdatedAt int not null, Note varchar(20) null, Seen timestamp null }
			}
			apply schema CadreControl;
		`);
		const declared = tableOf(writer.db, 'CadreControl', 'CadrePeer').columns.map(c => [c.declaredType, c.logicalType.name]);

		const { db, plugin } = await openEra('era2', shared);
		await plugin.hydrate(db);
		expect(tableOf(db, 'CadreControl', 'CadrePeer').columns.map(c => [c.declaredType, c.logicalType.name]))
			.to.deep.equal(declared);
		expect(declared.map(([spelling]) => spelling)).to.deep.equal(['text', 'int', 'varchar(20)', 'timestamp']);
	});

	it('keeps the with-context variables and enforces the CHECK that reads them, hydrated and re-applied', async () => {
		// The shape behind sereus's `context.ManagerKey isn't a column`: the differ does not
		// compare mutation contexts, so a copy without them stays without them after re-apply.
		const declaration = `
			declare schema app {
				table M { id integer primary key, k text, constraint Gate check (context.ManagerKey = 'k') }
					with context (ManagerKey text)
			}
			apply schema app;
		`;
		const shared = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openEra('era1', shared);
		await writer.db.exec(declaration);
		await writer.db.exec(`insert into app.M (id, k) with context ManagerKey = 'k' values (1, 'x')`);
		const declaredContext = declarationView(tableOf(writer.db, 'app', 'M').mutationContext as unknown as TableSchema);

		const { db, plugin } = await openEra('era2', shared);
		await plugin.hydrate(db);
		await db.exec(declaration);

		expect(declarationView(tableOf(db, 'app', 'M').mutationContext as unknown as TableSchema)).to.deep.equal(declaredContext);
		expect(await queryAll(db, 'select id, k from app.M')).to.deep.equal([{ id: 1, k: 'x' }]);
		expect(await captureThrowMessage(() => db.exec(`insert into app.M (id, k) values (2, 'y')`)))
			.to.include(`requires mutation context variable 'ManagerKey'`);
		expect(await captureThrowMessage(() => db.exec(`insert into app.M (id, k) with context ManagerKey = 'wrong' values (2, 'y')`)))
			.to.include('Gate');
		await db.exec(`insert into app.M (id, k) with context ManagerKey = 'k' values (2, 'y')`);
		expect(await queryAll(db, 'select id from app.M order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
	});

	it("binds a hydrated table to this session's transactor and network, not the writer's", async () => {
		// The shape behind sereus's transactor handover reading back nothing: the record used
		// to carry the writer's `transactor` / `keyNetwork` / `networkName`, and the rebuilt
		// table opened storage through them. Two counting wrappers over ONE store tell the
		// eras apart: the later session registers both keys and must only ever use its own.
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const era1 = countingTransactor(store);
		const writer = await openSession('era1', { 'local:era1': era1.transactor });
		await writer.db.exec(`declare schema app { table N { id integer primary key, v text } } apply schema app;`);
		await writer.db.exec(`insert into app.N (id, v) values (1, 'one')`);

		const era1Again = countingTransactor(store);
		const era2 = countingTransactor(store);
		const { db, plugin } = await openSession('era2', { 'local:era1': era1Again.transactor, 'local:era2': era2.transactor });
		await plugin.hydrate(db);

		expect(tableOf(db, 'app', 'N').vtabArgs).to.deep.equal(eraArgs('era2'));
		expect(await queryAll(db, 'select id, v from app.N')).to.deep.equal([{ id: 1, v: 'one' }]);
		await db.exec(`insert into app.N (id, v) values (2, 'two')`);
		expect(era2.counts.get, 'reads went through this era').to.be.greaterThan(0);
		expect(era2.counts.commit, 'the write went through this era').to.be.greaterThan(0);
		expect(era1Again.counts, "nothing touched the writer's era").to.include({ get: 0, pend: 0, commit: 0 });

		// A table that spells its own storage location keeps it: identity survives, binding does not.
		await writer.db.exec(`create table app.P (id integer primary key) using optimystic('tree://pinned/app/P')`);
		await writer.db.exec(`insert into app.P (id) values (7)`);
		const again = await openSession('era2', { 'local:era2': era2.transactor });
		await again.plugin.hydrate(again.db);
		expect(tableOf(again.db, 'app', 'P').vtabArgs).to.deep.equal({ ...eraArgs('era2'), '0': 'tree://pinned/app/P' });
		expect(await queryAll(again.db, 'select id from app.P')).to.deep.equal([{ id: 7 }]);
	});

	it('hydrate reads the catalog and writes nothing', async () => {
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openEra('era1', store);
		await writer.db.exec(EVERY_FEATURE);
		await seedEvery(writer.db);

		const era2 = countingTransactor(store);
		const { db, plugin } = await openSession('era2', { 'local:era2': era2.transactor });
		await plugin.hydrate(db);
		expect(era2.counts.get, 'hydrate read the catalog').to.be.greaterThan(0);
		expect(era2.counts, 'hydrate wrote nothing').to.include({ pend: 0, commit: 0 });

		// Nor does the first touch of a hydrated table re-write its (unchanged) record.
		era2.counts.reset();
		expect(await queryAll(db, 'select Id from app.Every')).to.deep.equal([{ Id: 1 }]);
		expect(era2.counts, 'a read of a hydrated table commits nothing').to.include({ pend: 0, commit: 0 });
	});
});
