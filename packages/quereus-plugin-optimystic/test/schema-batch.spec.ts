/**
 * `APPLY SCHEMA` coalesces the plugin's catalog writes into ONE catalog commit.
 *
 * Quereus drives `apply schema` as a loop of ordinary DDL statements and brackets that loop
 * with two optional module hooks, `beginSchemaBatch` and `endSchemaBatch`. Between them the
 * plugin holds every catalog write in an in-memory overlay (`CatalogBatch`) and serves every
 * catalog read from that overlay plus one catalog tree opened once for the whole apply; the
 * overlay is merged against the latest committed catalog and flushed in one commit at
 * `endSchemaBatch`. Before this landed a cold apply of T tables committed the catalog T times
 * and re-read a growing catalog on every create (quadratic reads — see
 * `cold-apply-cost.spec.ts`, whose gates now pin the new shape).
 *
 * The batch is a WRITE-COALESCING BUFFER, NOT A TRANSACTION. Quereus keeps the statements that
 * landed when an apply fails part-way (`@quereus/quereus/test/ddl-schema-event-atomicity.spec.ts`,
 * "a partially-applied schema keeps the events of the statements that landed"), so the plugin
 * commits what landed on BOTH success and error, and a per-statement checkpoint removes only the
 * failed statement's own catalog changes. Several cases below pin exactly that.
 *
 * Index trees ride the same batch. A new index over an EMPTY table leaves its invented tree
 * unwritten, exactly as CREATE TABLE leaves an unwritten table tree, so a cold apply of empty
 * tables costs ONE commit however many indexes it declares. A new index over a POPULATED table
 * is deferred and lands at `endSchemaBatch` BEFORE the catalog commit that lists it; if it fails
 * to land, that catalog commit does not happen, so no record ever lists an index over missing
 * entries.
 *
 * Harness: the `local` transactor over one `MemoryRawStorage`, shared by every `Database` in a
 * case so a second `Database` plus `hydrate` proves what actually reached storage — the pattern
 * from `catalog-hydration.spec.ts`. Counting happens at two seams: every `ITransactor` method
 * call (the substrate round trips the batch exists to remove), and `sync`/`replace` on the
 * catalog tree specifically (so index-tree commits cannot mask or inflate the catalog figure).
 * A `Trail` records the order of commits and catalog syncs, which is how the tree-before-catalog
 * order is asserted; `index:seek` trace lines prove a result came THROUGH an index.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import { Tree, TransactionCoordinator } from '@optimystic/db-core';
import type { ITransactor, CollectionId } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { QuereusEngine } from '../dist/index.js';
import { SchemaManager } from '../src/schema/schema-manager.js';
import type { StoredTableSchema } from '../src/schema/schema-manager.js';
import { queryAll } from './query-helpers.js';
import { captureTrace, indexSeekTraces } from './trace-helpers.js';

type PluginHandle = ReturnType<typeof register>;
type Counts = Record<string, number>;

/** What reached the shared transactor, in order — the seam the tree-before-catalog order is asserted at. */
interface Trail {
	/** The block ids of every `commit` attempt, in order. */
	commits: string[][];
	/** One word per event, in order: `index` (a commit carrying index-tree blocks), `other` (any other commit), `catalog-sync` (the catalog tree's sync was called). */
	events: string[];
}

/** Commit attempts whose block ids carry `fragment` — e.g. `/index/t0_by_name` for that index's tree. */
const commitsCarrying = (trail: Trail, fragment: string): number =>
	trail.commits.filter(ids => ids.some(id => id.includes(fragment))).length;

/** Message every injected failure carries, so a test can tell its own failure from a real one. */
const INJECTED = 'injected failure';

/** Collection id the catalog tree resolves to (`tree://optimystic/schema`, prefix stripped). */
const CATALOG_ID = 'optimystic/schema';

/**
 * Failure injection for the shared transactor. Both predicates see the block ids of the
 * request; a collection's header block is stored under its own collection id, so
 * `ids.includes(CATALOG_ID)` names the catalog's CREATING commit and `id.includes('/index/')`
 * names an index tree (see `CollectionFactory.parseCollectionId`).
 */
interface Gate {
	failGet?: (blockIds: string[]) => boolean;
	failCommit?: (blockIds: string[]) => boolean;
	/** Refuse every `sync` of the CATALOG tree (see `countCatalog`) — a warm catalog's commit carries no header id to match on. */
	failCatalogSync?: boolean;
}

/**
 * A `local`-style transactor over `storage` that counts every method call and honours `gate`.
 * Built once per case so every `Database` in it shares one tracker and sees the others' writes.
 */
function instrumentedTransactor(storage: MemoryRawStorage, gate: Gate, counts: Counts, trail?: Trail): ITransactor {
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
	const count = (method: string) => { counts[method] = (counts[method] ?? 0) + 1; };
	return {
		async get(blockGets) {
			count('get');
			const ids = blockGets.blockIds.map(id => String(id));
			if (gate.failGet?.(ids)) throw new Error(`${INJECTED} reading ${ids.join(', ')}`);
			return await repo.get(blockGets);
		},
		async getStatus(_trxRefs) { count('getStatus'); throw new Error('getStatus not implemented in test transactor'); },
		async pend(request) { count('pend'); return await repo.pend(request); },
		async commit(request) {
			count('commit');
			const ids = request.blockIds.map(id => String(id));
			trail?.commits.push(ids);
			trail?.events.push(ids.some(id => id.includes('/index/')) ? 'index' : 'other');
			if (gate.failCommit?.(ids)) throw new Error(`${INJECTED} committing ${ids.join(', ')}`);
			return await repo.commit(request);
		},
		async cancel(trxRef) { count('cancel'); return await repo.cancel(trxRef); },
	} as ITransactor;
}

const totalCalls = (counts: Counts): number => Object.values(counts).reduce((sum, n) => sum + n, 0);

function registerPlugin(db: Database, transactor: ITransactor): PluginHandle {
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>);
	plugin.collectionFactory.registerTransactor('local:test', transactor);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	return plugin;
}

/** The module surface these tests drive or spy on by hand. */
interface ModuleInternals {
	beginSchemaBatch(db: Database, schemaName: string): Promise<void>;
	endSchemaBatch(db: Database, schemaName: string, error?: unknown): Promise<void>;
	schemaManagers: Map<string, unknown>;
}

const moduleOf = (plugin: PluginHandle): ModuleInternals =>
	plugin.vtables[0]!.module as unknown as ModuleInternals;

/** Count the batch hooks the engine fires on this plugin's module. */
function spyHooks(plugin: PluginHandle): { begin: number; end: number; endErrors: unknown[] } {
	const spy = { begin: 0, end: 0, endErrors: [] as unknown[] };
	const module = moduleOf(plugin);
	const begin = module.beginSchemaBatch.bind(module);
	const end = module.endSchemaBatch.bind(module);
	module.beginSchemaBatch = async (db, schemaName) => { spy.begin++; return begin(db, schemaName); };
	module.endSchemaBatch = async (db, schemaName, error) => {
		spy.end++;
		spy.endErrors.push(error);
		return end(db, schemaName, error);
	};
	return spy;
}

/**
 * Count opens of, and commits through, the CATALOG tree — independent of every other
 * collection. Both factory entry points are wrapped (the read path opens through
 * `getCollection`, the write path through `createOrGetCollection`), and `sync` / `replace`
 * are counted on every catalog tree instance handed out: `replace` is stage-then-sync (the
 * unbatched write path), `sync` is the batch's end-of-apply flush.
 */
function countCatalog(plugin: PluginHandle, gate: Gate = {}, trail?: Trail): { opens: () => number; commits: () => number } {
	let opens = 0;
	let commits = 0;
	type TreeLike = { sync: () => Promise<void>; replace: (data: unknown) => Promise<void> } | undefined;
	const factory = plugin.collectionFactory as unknown as {
		createOrGetCollection: (options: { collectionUri?: string }, txnState?: unknown) => Promise<TreeLike>;
		getCollection: (options: { collectionUri?: string }, txnState?: unknown) => Promise<TreeLike>;
	};
	const instrument = (options: { collectionUri?: string }, tree: TreeLike): TreeLike => {
		if (options?.collectionUri !== 'tree://optimystic/schema') return tree;
		opens++;
		if (!tree) return tree;
		const sync = tree.sync.bind(tree);
		const replace = tree.replace.bind(tree);
		tree.sync = async () => {
			commits++;
			trail?.events.push('catalog-sync');
			if (gate.failCatalogSync) throw new Error(`${INJECTED} syncing the catalog`);
			return sync();
		};
		tree.replace = async (data) => { commits++; return replace(data); };
		return tree;
	};
	const create = factory.createOrGetCollection.bind(factory);
	factory.createOrGetCollection = async (options, txnState) => instrument(options, await create(options, txnState));
	const get = factory.getCollection.bind(factory);
	factory.getCollection = async (options, txnState) => instrument(options, await get(options, txnState));
	return { opens: () => opens, commits: () => commits };
}

/** Everything one case needs: shared storage + instrumented transactor + a first Database. */
function harness() {
	const storage = new MemoryRawStorage();
	const gate: Gate = {};
	const counts: Counts = {};
	const trail: Trail = { commits: [], events: [] };
	const transactor = instrumentedTransactor(storage, gate, counts, trail);
	const db = new Database();
	const plugin = registerPlugin(db, transactor);
	const catalog = countCatalog(plugin, gate, trail);
	const hooks = spyHooks(plugin);
	/** A fresh `Database` over the same storage, hydrated — what durably reached storage. */
	const reopen = async () => {
		const other = new Database();
		const otherPlugin = registerPlugin(other, transactor);
		const hydrated = await otherPlugin.hydrate(other);
		return { db: other, hydrated };
	};
	return { storage, gate, counts, trail, transactor, db, plugin, catalog, hooks, reopen };
}

type Harness = ReturnType<typeof harness>;

/**
 * Rows of `sql` plus the (lower-cased) indexes its scans sought through — the proof a result
 * came THROUGH an index rather than from a full scan that would mask a missing index entry.
 */
async function queryWithSeeks(db: Database, sql: string): Promise<{ rows: Record<string, any>[]; seeks: string[] }> {
	let rows: Record<string, any>[] = [];
	const lines = await captureTrace(async () => { rows = await queryAll(db, sql); });
	return { rows, seeks: indexSeekTraces(lines).map(seek => seek.index.toLowerCase()) };
}

/** Sorted `id` column of `rows`, so a multi-row result is compared independent of scan order. */
const idsOf = (rows: Record<string, any>[]): number[] => rows.map(row => Number(row.id)).sort((a, b) => a - b);

/**
 * Switch `db` to session mode (a `TransactionCoordinator` over the case's shared transactor),
 * the pattern from `committed-read-conformance.spec.ts`. `warm` recomputes the engine's schema
 * hash, which must happen OUTSIDE any statement after DDL and before the next transaction.
 */
async function enableSessionMode(
	db: Database,
	plugin: PluginHandle,
	transactor: ITransactor
): Promise<{ warm: () => Promise<unknown>; dispose: () => void }> {
	const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(db, coordinator);
	await engine.getSchemaHash();
	plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
	return { warm: () => engine.getSchemaHash(), dispose: () => engine.dispose() };
}

const tableBody = 'id integer primary key, name text';

/** A schema of `tables` index-free tables (`t0` … `t{n-1}`) plus one index per name in `indexes`. */
function declaration(tables: number, indexes: string[] = []): string {
	const parts: string[] = [];
	for (let i = 0; i < tables; i++) parts.push(`table t${i} { ${tableBody} }`);
	for (const name of indexes) parts.push(`index ${name}_by_name on ${name} (name)`);
	return `declare schema main {\n${parts.join('\n')}\n}\napply schema main;`;
}

async function expectRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	expect(thrown, 'expected the statement to reject').to.be.instanceOf(Error);
	expect((thrown as Error).message).to.match(pattern);
}

/** Bump every counter in `counts` down by its value in `since`: what happened after `since`. */
function delta(counts: Counts, since: Counts): Counts {
	const out: Counts = {};
	for (const [k, v] of Object.entries(counts)) out[k] = v - (since[k] ?? 0);
	return out;
}

describe('APPLY SCHEMA coalesces catalog writes into one commit', function () {
	this.timeout(20_000);

	it('fires the hooks once per apply that has DDL, and not at all on the idempotent re-apply', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);

		await h.db.exec(declaration(3));
		expect(h.hooks.begin, 'beginSchemaBatch once').to.equal(1);
		expect(h.hooks.end, 'endSchemaBatch once').to.equal(1);
		expect(h.hooks.endErrors).to.deep.equal([undefined]);
		expect(h.catalog.commits(), 'one catalog commit for the whole apply').to.equal(1);

		const before = { ...h.counts };
		await h.db.exec(declaration(3));
		expect(h.hooks.begin, 'no-op re-apply fires no hooks').to.equal(1);
		expect(h.hooks.end).to.equal(1);
		expect(totalCalls(delta(h.counts, before)), 'no-op re-apply touches the transactor not at all').to.equal(0);
	});

	it('a cold apply of T empty tables commits the catalog exactly once (was T commits)', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);

		await h.db.exec(declaration(5));

		// Index-free, so the sibling index-tree-flush ticket does not move this number: the ONLY
		// commit in a cold, index-free apply is the catalog's. Before the batch: 5.
		expect(h.counts['commit'], 'transactor commits').to.equal(1);
		expect(h.catalog.commits(), 'catalog commits').to.equal(1);
		expect(h.catalog.opens(), 'the catalog tree is opened once for the batch, plus once to create it at the end').to.be.at.most(2);

		// Durable and usable: a fresh Database hydrates all five, and DML round-trips.
		const { db: db2, hydrated } = await h.reopen();
		expect(hydrated).to.deep.equal({ tables: 5, indexes: 0 });
		await db2.exec(`insert into t4 values (1, 'x')`);
		expect(await queryAll(db2, 'select name from t4 where id = 1')).to.deep.equal([{ name: 'x' }]);
		await h.db.exec(`insert into t0 values (7, 'y')`);
		expect(await queryAll(h.db, 'select id from t0')).to.deep.equal([{ id: 7 }]);
	});

	it('tables AND indexes created by one batched apply hydrate in a fresh Database, and DML works', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);

		await h.db.exec(declaration(2, ['t0', 't1']));

		// CREATE INDEX inside the batch reads the table's PENDING record (it was created a
		// statement earlier and is not yet committed) — a miss there throws "Schema not found".
		expect(h.catalog.commits(), 'catalog commits').to.equal(1);
		// Total commits: the catalog once and nothing else. Both tables are empty, so each new
		// index tree is left invented and unwritten, like the tables' own trees (was 1 + I = 3).
		expect(h.counts['commit'], 'transactor commits').to.equal(1);
		expect(commitsCarrying(h.trail, '/index/'), 'no index-tree commit').to.equal(0);

		const { db: db2, hydrated } = await h.reopen();
		expect(hydrated).to.deep.equal({ tables: 2, indexes: 2 });
		await db2.exec(`insert into t0 values (1, 'alice'), (2, 'bob')`);
		expect(await queryAll(db2, `select id from t0 where name = 'bob'`)).to.deep.equal([{ id: 2 }]);
		expect(db2.schemaManager.findTable('t1', 'main')!.indexes!.map(idx => idx.name)).to.deep.equal(['t1_by_name']);
	});

	it('a warm apply (hydrated catalog, one new table) opens the catalog once and commits once', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);
		await h.db.exec(declaration(2));

		// A second Database over the same storage, instrumented BEFORE hydrate so the apply's
		// catalog opens can be told apart from hydrate's.
		const db3 = new Database();
		const plugin3 = registerPlugin(db3, h.transactor);
		await db3.exec(`pragma default_vtab_module='optimystic'`);
		const catalog3 = countCatalog(plugin3);
		await plugin3.hydrate(db3);
		const opensAfterHydrate = catalog3.opens();
		const before = { ...h.counts };

		await db3.exec(declaration(3));

		expect(catalog3.opens() - opensAfterHydrate, 'one catalog open for the whole apply').to.equal(1);
		expect(catalog3.commits(), 'one catalog commit').to.equal(1);
		expect(delta(h.counts, before)['commit'], 'one transactor commit').to.equal(1);
		const { hydrated } = await h.reopen();
		expect(hydrated.tables).to.equal(3);
	});

	it('direct DDL outside apply schema still commits per statement, exactly as before', async () => {
		const h = harness();

		await h.db.exec(`create table d (${tableBody}) using optimystic('tree://batch/d')`);
		expect(h.hooks.begin, 'no batch outside apply schema').to.equal(0);
		expect(h.catalog.commits(), 'create table commits the catalog once').to.equal(1);
		expect(h.counts['commit']).to.equal(1);

		await h.db.exec(`create index d_by_name on d (name)`);
		expect(h.catalog.commits(), 'create index commits the catalog once more').to.equal(2);
		// Plus the invented index tree's own flush.
		expect(h.counts['commit']).to.equal(3);
	});

	it('an apply with no optimystic DDL runs the hooks but makes zero transactor calls', async () => {
		const h = harness();
		// No default-module pragma: these tables land in Quereus's built-in memory module.
		await h.db.exec(`declare schema main { table m { ${tableBody} } } apply schema main;`);

		expect(h.hooks.begin).to.equal(1);
		expect(h.hooks.end).to.equal(1);
		expect(totalCalls(h.counts), 'no catalog open, no commit — nothing').to.equal(0);
		expect(h.catalog.opens()).to.equal(0);
		expect(await queryAll(h.db, 'select count(*) as n from m')).to.deep.equal([{ n: 0 }]);
	});

	it('a statement refused mid-loop leaves no catalog trace of its own; what landed before it commits', async () => {
		const h = harness();
		// Storage at tree://batch/b still holds a row of a DROPPED table declared (id, name).
		await h.db.exec(`create table b (${tableBody}) using optimystic('tree://batch/b')`);
		await h.db.exec(`insert into b values (1, 'kept')`);
		await h.db.exec(`drop table b`);
		const commitsBefore = h.counts['commit']!;

		const declared = (bColumns: string) =>
			`declare schema main {\n` +
			`table a using optimystic ('tree://batch/a') { ${tableBody} }\n` +
			`table b using optimystic ('tree://batch/b') { ${bColumns} }\n` +
			`}\napply schema main;`;

		// `a` lands; `b` re-declares an added column over rows that cannot supply it and the
		// storage-adoption guard refuses it — after `a`, so the loop aborts with `a` in the batch.
		await expectRejects(h.db.exec(declared(`${tableBody}, extra text`)), /still holds rows from a dropped table/);
		expect(h.hooks.endErrors, 'endSchemaBatch received the loop error').to.have.lengthOf(1);
		expect(h.hooks.endErrors[0]).to.be.instanceOf(Error);
		expect(h.counts['commit']! - commitsBefore, 'the surviving statement committed once').to.equal(1);

		// A fresh Database hydrates `a` and not `b`.
		const { db: db2, hydrated } = await h.reopen();
		expect(hydrated.tables).to.equal(1);
		expect(db2.schemaManager.findTable('a', 'main'), 'a landed').to.not.equal(undefined);
		expect(db2.schemaManager.findTable('b', 'main'), 'b did not').to.equal(undefined);

		// A corrected re-apply on the same Database succeeds and adopts the surviving row.
		await h.db.exec(declared(tableBody));
		expect(await queryAll(h.db, 'select name from b')).to.deep.equal([{ name: 'kept' }]);
	});

	it('a create refused AFTER its schema reached the overlay is rolled back by the checkpoint', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);
		// A secondary UNIQUE constraint makes doInitialize open a synthesized enforcement tree
		// AFTER it has written the schema; fail that open so the statement dies past the write.
		h.gate.failGet = ids => ids.some(id => id.includes('/index/_uniq_'));

		const declared = `declare schema main {\n` +
			`table ok { ${tableBody} }\n` +
			`table u { id integer primary key, email text unique }\n` +
			`}\napply schema main;`;
		await expectRejects(h.db.exec(declared), /injected failure/);

		// `ok` committed; `u`'s overlay entry was withdrawn with the failed statement.
		const { hydrated } = await h.reopen();
		expect(hydrated.tables).to.equal(1);

		// Heal and re-apply: `u` is created cleanly (no stale catalog record to fight).
		h.gate.failGet = undefined;
		await h.db.exec(declared);
		await h.db.exec(`insert into u values (1, 'a@x')`);
		await expectRejects(h.db.exec(`insert into u values (2, 'a@x')`), /unique/i);
		expect((await h.reopen()).hydrated.tables).to.equal(2);
	});

	it('a CREATE INDEX that fails inside the batch withdraws only the index from the pending record', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);
		// addIndex writes the index into the table's (pending) catalog record, then opens the
		// index tree; refuse that open's read so the statement dies after the catalog write.
		// (Refusing the tree's flush no longer works: an empty table's tree is not flushed.)
		h.gate.failGet = ids => ids.some(id => id.includes('/index/'));

		await expectRejects(h.db.exec(declaration(1, ['t0'])), /injected failure/);

		// The table committed WITHOUT the index; the index statement left no trace.
		h.gate.failGet = undefined;
		const { db: db2, hydrated } = await h.reopen();
		expect(hydrated).to.deep.equal({ tables: 1, indexes: 0 });
		expect(db2.schemaManager.findTable('t0', 'main')!.indexes ?? []).to.have.lengthOf(0);

		// Re-applying adds the index cleanly on top of the committed table.
		await h.db.exec(declaration(1, ['t0']));
		expect((await h.reopen()).hydrated).to.deep.equal({ tables: 1, indexes: 1 });
	});

	it('drop then create over the same URI in one apply sees the PENDING gravestone', async () => {
		const h = harness();
		await h.db.exec(`create table old (${tableBody}) using optimystic('tree://batch/shared')`);
		await h.db.exec(`insert into old values (1, 'kept')`);

		const declared = (columns: string) =>
			`declare schema main {\ntable new using optimystic ('tree://batch/shared') { ${columns} }\n}\napply schema main;`;

		// The plan is `drop table old` then `create table new`. The drop's gravestone is only in
		// the overlay when the create runs; the adoption guard must still find it and refuse the
		// contradicting re-declare over rows that still exist.
		await expectRejects(h.db.exec(declared(`${tableBody}, extra text`)), /still holds rows from a dropped table/);

		// The drop landed (committed at end despite the loop error); the create did not.
		const { db: db2, hydrated } = await h.reopen();
		expect(hydrated.tables).to.equal(0);
		expect(db2.schemaManager.findTable('old', 'main')).to.equal(undefined);

		// A matching re-declare adopts the rows.
		await h.db.exec(declared(tableBody));
		expect(await queryAll(h.db, 'select name from new')).to.deep.equal([{ name: 'kept' }]);
	});

	it('a failed end-of-batch commit is recovered by the next touch of each batch-created table', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);
		// Cold database: the batch's one catalog commit is the catalog's CREATING commit, so its
		// block ids carry the catalog header. (t0 is empty, so its index tree is not flushed at all.)
		h.gate.failCommit = ids => ids.includes(CATALOG_ID);

		await expectRejects(h.db.exec(declaration(1, ['t0'])), /injected failure/);
		expect(h.hooks.end, 'endSchemaBatch ran').to.equal(1);
		expect(h.hooks.endErrors, 'no loop error — the end-commit failure is what propagated').to.deep.equal([undefined]);

		// Nothing reached the catalog.
		h.gate.failCommit = undefined;
		expect((await h.reopen()).hydrated.tables).to.equal(0);

		// The engine still has t0 and its index. The next statement re-initializes the table,
		// finds no persisted record, and persists the schema INCLUDING the index it maintains.
		await h.db.exec(`insert into t0 values (1, 'x')`);
		const { db: db2, hydrated } = await h.reopen();
		expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
		expect(await queryAll(db2, `select id from t0 where name = 'x'`)).to.deep.equal([{ id: 1 }]);
	});

	it('a failed end-of-batch commit loses the gravestone of a table dropped inside it; the next hydrate resurrects it', async () => {
		const h = harness();
		await h.db.exec(`pragma default_vtab_module='optimystic'`);
		await h.db.exec(declaration(1));
		expect((await h.reopen()).hydrated.tables, 't0 persisted').to.equal(1);

		// Declaring only t1 plans `drop table t0` then `create table t1`; refuse the ONE commit
		// that would land both the gravestone and the new record.
		const declared = `declare schema main {\ntable t1 { ${tableBody} }\n}\napply schema main;`;
		h.gate.failCatalogSync = true;
		await expectRejects(h.db.exec(declared), /injected failure/);
		h.gate.failCatalogSync = false;

		// The engine dropped t0 and has t1; the catalog still says the opposite. Nothing can heal
		// t0's side — no instance is left to re-stage its gravestone — so a fresh Database
		// resurrects it, while t1 heals on its next touch exactly as the case above.
		expect(h.db.schemaManager.findTable('t0', 'main'), 'the engine dropped t0').to.equal(undefined);
		const stale = await h.reopen();
		expect(stale.hydrated).to.deep.equal({ tables: 1, indexes: 0 });
		expect(stale.db.schemaManager.findTable('t0', 'main'), 't0 resurrected from its live record').to.not.equal(undefined);
		expect(stale.db.schemaManager.findTable('t1', 'main'), 't1 never reached the catalog').to.equal(undefined);
		await h.db.exec(`insert into t1 values (1, 'x')`);
		expect((await h.reopen()).hydrated.tables, 't1 re-persisted; t0 still described').to.equal(2);

		// A Database that hydrated the stale record can drop it for real: the re-apply plans the
		// drop again, and this time the gravestone lands.
		await stale.db.exec(`pragma default_vtab_module='optimystic'`);
		await stale.db.exec(declared);
		expect((await h.reopen()).hydrated.tables).to.equal(1);
	});

	it('session mode: a cold apply still commits the catalog once, and the result hydrates and takes DML', async () => {
		const h = harness();
		const session = await enableSessionMode(h.db, h.plugin, h.transactor);
		try {
			await h.db.exec(`pragma default_vtab_module='optimystic'`);
			await h.db.exec(declaration(2, ['t0']));
			expect(h.hooks.begin, 'the hooks fire under the coordinator too').to.equal(1);
			expect(h.catalog.commits(), 'one catalog commit').to.equal(1);
			expect(h.catalog.opens(), 'one open for the batch, one to create at the end').to.be.at.most(2);
			// Session mode runs the whole apply as ONE coordinator transaction, and its commit —
			// after endSchemaBatch's catalog commit — carries every collection registered with
			// staged state: each new table's and index's invented tree, one transactor commit
			// apiece. So a session-mode cold apply costs 1 + T + I commits, as it did before the
			// index-tree deferral (the index tree only moved from addIndex's own flush into that
			// commit); the single commit is the legacy path's. Backlog:
			// feat-session-mode-apply-schema-tree-commits.
			expect(h.counts['commit'], 'the catalog, then the trees of t0, t1 and the index').to.equal(4);
			expect(commitsCarrying(h.trail, '/index/t0_by_name'), 'the index tree once').to.equal(1);
			expect(h.trail.events.indexOf('catalog-sync'), 'the catalog first; the trees ride the apply\'s own commit')
				.to.equal(0);

			expect((await h.reopen()).hydrated).to.deep.equal({ tables: 2, indexes: 1 });
			await session.warm();
			// The coordinator carries the never-flushed index tree (registered at CREATE INDEX)
			// alongside the table tree, invented header included.
			await h.db.exec(`insert into t0 values (1, 'x')`);
			const live = await queryWithSeeks(h.db, `select id from t0 where name = 'x'`);
			expect(live.rows).to.deep.equal([{ id: 1 }]);
			expect(live.seeks, 'answered through the index').to.include('t0_by_name');
			const { db: db2 } = await h.reopen();
			expect(await queryAll(db2, `select name from t0 where id = 1`), 'the session commit reached shared storage').to.deep.equal([{ name: 'x' }]);
			const fresh = await queryWithSeeks(db2, `select id from t0 where name = 'x'`);
			expect(fresh.rows, 'the index entry reached shared storage too').to.deep.equal([{ id: 1 }]);
			expect(fresh.seeks).to.include('t0_by_name');
		} finally {
			session.dispose();
		}
	});

	it('tables on two transactor configurations in one apply commit one catalog each', async () => {
		const h = harness();
		const declared = `declare schema main {\n` +
			`table p using optimystic ('tree://batch/p') { ${tableBody} }\n` +
			`table q using optimystic ('tree://batch/q', transactor = 'test', keyNetwork = 'test') { ${tableBody} }\n` +
			`}\napply schema main;`;

		await h.db.exec(declared);

		expect(moduleOf(h.plugin).schemaManagers.size, 'one SchemaManager per transactor configuration').to.equal(2);
		expect(h.catalog.commits(), 'one catalog commit per manager').to.equal(2);
		expect(h.counts['commit'], 'the shared local transactor saw exactly one of them').to.equal(1);
		expect((await h.reopen()).hydrated.tables, 'the local catalog lists only its own table').to.equal(1);
	});

	it('beginSchemaBatch while a batch is open throws rather than nesting', async () => {
		const h = harness();
		const module = moduleOf(h.plugin);
		await module.beginSchemaBatch(h.db, 'main');
		await expectRejects(module.beginSchemaBatch(h.db, 'main'), /already open/);
		await module.endSchemaBatch(h.db, 'main');
		// Closed cleanly: a new batch can begin, and nothing was committed for an empty batch.
		await module.beginSchemaBatch(h.db, 'main');
		await module.endSchemaBatch(h.db, 'main');
		expect(totalCalls(h.counts)).to.equal(0);
	});

	describe('index trees: left unwritten when empty, landed before the catalog when populated', () => {
		/** A committed `t0` holding `rows` (a SQL VALUES list), from an index-free apply — the table the apply under test indexes. */
		async function seedT0(h: Harness, rows: string): Promise<void> {
			await h.db.exec(`pragma default_vtab_module='optimystic'`);
			await h.db.exec(declaration(1));
			await h.db.exec(`insert into t0 values ${rows}`);
		}

		/** Forget what the trail recorded so far, so a case can assert on one apply alone. */
		const resetTrail = (h: Harness) => { h.trail.commits.length = 0; h.trail.events.length = 0; };

		it('an index over an empty table is left unwritten like the table; the first INSERT lands both trees (legacy bridge)', async () => {
			const h = harness();
			await h.db.exec(`pragma default_vtab_module='optimystic'`);
			await h.db.exec(declaration(1, ['t0']));
			expect(h.counts['commit'], 'the catalog commit, and nothing else').to.equal(1);
			expect(commitsCarrying(h.trail, '/index/'), 'no index-tree commit').to.equal(0);

			await h.db.exec(`insert into t0 values (1, 'alice'), (2, 'bob')`);
			expect(commitsCarrying(h.trail, '/index/t0_by_name'), "the INSERT's commit sweep carried the index tree").to.equal(1);
			const live = await queryWithSeeks(h.db, `select id from t0 where name = 'bob'`);
			expect(live.rows).to.deep.equal([{ id: 2 }]);
			expect(live.seeks, 'answered through the index').to.include('t0_by_name');

			const { db: db2 } = await h.reopen();
			const fresh = await queryWithSeeks(db2, `select id from t0 where name = 'bob'`);
			expect(fresh.rows, 'the index entry is durable').to.deep.equal([{ id: 2 }]);
			expect(fresh.seeks).to.include('t0_by_name');
		});

		it('an index over an empty table, opened by a fresh Database before any write: listed, empty, and writable', async () => {
			const h = harness();
			await h.db.exec(`pragma default_vtab_module='optimystic'`);
			await h.db.exec(declaration(1, ['t0']));

			// The never-committed index tree is invented empty on open, exactly as the table's is.
			const { db: db2, hydrated } = await h.reopen();
			expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
			const empty = await queryWithSeeks(db2, `select id from t0 where name = 'bob'`);
			expect(empty.rows).to.deep.equal([]);
			expect(empty.seeks, 'the seek ran, and did not fail').to.include('t0_by_name');

			await db2.exec(`insert into t0 values (1, 'bob')`);
			expect((await queryWithSeeks(db2, `select id from t0 where name = 'bob'`)).rows).to.deep.equal([{ id: 1 }]);
		});

		it('an index added to a POPULATED table lands before the catalog commit that lists it, with every existing row', async () => {
			const h = harness();
			await seedT0(h, `(1, 'alice'), (2, 'bob'), (3, 'bob')`);
			const before = { ...h.counts };
			resetTrail(h);

			await h.db.exec(declaration(1, ['t0']));

			expect(delta(h.counts, before)['commit'], 'the index tree, then the catalog').to.equal(2);
			expect(commitsCarrying(h.trail, '/index/t0_by_name'), 'the deferred tree landed once').to.equal(1);
			expect(h.trail.events.indexOf('index'), 'the tree landed BEFORE the catalog sync')
				.to.be.lessThan(h.trail.events.indexOf('catalog-sync'));

			const live = await queryWithSeeks(h.db, `select id from t0 where name = 'bob'`);
			expect(idsOf(live.rows)).to.deep.equal([2, 3]);
			expect(live.seeks).to.include('t0_by_name');
			const { db: db2, hydrated } = await h.reopen();
			expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
			const fresh = await queryWithSeeks(db2, `select id from t0 where name = 'bob'`);
			expect(idsOf(fresh.rows), 'the deferred flush reached storage').to.deep.equal([2, 3]);
			expect(fresh.seeks).to.include('t0_by_name');
		});

		it('a deferred index tree that fails to land cancels the catalog commit; nothing ever lists the index over missing entries', async () => {
			const h = harness();
			await seedT0(h, `(1, 'alice'), (2, 'bob')`);
			const catalogCommits = h.catalog.commits();
			h.gate.failCommit = ids => ids.some(id => id.includes('/index/'));

			await expectRejects(h.db.exec(declaration(1, ['t0'])), /injected failure/);
			expect(h.hooks.endErrors, 'the loop succeeded; endSchemaBatch is what failed').to.deep.equal([undefined, undefined]);
			expect(h.catalog.commits(), 'the catalog commit was never attempted').to.equal(catalogCommits);
			h.gate.failCommit = undefined;

			// Storage: the table and its rows, and no index.
			const stale = await h.reopen();
			expect(stale.hydrated).to.deep.equal({ tables: 1, indexes: 0 });

			// This Database: t0 re-initializes on its next touch WITHOUT the index whose tree did not
			// land, so a read routed through it refuses loudly instead of returning too few rows,
			// and the re-persist lists nothing new.
			await expectRejects(queryAll(h.db, `select id from t0 where name = 'bob'`), /does not maintain index 't0_by_name'/);
			expect(await queryAll(h.db, 'select count(*) as n from t0')).to.deep.equal([{ n: 2 }]);
			expect((await h.reopen()).hydrated, 'the recovery did not list the index').to.deep.equal({ tables: 1, indexes: 0 });

			// A corrected re-apply from the Database that hydrated the index-less record builds it
			// complete. Its plan is a lone CREATE INDEX on a table no statement there has touched yet.
			await stale.db.exec(`pragma default_vtab_module='optimystic'`);
			await stale.db.exec(declaration(1, ['t0']));
			const rebuilt = await queryWithSeeks(stale.db, `select id from t0 where name = 'bob'`);
			expect(rebuilt.rows).to.deep.equal([{ id: 2 }]);
			expect(rebuilt.seeks).to.include('t0_by_name');
			const { db: db3, hydrated } = await h.reopen();
			expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
			const fresh = await queryWithSeeks(db3, `select id from t0 where name = 'bob'`);
			expect(fresh.rows).to.deep.equal([{ id: 2 }]);
			expect(fresh.seeks).to.include('t0_by_name');
		});

		describe('an index added to a hydrated table that no statement has touched yet', () => {
			/** A second Database over `h`'s storage, hydrated but otherwise untouched, its catalog tree instrumented onto `h`'s trail. */
			async function hydratedUntouched(h: Harness): Promise<{ db: Database; catalog: ReturnType<typeof countCatalog> }> {
				const db = new Database();
				const plugin = registerPlugin(db, h.transactor);
				const catalog = countCatalog(plugin, h.gate, h.trail);
				expect(await plugin.hydrate(db)).to.deep.equal({ tables: 1, indexes: 0 });
				return { db, catalog };
			}

			/** The index answers `name = 'bob'` with every existing row, here and in a fresh hydrated Database. */
			async function expectIndexComplete(h: Harness, db: Database): Promise<void> {
				const live = await queryWithSeeks(db, `select id from t0 where name = 'bob'`);
				expect(idsOf(live.rows)).to.deep.equal([2, 3]);
				expect(live.seeks, 'answered through the index').to.include('t0_by_name');
				const { db: db2, hydrated } = await h.reopen();
				expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
				const fresh = await queryWithSeeks(db2, `select id from t0 where name = 'bob'`);
				expect(idsOf(fresh.rows), 'the index tree reached storage').to.deep.equal([2, 3]);
				expect(fresh.seeks).to.include('t0_by_name');
			}

			it('apply schema: the lone CREATE INDEX builds it, the tree landing before the catalog sync', async () => {
				const h = harness();
				await seedT0(h, `(1, 'alice'), (2, 'bob'), (3, 'bob')`);
				const other = await hydratedUntouched(h);
				await other.db.exec(`pragma default_vtab_module='optimystic'`);
				resetTrail(h);

				await other.db.exec(declaration(1, ['t0']));

				expect(other.catalog.commits(), 'one catalog commit').to.equal(1);
				expect(commitsCarrying(h.trail, '/index/t0_by_name'), 'the deferred tree landed once').to.equal(1);
				expect(h.trail.events.indexOf('index'), 'the tree landed BEFORE the catalog sync')
					.to.be.lessThan(h.trail.events.indexOf('catalog-sync'));
				await expectIndexComplete(h, other.db);
			});

			it('plain CREATE INDEX builds it', async () => {
				const h = harness();
				await seedT0(h, `(1, 'alice'), (2, 'bob'), (3, 'bob')`);
				const other = await hydratedUntouched(h);

				await other.db.exec(`create index t0_by_name on t0 (name)`);

				await expectIndexComplete(h, other.db);
			});
		});

		it('session mode: an index added to a POPULATED table lands once, before the catalog, with every existing row', async () => {
			const h = harness();
			const session = await enableSessionMode(h.db, h.plugin, h.transactor);
			try {
				await h.db.exec(`pragma default_vtab_module='optimystic'`);
				await h.db.exec(declaration(1));
				await session.warm();
				await h.db.exec(`insert into t0 values (1, 'alice'), (2, 'bob'), (3, 'bob')`);
				resetTrail(h);

				await h.db.exec(declaration(1, ['t0']));

				// endSchemaBatch syncs the deferred tree itself; the apply's coordinator commit must
				// not carry it a second time.
				expect(commitsCarrying(h.trail, '/index/t0_by_name'), 'the deferred tree landed once').to.equal(1);
				expect(h.trail.events.indexOf('index'), 'the tree landed BEFORE the catalog sync')
					.to.be.lessThan(h.trail.events.indexOf('catalog-sync'));

				await session.warm();
				const live = await queryWithSeeks(h.db, `select id from t0 where name = 'bob'`);
				expect(idsOf(live.rows)).to.deep.equal([2, 3]);
				expect(live.seeks).to.include('t0_by_name');
				const { db: db2, hydrated } = await h.reopen();
				expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
				const fresh = await queryWithSeeks(db2, `select id from t0 where name = 'bob'`);
				expect(idsOf(fresh.rows)).to.deep.equal([2, 3]);
				expect(fresh.seeks).to.include('t0_by_name');
			} finally {
				session.dispose();
			}
		});

		it('after a deferred index tree fails to land, DROP INDEX then CREATE INDEX recovers it in the same Database', async () => {
			const h = harness();
			await seedT0(h, `(1, 'alice'), (2, 'bob')`);
			h.gate.failCommit = ids => ids.some(id => id.includes('/index/'));
			await expectRejects(h.db.exec(declaration(1, ['t0'])), /injected failure/);
			h.gate.failCommit = undefined;

			// The engine still lists the index, so a re-apply plans nothing (the read stays refused)
			// and a bare CREATE INDEX is refused as a duplicate: the index has to be dropped first.
			await h.db.exec(declaration(1, ['t0']));
			await expectRejects(queryAll(h.db, `select id from t0 where name = 'bob'`), /does not maintain index 't0_by_name'/);
			await expectRejects(h.db.exec(`create index t0_by_name on t0 (name)`), /already exists/);
			await h.db.exec(`drop index t0_by_name`);
			await h.db.exec(`create index t0_by_name on t0 (name)`);

			const live = await queryWithSeeks(h.db, `select id from t0 where name = 'bob'`);
			expect(live.rows).to.deep.equal([{ id: 2 }]);
			expect(live.seeks).to.include('t0_by_name');
			const { db: db2, hydrated } = await h.reopen();
			expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
			const fresh = await queryWithSeeks(db2, `select id from t0 where name = 'bob'`);
			expect(fresh.rows).to.deep.equal([{ id: 2 }]);
			expect(fresh.seeks).to.include('t0_by_name');
		});

		it('a UNIQUE index over pre-existing duplicates still builds when deferred — only the flush moved', async () => {
			const h = harness();
			await seedT0(h, `(1, 'bob'), (2, 'bob')`);

			await h.db.exec(`declare schema main {\ntable t0 { ${tableBody} }\nunique index t0_by_name on t0 (name)\n}\napply schema main;`);

			// The existing duplicates both land in the index (see the NOTE on backfillIndexTrees);
			// the derived constraint refuses FUTURE duplicates.
			const live = await queryWithSeeks(h.db, `select id from t0 where name = 'bob'`);
			expect(idsOf(live.rows)).to.deep.equal([1, 2]);
			expect(live.seeks).to.include('t0_by_name');
			await expectRejects(h.db.exec(`insert into t0 values (3, 'bob')`), /unique/i);

			const { db: db2, hydrated } = await h.reopen();
			expect(hydrated).to.deep.equal({ tables: 1, indexes: 1 });
			expect(idsOf((await queryWithSeeks(db2, `select id from t0 where name = 'bob'`)).rows)).to.deep.equal([1, 2]);
		});

		it('several indexes on one populated table: each tree lands exactly once, then one catalog commit', async () => {
			const h = harness();
			const body = 'id integer primary key, name text, tag text';
			const declared = (indexes: string) => `declare schema main {\ntable t0 { ${body} }\n${indexes}}\napply schema main;`;
			await h.db.exec(`pragma default_vtab_module='optimystic'`);
			await h.db.exec(declared(''));
			await h.db.exec(`insert into t0 values (1, 'alice', 'x'), (2, 'bob', 'y'), (3, 'bob', 'x')`);
			const before = { ...h.counts };
			resetTrail(h);

			await h.db.exec(declared('index t0_by_name on t0 (name)\nindex t0_by_tag on t0 (tag)\n'));

			expect(delta(h.counts, before)['commit'], 'two trees, one catalog').to.equal(3);
			expect(commitsCarrying(h.trail, '/index/t0_by_name')).to.equal(1);
			expect(commitsCarrying(h.trail, '/index/t0_by_tag')).to.equal(1);
			expect(h.trail.events.lastIndexOf('index'), 'both trees landed BEFORE the catalog sync')
				.to.be.lessThan(h.trail.events.indexOf('catalog-sync'));

			const { db: db2, hydrated } = await h.reopen();
			expect(hydrated).to.deep.equal({ tables: 1, indexes: 2 });
			for (const db of [h.db, db2]) {
				const byName = await queryWithSeeks(db, `select id from t0 where name = 'bob'`);
				expect(idsOf(byName.rows)).to.deep.equal([2, 3]);
				expect(byName.seeks).to.include('t0_by_name');
				const byTag = await queryWithSeeks(db, `select id from t0 where tag = 'x'`);
				expect(idsOf(byTag.rows)).to.deep.equal([1, 3]);
				expect(byTag.seeks).to.include('t0_by_tag');
			}
		});

		it('a read through a deferred index before the batch ends sees its staged entries', async () => {
			// The engine only runs DDL between the hooks, so the batch is opened by hand here to put
			// a READ inside it — the shape a later statement of the same apply that reads through
			// the new index (an assertion body, say) would have.
			const h = harness();
			await seedT0(h, `(1, 'alice'), (2, 'bob')`);
			const module = moduleOf(h.plugin);

			await module.beginSchemaBatch(h.db, 'main');
			await h.db.exec(`create index t0_by_name on t0 (name)`);
			expect(commitsCarrying(h.trail, '/index/'), 'deferred, not flushed').to.equal(0);
			const inBatch = await queryWithSeeks(h.db, `select id from t0 where name = 'bob'`);
			expect(inBatch.rows, 'the same tree instance serves its staged entries').to.deep.equal([{ id: 2 }]);
			expect(inBatch.seeks).to.include('t0_by_name');
			await module.endSchemaBatch(h.db, 'main');

			expect(commitsCarrying(h.trail, '/index/t0_by_name'), 'landed at the end').to.equal(1);
			const { db: db2 } = await h.reopen();
			const fresh = await queryWithSeeks(db2, `select id from t0 where name = 'bob'`);
			expect(fresh.rows).to.deep.equal([{ id: 2 }]);
			expect(fresh.seeks).to.include('t0_by_name');
		});
	});

	describe('SchemaManager batch against a sibling writer (unit level)', () => {
		const CATALOG = CATALOG_ID as CollectionId;
		const keyOf = (entry: [string, unknown]) => entry[0];
		const compare = (a: string, b: string): -1 | 0 | 1 => (a < b ? -1 : a > b ? 1 : 0);

		/** A SchemaManager whose catalog tree is opened directly through db-core over `transactor`. */
		const managerOver = (transactor: ITransactor) => new SchemaManager(async (_t, create) =>
			create
				? await Tree.createOrOpen<string, any>(transactor, CATALOG, keyOf, compare)
				: await Tree.open<string, any>(transactor, CATALOG, keyOf, compare));

		const stored = (name: string, indexNames: string[]): StoredTableSchema => ({
			name,
			schemaName: 'main',
			columns: [
				{ name: 'id', affinity: 'INTEGER', notNull: true, primaryKey: true, pkOrder: 0, collation: 'BINARY', generated: false },
				{ name: 'v', affinity: 'TEXT', notNull: false, primaryKey: false, pkOrder: -1, collation: 'BINARY', generated: false },
			],
			primaryKeyDefinition: [{ index: 0 }],
			indexes: indexNames.map(idx => ({ name: idx, columns: [{ index: 1 }] })),
			vtabModuleName: 'optimystic',
		});

		it('re-merges each pending record with the LATEST committed one at commit time', async () => {
			const counts: Counts = {};
			const transactor = instrumentedTransactor(new MemoryRawStorage(), {}, counts);
			const a = managerOver(transactor);
			const b = managerOver(transactor);

			a.beginBatch();
			await a.storeStoredSchema(stored('t', ['ix_a']));
			expect(counts['commit'] ?? 0, 'a batched write commits nothing').to.equal(0);

			// A sibling adds a different index to the same table while A's batch is open.
			await b.storeStoredSchema(stored('t', ['ix_b']));
			expect(counts['commit'], 'the unbatched sibling committed immediately').to.equal(1);

			await a.commitBatch();
			expect(counts['commit'], 'the batch commits once').to.equal(2);

			// A third reader sees the union, not A's snapshot overwriting B's index.
			const c = managerOver(transactor);
			const committed = await c.getSchema('t');
			expect(committed!.indexes.map(idx => idx.name)).to.have.members(['ix_a', 'ix_b']);
			// And A's own cache was seeded with what was actually written, not with its snapshot.
			expect((await a.getSchema('t'))!.indexes.map(idx => idx.name)).to.have.members(['ix_a', 'ix_b']);
		});

		it('an empty batch does zero I/O, and a batch over an absent catalog creates it once', async () => {
			const counts: Counts = {};
			const transactor = instrumentedTransactor(new MemoryRawStorage(), {}, counts);
			const a = managerOver(transactor);

			a.beginBatch();
			await a.commitBatch();
			expect(totalCalls(counts), 'nothing pending: no open, no commit').to.equal(0);

			a.beginBatch();
			expect(await a.getSchema('t'), 'a read on a cold catalog is absent, not an error').to.equal(undefined);
			expect(counts['commit'] ?? 0, 'the read did not invent the catalog').to.equal(0);
			await a.storeStoredSchema(stored('t', []));
			await a.storeStoredSchema(stored('u', []));
			await a.commitBatch();
			expect(counts['commit'], 'two tables, one creating commit').to.equal(1);
			expect((await managerOver(transactor).listTables()).sort()).to.deep.equal(['t', 'u']);
		});

		it('a checkpoint restore withdraws the writes staged after it, including a gravestone', async () => {
			const counts: Counts = {};
			const transactor = instrumentedTransactor(new MemoryRawStorage(), {}, counts);
			const seed = managerOver(transactor);
			await seed.storeStoredSchema(stored('t', []));

			const a = managerOver(transactor);
			a.beginBatch();
			await a.storeStoredSchema(stored('keep', []));
			const cp = a.checkpointBatch();
			await a.deleteSchema('t');
			await a.storeStoredSchema(stored('discard', []));
			expect(await a.getSchema('t'), 'the pending gravestone hides t inside the batch').to.equal(undefined);
			a.restoreBatch(cp!);
			expect(await a.getSchema('t'), 'restored: t is live again').to.not.equal(undefined);
			expect(await a.getSchema('discard')).to.equal(undefined);
			await a.commitBatch();

			const after = managerOver(transactor);
			expect((await after.listTables()).sort()).to.deep.equal(['keep', 't']);
			expect(await after.getSchema('t')).to.not.equal(undefined);
		});
	});
});
