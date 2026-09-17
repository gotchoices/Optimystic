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
 * meaning; Maps become entry lists so they compare structurally; `indexes` and
 * `checkConstraints` are sorted by name. Everything else — including any field Quereus adds to
 * `TableSchema` later — is compared, so a new field a DDL-created table carries fails this
 * until hydrate carries it too.
 */
function declarationView(schema: TableSchema): unknown {
	const { vtabModule: _module, vtabAuxData: _aux, ...rest } = schema;
	// List order is creation order in Quereus's own catalog too (a later version's index lands
	// last), so it is history, not declaration; the plugin's record keeps one canonical order.
	const ordered = {
		...rest,
		...(Array.isArray(rest.indexes) ? { indexes: byName(rest.indexes) } : {}),
		...(Array.isArray(rest.checkConstraints) ? { checkConstraints: byName(rest.checkConstraints) } : {}),
	};
	return JSON.parse(JSON.stringify(ordered, (key, value: unknown) => {
		if (key === 'loc') return undefined;
		if (value instanceof Map) return [...value.entries()];
		if (typeof value === 'bigint') return `${value}n`;
		return value;
	}));
}

/** The catalog tree behind a SchemaManager — enough to walk its entries in key order. */
interface CatalogTreeAccess {
	requireSchemaTree(): Promise<{
		update(): Promise<void>;
		range(range: unknown): AsyncIterable<unknown>;
		isValid(path: unknown): boolean;
		at(path: unknown): unknown;
	}>;
}

/**
 * Every catalog entry `[key, record]` as the JSON the catalog is written with, in key order,
 * read back from storage by a SchemaManager of its own. The unit of the byte-identity guarantee.
 */
async function catalogRecordBytes(plugin: PluginHandle, era: string): Promise<string[]> {
	const module = plugin.vtables.find(v => v.name === 'optimystic')!.module as unknown as {
		createSchemaManager(options: unknown): CatalogTreeAccess;
		deriveDefaultOptions(config: Record<string, SqlValue>): unknown;
	};
	const catalog = module.createSchemaManager(module.deriveDefaultOptions({ default_transactor: 'local', default_key_network: era }));
	const tree = await catalog.requireSchemaTree();
	await tree.update();
	const entries: string[] = [];
	for await (const path of tree.range({ isAscending: true })) {
		if (tree.isValid(path)) entries.push(JSON.stringify(tree.at(path)));
	}
	return entries;
}

function byName<T extends { name?: string }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => ((a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0));
}

function tableOf(db: Database, schemaName: string, tableName: string): TableSchema {
	const table = db.schemaManager.findTable(tableName, schemaName);
	expect(table, `${schemaName}.${tableName} in the engine catalog`).to.not.equal(undefined);
	return table!;
}

/**
 * The indexes of `app.Every`, in declaration order. `ByScore` is declared FIRST but sorts last by
 * name, so a version that adds it to an existing table is the case where creation order and
 * declaration order disagree.
 */
const EVERY_FEATURE_INDEXES = [
	'index ByScore on Every (Score)',
	'index ByBig on Every (Big) where Big > 0',
	'unique index ByNote on Every (Note) where Note is not null',
] as const;

/** The named table-level CHECKs of `app.Every`, in declaration order. */
const EVERY_FEATURE_CHECKS = ['constraint BigNonNegative check (Big >= 0)'] as const;

/**
 * Named CHECKs to declare either side of `BigNonNegative`, sorting either side of it by name too:
 * a version that adds `BigNonNegative` between them is the case where creation order (added last)
 * and canonical order (by name) disagree.
 */
const CHECK_BEFORE_BIG = 'constraint AScoreBounded check (Score < 1000000)';
const CHECK_AFTER_BIG = 'constraint ZQtyBounded check (Qty < 1000000)';

/**
 * One table exercising every declaration feature the catalog record has to carry: a non-`main`
 * schema, alias type spellings, a column collation, literal and expression defaults, named and
 * unnamed CHECKs, a stored generated column, a foreign key with an action, column and table
 * tags, a table-level UNIQUE, a `with context` variable, a plain index, a partial index and a
 * partial unique index. `indexes` and `checks` swap in another version's index and named
 * table-level CHECK declarations.
 */
function everyFeatureDeclare(
	indexes: readonly string[] = EVERY_FEATURE_INDEXES,
	checks: readonly string[] = EVERY_FEATURE_CHECKS,
): string {
	return `
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
			${checks.map(check => `${check},`).join('\n\t\t\t')}
			unique (Name)
		} with context (ManagerKey text null) with tags (owner = 'app')
		${indexes.join('\n\t\t')}
	}
`;
}
const EVERY_FEATURE_DECLARE = everyFeatureDeclare();
const EVERY_FEATURE = `${EVERY_FEATURE_DECLARE} apply schema app;`;

/** The same shape spelled with canonical type names only — the form `diff schema` must find empty. */
const EVERY_FEATURE_CANONICAL_DECLARE = EVERY_FEATURE_DECLARE
	.replace('Id int primary key', 'Id integer primary key')
	.replace('Name varchar(20) not null', 'Name text not null')
	.replace('Big bigint null', 'Big integer null');
const EVERY_FEATURE_CANONICAL = `${EVERY_FEATURE_CANONICAL_DECLARE} apply schema app;`;

const SEED_EVERY = [
	`insert into app.Managers (Id) values ('m1')`,
	`insert into app.Every (Id, Name, Big, Qty, Note, ManagerId) values (1, 'alpha', 5, 3, 'n1', 'm1')`,
] as const;

async function seedEvery(db: Database): Promise<void> {
	for (const statement of SEED_EVERY) await db.exec(statement);
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

/** Run `statements` in a session of `era` over its own empty storage; the catalog bytes it leaves. */
async function catalogAfter(era: string, ...statements: string[]): Promise<string[]> {
	const session = await openEra(era, buildSharedLocalTransactor(new MemoryRawStorage()));
	for (const statement of statements) await session.db.exec(statement);
	return await catalogRecordBytes(session.plugin, era);
}

/**
 * Earlier versions of `app.Every`'s index declarations: every proper subset of
 * {@link EVERY_FEATURE_INDEXES} in declared order (each index dropped, pairs dropped, all
 * dropped), and every other order of the full set.
 */
function earlierIndexVersions(): { label: string; indexes: string[] }[] {
	const all = [...EVERY_FEATURE_INDEXES];
	const nameOf = (declaration: string) => /By\w+/.exec(declaration)![0];
	const render = (indexes: readonly string[]) => `[${indexes.map(nameOf).join(', ')}]`;
	const subsets = Array.from({ length: (1 << all.length) - 1 }, (_, mask) =>
		all.filter((_index, bit) => (mask >> bit) & 1));
	const orders = permutations(all).filter(order => order.some((index, i) => index !== all[i]));
	return [
		...subsets.map(indexes => ({ label: `earlier version with indexes ${render(indexes)}, rows, then this one`, indexes })),
		...orders.map(indexes => ({ label: `earlier version declaring ${render(indexes)}, rows, then this one`, indexes })),
	];
}

/**
 * Migrations of `app.Every` from an earlier version to a later one, each giving the existing
 * table something new: an index that sorts before the others, the `BigNonNegative` CHECK, both in
 * one apply, and that CHECK where it sorts between two others. Bare `declare schema` blocks;
 * callers append `apply schema app;`.
 */
const MIGRATION_PATHS: readonly { label: string; from: string; to: string }[] = [
	{
		label: 'from a version without ByScore',
		from: everyFeatureDeclare(EVERY_FEATURE_INDEXES.slice(1)),
		to: EVERY_FEATURE_DECLARE,
	},
	{
		label: 'from a version without BigNonNegative',
		from: everyFeatureDeclare(EVERY_FEATURE_INDEXES, []),
		to: EVERY_FEATURE_DECLARE,
	},
	{
		label: 'from a version without ByScore or BigNonNegative',
		from: everyFeatureDeclare(EVERY_FEATURE_INDEXES.slice(1), []),
		to: EVERY_FEATURE_DECLARE,
	},
	{
		label: 'from a version without BigNonNegative, to one declaring it between two other CHECKs',
		from: everyFeatureDeclare(EVERY_FEATURE_INDEXES, [CHECK_BEFORE_BIG, CHECK_AFTER_BIG]),
		to: everyFeatureDeclare(EVERY_FEATURE_INDEXES, [CHECK_BEFORE_BIG, ...EVERY_FEATURE_CHECKS, CHECK_AFTER_BIG]),
	},
];

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]];
	return items.flatMap((item, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
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
		expect(await hydrated.plugin.hydrate(hydrated.db)).to.deep.equal({ tables: 2, indexes: EVERY_FEATURE_INDEXES.length });
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

	it('writes byte-identical catalog records for one declaration, whatever machine, era or layout applied it', async () => {
		// A host writes the catalog alone on every machine before any peer contact, and that is
		// fork-safe only while every machine writes the same bytes. So: independent storages,
		// different eras (session binding), a reflowed declaration (parser positions), the tables
		// in the other order, and the declaration applied twice — all must persist exactly what a
		// fresh apply persists. Reaching it through earlier versions: the next test.
		const reference = await catalogAfter('era1', EVERY_FEATURE);
		expect(reference.join('\n')).to.not.include('"loc"').and.not.include('era1');

		const reflowed = EVERY_FEATURE.replace(/\s+/g, '  ');
		const tablesSwapped = EVERY_FEATURE
			.replace('table Managers { Id text primary key }', '')
			.replace('index ByScore', 'table Managers { Id text primary key }\n\t\tindex ByScore');
		expect(tablesSwapped.indexOf('table Managers')).to.be.greaterThan(tablesSwapped.indexOf('table Every'));

		expect(await catalogAfter('era2', reflowed), 'another era, reflowed').to.deep.equal(reference);
		expect(await catalogAfter('era3', tablesSwapped), 'tables in the other order').to.deep.equal(reference);
		expect(await catalogAfter('era4', EVERY_FEATURE, SEED_EVERY[0], EVERY_FEATURE),
			'applied twice').to.deep.equal(reference);
	});

	it('writes the same catalog record for a declaration whichever earlier version a machine migrated from', async () => {
		// The migration-path property: every earlier version derived from the declaration by
		// dropping any set of its indexes, or by declaring them in another order, then rows, then
		// the declaration itself, must persist exactly what a fresh apply persists. Index order in
		// the record used to be creation order, so a version adding `ByScore` (declared first)
		// to an existing table stored it last while a fresh apply stored it first.
		const reference = await catalogAfter('era1', EVERY_FEATURE);
		const earlier = earlierIndexVersions();
		expect(earlier.length, 'every proper subset and every other order').to.equal(7 + 5);
		for (const { label, indexes } of earlier) {
			const version = `${everyFeatureDeclare(indexes)} apply schema app;`;
			expect(await catalogAfter('era2', version, ...SEED_EVERY, EVERY_FEATURE), label).to.deep.equal(reference);
		}
	});

	it('writes the same catalog record whichever earlier version a machine migrated from, when a later version adds a CHECK', async () => {
		// The same property for a named table-level CHECK: `apply schema` adds it to the existing
		// table with ALTER TABLE ADD CONSTRAINT, which used to leave it out of the record altogether.
		for (const { label, from, to } of MIGRATION_PATHS) {
			const reference = await catalogAfter('era1', `${to} apply schema app;`);
			expect(await catalogAfter('era2', `${from} apply schema app;`, ...SEED_EVERY, `${to} apply schema app;`), label)
				.to.deep.equal(reference);
		}
	});

	it('an ALTER-added CHECK commits with the rest of its apply, in the one catalog commit', async () => {
		// A version adding an index and a CHECK to an EMPTY table: the index tree has nothing to
		// land, so the apply costs exactly its one catalog commit; a CHECK written outside the
		// batch would be a second.
		const counting = countingTransactor(buildSharedLocalTransactor(new MemoryRawStorage()));
		const { db, plugin } = await openSession('era1', { 'local:era1': counting.transactor });
		await db.exec(`${everyFeatureDeclare(EVERY_FEATURE_INDEXES.slice(1), [])} apply schema app;`);

		counting.counts.reset();
		await db.exec(EVERY_FEATURE);
		expect(counting.counts.commit, 'one commit for the index and the CHECK together').to.equal(1);
		expect(await catalogRecordBytes(plugin, 'era1')).to.deep.equal(await catalogAfter('era1', EVERY_FEATURE));
	});

	it('hydrates a migrated table as the table its declaration creates', async () => {
		// Storage that reached the declaration through an earlier version, hydrated by a new
		// session with no re-declaration, so whatever a later version added must come back from
		// the record alone. One era throughout, so the session binding is not what differs.
		for (const { label, from, to } of MIGRATION_PATHS) {
			const store = buildSharedLocalTransactor(new MemoryRawStorage());
			const migrating = await openEra('era1', store);
			await migrating.db.exec(`${from} apply schema app;`);
			await seedEvery(migrating.db);
			await migrating.db.exec(`${to} apply schema app;`);

			const hydrated = await openEra('era1', store);
			expect(await hydrated.plugin.hydrate(hydrated.db), label).to.deep.equal({ tables: 2, indexes: EVERY_FEATURE_INDEXES.length });
			const created = await openEra('era1', buildSharedLocalTransactor(new MemoryRawStorage()));
			await created.db.exec(`${to} apply schema app;`);

			const declared = declarationView(tableOf(created.db, 'app', 'Every'));
			expect(declarationView(tableOf(hydrated.db, 'app', 'Every')), label).to.deep.equal(declared);
			expect(declarationView(tableOf(migrating.db, 'app', 'Every')), `${label}: the migrating session's own table`).to.deep.equal(declared);

			// A session that declares instead of hydrating finds the record already canonical, so
			// its connect-time compare holds and nothing is rewritten.
			const counting = countingTransactor(store);
			const redeclaring = await openSession('era1', { 'local:era1': counting.transactor });
			await redeclaring.db.exec(`${to} apply schema app;`);
			expect(counting.counts, `${label}: re-declaring the migrated table commits nothing`).to.include({ pend: 0, commit: 0 });

			// Enforces `BigNonNegative` among the rest, restored by hydrate alone.
			await expectEveryBehaves(hydrated.db);
		}
	});

	it("never takes a hydrated table's encoding from the session's default args", async () => {
		// `encoding` in `default_vtab_args` describes tables the session creates; the bytes a
		// hydrated table already has in storage are described by its record alone. Overlaying
		// the session's would open the table with the wrong codec and write that into the record.
		const store = buildSharedLocalTransactor(new MemoryRawStorage());
		const writer = await openEra('era1', store);
		await writer.db.exec(`declare schema app { table N { id integer primary key, v text } } apply schema app;`);
		await writer.db.exec(`insert into app.N (id, v) values (1, 'one')`);

		const { db, plugin } = await openEra('era2', store);
		await db.exec(`pragma default_vtab_args = '${JSON.stringify({ ...eraArgs('era2'), encoding: 'msgpack' })}'`);
		await plugin.hydrate(db);
		expect(tableOf(db, 'app', 'N').vtabArgs).to.deep.equal(eraArgs('era2'));
		expect(await queryAll(db, 'select id, v from app.N')).to.deep.equal([{ id: 1, v: 'one' }]);

		const later = await openEra('era3', store);
		await later.plugin.hydrate(later.db);
		expect(await queryAll(later.db, 'select id, v from app.N'), 'the record was not re-labelled').to.deep.equal([{ id: 1, v: 'one' }]);
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
