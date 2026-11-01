/**
 * Which acknowledgement a commit gets while offline mode is in use (docs/offline-sync.md §Per-table
 * policy, §Network acknowledgement behind a non-empty queue): a table tagged
 * `"optimystic.offline" = 'network'` demotes a locally acknowledged transaction to network
 * acknowledgement, and a network-acknowledged commit made while transactions are queued is queued
 * behind them and waits for its own outcome — resolving on `committed`, throwing the mapped error on
 * `failed`, and throwing `OfflineCommitTimeoutError` when the wait outlasts
 * `offline.networkCommitTimeoutMs`. The cases assert what an application observes: statuses, the
 * error out of `db.exec`, and the rows each node reads.
 *
 * Two nodes on the in-process mesh (`mesh-node-harness.ts`), both responsible for every block. Node B
 * is made unreachable for cluster (write) rounds through `mesh.failures.failingPeers`, which keeps a
 * queued transaction retrying; a gate on the pends node A's repo receives (`parkingPends`) holds a
 * submission mid-flight, which is what keeps a transaction behind it genuinely unsent.
 */

import { expect } from 'chai';
import type { Database, SqlValue } from '@quereus/quereus';
import { waitFor } from '@optimystic/db-core/test';
import type { ITransactor } from '@optimystic/db-core';
import type { Mesh } from '@optimystic/db-p2p/testing';
import { OfflineCommitTimeoutError, type QueuedTransactionStatus, type SqlCommitDurability } from '../dist/index.js';
import { CommitGate, parkingPends } from './commit-gate.js';
import { countTreeEntries, createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { expectConcurrentModificationRefusal, queryAll } from './query-helpers.js';

type QueuedStatus = Extract<QueuedTransactionStatus, { kind: 'queued' }>;
type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

const NOTES_URI = 'tree://offline-ack/notes';
const REVOCATION_URI = 'tree://offline-ack/revocation';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;
const createRevocation = `create table Revocation (id integer primary key, peer text) using optimystic('${REVOCATION_URI}') with tags ("optimystic.offline" = 'network')`;

/** Node A's registration: the drain's re-check timer shortened so a reconnect is noticed quickly. */
const offlineConfig = (offline: Record<string, unknown> = {}): Record<string, SqlValue> =>
	({ offline: { recheck: { baseMs: 20, maxMs: 100 }, ...offline } }) as unknown as Record<string, SqlValue>;

interface TwoNodes {
	mesh: Mesh;
	a: MeshDbNode;
	b: MeshDbNode;
	/** Node A's transactor, for a second `Database` over the same node. */
	transactorA: ITransactor;
	/** Arm a fresh gate: every pend node A's repo receives from now on waits until it is released. */
	parkPends(): CommitGate;
	/** Every status node A's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
	/** Every durability report node A's plugin delivered, in order. */
	reports: SqlCommitDurability[];
}

/** Both nodes with `Notes` declared, and `Revocation` (tagged `'network'`) on node A. */
async function twoNodes(offline: Record<string, unknown> = {}): Promise<TwoNodes> {
	let gate: CommitGate | undefined;
	let parkedPeer: string | undefined;
	const { mesh, transactorFor } = await startMockMesh(2, {
		wrapRepo: (repo, node) => parkingPends(repo, () => node.peerId.toString() === parkedPeer ? gate : undefined),
	});
	parkedPeer = mesh.nodes[0]!.peerId.toString();
	const transactorA = transactorFor(0);
	const a = createMeshDbNode(transactorA, offlineConfig(offline));
	const b = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	a.plugin.offline.onStatus(status => { statuses.push(status); });
	const reports: SqlCommitDurability[] = [];
	a.plugin.onCommitDurability(report => { reports.push(report); });
	await a.db.exec(createNotes);
	await a.db.exec(createRevocation);
	await b.db.exec(createNotes);
	const parkPends = (): CommitGate => {
		gate = new CommitGate();
		gate.arm();
		return gate;
	};
	return { mesh, a, b, transactorA, parkPends, statuses, reports };
}

/** Node B stops answering cluster (write) rounds: a commit A drives meets a promise shortfall. */
function severB(mesh: Mesh): void {
	mesh.failures.failingPeers = new Set([mesh.nodes[1]!.peerId.toString()]);
}

function restoreB(mesh: Mesh): void {
	mesh.failures.failingPeers = undefined;
}

/** Every transaction id node A reported queued, in the order first reported. */
const queuedIds = (statuses: readonly QueuedTransactionStatus[]): string[] =>
	[...new Set(statuses.filter(s => s.kind === 'queued').map(s => s.transactionId))];

const queuedOf = (statuses: readonly QueuedTransactionStatus[], transactionId: string): QueuedStatus | undefined =>
	statuses.find((s): s is QueuedStatus => s.kind === 'queued' && s.transactionId === transactionId);

const committedIds = (statuses: readonly QueuedTransactionStatus[]): string[] =>
	statuses.filter(s => s.kind === 'committed').map(s => s.transactionId);

const notesOf = (db: Database): Promise<Record<string, unknown>[]> => queryAll(db, 'select id, body from Notes order by id');

/** `sql`'s exec settled: `undefined` when it resolved, the error when it rejected. */
const settledExec = (db: Database, sql: string): Promise<unknown> => db.exec(sql).then(() => undefined, (error: unknown) => error);

describe('Offline mode: the per-table policy, and a network-acknowledged commit behind the queue', function () {
	this.timeout(60_000);

	it("with nothing queued, a transaction writing a 'network' table is acknowledged by the network, alone or beside a 'queue' table, and a tag value naming no policy reads as 'queue'", async () => {
		const { a, b, statuses } = await twoNodes();
		a.plugin.offline.enter();

		await a.db.exec(`insert into Revocation (id, peer) values (1, 'p1')`);
		expect(statuses, 'nothing queued').to.deep.equal([]);
		expect(await countTreeEntries(b.plugin, REVOCATION_URI), 'on B when the commit resolved').to.equal(1);

		await a.db.exec('begin');
		await a.db.exec(`insert into Notes (id, body) values (1, 'beside')`);
		await a.db.exec(`insert into Revocation (id, peer) values (2, 'p2')`);
		await a.db.exec('commit');
		expect(statuses, 'the mixed transaction was not queued either').to.deep.equal([]);
		expect(await countTreeEntries(b.plugin, NOTES_URI), 'its Notes row on B').to.equal(1);
		expect(await countTreeEntries(b.plugin, REVOCATION_URI), 'its Revocation row on B').to.equal(2);

		await a.db.exec(`create table Later (id integer primary key) using optimystic('tree://offline-ack/later') with tags ("optimystic.offline" = 'later')`);
		await a.db.exec('insert into Later (id) values (1)');
		expect(statuses[0]?.kind, 'locally acknowledged').to.equal('queued');
		expect(queuedOf(statuses, statuses[0]!.transactionId)?.tables).to.deep.equal(['main.Later']);
		await a.plugin.offline.whenDrained();
	});

	it("a 'network' table written in offline mode behind a queued transaction: the autocommit waits, and resolves only after both commit in order", async () => {
		const { mesh, a, b, statuses, reports } = await twoNodes();
		severB(mesh);
		a.plugin.offline.enter();
		await a.db.exec(`insert into Notes (id, body) values (1, 'queued')`);
		const [noteId] = queuedIds(statuses);

		const timeline: string[] = [];
		a.plugin.offline.onStatus(status => { if (status.kind === 'committed') timeline.push(`committed:${status.transactionId}`); });
		const revocation = a.db.exec(`insert into Revocation (id, peer) values (1, 'p1')`).then(() => { timeline.push('exec-resolved'); });
		await waitFor(() => queuedIds(statuses).length === 2, { description: 'the revocation to queue behind the note' });
		const revocationId = queuedIds(statuses)[1]!;
		expect(queuedOf(statuses, revocationId)?.tables).to.deep.equal(['main.Revocation']);
		// The note is retried, and refused again, while the revocation waits behind it.
		const seen = statuses.length;
		await waitFor(() => statuses.slice(seen).some(s => s.kind === 'queued' && s.transactionId === noteId && s.waitingFor === 'cohort'),
			{ description: 'another attempt of the note to meet the shortfall', timeoutMs: 5_000 });
		expect(timeline, 'the exec is still pending').to.deep.equal([]);

		restoreB(mesh);
		await revocation;
		expect(timeline).to.deep.equal([`committed:${noteId}`, `committed:${revocationId}`, 'exec-resolved']);
		expect(reports.filter(report => report.transactionId === revocationId), 'reported once, by the drain').to.have.length(1);
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(1);
		expect(await countTreeEntries(b.plugin, REVOCATION_URI)).to.equal(1);
	});

	it('exit() with transactions queued: a commit to the table they wrote waits behind them and lands after them', async () => {
		const { mesh, a, b, statuses } = await twoNodes();
		severB(mesh);
		a.plugin.offline.enter();
		await a.db.exec(`insert into Notes (id, body) values (1, 'queued')`);
		a.plugin.offline.exit();

		const edit = a.db.exec(`update Notes set body = 'edited' where id = 1`);
		await waitFor(() => queuedIds(statuses).length === 2, { description: 'the update to queue behind the insert' });
		const [insertId, updateId] = queuedIds(statuses);
		expect(queuedOf(statuses, updateId!)?.tables).to.deep.equal(['main.Notes']);

		restoreB(mesh);
		await edit;
		expect(committedIds(statuses)).to.deep.equal([insertId, updateId]);
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'edited' }]);
	});

	it('a network-acknowledged commit behind the queue that a rival refuses throws the mapped error, its row change is gone, and the next transaction commits', async () => {
		const { a, b, parkPends, statuses } = await twoNodes();
		await a.db.exec(`insert into Notes (id, body) values (1, 'seed')`);
		a.plugin.offline.enter();
		const gate = parkPends();
		await a.db.exec(`insert into Notes (id, body) values (2, 'queued')`);
		await gate.entered;
		a.plugin.offline.exit();

		const update = settledExec(a.db, `update Notes set body = 'from-a' where id = 1`);
		await waitFor(() => queuedIds(statuses).length === 2, { description: 'the update to queue behind the insert' });
		await b.db.exec(`update Notes set body = 'from-b' where id = 1`);
		gate.release();

		const refusal = await update;
		expectConcurrentModificationRefusal(refusal as Error, 'the update B changed the row under');
		const updateId = queuedIds(statuses)[1]!;
		const failed = statuses.filter((s): s is FailedStatus => s.kind === 'failed' && s.transactionId === updateId);
		expect(failed.map(s => s.reason)).to.deep.equal(['concurrent-modification']);
		expect(await notesOf(a.db), 'B\'s change, and the insert queued ahead').to.deep.equal([{ id: 1, body: 'from-b' }, { id: 2, body: 'queued' }]);
		expect(a.plugin.txnBridge.isDegraded(), 'nothing of it committed').to.equal(false);

		await a.db.exec(`update Notes set body = 'retried' where id = 1`);
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'retried' }, { id: 2, body: 'queued' }]);
	});

	it('the wait outlasts networkCommitTimeoutMs before the transaction is sent: it is withdrawn, discarded, and its row is gone', async () => {
		const { a, parkPends, statuses } = await twoNodes({ networkCommitTimeoutMs: 200 });
		a.plugin.offline.enter();
		const gate = parkPends();
		await a.db.exec(`insert into Notes (id, body) values (1, 'parked')`);
		await gate.entered;
		a.plugin.offline.exit();

		const refusal = await settledExec(a.db, `insert into Notes (id, body) values (2, 'timed out')`);
		expect(refusal).to.be.instanceOf(OfflineCommitTimeoutError);
		const timeout = refusal as OfflineCommitTimeoutError;
		expect(timeout.sent).to.equal(false);
		expect(timeout.transactionId).to.equal(queuedIds(statuses)[1]);
		const outcome = a.plugin.offline.status(timeout.transactionId);
		expect(outcome?.kind === 'failed' && outcome.reason).to.equal('discarded');
		expect(await notesOf(a.db)).to.deep.equal([{ id: 1, body: 'parked' }]);

		gate.release();
		await a.plugin.offline.whenDrained();
	});

	it('the wait outlasts networkCommitTimeoutMs after the transaction was sent: it stays queued, and commits once its submission returns', async () => {
		const { a, b, parkPends, statuses } = await twoNodes({ networkCommitTimeoutMs: 1_000 });
		a.plugin.offline.enter();
		const first = parkPends();
		await a.db.exec(`insert into Notes (id, body) values (1, 'first')`);
		await first.entered;
		const [firstId] = queuedIds(statuses);
		a.plugin.offline.exit();

		// The moment the second is queued, park its submission and let the first through.
		let second: CommitGate | undefined;
		const stop = a.plugin.offline.onStatus(status => {
			if (status.kind === 'queued' && status.transactionId !== firstId && second === undefined) {
				second = parkPends();
				first.release();
			}
		});
		const refusal = await settledExec(a.db, `insert into Notes (id, body) values (2, 'sent')`);
		stop();
		expect(second?.isEntered, 'the second transaction was sent').to.equal(true);
		expect(refusal).to.be.instanceOf(OfflineCommitTimeoutError);
		const timeout = refusal as OfflineCommitTimeoutError;
		expect(timeout.sent).to.equal(true);
		expect(a.plugin.offline.entries().map(entry => entry.transactionId), 'still queued').to.deep.equal([timeout.transactionId]);
		expect(await notesOf(a.db), 'its row stays in view').to.deep.equal([{ id: 1, body: 'first' }, { id: 2, body: 'sent' }]);

		second!.release();
		await a.plugin.offline.whenDrained();
		expect(a.plugin.offline.status(timeout.transactionId)?.kind).to.equal('committed');
		expect(await notesOf(b.db)).to.deep.equal([{ id: 1, body: 'first' }, { id: 2, body: 'sent' }]);
	});

	it("a tag changed to 'network' applies to the running table, and survives hydrate into a fresh Database", async () => {
		const { a, b, transactorA, statuses } = await twoNodes();
		await a.db.exec(`alter table Notes set tags ("optimystic.offline" = 'network')`);
		a.plugin.offline.enter();
		await a.db.exec(`insert into Notes (id, body) values (1, 'altered')`);
		expect(statuses, 'not queued').to.deep.equal([]);
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(1);
		await a.plugin.whenCatalogPersisted();

		const fresh = createMeshDbNode(transactorA, offlineConfig());
		await fresh.plugin.hydrate(fresh.db);
		const freshStatuses: QueuedTransactionStatus[] = [];
		fresh.plugin.offline.onStatus(status => { freshStatuses.push(status); });
		fresh.plugin.offline.enter();
		await fresh.db.exec(`insert into Notes (id, body) values (2, 'after hydrate')`);
		expect(freshStatuses, 'not queued after hydrate').to.deep.equal([]);
		expect(await countTreeEntries(b.plugin, NOTES_URI)).to.equal(2);
	});
});
