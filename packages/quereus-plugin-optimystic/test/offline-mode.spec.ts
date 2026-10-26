/**
 * Offline mode at the SQL level (docs/offline-sync.md §Application interface): entering and leaving
 * the mode, a commit sealed into the queue instead of reaching storage, the statuses the plugin
 * reports under the transaction's `StampId()`, and the durability report a drained entry produces.
 * The queue's own behaviour is pinned in `packages/db-core/test/offline-queue.spec.ts`; these cases
 * assert what an application observes through `plugin.offline` and the two nodes' rows.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`), both responsible for every block, at a
 * super-majority of two. Node B is made unreachable for cluster (write) rounds through
 * `mesh.failures.failingPeers`: a commit A drives then meets a promise shortfall, which the drain
 * sorts as `cohort-unreachable` and re-checks on its timer (shortened through `offline.recheck`).
 *
 * Not pinned here, and why: `expireAfterMs` reached while unreachable. These cases register no
 * reachability gate, so the drain sends the head at once; the first attempt puts the entry in doubt
 * (it is sent, and a shortfall does not clear doubt — `OfflineQueue.recordAttempts`), and an entry in
 * doubt is neither expired nor discardable. The gate is what keeps an entry unsent, and so expirable,
 * while the cohort is unreachable: `offline-mode-two-machine.spec.ts` pins the expiry over the node's
 * real gate.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { TransactionCoordinator, Tree } from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';
import type { Mesh } from '@optimystic/db-p2p/testing';
import register from '../dist/plugin.js';
import {
	EntryNotDiscardableError, OfflineModeRefusedError, QuereusEngine, SessionModeRefusedError,
	type OfflineModeState, type ParsedOptimysticTreeOptions as ParsedOptimysticOptions, type QueuedTransactionStatus,
	type SqlCommitDurability,
} from '../dist/index.js';
import { countTreeEntries, createMeshDbNode, startMockMesh, type MeshDbNode, type Plugin } from './mesh-node-harness.js';
import { expectIndexAgreesWithScan } from './query-helpers.js';

type Row = Record<string, SqlValue>;
type QueuedStatus = Extract<QueuedTransactionStatus, { kind: 'queued' }>;
type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

/** The drain's re-check timer, shortened so a reconnect is noticed within a test's patience. */
const offlineConfig = { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>;

const NOTES_URI = 'tree://offline/notes';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;

interface TwoNodes {
	mesh: Mesh;
	a: MeshDbNode;
	b: MeshDbNode;
	/** Every status node A's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
	/** Every durability report node A's plugin delivered, in order. */
	reports: SqlCommitDurability[];
}

async function twoNodes(): Promise<TwoNodes> {
	const { mesh, transactorFor } = await startMockMesh(2);
	const a = createMeshDbNode(transactorFor(0), offlineConfig);
	const b = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	a.plugin.offline.onStatus(status => { statuses.push(status); });
	const reports: SqlCommitDurability[] = [];
	a.plugin.onCommitDurability(report => { reports.push(report); });
	return { mesh, a, b, statuses, reports };
}

/** Node B stops answering cluster (write) rounds: a commit A drives meets a promise shortfall. */
function severB(mesh: Mesh): void {
	mesh.failures.failingPeers = new Set([mesh.nodes[1]!.peerId.toString()]);
}

function restoreB(mesh: Mesh): void {
	mesh.failures.failingPeers = undefined;
}

const kindsOf = (statuses: readonly QueuedTransactionStatus[], transactionId: string): string[] =>
	statuses.filter(status => status.transactionId === transactionId).map(status => status.kind);

async function collect(db: Database, sql: string): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of db.eval(sql)) rows.push(row as Row);
	return rows;
}

async function stampIdOf(db: Database): Promise<string> {
	const row = await db.prepare('select StampId() as stamp_id').get() as { stamp_id: string };
	return row.stamp_id;
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

/** A `Database` over the in-memory test transactor, for the cases that need no second node. */
function createTestDb(): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, { default_transactor: 'test', default_key_network: 'test', enable_cache: false });
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	return { db, plugin };
}

/** Wire session mode over the bridge's live registry, the way a host does (see sql-commit-durability.spec.ts). */
async function configureSessionMode(db: Database, plugin: Plugin): Promise<() => void> {
	const transactor = await plugin.collectionFactory.getOrCreateTransactor({
		collectionUri: 'tree://unused',
		transactor: 'test',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json',
	});
	const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(db, coordinator);
	await engine.getSchemaHash();
	try {
		plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
	} catch (error) {
		engine.dispose();
		throw error;
	}
	return () => engine.dispose();
}

describe('Offline mode: entering, sealing a commit, following it to the other node', function () {
	this.timeout(60_000);

	it('an offline commit with the cohort reachable: queued, submitting and committed reported once each under the StampId, the durability report shared, the table named, the row on B', async () => {
		const { a, b, statuses, reports } = await twoNodes();
		await a.db.exec(createNotes);
		a.plugin.offline.enter();

		await a.db.exec('begin');
		await a.db.exec(`insert into Notes (id, body) values (1, 'hello')`);
		const stampId = await stampIdOf(a.db);
		await a.db.exec('commit');

		// Delivered inside the commit, before anything was sent.
		const queued = statuses.find((s): s is QueuedStatus => s.kind === 'queued' && s.transactionId === stampId);
		expect(queued?.tables, 'the table the transaction wrote').to.deep.equal(['main.Notes']);
		expect(queued?.seq).to.equal(1);
		expect(queued?.inDoubt).to.equal(false);
		expect(reports, 'nothing reached storage when the commit resolved').to.have.length(0);

		await a.plugin.offline.whenDrained();
		expect(kindsOf(statuses, stampId)).to.deep.equal(['queued', 'submitting', 'committed']);
		const committed = statuses.find(s => s.kind === 'committed');
		expect(committed?.kind === 'committed' && [...committed.tables.keys()]).to.deep.equal(['main.Notes']);
		expect(reports.map(r => r.transactionId), 'onCommitDurability received the drained commit').to.deep.equal([stampId]);
		expect(committed?.kind === 'committed' && committed.durability, 'the status carries the very report').to.equal(reports[0]!.durability);
		expect(await countTreeEntries(b.plugin, NOTES_URI), 'the row is on B').to.equal(1);

		// Retained as an outcome until acknowledged.
		expect(a.plugin.offline.status(stampId)?.kind).to.equal('committed');
		expect(a.plugin.offline.outcomes().map(o => o.transactionId)).to.deep.equal([stampId]);
		a.plugin.offline.acknowledge(stampId);
		expect(a.plugin.offline.status(stampId)).to.equal(undefined);
		expect(a.plugin.offline.entries()).to.deep.equal([]);
	});

	it('an offline commit while B is unreachable is read back on A, listed by entries(), absent from B, and drained to B on reconnect', async () => {
		const { mesh, a, b, statuses } = await twoNodes();
		await a.db.exec(createNotes);
		severB(mesh);
		a.plugin.offline.enter();

		await a.db.exec(`insert into Notes (id, body) values (1, 'offline')`);
		const queued = statuses[0];
		expect(queued?.kind).to.equal('queued');
		const stampId = queued!.transactionId;

		expect(await collect(a.db, 'select id, body from Notes'), 'A reads its own queued row').to.deep.equal([{ id: 1, body: 'offline' }]);
		expect(await countTreeEntries(b.plugin, NOTES_URI), 'B holds nothing of it').to.equal(0);
		expect(a.plugin.offline.entries().map(e => e.transactionId)).to.deep.equal([stampId]);
		// The drain tried once and met the shortfall: queued again, waiting for the cohort.
		await waitFor(() => statuses.some(s => s.kind === 'queued' && s.transactionId === stampId && s.waitingFor === 'cohort'),
			'the entry to report waiting for the cohort');
		expect(a.plugin.offline.queueState()).to.include({ mode: 'offline', depth: 1, waitingFor: 'cohort' });

		restoreB(mesh);
		await a.plugin.offline.whenDrained();
		const kinds = kindsOf(statuses, stampId);
		expect(kinds[0]).to.equal('queued');
		expect(kinds.filter(k => k === 'committed'), 'committed exactly once').to.have.length(1);
		expect(kinds.at(-1)).to.equal('committed');
		expect(await countTreeEntries(b.plugin, NOTES_URI), 'the row reached B').to.equal(1);
		expect(a.plugin.offline.queueState()).to.include({ depth: 0, draining: false });
	});

	it('several entries across a table and its secondary index drain in order; after each settles, an index-driven read and a full scan on B agree', async () => {
		const { mesh, a, b, statuses } = await twoNodes();
		const uri = 'tree://offline/items';
		const createItems = `create table Items (Id integer primary key, Token text) using optimystic('${uri}')`;
		const createIndex = 'create index items_by_token on Items(Token)';
		await a.db.exec(createItems);
		await a.db.exec(createIndex);
		await b.db.exec(createItems);
		await b.db.exec(createIndex);

		severB(mesh);
		a.plugin.offline.enter();
		await a.db.exec(`insert into Items (Id, Token) values (1, 'tok-a')`);
		await a.db.exec(`insert into Items (Id, Token) values (2, 'tok-b')`);
		await a.db.exec(`insert into Items (Id, Token) values (3, 'tok-a')`);
		const queuedOrder = statuses.filter(s => s.kind === 'queued').map(s => s.transactionId);
		expect(new Set(queuedOrder).size, 'three transactions queued').to.equal(3);
		expect(statuses.filter((s): s is QueuedStatus => s.kind === 'queued').map(s => s.tables))
			.to.deep.equal([['main.Items'], ['main.Items'], ['main.Items']]);
		// Every later read on this machine sees the queued rows, through the index as through a scan.
		await expectIndexAgreesWithScan(a.db, 'Items', 'Token');
		expect((await collect(a.db, 'select Id from Items order by Id')).map(r => r.Id), 'A reads its three queued rows').to.deep.equal([1, 2, 3]);

		// After each commit settles, B's two read shapes of the table must agree with each other.
		const checks: Promise<void>[] = [];
		let settled = 0;
		a.plugin.offline.onStatus(status => {
			if (status.kind !== 'committed') return;
			const expectedAtLeast = ++settled;
			checks.push((async () => {
				await expectIndexAgreesWithScan(b.db, 'Items', 'Token');
				const rows = await collect(b.db, 'select Id from Items');
				expect(rows.length, 'B holds every row committed so far').to.be.at.least(expectedAtLeast);
			})());
		});

		restoreB(mesh);
		await a.plugin.offline.whenDrained();
		await Promise.all(checks);
		expect(statuses.filter(s => s.kind === 'committed').map(s => s.transactionId), 'committed in queue order').to.deep.equal(queuedOrder);
		expect(await countTreeEntries(b.plugin, uri)).to.equal(3);
		expect(await countTreeEntries(b.plugin, `${uri}/index/items_by_token`)).to.equal(3);
		await expectIndexAgreesWithScan(a.db, 'Items', 'Token');
	});

	it('the acknowledgement is fixed when the transaction begins: enter() after begin leaves it network-acknowledged, exit() after begin leaves it local', async () => {
		const { a, b, statuses } = await twoNodes();
		await a.db.exec(createNotes);

		await a.db.exec('begin');
		await a.db.exec(`insert into Notes (id, body) values (1, 'before enter')`);
		a.plugin.offline.enter();
		const first = await stampIdOf(a.db);
		await a.db.exec('commit');
		expect(kindsOf(statuses, first), 'no status: the commit went to the network').to.deep.equal([]);
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(1);

		await a.db.exec('begin');
		await a.db.exec(`insert into Notes (id, body) values (2, 'before exit')`);
		a.plugin.offline.exit();
		const second = await stampIdOf(a.db);
		await a.db.exec('commit');
		// The drain may already have reported `submitting` by the time the commit resolved (B is reachable).
		expect(kindsOf(statuses, second)[0], 'queued: the acknowledgement was fixed at begin').to.equal('queued');
		await a.plugin.offline.whenDrained();
		expect(kindsOf(statuses, second)).to.deep.equal(['queued', 'submitting', 'committed']);
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(2);
	});

	it('exit() with entries queued: the mode change is published, the drain continues, and both entries land on reconnect', async () => {
		const { mesh, a, b, statuses } = await twoNodes();
		await a.db.exec(createNotes);
		const states: OfflineModeState[] = [];
		a.plugin.offline.onQueueState(state => { states.push(state); });

		severB(mesh);
		a.plugin.offline.enter();
		await a.db.exec(`insert into Notes (id, body) values (1, 'one')`);
		await a.db.exec(`insert into Notes (id, body) values (2, 'two')`);
		a.plugin.offline.exit();
		expect(a.plugin.offline.queueState()).to.include({ mode: 'online', depth: 2 });
		expect(states.map(s => s.mode)[0]).to.equal('offline');
		expect(states.at(-1)?.mode).to.equal('online');

		restoreB(mesh);
		await a.plugin.offline.whenDrained();
		const order = statuses.filter(s => s.kind === 'queued').map(s => s.transactionId).filter((id, i, ids) => ids.indexOf(id) === i);
		expect(statuses.filter(s => s.kind === 'committed').map(s => s.transactionId)).to.deep.equal(order);
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(2);
	});

	it('a transaction that staged nothing in offline mode queues nothing: a select, and an update that matched no row', async () => {
		const { a, statuses } = await twoNodes();
		await a.db.exec(createNotes);
		a.plugin.offline.enter();

		expect(await collect(a.db, 'select id from Notes')).to.deep.equal([]);
		await a.db.exec(`update Notes set body = 'x' where id = 99`);

		expect(statuses).to.deep.equal([]);
		expect(a.plugin.offline.entries()).to.deep.equal([]);
	});

	it("an autocommit statement's queued status is delivered during the db.exec that committed it", async () => {
		const { a, statuses } = await twoNodes();
		await a.db.exec(createNotes);
		a.plugin.offline.enter();

		let execInFlight = false;
		let queuedDuringExec: boolean | undefined;
		a.plugin.offline.onStatus(status => {
			if (status.kind === 'queued') queuedDuringExec = execInFlight;
		});
		execInFlight = true;
		await a.db.exec(`insert into Notes (id, body) values (1, 'autocommit')`);
		execInFlight = false;

		expect(queuedDuringExec, 'the queued status arrived while exec was running').to.equal(true);
		expect(statuses[0]?.kind).to.equal('queued');
		await a.plugin.offline.whenDrained();
	});

	it('discard before send fails the entry with discarded and its row disappears; discard after send is refused', async () => {
		const { mesh, a, statuses } = await twoNodes();
		await a.db.exec(createNotes);
		await a.db.exec(`insert into Notes (id, body) values (1, 'seed')`);

		// Before send: withdrawn from the synchronous `queued` delivery, ahead of the drain's first step.
		severB(mesh);
		a.plugin.offline.enter();
		let discardedId: string | undefined;
		const stopDiscarding = a.plugin.offline.onStatus(status => {
			if (status.kind === 'queued' && discardedId === undefined) {
				discardedId = status.transactionId;
				a.plugin.offline.discard(status.transactionId);
			}
		});
		await a.db.exec(`insert into Notes (id, body) values (2, 'withdrawn')`);
		stopDiscarding();
		await waitFor(() => statuses.some(s => s.kind === 'failed' && s.transactionId === discardedId), 'the discarded entry to fail');
		const failed = statuses.find((s): s is FailedStatus => s.kind === 'failed' && s.transactionId === discardedId);
		expect(failed?.reason).to.equal('discarded');
		expect(failed?.changedTables).to.deep.equal(['main.Notes']);
		expect(await collect(a.db, 'select id from Notes order by id'), 'the withdrawn row is gone, the seed stays').to.deep.equal([{ id: 1 }]);
		expect(a.plugin.offline.entries()).to.deep.equal([]);
		expect(a.plugin.offline.status(discardedId!)?.kind, 'retained as an outcome').to.equal('failed');
		await a.plugin.offline.whenDrained();

		// After send: the entry is being submitted when the application asks.
		restoreB(mesh);
		let refusal: unknown;
		a.plugin.offline.onStatus(status => {
			if (status.kind !== 'submitting') return;
			try {
				a.plugin.offline.discard(status.transactionId);
			} catch (error) {
				refusal = error;
			}
		});
		await a.db.exec(`insert into Notes (id, body) values (3, 'sent')`);
		await a.plugin.offline.whenDrained();
		expect(refusal).to.be.instanceOf(EntryNotDiscardableError);
		expect((refusal as EntryNotDiscardableError).because).to.equal('submitting');
		expect(statuses.at(-1)?.kind).to.equal('committed');
	});

	it('session mode and offline mode refuse each other in either order', async () => {
		// Session mode first: entering is refused.
		const sessionFirst = createTestDb();
		await sessionFirst.db.exec(createNotes);
		const disposeEngine = await configureSessionMode(sessionFirst.db, sessionFirst.plugin);
		try {
			expect(() => sessionFirst.plugin.offline.enter()).to.throw(OfflineModeRefusedError).with.property('reason', 'session-mode');
			expect(sessionFirst.plugin.offline.queueState().mode).to.equal('online');
		} finally {
			disposeEngine();
			sessionFirst.db.close();
		}

		// Offline mode first: configuring session mode is refused.
		const offlineFirst = createTestDb();
		await offlineFirst.db.exec(createNotes);
		try {
			offlineFirst.plugin.offline.enter();
			let refusal: unknown;
			await configureSessionMode(offlineFirst.db, offlineFirst.plugin).catch(error => { refusal = error; });
			expect(refusal).to.be.instanceOf(SessionModeRefusedError).with.property('reason', 'offline-mode');
			expect(offlineFirst.plugin.txnBridge.isTransactionModeEnabled()).to.equal(false);
		} finally {
			offlineFirst.db.close();
		}

		// Mode left, entries still queued: configuring session mode is refused until they settle.
		const { mesh, a } = await twoNodes();
		await a.db.exec(createNotes);
		severB(mesh);
		a.plugin.offline.enter();
		await a.db.exec(`insert into Notes (id, body) values (1, 'queued')`);
		a.plugin.offline.exit();
		let refusal: unknown;
		await configureSessionMode(a.db, a.plugin).catch(error => { refusal = error; });
		expect(refusal).to.be.instanceOf(SessionModeRefusedError).with.property('reason', 'queued-entries');
		restoreB(mesh);
		await a.plugin.offline.whenDrained();
	});

	it('a dirty set that cannot be one entry (two tree instances over one collection id) falls back to network acknowledgement', async () => {
		// Model: test/legacy-batch-shared-collection-id.spec.ts, which drives the bridge directly.
		const db = new Database();
		const plugin = register(db, { default_transactor: 'local', default_key_network: 'test', enable_cache: false });
		const transactor = new TestTransactor();
		plugin.collectionFactory.registerTransactor('local:test', transactor);
		const collectionId = 'offline/shared-id';
		const options: ParsedOptimysticOptions = {
			collectionUri: `tree://${collectionId}`,
			transactor: 'local',
			keyNetwork: 'test',
			libp2pOptions: {},
			cache: false,
			encoding: 'json',
		};
		type Entry = { key: number; name: string };
		try {
			const seed = await Tree.createOrOpen<number, Entry>(transactor, collectionId, e => e.key);
			await seed.stage([[0, { key: 0, name: 'seed' }]]);
			await seed.sync();
			const first = await Tree.createOrOpen<number, Entry>(transactor, collectionId, e => e.key);
			const second = await Tree.createOrOpen<number, Entry>(transactor, collectionId, e => e.key);
			const statuses: QueuedTransactionStatus[] = [];
			plugin.offline.onStatus(status => { statuses.push(status); });
			plugin.offline.enter();

			const bridge = plugin.txnBridge;
			const transaction = await bridge.beginTransaction(options);
			expect(transaction.acknowledgement).to.equal('local');
			bridge.markDirty(first);
			bridge.markDirty(second);
			await first.stage([[1, { key: 1, name: 'first' }]]);
			await second.stage([[2, { key: 2, name: 'second' }]]);
			await bridge.commitTransaction();

			expect(statuses, 'nothing was queued').to.deep.equal([]);
			expect(bridge.isDegraded()).to.equal(false);
			const fresh = await Tree.createOrOpen<number, Entry>(transactor, collectionId, e => e.key);
			expect(await fresh.get(1)).to.deep.equal({ key: 1, name: 'first' });
			expect(await fresh.get(2)).to.deep.equal({ key: 2, name: 'second' });
		} finally {
			db.close();
		}
	});

	it('register refuses an offline block it does not understand', () => {
		const db = new Database();
		try {
			expect(() => register(db, { offline: { soloCommit: true } as unknown as SqlValue })).to.throw(/offline\.soloCommit is not a registration option/);
			expect(() => register(db, { offline: { allowSoloCommit: 'yes' } as unknown as SqlValue })).to.throw(/offline\.allowSoloCommit must be true or false/);
			expect(() => register(db, { offline: { expireAfterMs: -1 } as unknown as SqlValue })).to.throw(/offline\.expireAfterMs must be a positive number/);
			expect(() => register(db, { offline: { recheck: { base: 1 } } as unknown as SqlValue })).to.throw(/offline\.recheck\.base is not a registration option/);
		} finally {
			db.close();
		}
	});
});
