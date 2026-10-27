/**
 * What an application sees when a queued offline transaction leaves this machine's view, and what an
 * open SQL transaction or savepoint rolled back while the drain changes the queue keeps
 * (docs/offline-sync.md §Removing an entry, §Rollback and savepoints only touch the open segment).
 * The queue's own cascade is pinned in `packages/db-core/test/offline-queue.spec.ts`; these cases
 * assert the statuses `plugin.offline` reports, the watcher the removal wakes, and the rows each node
 * reads.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`), both responsible for every block. Each
 * node coordinates its own writes, so a gate on the pends node A's repo receives holds the drain's
 * submission mid-flight — after the attempt is built against what A held, before the cohort sees
 * it — while node B commits a rival write and node A runs SQL. Releasing it is the reconnect.
 */

import { expect } from 'chai';
import type { Database, SqlValue, WatchEvent } from '@quereus/quereus';
import { Log, type LogEntry } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import type { QueuedTransactionStatus } from '../dist/index.js';
import { CommitGate, parkingPends } from './commit-gate.js';
import { countTreeEntries, createMeshDbNode, openFreshTree, startMockMesh, type MeshDbNode, type Plugin } from './mesh-node-harness.js';
import { expectConcurrentModificationRefusal, expectConstraintRefusal, queryAll } from './query-helpers.js';

type QueuedStatus = Extract<QueuedTransactionStatus, { kind: 'queued' }>;
type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

const offlineConfig = { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>;

const NOTES_URI = 'tree://offline-removal/notes';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;

interface TwoNodes {
	a: MeshDbNode;
	b: MeshDbNode;
	/** Arm a fresh gate: every pend node A's repo receives from now on waits until it is released. */
	parkPends(): CommitGate;
	/** Every status node A's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
}

/** Both nodes with `Notes` declared and node A's statuses recorded; no gate is armed yet. */
async function twoNodes(): Promise<TwoNodes> {
	let gate: CommitGate | undefined;
	let parkedPeer: string | undefined;
	const { mesh, transactorFor } = await startMockMesh(2, {
		wrapRepo: (repo, node) => parkingPends(repo, () => node.peerId.toString() === parkedPeer ? gate : undefined),
	});
	parkedPeer = mesh.nodes[0]!.peerId.toString();
	const a = createMeshDbNode(transactorFor(0), offlineConfig);
	const b = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	a.plugin.offline.onStatus(status => { statuses.push(status); });
	await a.db.exec(createNotes);
	await b.db.exec(createNotes);
	const parkPends = (): CommitGate => {
		gate = new CommitGate();
		gate.arm();
		return gate;
	};
	return { a, b, parkPends, statuses };
}

/** Every transaction id node A reported queued, in the order first reported. */
const queuedIds = (statuses: readonly QueuedTransactionStatus[]): string[] =>
	[...new Set(statuses.filter(s => s.kind === 'queued').map(s => s.transactionId))];

const failedOf = (statuses: readonly QueuedTransactionStatus[], transactionId: string): FailedStatus[] =>
	statuses.filter((s): s is FailedStatus => s.kind === 'failed' && s.transactionId === transactionId);

const queuedOf = (statuses: readonly QueuedTransactionStatus[], transactionId: string): QueuedStatus | undefined =>
	statuses.find((s): s is QueuedStatus => s.kind === 'queued' && s.transactionId === transactionId);

const rowsOf = (db: Database): Promise<Record<string, unknown>[]> => queryAll(db, 'select id, body from Notes order by id');

/** The action entries of `collectionUri`'s committed log, read on this node through a fresh handle. */
async function committedActions(plugin: Plugin, collectionUri: string): Promise<LogEntry<unknown>[]> {
	const tree = await openFreshTree(plugin, collectionUri);
	await tree.update();
	const collection = tree.getCollection();
	const log = await Log.open<unknown>(collection.tracker, collection.id);
	const entries: LogEntry<unknown>[] = [];
	for await (const entry of log?.select() ?? []) {
		if (entry.action !== undefined) entries.push(entry);
	}
	return entries;
}

describe('Offline mode: a queued transaction removed from this machine\'s view, and a rollback during the drain', function () {
	this.timeout(60_000);

	it('a rival takes the primary key: the insert fails with constraint, its row leaves a live read, a watcher wakes after the failed status, and the update queued over it fails with concurrent-modification caused by it', async () => {
		const { a, b, parkPends, statuses } = await twoNodes();
		a.plugin.offline.enter();
		const gate = parkPends();

		await a.db.exec(`insert into Notes (id, body) values (1, 'from-a')`);
		await gate.entered;
		await a.db.exec(`update Notes set body = 'edited-on-a' where id = 1`);
		const [insertId, updateId] = queuedIds(statuses);
		expect(updateId, 'two transactions queued').to.not.equal(undefined);

		await b.db.exec(`insert into Notes (id, body) values (1, 'from-b')`);

		// Only the removal can wake it from here: A commits nothing more, and this mesh's transactors
		// report no storage change events.
		const timeline: string[] = [];
		a.plugin.offline.onStatus(status => { timeline.push(`${status.kind}:${status.transactionId}`); });
		const subscription = a.db.watch(a.db.prepare('select * from Notes').getChangeScope(), (_event: WatchEvent) => { timeline.push('watch'); });

		// A live read before the drain is released pulls B's commit; the replay it runs is what refuses
		// both queued transactions, so B's row is what A reads.
		expect(await rowsOf(a.db), 'a live read on A after B committed').to.deep.equal([{ id: 1, body: 'from-b' }]);

		gate.release();
		await a.plugin.offline.whenDrained();
		await waitFor(() => timeline.includes('watch'), { description: 'a watcher on Notes to wake', timeoutMs: 5_000 });
		subscription.unsubscribe();

		const [insertFailed] = failedOf(statuses, insertId!);
		expect(failedOf(statuses, insertId!), 'the insert failed exactly once').to.have.length(1);
		expect(insertFailed!.reason).to.equal('constraint');
		expectConstraintRefusal(insertFailed!.error, 'the insert queued under a key B took');
		expect(insertFailed!.error.message).to.match(/UNIQUE constraint failed/);
		expect(insertFailed!.causedBy, 'a rival refused it, not an earlier entry').to.equal(undefined);

		const [updateFailed] = failedOf(statuses, updateId!);
		expect(failedOf(statuses, updateId!), 'the update failed exactly once').to.have.length(1);
		expect(updateFailed!.reason).to.equal('concurrent-modification');
		expectConcurrentModificationRefusal(updateFailed!.error, 'the update queued over the refused insert');
		expect(updateFailed!.causedBy).to.equal(insertId);

		for (const id of [insertId!, updateId!]) {
			expect(queuedOf(statuses, id)?.tables, `the tables ${id} was queued with`).to.deep.equal(['main.Notes']);
			expect(failedOf(statuses, id)[0]!.changedTables, `the tables ${id}'s removal changed`).to.deep.equal(['main.Notes']);
		}
		expect(timeline.indexOf('watch'), 'the watcher woke after the failed status')
			.to.be.greaterThan(timeline.indexOf(`failed:${insertId}`));
		expect(await rowsOf(a.db), 'A reads B\'s row').to.deep.equal([{ id: 1, body: 'from-b' }]);
	});

	it('a rival changes the row a queued update read: the update fails with concurrent-modification', async () => {
		const { a, b, parkPends, statuses } = await twoNodes();
		await a.db.exec(`insert into Notes (id, body) values (1, 'seed')`);
		a.plugin.offline.enter();
		const gate = parkPends();

		await a.db.exec(`update Notes set body = 'from-a' where id = 1`);
		await gate.entered;
		await b.db.exec(`update Notes set body = 'from-b' where id = 1`);
		gate.release();
		await a.plugin.offline.whenDrained();

		const [updateId] = queuedIds(statuses);
		const failed = failedOf(statuses, updateId!);
		expect(failed, 'the update failed exactly once').to.have.length(1);
		expect(failed[0]!.reason).to.equal('concurrent-modification');
		expectConcurrentModificationRefusal(failed[0]!.error, 'the update queued over a row B then changed');
		expect(failed[0]!.changedTables).to.deep.equal(['main.Notes']);
		expect(await rowsOf(a.db)).to.deep.equal([{ id: 1, body: 'from-b' }]);
	});

	it('a transaction rolled back while the drain commits the queued entry: the entry commits once, the entry still queued behind it stays in view, and the rolled-back row is gone', async () => {
		const { a, b, parkPends, statuses } = await twoNodes();
		await a.db.exec(`insert into Notes (id, body) values (0, 'seed')`);
		a.plugin.offline.enter();
		const first = parkPends();

		await a.db.exec(`insert into Notes (id, body) values (1, 'queued first')`);
		await first.entered;
		await a.db.exec(`insert into Notes (id, body) values (4, 'queued second')`);
		const [firstId, secondId] = queuedIds(statuses);
		// Its snapshot of Notes is taken while both queued inserts are sealed, the first in flight.
		await a.db.exec('begin');
		await a.db.exec(`insert into Notes (id, body) values (2, 'rolled back')`);

		const second = parkPends();
		first.release();
		await second.entered;
		expect(statuses.filter(s => s.kind === 'committed').map(s => s.transactionId), 'the first committed, the second in flight').to.deep.equal([firstId]);
		await a.db.exec('rollback');

		expect(await rowsOf(a.db), 'A after the rollback').to.deep.equal([
			{ id: 0, body: 'seed' }, { id: 1, body: 'queued first' }, { id: 4, body: 'queued second' },
		]);
		second.release();
		await a.plugin.offline.whenDrained();
		// Network-acknowledged: this commit sends whatever the rollback and the drain left staged.
		a.plugin.offline.exit();
		await a.db.exec(`insert into Notes (id, body) values (3, 'online')`);

		expect(statuses.filter(s => s.kind === 'committed').map(s => s.transactionId), 'each committed once, in order').to.deep.equal([firstId, secondId]);
		expect(await rowsOf(b.db), 'B').to.deep.equal([
			{ id: 0, body: 'seed' }, { id: 1, body: 'queued first' }, { id: 3, body: 'online' }, { id: 4, body: 'queued second' },
		]);
		expect(await countTreeEntries(b.plugin, NOTES_URI), 'entries in B\'s committed tree').to.equal(4);
		expect(await committedActions(b.plugin, NOTES_URI), 'one log entry each for the seed, the two queued inserts and the online insert')
			.to.have.length(4);
	});

	it('a savepoint rolled back after the drain removed a refused entry: the removed row stays gone and the savepoint\'s own row is discarded', async () => {
		const { a, b, parkPends, statuses } = await twoNodes();
		a.plugin.offline.enter();
		const gate = parkPends();

		await a.db.exec(`insert into Notes (id, body) values (1, 'from-a')`);
		await gate.entered;
		const [refusedId] = queuedIds(statuses);
		// The savepoint is taken while the insert B is about to refuse is still sealed in Notes.
		await a.db.exec('begin');
		await a.db.exec(`insert into Notes (id, body) values (7, 'before the savepoint')`);
		await a.db.exec('savepoint sp1');
		await a.db.exec(`insert into Notes (id, body) values (8, 'inside the savepoint')`);

		await b.db.exec(`insert into Notes (id, body) values (1, 'from-b')`);
		gate.release();
		await waitFor(() => failedOf(statuses, refusedId!).length > 0, { description: 'the refused insert to fail', timeoutMs: 10_000 });
		expect(failedOf(statuses, refusedId!)[0]!.reason).to.equal('constraint');

		await a.db.exec('rollback to sp1');
		expect(await rowsOf(a.db), 'A inside the transaction after the rollback to the savepoint')
			.to.deep.equal([{ id: 1, body: 'from-b' }, { id: 7, body: 'before the savepoint' }]);
		await a.db.exec('commit');
		await a.plugin.offline.whenDrained();

		expect(await rowsOf(b.db), 'B').to.deep.equal([{ id: 1, body: 'from-b' }, { id: 7, body: 'before the savepoint' }]);
	});
});
