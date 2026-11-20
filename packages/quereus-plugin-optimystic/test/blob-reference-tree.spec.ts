/**
 * A table's blob reference tree follows its rows (docs/blobs.md §Registering references).
 *
 * For every table with a `blobref` column the plugin keeps a second tree, `<table>/blobrefs`,
 * listing which of its rows reference which stored blobs, written in the same transaction as the
 * rows themselves. That list is what keeps a referenced blob's bytes alive, so it has to say
 * exactly what the rows say after every shape of write — and the table's own id has to be in the
 * network's scope registry, since a scope the registry does not list is one no storage node reads.
 *
 * What is pinned here:
 *
 *  - **The shapes**, table-driven against an oracle: after each case's statements, the triples
 *    `(reference, row key, column)` the tree holds equal the ones a full scan of the rows implies.
 *    One oracle for every case, so a new case costs a row of data. Built with the production
 *    referrer builder (`blobReferrer`) and the production row codec on purpose: the key framing has
 *    its own specs (`key-encoding.spec.ts`), and what this must pin is that the tree's contents
 *    match the rows.
 *  - **Racing writers**: a loser refused on one row leaves no reference entry behind, and two
 *    writers referencing one blob from different rows both land.
 *  - **The registry**: a created table's scope is listed, a dropped one's is not.
 *  - **The two refusals** that keep the tree describing real rows: a re-declare that changes or
 *    omits a `blobref` column, and a DROP COLUMN of one.
 *
 * Not pinned here, deliberately: the commit routes (legacy flush, session coordinator, the offline
 * queue) and the offline restore. The reference tree is one more dirty tree and one more registered
 * collection, which is what carries it on all of them, and the existing commit-route and
 * offline-restore specs hold that mechanism for every tree a table opens.
 *
 * The references below are fixed vectors from `packages/db-core/test/blob-builder.spec.ts`, so they
 * are references real IPFS tools produce rather than strings made to fit.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { BlobReferenceTree, BlobScopeRegistry, TransactionCoordinator, decodeBlobReferenceKey } from '@optimystic/db-core';
import type { CollectionId, ITransactor } from '@optimystic/db-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import register from '../dist/plugin.js';
import { QuereusEngine, RowCodec, blobReferrer, isBlobRefColumn, splitKeyTuple } from '../dist/index.js';
import type { StoredTableSchema } from '../dist/index.js';
import { captureThrown, expectConcurrentModificationRefusal, queryAll } from './query-helpers.js';

/** Fixed vectors: the 0-byte, 1,000-byte and 262,144-byte files of the builder's reference set. */
const REF_A = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';
const REF_B = 'bafkreicojquuwmy7piqjti3zx3buxh47ya64i2vumxmzr5gwqpnfgsd6nu';
const REF_C = 'bafkreibruh455iawsviqslif5c7uurdcfdemh22mtnytyzvnzn75kpejxy';

type Plugin = ReturnType<typeof register>;

/**
 * A `local` session over `storage`, with the plugin's `types` registered as `registerPlugin` does —
 * which is what makes a `blobref` column resolve. Two sessions over ONE `MemoryRawStorage` are two
 * handles over one store, each with its own collection factory and so its own tree trackers: the
 * racing shape, without a temporary directory.
 */
function createDb(storage: MemoryRawStorage): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => storage,
	} as unknown as Record<string, SqlValue>);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	for (const type of plugin.types) db.registerType(type.name, type.definition);
	return { db, plugin };
}

/** Options that resolve to the session's one cached `local:test` transactor. */
function bindingOptions(storage: MemoryRawStorage) {
	return {
		collectionUri: 'tree://unused',
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
		rawStorageFactory: () => storage,
	};
}

async function transactorOf(plugin: Plugin, storage: MemoryRawStorage): Promise<ITransactor> {
	return await plugin.collectionFactory.getOrCreateTransactor(bindingOptions(storage));
}

interface SchemaManagerLike {
	getSchema: (schemaName: string, name: string) => Promise<StoredTableSchema | undefined>;
}

/** Reach the plugin's shared SchemaManager (populated by create), as the hydrate specs do. */
function sharedSchemaManager(plugin: Plugin): SchemaManagerLike {
	const optimysticModule = plugin.vtables[0]!.module as unknown as {
		schemaManagers: Map<string, SchemaManagerLike>;
	};
	const managers = [...optimysticModule.schemaManagers.values()];
	expect(managers, 'plugin should have exactly one shared SchemaManager').to.have.lengthOf(1);
	return managers[0]!;
}

/** The reference tree's collection id — the table's scope — for a table declared at `uri`. */
function scopeOf(uri: string): CollectionId {
	return `${uri.replace(/^tree:\/\//, '')}/blobrefs` as CollectionId;
}

/**
 * One reference-tree entry as both sides of the oracle render it: the reference, the referring
 * row's key elements, and the column. A failure then names a row and column a reader can find in
 * the SQL rather than a framed tree key.
 */
function renderEntry(ref: string, referrer: string): string {
	const elements = splitKeyTuple(referrer);
	const column = elements[elements.length - 1];
	const key = elements.slice(0, -1).map(element => (element.isNull ? null : element.payload));
	return `${ref} ${JSON.stringify(key)}.${column === undefined || column.isNull ? '(no column)' : column.payload}`;
}

/** Every entry the committed reference tree at `scope` holds, as {@link renderEntry} renders it. */
async function entriesInTree(transactor: ITransactor, scope: CollectionId): Promise<string[]> {
	// `createOrOpen` as the plugin opens it: a tree that was never written reads as empty, and
	// opening it here brings nothing into existence (nothing is staged or synced).
	const references = await BlobReferenceTree.createOrOpen(transactor, scope);
	const tree = references.tree;
	await tree.update();
	const found: string[] = [];
	const path = await tree.first();
	while (path.on) {
		const [key] = tree.at(path)!;
		const { ref, referrer } = decodeBlobReferenceKey(key);
		found.push(renderEntry(ref, referrer));
		await tree.moveNext(path);
	}
	return found.sort();
}

/** Every entry the rows of `table` imply, through the table's own row codec and the production
 *  referrer builder. */
async function entriesInRows(db: Database, stored: StoredTableSchema, table: string): Promise<string[]> {
	const rowCodec = new RowCodec(stored, 'json');
	const keyColumns = stored.primaryKeyDefinition.map(pk => stored.columns[pk.index]!.name);
	const refColumns = stored.columns.filter(isBlobRefColumn).map(column => column.name);
	const expected: string[] = [];
	for (const row of await queryAll(db, `select * from ${table}`)) {
		const key = rowCodec.createPrimaryKey(rowCodec.asPrimaryKeyTuple(keyColumns.map(name => row[name] ?? null)));
		for (const column of refColumns) {
			const cell = row[column] ?? null;
			if (cell !== null) expected.push(renderEntry(String(cell), blobReferrer(key, column)));
		}
	}
	return expected.sort();
}

/** THE oracle: the reference tree says exactly what the rows say. */
async function expectTreeMatchesRows(
	db: Database,
	plugin: Plugin,
	storage: MemoryRawStorage,
	uri: string,
	when: string,
	options: { readonly entries?: number; readonly table?: string } = {},
): Promise<void> {
	const table = options.table ?? 'T';
	const stored = await sharedSchemaManager(plugin).getSchema('main', table);
	expect(stored, `${table} should have a catalog record`).to.not.equal(undefined);
	const [found, expected] = await Promise.all([
		entriesInTree(await transactorOf(plugin, storage), scopeOf(uri)),
		entriesInRows(db, stored!, table),
	]);
	expect(found, `${table}'s reference tree ${when}`).to.deep.equal(expected);
	if (options.entries !== undefined) {
		expect(found.length, `${table}'s reference tree ${when} should hold this many entries`).to.equal(options.entries);
	}
}

/**
 * The shapes table: a composite primary key whose columns are not the leading ones, two `blobref`
 * columns, a secondary UNIQUE that resolves REPLACE, and a foreign key for the cascade case. The
 * primary key resolves REPLACE too, which is what makes a DISPLACING move reachable from an
 * ordinary `update` (Quereus has no `update or replace`).
 */
const PARENT_DDL = (uri: string) => `create table P (Id integer primary key) using optimystic('${uri}/p')`;
const TABLE_DDL = (uri: string) => `
	create table T (
		A text null,
		K1 integer,
		K2 text,
		R1 blobref null,
		R2 blobref null,
		U text null unique on conflict replace,
		Pid integer null references P (Id) on delete cascade,
		primary key (K2, K1) on conflict replace
	) using optimystic('${uri}/t')
`;

/** Insert one row of T, naming every column so a later DROP COLUMN case still reads. */
const insertRow = (
	values: { A?: string | null; K1: number; K2: string; R1?: string | null; R2?: string | null; U?: string | null; Pid?: number | null },
	or = '',
): string =>
	`insert ${or} into T (A, K1, K2, R1, R2, U, Pid) values (`
	+ [
		literal(values.A ?? null), String(values.K1), literal(values.K2),
		literal(values.R1 ?? null), literal(values.R2 ?? null), literal(values.U ?? null),
		values.Pid === undefined || values.Pid === null ? 'null' : String(values.Pid),
	].join(', ')
	+ ')';

function literal(value: string | null): string {
	return value === null ? 'null' : `'${value}'`;
}

interface ShapeCase {
	readonly name: string;
	readonly statements: readonly string[];
	/** How many entries the tree must hold afterwards. The oracle compares two derived sets, so
	 *  this is what keeps a case from passing because both sides came out empty. */
	readonly entries: number;
}

const SHAPES: readonly ShapeCase[] = [
	{
		name: 'an insert registers every reference the row holds, and NULL registers nothing',
		statements: [
			insertRow({ A: 'a', K1: 1, K2: 'k', R1: REF_A }),
			insertRow({ A: 'b', K1: 2, K2: 'k', R1: REF_B, R2: REF_C }),
			insertRow({ A: 'c', K1: 1, K2: 'j' }),
		],
		entries: 3,
	},
	{
		name: 'a delete takes every reference the row held',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A, R2: REF_B }),
			insertRow({ K1: 2, K2: 'k', R1: REF_C }),
			`delete from T where K2 = 'k' and K1 = 1`,
		],
		entries: 1,
	},
	{
		name: 'a cascade delete takes the child row\'s references with it',
		statements: [
			'insert into P (Id) values (1)',
			insertRow({ K1: 1, K2: 'k', R1: REF_A, Pid: 1 }),
			insertRow({ K1: 2, K2: 'k', R1: REF_B }),
			'delete from P where Id = 1',
		],
		entries: 1,
	},
	{
		name: 'a secondary-UNIQUE REPLACE eviction takes the evicted row\'s references',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A, U: 'u' }),
			insertRow({ K1: 2, K2: 'k', R1: REF_B, U: 'u' }),
		],
		entries: 1,
	},
	{
		name: 'INSERT OR REPLACE over an occupied key swaps the row\'s references',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A, R2: REF_B }),
			insertRow({ K1: 1, K2: 'k', R1: REF_C }, 'or replace'),
		],
		entries: 1,
	},
	{
		name: 'a same-key update that changes a reference swaps that column\'s entry',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A, R2: REF_B }),
			`update T set R1 = '${REF_C}' where K2 = 'k' and K1 = 1`,
		],
		entries: 2,
	},
	{
		name: 'a same-key update that keeps the references changes nothing',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A, R2: REF_B }),
			`update T set A = 'z' where K2 = 'k' and K1 = 1`,
		],
		entries: 2,
	},
	{
		name: 'a same-key update to NULL drops the entry, and from NULL adds one',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A }),
			insertRow({ K1: 2, K2: 'k' }),
			`update T set R1 = null where K2 = 'k' and K1 = 1`,
			`update T set R2 = '${REF_B}' where K2 = 'k' and K1 = 2`,
		],
		entries: 1,
	},
	{
		name: 'a primary-key move carries every reference to the new key',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A, R2: REF_B }),
			`update T set K1 = 9 where K2 = 'k' and K1 = 1`,
		],
		entries: 2,
	},
	{
		name: 'a displacing move drops the displaced row\'s references and keeps the moving row\'s',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A }),
			insertRow({ K1: 2, K2: 'k', R1: REF_B }),
			`update T set K1 = 2 where K2 = 'k' and K1 = 1`,
		],
		entries: 1,
	},
	{
		// The displaced row and the moving row stage the IDENTICAL tree key, so the remove and the
		// add must not invert: remove-then-add leaves it present, add-then-remove would lose it.
		name: 'a displacing move where both rows hold one reference in one column keeps the entry',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A }),
			insertRow({ K1: 2, K2: 'k', R1: REF_A }),
			`update T set K1 = 2 where K2 = 'k' and K1 = 1`,
		],
		entries: 1,
	},
	{
		// Two columns of one row are two referrers, so one reference held twice is two entries, and
		// clearing one column leaves the other's entry alone.
		name: 'one reference held in both columns of one row is two entries',
		statements: [
			insertRow({ K1: 1, K2: 'k', R1: REF_A, R2: REF_A }),
			`update T set R2 = null where K2 = 'k' and K1 = 1`,
		],
		entries: 1,
	},
	{
		// The `blobref` columns move; the maintainer's column list is rebuilt from the new layout
		// (`republishColumnLayout`), so the rows written after the drop are keyed the same way.
		name: 'a catalog-only drop of an unrelated column leaves later writes keyed correctly',
		statements: [
			insertRow({ A: 'a', K1: 1, K2: 'k', R1: REF_A }),
			'alter table T drop column A',
			`insert into T (K1, K2, R1, R2, U, Pid) values (2, 'k', '${REF_B}', '${REF_C}', null, null)`,
			`delete from T where K2 = 'k' and K1 = 1`,
		],
		entries: 2,
	},
];

describe('a table\'s blob reference tree follows its rows', function () {
	this.timeout(30_000);

	describe('every shape of row change', () => {
		for (const [at, shape] of SHAPES.entries()) {
			it(shape.name, async () => {
				const uri = `tree://blobrefs/shape-${at}`;
				const storage = new MemoryRawStorage();
				const { db, plugin } = createDb(storage);
				try {
					await db.exec(PARENT_DDL(uri));
					await db.exec(TABLE_DDL(uri));
					for (const sql of shape.statements) await db.exec(sql);
					await expectTreeMatchesRows(db, plugin, storage, `${uri}/t`, 'after the case\'s statements', { entries: shape.entries });
				} finally {
					db.close();
					await plugin.dispose();
				}
			});
		}
	});

	describe('racing writers', () => {
		const RACE_DDL = (uri: string) =>
			`create table T (Id integer primary key, R1 blobref null) using optimystic('${uri}')`;

		it('a loser refused on the row it changed leaves no reference entry behind', async () => {
			const uri = 'tree://blobrefs/race-one-row';
			const storage = new MemoryRawStorage();
			const a = createDb(storage);
			const b = createDb(storage);
			try {
				for (const { db } of [a, b]) await db.exec(RACE_DDL(uri));
				await a.db.exec(`insert into T (Id, R1) values (1, '${REF_A}')`);
				expect(await queryAll(b.db, 'select Id from T'), 'B must see the seed row').to.deep.equal([{ Id: 1 }]);

				// A stages, B commits a rival change to the same row, then A commits: the refusal can
				// only come from A's commit-time conflict replay.
				await a.db.exec('begin');
				await a.db.exec(`update T set R1 = '${REF_B}' where Id = 1`);
				await b.db.exec(`update T set R1 = '${REF_C}' where Id = 1`);
				const refusal = await captureThrown(() => a.db.exec('commit'));
				expectConcurrentModificationRefusal(refusal, 'the loser\'s COMMIT');

				for (const [name, handle] of [['A', a], ['B', b]] as const) {
					expect(await queryAll(handle.db, 'select Id, R1 from T'), `handle ${name}'s rows`)
						.to.deep.equal([{ Id: 1, R1: REF_C }]);
					await expectTreeMatchesRows(handle.db, handle.plugin, storage, uri,
						`on handle ${name} after the refused race`, { entries: 1 });
				}
			} finally {
				a.db.close();
				b.db.close();
				await a.plugin.dispose();
				await b.plugin.dispose();
			}
		});

		it('two writers referencing one blob from different rows both land', async () => {
			const uri = 'tree://blobrefs/race-two-rows';
			const storage = new MemoryRawStorage();
			const a = createDb(storage);
			const b = createDb(storage);
			try {
				for (const { db } of [a, b]) await db.exec(RACE_DDL(uri));
				await a.db.exec('begin');
				await a.db.exec(`insert into T (Id, R1) values (1, '${REF_A}')`);
				await b.db.exec(`insert into T (Id, R1) values (2, '${REF_A}')`);
				await a.db.exec('commit');

				for (const [name, handle] of [['A', a], ['B', b]] as const) {
					expect((await queryAll(handle.db, 'select Id from T order by Id')).map(row => row.Id), `handle ${name}'s rows`)
						.to.deep.equal([1, 2]);
					// Two referrers of one reference: the entries differ, so neither overwrote the other.
					await expectTreeMatchesRows(handle.db, handle.plugin, storage, uri, `on handle ${name}`, { entries: 2 });
				}
			} finally {
				a.db.close();
				b.db.close();
				await a.plugin.dispose();
				await b.plugin.dispose();
			}
		});
	});

	it('a session-mode transaction commits the reference tree with the rows, on a validated pend', async () => {
		// Session (coordinator) mode is the route a validating member re-checks: the coordinator
		// commits every REGISTERED collection with staged changes, and the pend it sends carries the
		// transaction plus the hash of all operations across all of them. So what has to hold here is
		// that the reference tree is one of those collections — if it were not, its entries would be
		// left behind by the commit and absent from the hash the member recomputes.
		const uri = 'tree://blobrefs/session';
		const storage = new MemoryRawStorage();
		const { db, plugin } = createDb(storage);
		let disposeEngine: (() => void) | undefined;
		try {
			await db.exec(`create table T (Id integer primary key, R1 blobref null) using optimystic('${uri}')`);
			await db.exec(`insert into T (Id, R1) values (1, '${REF_A}'), (2, '${REF_B}'), (3, '${REF_C}')`);

			const base = await transactorOf(plugin, storage);
			const pends: { validation?: unknown }[] = [];
			const watched = {
				get: (request: never) => base.get(request),
				getStatus: (request: never) => base.getStatus(request),
				pend: (request: never) => { pends.push(request); return base.pend(request); },
				commit: (request: never) => base.commit(request),
				cancel: (request: never) => base.cancel(request),
			} as unknown as ITransactor;
			const coordinator = new TransactionCoordinator(watched, plugin.txnBridge.getCollectionRegistry());
			const engine = new QuereusEngine(db, coordinator);
			// Warmed outside any statement: the provider the bridge awaits at `begin` refuses to
			// compute a cold hash there (see session-mode-commit.spec.ts).
			await engine.getSchemaHash();
			plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
			disposeEngine = () => engine.dispose();

			await db.exec('begin');
			await db.exec(`insert into T (Id, R1) values (4, '${REF_A}')`);
			await db.exec(`update T set R1 = '${REF_C}' where Id = 1`);
			await db.exec('delete from T where Id = 2');
			await db.exec('commit');

			await expectTreeMatchesRows(db, plugin, storage, uri, 'after the session-mode transaction', { entries: 3 });
			expect(pends.length, 'the commit pended something').to.be.greaterThan(0);
			expect(pends.every(pend => pend.validation !== undefined),
				'every pend carried the transaction and its operations hash').to.equal(true);
		} finally {
			disposeEngine?.();
			db.close();
			await plugin.dispose();
		}
	});

	it('an ADD COLUMN that gives a table its first blobref column starts maintaining the tree', async () => {
		// The one path that attaches the maintainer outside a full initialization
		// (`attachBlobReferences`): the table was opened without a reference tree, so the instance
		// has to pick one up mid-session, and the scope has to reach the registry then too. A second
		// such column afterwards extends the maintainer's column list (`republishColumnLayout`).
		const uri = 'tree://blobrefs/add-column';
		const storage = new MemoryRawStorage();
		const { db, plugin } = createDb(storage);
		try {
			await db.exec(`create table T (Id integer primary key, V text) using optimystic('${uri}')`);
			await db.exec(`insert into T (Id, V) values (1, 'a')`);

			const transactor = await transactorOf(plugin, storage);
			expect((await BlobScopeRegistry.enumerate(transactor)).scopes, 'nothing registered yet')
				.to.not.include(scopeOf(uri));

			await db.exec('alter table T add column Content blobref null');
			expect((await BlobScopeRegistry.enumerate(transactor)).scopes, 'the scope joins the registry with the column')
				.to.include(scopeOf(uri));

			// From the very next statement, with no re-initialization in between.
			await db.exec(`update T set Content = '${REF_A}' where Id = 1`);
			await db.exec(`insert into T (Id, V, Content) values (2, 'b', '${REF_B}')`);
			await expectTreeMatchesRows(db, plugin, storage, uri, 'after the column was added', { entries: 2 });

			await db.exec('alter table T add column Spare blobref null');
			await db.exec(`update T set Spare = '${REF_C}' where Id = 2`);
			await expectTreeMatchesRows(db, plugin, storage, uri, 'after a second blobref column', { entries: 3 });
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	it('a created table\'s scope is in the registry and a dropped one\'s is not', async () => {
		const withRefs = 'tree://blobrefs/registry-refs';
		const without = 'tree://blobrefs/registry-plain';
		const storage = new MemoryRawStorage();
		const { db, plugin } = createDb(storage);
		try {
			await db.exec(`create table T (Id integer primary key, R1 blobref null) using optimystic('${withRefs}')`);
			await db.exec(`create table U (Id integer primary key, V text) using optimystic('${without}')`);
			const transactor = await transactorOf(plugin, storage);

			const listed = await BlobScopeRegistry.enumerate(transactor);
			expect(listed.certain, 'the registry read must be trustworthy').to.equal(true);
			expect(listed.scopes, 'the blobref table\'s scope is registered').to.include(scopeOf(withRefs));
			expect(listed.scopes, 'a table with no blobref column registers nothing').to.not.include(scopeOf(without));

			await db.exec('drop table T');
			const afterDrop = await BlobScopeRegistry.enumerate(transactor);
			expect(afterDrop.scopes, 'a dropped table\'s scope leaves the registry').to.not.include(scopeOf(withRefs));
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	describe('the refusals that keep the tree describing real rows', () => {
		it('refuses a re-declare that turns a persisted text column into blobref', async () => {
			const uri = 'tree://blobrefs/redeclare-to';
			const storage = new MemoryRawStorage();
			const first = createDb(storage);
			try {
				await first.db.exec(`create table T (Id integer primary key, Content text) using optimystic('${uri}')`);
				await first.db.exec(`insert into T (Id, Content) values (1, '${REF_A}')`);
			} finally {
				first.db.close();
				await first.plugin.dispose();
			}

			const second = createDb(storage);
			try {
				const refusal = await captureThrown(() => second.db.exec(
					`create table T (Id integer primary key, Content blobref null) using optimystic('${uri}')`));
				expect(refusal.message).to.include(`Cannot re-declare column 'Content' of table 'main.T' to or from blobref`);
			} finally {
				second.db.close();
				await second.plugin.dispose();
			}
		});

		it('refuses a re-declare that omits a persisted blobref column', async () => {
			const uri = 'tree://blobrefs/redeclare-without';
			const storage = new MemoryRawStorage();
			const first = createDb(storage);
			try {
				await first.db.exec(`create table T (Id integer primary key, Content blobref null) using optimystic('${uri}')`);
			} finally {
				first.db.close();
				await first.plugin.dispose();
			}

			const second = createDb(storage);
			try {
				const refusal = await captureThrown(() => second.db.exec(
					`create table T (Id integer primary key) using optimystic('${uri}')`));
				expect(refusal.message).to.include(`Cannot re-declare table 'main.T' without column 'Content'`);
			} finally {
				second.db.close();
				await second.plugin.dispose();
			}
		});

		it('refuses DROP COLUMN of a blobref column', async () => {
			const uri = 'tree://blobrefs/drop-column';
			const storage = new MemoryRawStorage();
			const { db, plugin } = createDb(storage);
			try {
				await db.exec(`create table T (Id integer primary key, Content blobref null, Other text) using optimystic('${uri}')`);
				const refusal = await captureThrown(() => db.exec('alter table T drop column Content'));
				expect(refusal.message).to.include('it holds blob references');
				// An unconstrained column of the same table still drops, so the refusal is the rule
				// and not a table-wide block.
				await db.exec('alter table T drop column Other');
			} finally {
				db.close();
				await plugin.dispose();
			}
		});
	});
});
