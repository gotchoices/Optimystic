/**
 * The rule under test (ticket slug
 * `bug-one-failed-open-makes-a-table-unusable-for-the-session`):
 *
 * > A memoized promise must never memoize its own rejection.
 *
 * `OptimysticVirtualTable` does its real setup lazily on the first touch and memoizes
 * the in-flight promise so the next hundred statements don't repeat it. Before the fix
 * the memo was never cleared, so a first touch that failed for a PASSING reason — a
 * brief network hiccup, a storage node answering late — became the memoized answer for
 * the life of the process: every later statement against that table replayed the same
 * stale error, including statements issued long after the cohort recovered.
 *
 * These tests inject a transport failure by wrapping the transactor's `get` and
 * throwing for a chosen set of block ids, then "healing" the wrapper and asserting the
 * NEXT touch of the SAME table on the SAME `Database` succeeds. Block ids are readable
 * here because a collection's header block is stored under its own collection id, which
 * is the URI path: `scratch/x` for the table, `scratch/x/index/ix` for an index tree
 * (see CollectionFactory.parseCollectionId and Collection.probeHeader). That lets a gate
 * choose the DEPTH at which initialization fails — before `this.collection` is assigned,
 * or after `collection`/`rowCodec` already are.
 *
 * Single-process, in-memory (`MemoryRawStorage`, one `Database` per "session"), the same
 * harness as drop-table-orphan-rows.spec.ts.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { TableSchema } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { queryAll } from './query-helpers.js';

type PluginHandle = ReturnType<typeof register>;

/** Build a `local`-style transactor over raw storage, shared across plugin instances so
 *  Trees opened by either side see the other's writes. */
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

/** Message every injected transport failure carries, so a test can tell its own
 *  injected failure apart from a genuine one. */
const INJECTED = 'injected transport failure';

/**
 * A transactor that delegates to `base` but throws out of `get` while `failing` names a
 * predicate that matches the block ids being read. Set `failing` to undefined to heal.
 */
interface Gate {
	/** While set, a `get` whose block ids satisfy this throws instead of reading. */
	failing?: (blockIds: string[]) => boolean;
}

function gatedTransactor(base: ITransactor, gate: Gate): ITransactor {
	return {
		async get(blockGets) {
			const ids = blockGets.blockIds.map(id => String(id));
			if (gate.failing?.(ids)) {
				throw new Error(`${INJECTED} reading ${ids.join(', ')}`);
			}
			return await base.get(blockGets);
		},
		async getStatus(trxRefs) { return await base.getStatus(trxRefs); },
		async pend(request) { return await base.pend(request); },
		async commit(request) { return await base.commit(request); },
		async cancel(trxRef) { return await base.cancel(trxRef); },
	} as ITransactor;
}

/** Gate predicate: fail the header read of the collection at `uri` (the FIRST await in
 *  doInitialize, before `this.collection` is assigned). */
function headerOf(uri: string): (blockIds: string[]) => boolean {
	const collectionId = uri.replace(/^tree:\/\//, '');
	return ids => ids.includes(collectionId);
}

/** Gate predicate: fail any index-tree read (`<uri>/index/<name>`), which happens well
 *  after `collection` and `rowCodec` are assigned. */
function anyIndexTree(ids: string[]): boolean {
	return ids.some(id => id.includes('/index/'));
}

/** Count `createOrGetCollection` calls per collection URI — one per doInitialize pass for
 *  the table's own collection, so it reads as "how many times did initialization run". */
function countCollectionOpens(plugin: PluginHandle): (uri: string) => number {
	const counts = new Map<string, number>();
	const factory = plugin.collectionFactory as unknown as {
		createOrGetCollection: (options: { collectionUri?: string }, txnState?: unknown) => Promise<unknown>;
	};
	const original = factory.createOrGetCollection.bind(factory);
	factory.createOrGetCollection = async (options, txnState) => {
		const uri = options?.collectionUri ?? '';
		counts.set(uri, (counts.get(uri) ?? 0) + 1);
		return await original(options, txnState);
	};
	return uri => counts.get(uri) ?? 0;
}

/** The module surface these tests drive by hand, plus the SchemaManager registry the
 *  branch-discriminator test spies on. */
interface ModuleInternals {
	connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: Record<string, unknown>,
		tableSchema?: TableSchema,
	): Promise<unknown>;
	schemaManagers: Map<string, { tableSchemaToStored: (schema: TableSchema) => unknown }>;
}

function moduleOf(plugin: PluginHandle): ModuleInternals {
	return plugin.vtables[0]!.module as unknown as ModuleInternals;
}

/** The one SchemaManager a single-transactor plugin builds (keyed by transactor
 *  fingerprint), reached the same way secondary-unique-hydrate.spec.ts reaches it. */
function sharedSchemaManager(plugin: PluginHandle) {
	const managers = [...moduleOf(plugin).schemaManagers.values()];
	expect(managers, 'plugin should have exactly one shared SchemaManager').to.have.lengthOf(1);
	return managers[0]!;
}

/** Run `body` and return what it threw, failing the test if it resolved instead. */
async function captureFailure(body: () => Promise<unknown>, why: string): Promise<Error> {
	let caught: Error | undefined;
	try {
		await body();
	} catch (error) {
		caught = error as Error;
	}
	expect(caught, why).to.not.equal(undefined);
	return caught!;
}

/** Session A: create `t` at `uri` with one row, using a healthy transactor. */
async function seed(shared: ITransactor, uri: string, options: { indexOn?: string } = {}): Promise<void> {
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

describe('A failed first open must not be memoized for the life of the session', function () {
	this.timeout(20000);

	it('connect path: the SAME statement succeeds once the transport heals', async () => {
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/connect');

		// Session B opens the persisted table through a gate that fails the table's own
		// header read. The schema catalog stays readable so `hydrate` still works — the
		// failure has to land inside the table's initialization, not before it.
		const gate: Gate = {};
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
		try {
			expect((await plugin.hydrate(db)).tables).to.equal(1);

			gate.failing = headerOf('tree://initretry/connect');
			const first = await captureFailure(
				() => queryAll(db, `select * from t`),
				'a select against an unreachable collection must fail',
			);
			expect(first.message).to.include(INJECTED);

			// Before the fix this second attempt replayed the memoized rejection verbatim
			// ("Failed to initialize Optimystic table: <original error>") no matter how
			// healthy the transport had become.
			gate.failing = undefined;
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);

			// And the healed table stays usable for writes, not just the one read.
			await db.exec(`insert into t (id, a, b) values (2, 'cc', 'dd')`);
			expect(await queryAll(db, `select id from t order by id`)).to.deep.equal([{ id: 1 }, { id: 2 }]);
		} finally {
			db.close();
		}
	});

	it('create path: re-issuing the CREATE TABLE succeeds once the transport heals', async () => {
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);

		const gate: Gate = { failing: headerOf('tree://initretry/create') };
		const db = new Database();
		registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
		try {
			const ddl = `create table t (id integer primary key, a text) using optimystic('tree://initretry/create')`;
			const first = await captureFailure(() => db.exec(ddl), 'a create against an unreachable collection must fail');
			expect(first.message).to.include(INJECTED);

			// create() evicts the instance on failure, so the retry arrives as a fresh
			// table — a different recovery mechanism from the connect path above, and it
			// must work too.
			gate.failing = undefined;
			await db.exec(ddl);
			await db.exec(`insert into t (id, a) values (1, 'aa')`);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa' }]);
		} finally {
			db.close();
		}
	});

	it('two first touches in flight share ONE successful initialization', async () => {
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/shared-ok');

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, healthy);
		const opens = countCollectionOpens(plugin);
		try {
			await plugin.hydrate(db);
			const schema = db.schemaManager.findTable('t', 'main')!;
			const module = moduleOf(plugin);

			// Issued without awaiting the first: the memo exists precisely so these share
			// one pass, and that is the easiest thing to break while fixing the rejection
			// case.
			const [one, two] = await Promise.all([
				module.connect(db, undefined, 'optimystic', 'main', 't', {}, schema),
				module.connect(db, undefined, 'optimystic', 'main', 't', {}, schema),
			]);
			expect(one, 'both callers must get the one cached table instance').to.equal(two);
			expect(opens('tree://initretry/shared-ok'), 'initialization must have run exactly once').to.equal(1);
		} finally {
			db.close();
		}
	});

	it('two first touches in flight share ONE failing initialization, and a later touch retries', async () => {
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/shared-fail');

		const gate: Gate = {};
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
		const opens = countCollectionOpens(plugin);
		try {
			await plugin.hydrate(db);
			const schema = db.schemaManager.findTable('t', 'main')!;
			const module = moduleOf(plugin);

			gate.failing = headerOf('tree://initretry/shared-fail');
			const results = await Promise.allSettled([
				module.connect(db, undefined, 'optimystic', 'main', 't', {}, schema),
				module.connect(db, undefined, 'optimystic', 'main', 't', {}, schema),
			]);
			const reasons = results.map(r => (r.status === 'rejected' ? (r.reason as Error).message : 'RESOLVED'));
			expect(reasons[0], 'both concurrent callers must receive the error').to.include(INJECTED);
			expect(reasons[1], 'both concurrent callers must receive the error').to.equal(reasons[0]);
			expect(opens('tree://initretry/shared-fail'), 'the two callers must share one attempt').to.equal(1);

			// The memo must be clear afterwards, so a third caller starts a NEW attempt.
			gate.failing = undefined;
			await module.connect(db, undefined, 'optimystic', 'main', 't', {}, schema);
			expect(opens('tree://initretry/shared-fail'), 'the third caller must start a second attempt').to.equal(2);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});

	it('a healed table serves a committed read without starting a redundant provisional pass', async () => {
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/committed');

		const gate: Gate = {};
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
		const opens = countCollectionOpens(plugin);
		try {
			await plugin.hydrate(db);
			const schema = db.schemaManager.findTable('t', 'main')!;
			const module = moduleOf(plugin);

			gate.failing = headerOf('tree://initretry/committed');
			await captureFailure(
				() => module.connect(db, undefined, 'optimystic', 'main', 't', {}, schema),
				'the first touch must fail under the gate',
			);

			gate.failing = undefined;
			await module.connect(db, undefined, 'optimystic', 'main', 't', {}, schema);
			const afterFullInit = opens('tree://initretry/committed');

			// initializeForCommittedRead checks isInitialized BEFORE initializationPromise,
			// so clearing the memo on SUCCESS must not make a committed read redo the work
			// as a provisional pass.
			await module.connect(db, undefined, 'optimystic', 'main', 't', { _readCommitted: true }, schema);
			expect(
				opens('tree://initretry/committed'),
				'a committed read of an already-initialized table must not re-open its collection',
			).to.equal(afterFullInit);
		} finally {
			db.close();
		}
	});

	it('a deterministic refusal fails identically on the retry — no accidental success', async () => {
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/deterministic');

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, healthy);
		try {
			await plugin.hydrate(db);
			await db.exec(`drop table t`);
			// The storage-adoption guard refuses this every time: the leftover rows cannot
			// supply `z`. Retrying must reproduce the refusal, not stumble into a success
			// off state the first attempt left behind.
			const ddl = `create table t (id integer primary key, z integer) using optimystic('tree://initretry/deterministic')`;
			const first = await captureFailure(() => db.exec(ddl), 'the guard must refuse this declaration');
			const second = await captureFailure(() => db.exec(ddl), 'the guard must refuse it again');
			expect(first.message).to.include(`adds column 'z'`);
			expect(second.message, 'the retry must fail the same way').to.equal(first.message);

			// A genuinely missing column list is the other deterministic failure; the way
			// out the guard's message names still works after two refusals.
			await db.exec(`create table t (id integer primary key, a text, b text) using optimystic('tree://initretry/deterministic')`);
			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});

	it('a retry after a LATE failure keeps the load branch — it does not turn a read-only open into a schema write', async () => {
		// Regression test for the `declaredColumns` capture. `doInitialize` picks its
		// branch from whether the DECLARATION supplied columns; the load branch (a connect
		// that must read its columns out of storage) populates `tableSchema.columns` as it
		// goes. Reading that list to pick the branch — which is what the code did — makes a
		// retry after a LATE failure take the other branch: local-DDL-wins, which can write
		// the schema where the first attempt intended only to read it.
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/late', { indexOn: 'a' });

		const gate: Gate = {};
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
		try {
			await plugin.hydrate(db);

			// A column-less placeholder is what the load branch exists for; build one from
			// the hydrated catalog entry so everything except the column list is real.
			const hydrated = db.schemaManager.findTable('t', 'main')!;
			const placeholder = {
				...hydrated,
				columns: [],
				columnIndexMap: new Map<string, number>(),
				primaryKeyDefinition: [],
			} as unknown as TableSchema;

			const module = moduleOf(plugin);
			// Spy on the one call only the local-DDL-wins branch makes. Counting schema-tree
			// WRITES is not enough on its own: the two branches agree whenever the persisted
			// schema round-trips exactly, so the write is only a symptom. This asserts the
			// branch itself.
			const manager = sharedSchemaManager(plugin);
			const originalToStored = manager.tableSchemaToStored.bind(manager);
			let ddlBranchEntries = 0;
			manager.tableSchemaToStored = (schema: TableSchema) => {
				ddlBranchEntries++;
				return originalToStored(schema);
			};

			// Succeed for the schema read (so the load branch runs and stamps the columns),
			// fail for the index-tree read that comes after `collection` and `rowCodec` are
			// already assigned.
			gate.failing = anyIndexTree;
			const first = await captureFailure(
				() => module.connect(db, undefined, 'optimystic', 'main', 't', {}, placeholder),
				'the index-tree read must fail under the gate',
			);
			expect(first.message).to.include(INJECTED);
			expect(placeholder.columns, 'the failed attempt stamped the loaded columns').to.have.lengthOf(3);
			expect(ddlBranchEntries, 'the first attempt must take the load branch').to.equal(0);

			gate.failing = undefined;
			await module.connect(db, undefined, 'optimystic', 'main', 't', {}, placeholder);
			expect(
				ddlBranchEntries,
				'the retry must take the SAME (load) branch as the first attempt, not local-DDL-wins',
			).to.equal(0);

			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});
	it('a committed read after a FAILED full pass is not poisoned by what that pass half-built', async () => {
		// A full pass replaces `rowCodec`/`indexManager` in place, so one that throws inside
		// the index-tree open leaves an IndexManager that was assigned but never opened its
		// trees. `isProvisionallyInitialized` is untouched by that failure, so a later
		// committed read arriving while a writer is active would short-circuit straight onto
		// that wreckage — an index-driven scan then fails the maintained-index backstop for
		// the rest of the transaction, which is this ticket's own bug in miniature.
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/provisional', { indexOn: 'a' });

		const gate: Gate = {};
		const db = new Database();
		const plugin = registerWithSharedTransactor(db, gatedTransactor(healthy, gate));
		const opens = countCollectionOpens(plugin);
		try {
			await plugin.hydrate(db);
			// A second table carries the writer transaction, so the bridge reads as ACTIVE —
			// the condition that routes a first-touch committed read down the PROVISIONAL
			// (read-only) branch instead of a full initialization.
			await db.exec(`create table w (k integer primary key) using optimystic('tree://initretry/provisional-w')`);
			await db.exec('begin');
			await db.exec(`insert into w (k) values (1)`);

			expect(await queryAll(db, `select * from committed.t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
			const afterProvisional = opens('tree://initretry/provisional');
			expect(afterProvisional, 'the committed read must have run a provisional pass').to.be.greaterThan(0);

			gate.failing = anyIndexTree;
			const failure = await captureFailure(
				() => queryAll(db, `select * from t`),
				'the live touch must fail its full pass under the gate',
			);
			expect(failure.message).to.include(INJECTED);
			const afterFailure = opens('tree://initretry/provisional');

			// The load-bearing assertion. Before the atomic publish this threw at PLAN time
			// — "Table 't' does not maintain index 'ix'" out of assertIndexMaintained, which
			// reads the half-built IndexManager the failed pass left behind — and kept
			// throwing for every index-driven plan until some non-index query happened to
			// run a successful full pass.
			gate.failing = undefined;
			expect(await queryAll(db, `select * from committed.t where a = 'aa'`))
				.to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);

			// And it answers from the provisional state the failed pass left INTACT — no
			// rebuild needed, because nothing was half-replaced. (The counter moved once
			// during the failed pass itself, which is why it is sampled after it.)
			expect(
				opens('tree://initretry/provisional'),
				'the surviving provisional state is coherent, so the committed read re-opens nothing',
			).to.equal(afterFailure);
		} finally {
			db.close();
		}
	});
	it('a provisional→full upgrade of a column-less open stays on the load branch and writes no schema', async () => {
		// The other face of the `declaredColumns` capture. doInitialize also runs twice on the
		// provisional→full upgrade, and the SAME branch must be chosen both times: a column-less
		// open is a read of the persisted schema, and upgrading it must not turn into a write.
		const storage = new MemoryRawStorage();
		const healthy = buildSharedLocalTransactor(storage);
		await seed(healthy, 'tree://initretry/upgrade', { indexOn: 'a' });

		const db = new Database();
		const plugin = registerWithSharedTransactor(db, healthy);
		try {
			await plugin.hydrate(db);
			// A second table carries the writer transaction, so the bridge reads as ACTIVE and
			// the committed read below takes the PROVISIONAL branch rather than a full pass.
			await db.exec(`create table w (k integer primary key) using optimystic('tree://initretry/upgrade-w')`);

			const hydrated = db.schemaManager.findTable('t', 'main')!;
			const placeholder = {
				...hydrated,
				columns: [],
				columnIndexMap: new Map<string, number>(),
				primaryKeyDefinition: [],
			} as unknown as TableSchema;

			const manager = sharedSchemaManager(plugin);
			const originalToStored = manager.tableSchemaToStored.bind(manager);
			let ddlBranchEntries = 0;
			manager.tableSchemaToStored = (schema: TableSchema) => {
				ddlBranchEntries++;
				return originalToStored(schema);
			};

			const module = moduleOf(plugin);
			await db.exec('begin');
			await db.exec(`insert into w (k) values (1)`);
			await module.connect(db, undefined, 'optimystic', 'main', 't', { _readCommitted: true }, placeholder);
			expect(placeholder.columns, 'the provisional pass must have loaded the columns').to.have.lengthOf(3);
			expect(ddlBranchEntries, 'the provisional pass must take the load branch').to.equal(0);

			// The upgrade: a live touch of the same instance runs the FULL pass.
			await module.connect(db, undefined, 'optimystic', 'main', 't', {}, placeholder);
			expect(
				ddlBranchEntries,
				'the full pass must take the SAME (load) branch — an upgrade is not a re-declaration',
			).to.equal(0);
			await db.exec('rollback');

			expect(await queryAll(db, `select * from t`)).to.deep.equal([{ id: 1, a: 'aa', b: 'bb' }]);
		} finally {
			db.close();
		}
	});
});
