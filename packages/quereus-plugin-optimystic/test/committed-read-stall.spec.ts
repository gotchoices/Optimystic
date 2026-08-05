/**
 * Proof B for ticket `committed-read-snapshot-declaration`: a committed
 * (`readConcurrency: 'committed'` / `_readCommitted`) read must answer PROMPTLY and
 * from ONE coherent pre-commit boundary while a write to the same table is parked
 * against an unresponsive commit cohort — in BOTH commit modes.
 *
 * The stall is a delegating transactor (test/commit-gate.ts) whose commit-side
 * calls (`pend`/`commit`) await a test-controlled gate; `get` passes straight
 * through. Unlike Quereus's `installCommitStall` (which parks at the ENTRY of a
 * registered connection's commit, BEFORE this plugin's publish begins), this gate
 * parks INSIDE the publish window — including between tree N and tree N+1 of the
 * legacy multi-tree sweep, the arm the engine-shipped harness cannot reach.
 *
 * Promptness is asserted with `settleMacrotasks` (bounded event-loop turns), never
 * a wall-clock timeout: a read that would queue behind the parked writer's exec
 * mutex does not resolve in bounded turns, so the promptness assertion doubles as
 * proof that the engine actually routed the read onto the mutex-free path.
 */
import { expect } from 'chai';
import { Database, settleMacrotasks } from '@quereus/quereus';
import type { SqlValue, FilterInfo } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import { TransactionCoordinator } from '@optimystic/db-core';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { QuereusEngine } from '../dist/index.js';
import { CommitGate, gateTransactor, type GateTransactorOptions } from './commit-gate.js';

type Plugin = ReturnType<typeof register>;
type VtabRow = readonly SqlValue[];

/** Options that resolve to the transactor cache key `local:test` (see registerTransactor). */
function localOptions() {
	return {
		collectionUri: 'tree://unused',
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
	};
}

/** One in-memory StorageRepo-backed transactor, shareable across Databases. */
function buildInnerTransactor(storage: MemoryRawStorage): ITransactor {
	const repo = new StorageRepo((blockId) => new BlockStorage(blockId, storage));
	return {
		async get(blockGets) { return await repo.get(blockGets); },
		async getStatus(_refs) { throw new Error('getStatus not implemented in test transactor'); },
		async pend(request) { return await repo.pend(request); },
		async commit(request) { return await repo.commit(request); },
		async cancel(trxRef) { return await repo.cancel(trxRef); },
	} as ITransactor;
}

/** Fresh Database whose `local:test` transactor is `transactor` (usually gated). */
function createDbWith(transactor: ITransactor): { db: Database; plugin: Plugin } {
	const db = new Database();
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
	return { db, plugin };
}

/** Wire session (coordinator/consensus) mode over the plugin's cached `local:test`
 * transactor — which is the GATED one, so the coordinator's pend/commit park. */
async function enableSessionMode(db: Database, plugin: Plugin): Promise<() => void> {
	const transactor = await plugin.collectionFactory.getOrCreateTransactor(localOptions());
	const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(db, coordinator);
	await engine.getSchemaHash();
	plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
	return () => engine.dispose();
}

/** Await `p`, failing loudly if it does not resolve within `macrotasks` event-loop
 * turns — the bounded-turns promptness check (never wall-clock). */
async function expectPrompt<T>(p: Promise<T>, label: string, macrotasks = 200): Promise<T> {
	const outcome = await Promise.race([
		p.then(
			(v) => ({ state: 'resolved' as const, v }),
			(e) => ({ state: 'rejected' as const, e }),
		),
		settleMacrotasks(macrotasks).then(() => ({ state: 'pending' as const })),
	]);
	if (outcome.state === 'pending') {
		throw new Error(`${label}: did not settle within ${macrotasks} macrotask turns while the commit was parked`);
	}
	if (outcome.state === 'rejected') {
		throw outcome.e instanceof Error ? outcome.e : new Error(String(outcome.e));
	}
	return outcome.v;
}

/** Track settlement of a promise without consuming its rejection. */
function trackSettled(p: Promise<unknown>): () => boolean {
	let settled = false;
	p.then(() => { settled = true; }, () => { settled = true; });
	return () => settled;
}

async function rows(db: Database, sql: string, committed = false): Promise<Array<Record<string, SqlValue>>> {
	const out: Array<Record<string, SqlValue>> = [];
	const iter = committed
		? db.eval(sql, undefined, { readConcurrency: 'committed' })
		: db.eval(sql);
	for await (const row of iter) {
		out.push(row as Record<string, SqlValue>);
	}
	return out;
}

function collectRows(db: Database, sql: string, committed = false): Promise<Array<Record<string, SqlValue>>> {
	return rows(db, sql, committed);
}

async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected operation to throw, but it resolved');
}

/** Hand-driven committed connect + query surface (mirrors committed-read-isolation.spec.ts). */
interface HandDrivenTable {
	query(filterInfo: FilterInfo): AsyncIterable<VtabRow>;
	disconnect(): Promise<void>;
}
async function connectCommitted(db: Database, plugin: Plugin, tableName: string): Promise<HandDrivenTable> {
	const module = plugin.vtables[0]!.module as unknown as {
		connect(db: Database, pAux: unknown, mod: string, schema: string, table: string, opts: Record<string, unknown>): Promise<HandDrivenTable>;
	};
	return module.connect(db, null, 'optimystic', 'main', tableName, { _readCommitted: true });
}
function filterInfo(idxStr: string | null, args: SqlValue[] = [], idxNum = 0): FilterInfo {
	return { idxNum, idxStr, args, constraints: [], indexInfoOutput: {} } as unknown as FilterInfo;
}
async function drain(iter: AsyncIterable<VtabRow>): Promise<VtabRow[]> {
	const out: VtabRow[] = [];
	for await (const row of iter) out.push(row);
	return out;
}

/** Seed `count` rows (id 1..count, cat 'a'/'b' alternating) into `table`. */
async function seedRows(db: Database, table: string, count: number): Promise<void> {
	const values: string[] = [];
	for (let id = 1; id <= count; id++) {
		values.push(`(${id}, '${id % 2 === 0 ? 'a' : 'b'}')`);
	}
	await db.exec(`insert into ${table} (id, cat) values ${values.join(', ')}`);
}

const SEED = 40;
const seededCats = (): string[] => Array.from({ length: SEED }, (_, i) => ((i + 1) % 2 === 0 ? 'a' : 'b'));

describe('Committed reads under a stalled commit (proof B)', function () {
	this.timeout(30_000);

	/** Build the gated single-Database harness for one test. */
	function makeHarness(gateOptions?: GateTransactorOptions) {
		const storage = new MemoryRawStorage();
		const inner = buildInnerTransactor(storage);
		const gate = new CommitGate();
		const gated = gateTransactor(inner, gate, gateOptions);
		const { db, plugin } = createDbWith(gated);
		return { storage, inner, gate, db, plugin };
	}

	describe('session mode (coordinator consensus commit)', () => {
		it('answers promptly with pre-write values while the commit is parked; full scan and index-driven scan agree; fresh read sees post-write after release', async () => {
			const h = makeHarness();
			let dispose: (() => void) | undefined;
			let writer: Promise<void> | undefined;
			try {
				await h.db.exec(`create table Store (id integer primary key, cat text) using optimystic('tree://stall/session')`);
				await h.db.exec(`create index idx_cat on Store (cat)`);
				await seedRows(h.db, 'Store', SEED);
				dispose = await enableSessionMode(h.db, h.plugin);
				expect(h.plugin.txnBridge.isTransactionModeEnabled()).to.equal(true);

				h.gate.arm();
				writer = h.db.exec(`update Store set cat = 'z'`);
				const writerSettled = trackSettled(writer);
				await h.gate.entered;

				// Engine-level committed full scan: MUST resolve in bounded turns (the
				// serialized path would queue behind the parked writer's exec mutex) and
				// MUST show only pre-write values.
				const scan = await expectPrompt(
					collectRows(h.db, 'select id, cat from Store order by id', true),
					'committed full scan during session-commit stall',
				);
				expect(scan.map(r => r.cat)).to.deep.equal(seededCats());
				expect(writerSettled(), 'writer must still be parked after the read').to.equal(false);

				// Index-driven committed scan (hand-driven so the access path is certain)
				// must agree row-for-row with the full scan's cat='a' subset.
				const committedTable = await connectCommitted(h.db, h.plugin, 'Store');
				const indexRows = await expectPrompt(
					drain(committedTable.query(filterInfo('idx=idx_cat(0);plan=2', ['a']))),
					'committed index-driven scan during session-commit stall',
				);
				const indexIds = indexRows.map(r => Number(r[0])).sort((x, y) => x - y);
				const scanAIds = scan.filter(r => r.cat === 'a').map(r => Number(r.id)).sort((x, y) => x - y);
				expect(indexIds).to.deep.equal(scanAIds);
				expect(writerSettled(), 'writer must still be parked after both reads').to.equal(false);

				h.gate.release();
				await writer;

				const fresh = await collectRows(h.db, 'select id, cat from Store order by id');
				expect(fresh.map(r => r.cat)).to.deep.equal(Array.from({ length: SEED }, () => 'z'));
				// And a committed read now serves the post-write state too (no permanent pin).
				const freshCommitted = await collectRows(h.db, 'select id, cat from Store order by id', true);
				expect(freshCommitted.map(r => r.cat)).to.deep.equal(Array.from({ length: SEED }, () => 'z'));
			} finally {
				h.gate.release();
				await writer?.catch(() => { });
				dispose?.();
				h.db.close();
			}
		});

		it('a stalled commit that then FAILS cleanly: reads taken during the stall stay correct after the rollback; no degraded latch', async () => {
			const h = makeHarness();
			let dispose: (() => void) | undefined;
			let writer: Promise<void> | undefined;
			try {
				await h.db.exec(`create table Acct (id integer primary key, cat text) using optimystic('tree://stall/sessionfail')`);
				await seedRows(h.db, 'Acct', SEED);
				dispose = await enableSessionMode(h.db, h.plugin);

				h.gate.arm();
				writer = h.db.exec(`update Acct set cat = 'z'`);
				await h.gate.entered;

				const during = await expectPrompt(
					collectRows(h.db, 'select id, cat from Acct order by id', true),
					'committed read during stall',
				);
				expect(during.map(r => r.cat)).to.deep.equal(seededCats());

				// The cohort answers with a FAILURE instead of an ack.
				h.gate.releaseWithError(new Error('injected cohort failure'));
				await captureThrow(() => writer!);

				// Nothing durably committed → clean rollback: the rows the stall-window
				// reads showed are exactly what the store still holds, and the latch is off.
				expect(h.plugin.txnBridge.isDegraded()).to.equal(false);
				const after = await collectRows(h.db, 'select id, cat from Acct order by id', true);
				expect(after.map(r => r.cat)).to.deep.equal(seededCats());
				const live = await collectRows(h.db, 'select id, cat from Acct order by id');
				expect(live.map(r => r.cat)).to.deep.equal(seededCats());
			} finally {
				h.gate.release();
				await writer?.catch(() => { });
				dispose?.();
				h.db.close();
			}
		});
	});

	describe('legacy mode (tree-by-tree sweep, no coordinator)', () => {
		it('MID-SWEEP stall (main table flushed, index parked): committed reads still show the pre-transaction boundary and agree across access paths', async () => {
			// gateOn 'commit' + skipCalls 1: tree 1 of the sweep (the main table) pends
			// AND commits — durably flushed and folded into the live tree — then tree 2
			// (the index) parks at its commit. This is the window where an unpinned
			// committed view tears: the main tree's context has advanced past the index's.
			// The snapshot-boundary pin (CollectionSnapshot.context) is what holds it.
			const h = makeHarness({ gateOn: 'commit', skipCalls: 1 });
			let writer: Promise<void> | undefined;
			try {
				await h.db.exec(`create table Item (id integer primary key, cat text) using optimystic('tree://stall/legacy')`);
				await h.db.exec(`create index idx_cat on Item (cat)`);
				await seedRows(h.db, 'Item', SEED);

				h.gate.arm();
				writer = h.db.exec(`update Item set cat = 'z'`);
				const writerSettled = trackSettled(writer);
				await h.gate.entered;

				// Full scan: none of the already-flushed main tree's rewritten rows may show.
				const scan = await expectPrompt(
					collectRows(h.db, 'select id, cat from Item order by id', true),
					'committed full scan during mid-sweep stall',
				);
				expect(scan.map(r => r.cat)).to.deep.equal(seededCats());
				expect(writerSettled()).to.equal(false);

				// Index-driven scan agrees row-for-row with the full scan's cat='a' subset.
				const committedTable = await connectCommitted(h.db, h.plugin, 'Item');
				const indexRows = await expectPrompt(
					drain(committedTable.query(filterInfo('idx=idx_cat(0);plan=2', ['a']))),
					'committed index scan during mid-sweep stall',
				);
				const indexIds = indexRows.map(r => Number(r[0])).sort((x, y) => x - y);
				const scanAIds = scan.filter(r => r.cat === 'a').map(r => Number(r.id)).sort((x, y) => x - y);
				expect(indexIds).to.deep.equal(scanAIds);

				h.gate.release();
				await writer;
				const fresh = await collectRows(h.db, 'select id, cat from Item order by id', true);
				expect(fresh.map(r => r.cat)).to.deep.equal(Array.from({ length: SEED }, () => 'z'));
			} finally {
				h.gate.release();
				await writer?.catch(() => { });
				h.db.close();
			}
		});

		it('stall at the FIRST tree released into an error: clean rollback, reads stay pre-write, no latch', async () => {
			const h = makeHarness({ gateOn: 'commit' });
			let writer: Promise<void> | undefined;
			try {
				// No index: single tree, so the failure hits before anything persisted.
				await h.db.exec(`create table Solo (id integer primary key, cat text) using optimystic('tree://stall/legacyfail')`);
				await seedRows(h.db, 'Solo', SEED);

				h.gate.arm();
				writer = h.db.exec(`update Solo set cat = 'z'`);
				await h.gate.entered;

				const during = await expectPrompt(
					collectRows(h.db, 'select id, cat from Solo order by id', true),
					'committed read during first-tree stall',
				);
				expect(during.map(r => r.cat)).to.deep.equal(seededCats());

				h.gate.releaseWithError(new Error('injected cohort failure'));
				const err = await captureThrow(() => writer!);
				expect(String((err as Error)?.message ?? err).toLowerCase()).to.not.contain('not atomic');

				expect(h.plugin.txnBridge.isDegraded()).to.equal(false);
				const after = await collectRows(h.db, 'select id, cat from Solo order by id', true);
				expect(after.map(r => r.cat)).to.deep.equal(seededCats());
			} finally {
				h.gate.release();
				await writer?.catch(() => { });
				h.db.close();
			}
		});

		it('a mid-sweep stall that ends in a PARTIAL commit: reads answer during the stall, then REFUSE once the store is split', async () => {
			const h = makeHarness({ gateOn: 'commit', skipCalls: 1 });
			let writer: Promise<void> | undefined;
			try {
				await h.db.exec(`create table Split (id integer primary key, cat text) using optimystic('tree://stall/partial')`);
				await h.db.exec(`create index idx_cat on Split (cat)`);
				await seedRows(h.db, 'Split', SEED);

				h.gate.arm();
				writer = h.db.exec(`update Split set cat = 'z'`);
				await h.gate.entered;

				// During the stall the store is not yet split — reads answer, pre-write.
				const during = await expectPrompt(
					collectRows(h.db, 'select id, cat from Split order by id', true),
					'committed read during pre-split stall',
				);
				expect(during.map(r => r.cat)).to.deep.equal(seededCats());

				// The parked SECOND tree's commit fails: main persisted, index not → a
				// durable split, surfaced as PartialCommitError and latched.
				h.gate.releaseWithError(new Error('injected cohort failure'));
				const err = await captureThrow(() => writer!);
				expect(String((err as Error)?.message ?? err).toLowerCase()).to.contain('not atomic');
				expect(h.plugin.txnBridge.isDegraded()).to.equal(true);

				// Committed reads now REFUSE (the degraded latch), naming the split.
				const refusal = await captureThrow(() => collectRows(h.db, 'select id, cat from Split order by id', true));
				expect(String((refusal as Error)?.message ?? refusal)).to.match(/partially-committed state/);

				// A later clean commit clears the latch and reads answer again.
				await h.db.exec(`insert into Split (id, cat) values (${SEED + 1}, 'c')`);
				expect(h.plugin.txnBridge.isDegraded()).to.equal(false);
				const after = await collectRows(h.db, `select count(*) as v from Split`, true);
				expect(Number(after[0]!.v)).to.equal(SEED + 1);
			} finally {
				h.gate.release();
				await writer?.catch(() => { });
				h.db.close();
			}
		});

		it('a committed read of a DIFFERENT table answers promptly while table A’s commit is parked', async () => {
			const h = makeHarness();
			let writer: Promise<void> | undefined;
			try {
				await h.db.exec(`create table TabA (id integer primary key, cat text) using optimystic('tree://stall/taba')`);
				await h.db.exec(`create table TabB (id integer primary key, cat text) using optimystic('tree://stall/tabb')`);
				await seedRows(h.db, 'TabA', SEED);
				await seedRows(h.db, 'TabB', SEED);

				h.gate.arm();
				writer = h.db.exec(`update TabA set cat = 'z'`);
				await h.gate.entered;

				const scanB = await expectPrompt(
					collectRows(h.db, 'select id, cat from TabB order by id', true),
					'committed read of an unrelated table during the stall',
				);
				expect(scanB.map(r => r.cat)).to.deep.equal(seededCats());
			} finally {
				h.gate.release();
				await writer?.catch(() => { });
				h.db.close();
			}
		});

		it('a committed read STARTED during the stall and finished after the commit lands still serves the pinned pre-commit rows', async () => {
			const h = makeHarness({ gateOn: 'commit', skipCalls: 1 });
			let writer: Promise<void> | undefined;
			try {
				await h.db.exec(`create table Long (id integer primary key, cat text) using optimystic('tree://stall/outlive')`);
				await h.db.exec(`create index idx_cat on Long (cat)`);
				await seedRows(h.db, 'Long', SEED);

				h.gate.arm();
				writer = h.db.exec(`update Long set cat = 'z'`);
				await h.gate.entered;

				// Start the scan mid-stall and pull ONE row, leaving it mid-iteration.
				const committedTable = await connectCommitted(h.db, h.plugin, 'Long');
				const iter = committedTable.query(filterInfo(null))[Symbol.asyncIterator]();
				const first = await expectPrompt(iter.next(), 'first pull during stall');
				expect(first.done).to.equal(false);
				const collected: VtabRow[] = [first.value as VtabRow];

				// Release, let the commit COMPLETE, then finish the scan: every remaining
				// row must still come from the pinned pre-commit boundary. (Tree order is
				// encoded-key order, not numeric id order — sort by id before comparing.)
				h.gate.release();
				await writer;
				for (let r = await iter.next(); !r.done; r = await iter.next()) {
					collected.push(r.value as VtabRow);
				}
				const byId = collected
					.map(row => ({ id: Number(row[0]), cat: row[1] }))
					.sort((x, y) => x.id - y.id);
				expect(byId.map(r => r.cat)).to.deep.equal(seededCats());

				// The NEXT committed scan serves the post-commit state.
				const fresh = await collectRows(h.db, 'select id, cat from Long order by id', true);
				expect(fresh.map(r => r.cat)).to.deep.equal(Array.from({ length: SEED }, () => 'z'));
			} finally {
				h.gate.release();
				await writer?.catch(() => { });
				h.db.close();
			}
		});

		it('a COLD-CACHE committed read (fresh Database, first touch) during a stall fetches blocks through the ungated read path', async () => {
			// Two Databases over ONE storage, both behind the same gate: dbA's writer
			// parks; dbB — whose module cache and block cache have never seen the table —
			// runs a committed first-touch read. Every block faults through `get`, which
			// the gate never covers, so the read must be prompt AND must register nothing.
			const storage = new MemoryRawStorage();
			const inner = buildInnerTransactor(storage);
			const gate = new CommitGate();
			const a = createDbWith(gateTransactor(inner, gate));
			const b = createDbWith(gateTransactor(inner, gate));
			let writer: Promise<void> | undefined;
			try {
				await a.db.exec(`create table Cold (id integer primary key, cat text) using optimystic('tree://stall/cold')`);
				await seedRows(a.db, 'Cold', SEED);
				await b.plugin.hydrate(b.db);

				gate.arm();
				writer = a.db.exec(`update Cold set cat = 'z'`);
				await gate.entered;

				const scan = await expectPrompt(
					collectRows(b.db, 'select id, cat from Cold order by id', true),
					'cold-cache committed first-touch read during the stall',
					// First touch initializes the table (schema + collection opens) before
					// scanning ~40 faulted blocks; give it more turns than a warm read.
					2000,
				);
				expect(scan.map(r => r.cat)).to.deep.equal(seededCats());
				const connections = (b.db as unknown as {
					getConnectionsForTable(t: string): ReadonlyArray<unknown>;
				}).getConnectionsForTable('Cold');
				expect(connections.length, 'committed first touch must not register a connection').to.equal(0);
			} finally {
				gate.release();
				await writer?.catch(() => { });
				a.db.close();
				b.db.close();
			}
		});
	});

	describe('first-touch committed read while a writer transaction is OPEN (provisional initialization)', () => {
		it('leaves the bridge’s transaction state and collection registry untouched, then upgrades on the next quiescent touch', async () => {
			const storage = new MemoryRawStorage();
			const inner = buildInnerTransactor(storage);
			// No gate needed: the hazard is the OPEN transaction, not a stall.
			const a = createDbWith(inner);
			const b = createDbWith(inner);
			try {
				await a.db.exec(`create table Warm (id integer primary key, cat text) using optimystic('tree://stall/warm')`);
				await a.db.exec(`create table Frozen (id integer primary key, cat text) using optimystic('tree://stall/frozen')`);
				await seedRows(a.db, 'Warm', 4);
				await seedRows(a.db, 'Frozen', 4);
				await b.plugin.hydrate(b.db);

				// Open a writer transaction on dbB touching Warm only. Frozen stays COLD
				// in dbB's module cache.
				await b.db.exec('begin');
				await b.db.exec(`insert into Warm (id, cat) values (100, 'w')`);
				expect(b.plugin.txnBridge.isTransactionActive()).to.equal(true);

				const registry = b.plugin.txnBridge.getCollectionRegistry();
				const frozenId = b.plugin.collectionFactory.getCollectionId({ ...localOptions(), collectionUri: 'tree://stall/frozen' });
				const registrySizeBefore = registry.size;
				const txnCollectionsBefore = b.plugin.txnBridge.getCurrentTransaction()!.collections.size;

				// First-EVER touch of Frozen on dbB, as a committed read, mid-transaction.
				const scan = await collectRows(b.db, 'select id, cat from committed.Frozen order by id');
				expect(scan.length).to.equal(4);

				// The provisional initialization must have joined NOTHING:
				expect(registry.has(frozenId), 'bridge registry must not gain the cold table').to.equal(false);
				expect(registry.size).to.equal(registrySizeBefore);
				expect(b.plugin.txnBridge.getCurrentTransaction()!.collections.size, 'writer txn collection cache untouched').to.equal(txnCollectionsBefore);
				const connections = (b.db as unknown as {
					getConnectionsForTable(t: string): ReadonlyArray<unknown>;
				}).getConnectionsForTable('Frozen');
				expect(connections.length).to.equal(0);

				await b.db.exec('commit');

				// Next LIVE touch upgrades to a full initialization: registry gains the table.
				const live = await collectRows(b.db, 'select id, cat from Frozen order by id');
				expect(live.length).to.equal(4);
				expect(registry.has(frozenId), 'live touch completes registration').to.equal(true);
			} finally {
				a.db.close();
				b.db.close();
			}
		});
	});
});
