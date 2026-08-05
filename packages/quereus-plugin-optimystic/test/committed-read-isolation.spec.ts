/**
 * Coverage for ticket `committed-read-connection-isolation`: a committed
 * (`_readCommitted`) read must be fully isolated from the writer's connection and
 * assembled from ONE committed moment.
 *
 * Four properties are pinned here:
 *
 * 1. **No connection-registry mutation.** A committed connect/scan/disconnect never
 *    registers, reuses, or removes an engine connection — upstream forbids handing a
 *    `_readCommitted` connection to `Database.registerConnection` (it would join the
 *    writer's transaction). The wrapper also refuses `createConnection()` and returns
 *    no `getConnection()`, so nothing can enlist it by accident. This includes the
 *    first-EVER touch of a table (fresh Database, hydrated catalog, no live access).
 *
 * 2. **Single-moment views.** An index-driven committed scan and a full committed
 *    scan of the same nominal snapshot agree row-for-row even when an external
 *    commit lands mid-scan (and interleaved LIVE reads fold that commit into the
 *    shared cache). Both views (main + index) are built in one synchronous block in
 *    `runQuery`, so no commit can slip between them.
 *
 * 3. **All read shapes honour the committed source.** Composite-PK point lookup and
 *    range scan take the already-resolved committed view — asserted, not assumed.
 *
 * 4. **Degraded refusal.** After a `PartialCommitError` (legacy multi-tree commit
 *    split), committed reads THROW (naming the persisted/unpersisted trees) until
 *    the next successful commit or rollback clears the latch. Live reads keep
 *    answering (they honestly mirror storage).
 *
 * Queries under (2) and (3) are driven BY HAND through the module's `connect` +
 * `query` surface (hand-built FilterInfo), not only through SQL — per the ticket,
 * so the interleaving points are deterministic.
 */

import { expect } from 'chai';
import { Database, getModuleConcurrencyMode, getModuleReadCommittedSnapshot } from '@quereus/quereus';
import type { SqlValue, FilterInfo } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/** Vtab-level rows are POSITIONAL (quereus `Row` = `SqlValue[]`); only `db.eval`
 * maps them to named-column objects. */
type VtabRow = readonly SqlValue[];
type Plugin = ReturnType<typeof register>;

/** The registry surface the engine exposes on DatabaseInternal (cast in tests). */
interface ConnectionRegistry {
	getConnectionsForTable(tableName: string): ReadonlyArray<{ connectionId: string }>;
}

/** The committed-capable vtab surface driven by hand in these tests. */
interface HandDrivenTable {
	query(filterInfo: FilterInfo): AsyncIterable<VtabRow>;
	createConnection?(): unknown;
	getConnection?(): unknown;
	disconnect(): Promise<void>;
}

/** The module surface needed to open a committed connect by hand. */
interface ConnectableModule {
	connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: Record<string, unknown>,
	): Promise<HandDrivenTable>;
}

function connections(db: Database, tableName: string): ReadonlyArray<{ connectionId: string }> {
	return (db as unknown as ConnectionRegistry).getConnectionsForTable(tableName);
}

function moduleOf(plugin: Plugin): ConnectableModule {
	return plugin.vtables[0]!.module as unknown as ConnectableModule;
}

/** Open a `_readCommitted` connect on the plugin's module by hand. */
async function connectCommitted(db: Database, plugin: Plugin, tableName: string): Promise<HandDrivenTable> {
	return moduleOf(plugin).connect(db, null, 'optimystic', 'main', tableName, { _readCommitted: true });
}

/** Minimal FilterInfo — runQuery reads only idxNum/idxStr/args. */
function filterInfo(idxStr: string | null, args: SqlValue[] = [], idxNum = 0): FilterInfo {
	return { idxNum, idxStr, args, constraints: [], indexInfoOutput: {} } as unknown as FilterInfo;
}

async function drain(iter: AsyncIterable<VtabRow>): Promise<VtabRow[]> {
	const rows: VtabRow[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
}

async function scalar(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return Number((row as { v: number }).v);
	}
	throw new Error('scalar query returned no rows');
}

/** Run `fn`, returning the thrown error (fails if it unexpectedly resolves). */
async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected operation to throw, but it resolved');
}

/** Fresh Database on the in-memory `test` transactor (mirrors committed-read.spec.ts). */
function createTestDb(): { db: Database; plugin: Plugin } {
	const db = new Database();
	const config = {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

/** Shared `local`-style transactor over one raw storage, so two Database instances
 * see each other's commits (same shape as committed-read-interleave.spec.ts). */
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

function registerWithSharedTransactor(db: Database, transactor: ITransactor): Plugin {
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

describe('Committed-read connection isolation', function () {
	this.timeout(30_000);

	describe('module declarations', () => {
		it('declares reentrant-reads; readCommittedSnapshot stays OFF until proven', () => {
			const { db, plugin } = createTestDb();
			try {
				const module = plugin.vtables[0]!.module;
				expect(getModuleConcurrencyMode(module)).to.equal('reentrant-reads');
				// Deliberately still false: ticket `committed-read-snapshot-declaration`
				// flips this assertion WITH its stall-overlap proof. Do not flip it here.
				expect(getModuleReadCommittedSnapshot(module)).to.equal(false);
			} finally {
				db.close();
			}
		});
	});

	describe('connection registry stays untouched', () => {
		it('committed connect/scan/disconnect never changes the connection count; wrapper refuses enlistment', async () => {
			const { db, plugin } = createTestDb();
			try {
				await db.exec(`create table Item (id integer primary key, cat text) using optimystic('tree://iso/registry')`);
				await db.exec(`insert into Item (id, cat) values (1, 'a'), (2, 'b')`);

				const baseline = connections(db, 'Item').length;
				expect(baseline, 'create() registers the writer connection').to.be.greaterThan(0);

				const committedTable = await connectCommitted(db, plugin, 'Item');
				expect(connections(db, 'Item').length, 'connect must not register').to.equal(baseline);

				// Nothing can enlist the committed view, even by accident.
				expect(() => committedTable.createConnection!()).to.throw(/committed-read/);
				expect(committedTable.getConnection!()).to.equal(undefined);

				const rows = await drain(committedTable.query(filterInfo(null)));
				expect(rows.length).to.equal(2);
				expect(connections(db, 'Item').length, 'scan must not register').to.equal(baseline);

				await committedTable.disconnect();
				expect(connections(db, 'Item').length, 'disconnect must not unregister the writer').to.equal(baseline);
			} finally {
				db.close();
			}
		});

		it('first-EVER touch of a table as a committed read works and registers nothing', async () => {
			const storage = new MemoryRawStorage();
			const shared = buildSharedLocalTransactor(storage);

			const dbA = new Database();
			registerWithSharedTransactor(dbA, shared);
			await dbA.exec(`create table Item (id integer primary key, cat text) using optimystic('tree://iso/firsttouch')`);
			await dbA.exec(`insert into Item (id, cat) values (1, 'a'), (2, 'b'), (3, 'a')`);

			// Fresh Database over the same storage: catalog hydrated, table never touched
			// (the module's table cache is empty), so this committed read initializes the
			// table from scratch — and still must not register a connection.
			const dbB = new Database();
			const pluginB = registerWithSharedTransactor(dbB, shared);
			await pluginB.hydrate(dbB);
			try {
				expect(connections(dbB, 'Item').length).to.equal(0);
				expect(await scalar(dbB, `select count(*) as v from committed.Item`)).to.equal(3);
				expect(connections(dbB, 'Item').length, 'committed first touch must not register').to.equal(0);

				// A live read on the same table DOES register — the contrast proves the
				// committed path (not some global behavior) is what skipped registration.
				expect(await scalar(dbB, `select count(*) as v from Item`)).to.equal(3);
				expect(connections(dbB, 'Item').length).to.be.greaterThan(0);
			} finally {
				dbA.close();
				dbB.close();
			}
		});
	});

	describe('single-moment committed views (index-driven vs full scan)', () => {
		it('two concurrent hand-driven committed scans agree and ignore a mid-scan external commit', async () => {
			const storage = new MemoryRawStorage();
			const shared = buildSharedLocalTransactor(storage);

			const dbA = new Database();
			const pluginA = registerWithSharedTransactor(dbA, shared);
			await dbA.exec(`create table Item (id integer primary key, cat text) using optimystic('tree://iso/agree')`);
			await dbA.exec(`create index idx_cat on Item (cat)`);
			const seed: string[] = [];
			for (let id = 1; id <= 40; id++) {
				seed.push(`(${id}, '${id % 2 === 0 ? 'a' : 'b'}')`);
			}
			await dbA.exec(`insert into Item (id, cat) values ${seed.join(', ')}`);
			const committedAIds = Array.from({ length: 40 }, (_, i) => i + 1).filter(id => id % 2 === 0);

			const dbB = new Database();
			const pluginB = registerWithSharedTransactor(dbB, shared);
			await pluginB.hydrate(dbB);

			try {
				// An in-flight staged row on the writer exercises the pre-stage-snapshot arm
				// of committedTreeView for BOTH the main tree and the index tree.
				await dbA.exec('begin');
				await dbA.exec(`insert into Item (id, cat) values (100000, 'a')`);

				const committedTable = await connectCommitted(dbA, pluginA, 'Item');
				// idx=<name>(...);plan=2 routes executeIndexScan; args seek cat='a'.
				const indexIter = committedTable.query(filterInfo('idx=idx_cat(0);plan=2', ['a']))[Symbol.asyncIterator]();
				const scanIter = committedTable.query(filterInfo(null))[Symbol.asyncIterator]();

				// Pull one row from each so both scans have pinned their views and stand
				// mid-iteration, interleaved with each other.
				const indexRows: VtabRow[] = [];
				const scanRows: VtabRow[] = [];
				const firstIndex = await indexIter.next();
				const firstScan = await scanIter.next();
				expect(firstIndex.done).to.equal(false);
				expect(firstScan.done).to.equal(false);
				indexRows.push(firstIndex.value as VtabRow);
				scanRows.push(firstScan.value as VtabRow);

				// Mid-scan external commit: new cat='a' rows ahead of both frontiers, plus
				// deletion of a committed cat='a' row neither scan has reached ('9…' keys
				// sort last lexicographically). Then a LIVE read on the writer folds that
				// commit into the shared cache (collection.update()) — the cache-clearing
				// interleave the pinned views must survive.
				await dbB.exec(`insert into Item (id, cat) values (997, 'a'), (998, 'a'), (999, 'a')`);
				await dbB.exec(`delete from Item where id = 38`);
				// Run a LIVE read on the writer so its scan path executes
				// collection.update() with the external commit outstanding — the
				// cache-interleave pressure the pinned committed views must survive. The
				// VALUE is deliberately not asserted: how a live in-transaction read folds
				// (or defers) a concurrent external commit is transaction-visibility
				// semantics outside this ticket's scope.
				await scalar(dbA, `select count(*) as v from Item where id < 100000`);

				// Drain both scans, still interleaved row-by-row.
				let ir = await indexIter.next();
				let sr = await scanIter.next();
				while (!ir.done || !sr.done) {
					if (!ir.done) { indexRows.push(ir.value as VtabRow); ir = await indexIter.next(); }
					if (!sr.done) { scanRows.push(sr.value as VtabRow); sr = await scanIter.next(); }
				}
				await dbA.exec('rollback');

				// Positional columns: Item is (id, cat) → row[0] = id, row[1] = cat.
				// Full scan: exactly the 40 committed rows — id 38 still present, no
				// 997..999, no in-flight 100000.
				const scanIds = scanRows.map(r => Number(r[0])).sort((x, y) => x - y);
				expect(scanIds).to.deep.equal(Array.from({ length: 40 }, (_, i) => i + 1));

				// Index-driven: exactly the committed cat='a' set, agreeing row-for-row
				// with the full scan of the same nominal snapshot filtered to cat='a'.
				const indexIds = indexRows.map(r => Number(r[0])).sort((x, y) => x - y);
				expect(indexIds).to.deep.equal(committedAIds);
				const scanAIds = scanRows.filter(r => r[1] === 'a').map(r => Number(r[0])).sort((x, y) => x - y);
				expect(indexIds).to.deep.equal(scanAIds);
			} finally {
				dbA.close();
				dbB.close();
			}
		});
	});

	describe('committed point lookup and range scan', () => {
		it('composite-PK point lookup and range scan read the committed view, excluding staged rows', async () => {
			const { db, plugin } = createTestDb();
			try {
				await db.exec(`
					create table CPK (
						a text,
						b integer,
						v text,
						primary key (a, b)
					) using optimystic('tree://iso/cpk')
				`);
				await db.exec(`insert into CPK (a, b, v) values ('x', 1, 'one'), ('x', 2, 'two'), ('y', 1, 'three')`);

				await db.exec('begin');
				await db.exec(`insert into CPK (a, b, v) values ('x', 3, 'staged')`);

				const committedTable = await connectCommitted(db, plugin, 'CPK');

				// Positional columns: CPK is (a, b, v) → row[2] = v.
				// plan=2 with full-PK args → executePointLookup on the committed view.
				const hit = await drain(committedTable.query(filterInfo('idx=_primary_(0);plan=2', ['x', 2])));
				expect(hit.length).to.equal(1);
				expect(hit[0]![2]).to.equal('two');

				// The staged row's key resolves to nothing on the committed view.
				const staged = await drain(committedTable.query(filterInfo('idx=_primary_(0);plan=2', ['x', 3])));
				expect(staged.length).to.equal(0);

				// plan=3 (range) → executeRangeQuery, currently a full scan: all three
				// committed rows, never the staged one.
				const range = await drain(committedTable.query(filterInfo('idx=_primary_(0);plan=3')));
				expect(range.map(r => r[2]).sort()).to.deep.equal(['one', 'three', 'two']);

				await db.exec('rollback');
			} finally {
				db.close();
			}
		});
	});

	describe('degraded latch after a partial commit', () => {
		let dir: string;

		beforeEach(async () => {
			dir = path.join(os.tmpdir(), 'optimystic-committed-read-isolation', randomUUID());
			await fs.mkdir(dir, { recursive: true });
		});

		afterEach(async () => {
			await fs.rm(dir, { recursive: true, force: true });
		});

		/** Injected transactor failing the SECOND tree's commit (mirrors
		 * legacy-commit-atomicity.spec.ts) so the sweep splits: main table persisted,
		 * index not → PartialCommitError. */
		function createDbWithSecondTreeFailure() {
			const db = new Database();
			const config = {
				default_transactor: 'local',
				default_key_network: 'test',
				enable_cache: false,
				rawStorageFactory: () => new FileRawStorage(dir),
			} as unknown as Record<string, SqlValue>;
			const plugin = register(db, config);

			const rawStorage = new FileRawStorage(dir);
			const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));
			let armed = false;
			let firstTail: string | undefined;
			let tripped = false;
			const transactor = {
				async get(blockGets: unknown) { return storageRepo.get(blockGets as never); },
				async getStatus(_refs: unknown) { throw new Error('getStatus not implemented'); },
				async pend(request: unknown) { return storageRepo.pend(request as never); },
				async commit(request: unknown) {
					if (armed && !tripped) {
						const tail = (request as { tailId: string }).tailId;
						if (firstTail === undefined) {
							firstTail = tail;
						} else if (tail !== firstTail) {
							tripped = true;
							throw new Error('injected commit failure (second tree)');
						}
					}
					return storageRepo.commit(request as never);
				},
				async cancel(trxRef: unknown) { return storageRepo.cancel(trxRef as never); },
				onCollectionChange: storageRepo.onCollectionChange.bind(storageRepo),
			};
			plugin.collectionFactory.registerTransactor('local:test', transactor as unknown as ITransactor);
			for (const vtable of plugin.vtables) {
				db.registerModule(vtable.name, vtable.module, vtable.auxData);
			}
			for (const func of plugin.functions) {
				db.registerFunction(func.schema);
			}
			return {
				db,
				plugin,
				arm() { armed = true; firstTail = undefined; tripped = false; },
				disarm() { armed = false; },
			};
		}

		async function forcePartialCommit(harness: ReturnType<typeof createDbWithSecondTreeFailure>): Promise<void> {
			const { db } = harness;
			await db.exec(`create table Item (id integer primary key, cat text) using optimystic('tree://iso/degraded')`);
			await db.exec(`create index idx_cat on Item (cat)`);
			await db.exec(`insert into Item (id, cat) values (1, 'a')`);

			harness.arm();
			const err = await captureThrow(() => db.exec(`insert into Item (id, cat) values (2, 'b')`));
			harness.disarm();
			expect(String((err as Error)?.message ?? err).toLowerCase()).to.contain('not atomic');
			expect(harness.plugin.txnBridge.isDegraded(), 'bridge must latch degraded').to.equal(true);
		}

		it('committed reads throw (naming the split trees) while latched; live reads still answer; a clean COMMIT clears it', async () => {
			const harness = createDbWithSecondTreeFailure();
			const { db, plugin } = harness;
			try {
				await forcePartialCommit(harness);

				// Committed read refuses with the persisted/unpersisted split in the message.
				const err = await captureThrow(() => scalar(db, `select count(*) as v from committed.Item`));
				const message = String((err as Error)?.message ?? err);
				expect(message).to.match(/partially-committed state/);
				expect(message).to.match(/Persisted/);
				expect(message).to.match(/Not persisted/);

				// Live reads are unaffected: the main tree durably committed row 2 and the
				// live view honestly mirrors that.
				expect(await scalar(db, `select count(*) as v from Item`)).to.equal(2);

				// The next SUCCESSFUL commit clears the latch and committed reads answer.
				await db.exec(`insert into Item (id, cat) values (3, 'c')`);
				expect(plugin.txnBridge.isDegraded()).to.equal(false);
				expect(await scalar(db, `select count(*) as v from committed.Item`)).to.equal(3);
			} finally {
				db.close();
			}
		});

		it('a clean ROLLBACK also clears the latch', async () => {
			const harness = createDbWithSecondTreeFailure();
			const { db, plugin } = harness;
			try {
				await forcePartialCommit(harness);
				expect(plugin.txnBridge.isDegraded()).to.equal(true);

				await db.exec('begin');
				await db.exec(`insert into Item (id, cat) values (10, 'z')`);
				await db.exec('rollback');

				expect(plugin.txnBridge.isDegraded()).to.equal(false);
				expect(await scalar(db, `select count(*) as v from committed.Item`)).to.equal(2);
			} finally {
				db.close();
			}
		});
	});
});
