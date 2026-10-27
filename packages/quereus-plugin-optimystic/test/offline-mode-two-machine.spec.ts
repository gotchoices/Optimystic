/**
 * Offline mode on a two-machine group.
 *
 * One member away (docs/offline-sync.md §When to submit: the reachability gate): a transaction made in
 * the mode on the machine left alone is queued, not committed alone; a live read there serves it from
 * that machine's own view; and it is sent the moment the partner returns, woken by the gate rather
 * than found by the re-check timer. Two nodes on the in-process mesh (`mesh-node-harness.ts`). Node A's
 * gate is the node's real one, `KeyNetworkCohortReachability` from `@optimystic/db-p2p`, over A's own
 * view of the mesh's key network, registered on A's factory under the transactor's key before any
 * table exists — where a node built by `createLibp2pNode` has its `node.cohortReachability` registered
 * by the factory itself. Its events come from an `EventTarget` the spec dispatches on, standing in for
 * the libp2p node's. "B away" is {@link PartnerAway}: each node's view of the cohort holds only itself
 * and names the other as absent, and every request to B fails. The deterministic counterpart of phase 5
 * of `packages/db-p2p/test/small-deployment-lifecycle.integration.spec.ts`, for writes made in the mode.
 *
 * Both members offline, making the same change (docs/offline-sync.md §Guards that make idempotent
 * writes assured): the second to drain finds its change already made by the first and commits with
 * `effect: 'already-applied'`, where a different change by the first still refuses it. Each node's gate
 * here is a switch the case opens when it wants that node to drain.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import type { IRepo } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { KeyNetworkCohortReachability } from '@optimystic/db-p2p';
import type { Mesh, MeshNode } from '@optimystic/db-p2p/testing';
import type { QueuedTransactionStatus } from '../dist/index.js';
import { countTreeEntries, createMeshDbNode, startMockMesh, type MeshDbNode } from './mesh-node-harness.js';
import { queryAll } from './query-helpers.js';

type FailedStatus = Extract<QueuedTransactionStatus, { kind: 'failed' }>;

const NOTES_URI = 'tree://offline-two-machine/notes';
const createNotes = `create table Notes (id integer primary key, body text) using optimystic('${NOTES_URI}')`;

/**
 * Cuts node B off, and brings it back: while away, each node's own key-network view holds only itself
 * and names the other as a cohort member it could not place (`failures.partitionSides`), cluster rounds
 * to B fail (`failures.failingPeers`), and every repo request sent to B throws, as a dropped connection
 * does. Every write request any transactor sends is counted, so a case can say nothing was sent.
 */
class PartnerAway {
	sends = 0;
	private away: string | undefined;

	readonly wrap = (repo: IRepo, node: MeshNode): IRepo => {
		const reach = <T>(call: () => Promise<T>): Promise<T> => this.away === node.peerId.toString()
			? Promise.reject(new Error(`${node.peerId.toString()} is away`))
			: call();
		const send = <T>(call: () => Promise<T>): Promise<T> => {
			this.sends++;
			return reach(call);
		};
		const pendMany = repo.pendMany?.bind(repo);
		const commitMany = repo.commitMany?.bind(repo);
		return {
			get: (blockGets, options) => reach(() => repo.get(blockGets, options)),
			pend: (request, options) => send(() => repo.pend(request, options)),
			cancel: (actionRef, options) => reach(() => repo.cancel(actionRef, options)),
			commit: (request, options) => send(() => repo.commit(request, options)),
			...(pendMany ? { pendMany: (...args: Parameters<typeof pendMany>) => send(() => pendMany(...args)) } : {}),
			...(commitMany ? { commitMany: (...args: Parameters<typeof commitMany>) => send(() => commitMany(...args)) } : {}),
		};
	};

	leave(mesh: Mesh): void {
		const [a, b] = mesh.nodes.map(node => node.peerId.toString());
		mesh.failures.partitionSides = [new Set([a!]), new Set([b!])];
		mesh.failures.failingPeers = new Set([b!]);
		this.away = b;
	}

	return(mesh: Mesh): void {
		mesh.failures.partitionSides = undefined;
		mesh.failures.failingPeers = undefined;
		this.away = undefined;
	}
}

interface Group {
	mesh: Mesh;
	partner: PartnerAway;
	a: MeshDbNode;
	b: MeshDbNode;
	/** What A's gate hears its connection events from. */
	events: EventTarget;
	gate: KeyNetworkCohortReachability;
	/** Every status node A's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
}

/** Both nodes with `Notes` declared and one row committed while both are present; node A registered
 * with `offline`, its gate registered before the table was created, and the table read once. */
async function twoMachines(offline: Record<string, unknown>): Promise<Group> {
	const partner = new PartnerAway();
	const { mesh, transactorFor } = await startMockMesh(2, { wrapRepo: partner.wrap });
	const a = createMeshDbNode(transactorFor(0), { offline } as unknown as Record<string, SqlValue>);
	const events = new EventTarget();
	const gate = new KeyNetworkCohortReachability({
		keyNetwork: mesh.nodes[0]!.keyNetwork,
		selfId: mesh.nodes[0]!.peerId.toString(),
		events,
		wakeDebounceMs: 10,
	});
	a.plugin.collectionFactory.registerCohortReachability('shared:test', gate);
	const b = createMeshDbNode(transactorFor(1));
	const statuses: QueuedTransactionStatus[] = [];
	a.plugin.offline.onStatus(status => { statuses.push(status); });
	for (const node of [a, b]) await node.db.exec(createNotes);
	await a.db.exec(`insert into Notes (id, body) values (1, 'both present')`);
	await notesOf(a);
	return { mesh, partner, a, b, events, gate, statuses };
}

const notesOf = (node: MeshDbNode): Promise<Record<string, unknown>[]> => queryAll(node.db, 'select id, body from Notes order by id');

/** The kinds of `statuses`, each run of one kind collapsed to one. */
const kindRuns = (statuses: readonly QueuedTransactionStatus[]): string[] =>
	statuses.map(status => status.kind).filter((kind, index, kinds) => kind !== kinds[index - 1]);

type CommittedStatus = Extract<QueuedTransactionStatus, { kind: 'committed' }>;

interface Machine extends MeshDbNode {
	/** Every status this node's plugin reported, in order. */
	statuses: QueuedTransactionStatus[];
	/** Let this node's queue reach its cohort. */
	openGate(): void;
}

/** Both nodes registered with `offline`, each behind its own closed gate, with `creates` declared on both. */
async function twoOfflineMachines(...creates: string[]): Promise<{ a: Machine; b: Machine }> {
	const { transactorFor } = await startMockMesh(2);
	const machine = (index: number): Machine => {
		const node = createMeshDbNode(transactorFor(index), { offline: { recheck: { baseMs: 20, maxMs: 100 } } } as unknown as Record<string, SqlValue>);
		let open = false;
		node.plugin.collectionFactory.registerCohortReachability('shared:test', { reachable: () => Promise.resolve(open) });
		const statuses: QueuedTransactionStatus[] = [];
		node.plugin.offline.onStatus(status => { statuses.push(status); });
		return { ...node, statuses, openGate: () => { open = true; } };
	};
	const a = machine(0);
	const b = machine(1);
	for (const sql of creates) {
		await a.db.exec(sql);
		await b.db.exec(sql);
	}
	return { a, b };
}

/** Run `sql` as one offline transaction on `machine` and answer the id its `queued` status carried. */
async function queuedOn(machine: Machine, sql: string): Promise<string> {
	const before = machine.statuses.length;
	await machine.db.exec(sql);
	const queued = machine.statuses.slice(before).find(status => status.kind === 'queued');
	expect(queued, `a queued status was delivered before the commit resolved: ${sql}`).to.not.equal(undefined);
	return queued!.transactionId;
}

/** Open `machine`'s gate and wait for everything it queued to settle. */
async function drain(machine: Machine): Promise<void> {
	machine.openGate();
	await machine.plugin.offline.whenDrained();
}

const committedOn = (machine: Machine, transactionId: string): CommittedStatus | undefined =>
	machine.statuses.find((status): status is CommittedStatus => status.kind === 'committed' && status.transactionId === transactionId);

const failedOn = (machine: Machine, transactionId: string): FailedStatus | undefined =>
	machine.statuses.find((status): status is FailedStatus => status.kind === 'failed' && status.transactionId === transactionId);

const createTasks = `create table Tasks (id integer primary key, title text, done integer) using optimystic('tree://offline-two-machine/tasks')`;
const createTasksByDone = `create index TasksByDone on Tasks (done)`;
const createCounters = `create table Counters (name text primary key, n integer) using optimystic('tree://offline-two-machine/counters')`;
const createUsers = `create table Users (name text primary key, bio text) using optimystic('tree://offline-two-machine/users')`;
/** A blob store keyed by content hash: two machines storing the same content insert the same row. */
const createBlobs = `create table Blobs (hash text primary key, body text) using optimystic('tree://offline-two-machine/blobs') with tags ("optimystic.content_key" = true)`;

describe('Offline mode: two machines make the same change offline', function () {
	this.timeout(60_000);

	it('both mark the same task done: the second to drain commits already applied, and both read the task done, by index and by scan', async () => {
		const { a, b } = await twoOfflineMachines(createTasks, createTasksByDone);
		await a.db.exec(`insert into Tasks (id, title, done) values (1, 'write the tests', 0)`);
		const tasksOf = (machine: Machine): Promise<Record<string, unknown>[]> => queryAll(machine.db, 'select id, title, done from Tasks order by id');
		expect(await tasksOf(b), 'B holds the task before going offline').to.deep.equal([{ id: 1, title: 'write the tests', done: 0 }]);
		a.plugin.offline.enter();
		b.plugin.offline.enter();

		const onA = await queuedOn(a, `update Tasks set done = 1 where id = 1`);
		const onB = await queuedOn(b, `update Tasks set done = 1 where id = 1`);
		await drain(a);
		await drain(b);

		expect(committedOn(a, onA)?.effect).to.equal('applied');
		expect(committedOn(b, onB)?.effect, 'B found A had already made its change').to.equal('already-applied');
		for (const [name, machine] of [['A', a], ['B', b]] as const) {
			expect(await tasksOf(machine), `${name}'s scan`).to.deep.equal([{ id: 1, title: 'write the tests', done: 1 }]);
			expect(await queryAll(machine.db, 'select id from Tasks where done = 1'), `${name}'s index-driven read`).to.deep.equal([{ id: 1 }]);
			expect(await queryAll(machine.db, 'select id from Tasks where done = 0'), `${name}'s old index entry is gone`).to.deep.equal([]);
		}
	});

	it('both delete the same row: the second to drain commits already applied, and the row is gone on both', async () => {
		const { a, b } = await twoOfflineMachines(createTasks);
		await a.db.exec(`insert into Tasks (id, title, done) values (1, 'obsolete', 0)`);
		expect(await queryAll(b.db, 'select id from Tasks'), 'B holds the task before going offline').to.deep.equal([{ id: 1 }]);
		a.plugin.offline.enter();
		b.plugin.offline.enter();

		const onA = await queuedOn(a, `delete from Tasks where id = 1`);
		const onB = await queuedOn(b, `delete from Tasks where id = 1`);
		await drain(a);
		await drain(b);

		expect(committedOn(a, onA)?.effect).to.equal('applied');
		expect(committedOn(b, onB)?.effect).to.equal('already-applied');
		expect(await queryAll(a.db, 'select id from Tasks')).to.deep.equal([]);
		expect(await queryAll(b.db, 'select id from Tasks')).to.deep.equal([]);
	});

	it('both insert or replace the same row over an existing one: the second to drain commits already applied, and the index holds the replacement once', async () => {
		const { a, b } = await twoOfflineMachines(createTasks, createTasksByDone);
		await a.db.exec(`insert into Tasks (id, title, done) values (1, 'draft', 0)`);
		expect(await queryAll(b.db, 'select id from Tasks'), 'B holds the row before going offline').to.deep.equal([{ id: 1 }]);
		a.plugin.offline.enter();
		b.plugin.offline.enter();

		// The probe finds the key occupied on both, so each stages the REPLACE arm's rewrite, guarded on
		// the row it displaces; the second to drain finds the rival's replacement equal to its own.
		const onA = await queuedOn(a, `insert or replace into Tasks (id, title, done) values (1, 'final', 1)`);
		const onB = await queuedOn(b, `insert or replace into Tasks (id, title, done) values (1, 'final', 1)`);
		await drain(a);
		await drain(b);

		expect(committedOn(a, onA)?.effect).to.equal('applied');
		expect(committedOn(b, onB)?.effect, 'B found A had already made its replace').to.equal('already-applied');
		for (const [name, machine] of [['A', a], ['B', b]] as const) {
			expect(await queryAll(machine.db, 'select id, title, done from Tasks'), `${name}'s scan`).to.deep.equal([{ id: 1, title: 'final', done: 1 }]);
			expect(await queryAll(machine.db, 'select id from Tasks where done = 1'), `${name}'s index-driven read`).to.deep.equal([{ id: 1 }]);
			expect(await queryAll(machine.db, 'select id from Tasks where done = 0'), `${name}'s displaced index entry is gone`).to.deep.equal([]);
		}
	});

	it('both increment the same counter: the second to drain fails with concurrent-modification, and both read one increment', async () => {
		const { a, b } = await twoOfflineMachines(createCounters);
		await a.db.exec(`insert into Counters (name, n) values ('hits', 0)`);
		expect(await queryAll(b.db, 'select n from Counters'), 'B holds the counter before going offline').to.deep.equal([{ n: 0 }]);
		a.plugin.offline.enter();
		b.plugin.offline.enter();

		const onA = await queuedOn(a, `update Counters set n = n + 1 where name = 'hits'`);
		const onB = await queuedOn(b, `update Counters set n = n + 1 where name = 'hits'`);
		await drain(a);
		await drain(b);

		expect(committedOn(a, onA)?.effect).to.equal('applied');
		expect(failedOn(b, onB)?.reason, 'an increment is not self-independent: a rival\'s, then ours, is a different row').to.equal('concurrent-modification');
		expect(await queryAll(a.db, 'select n from Counters')).to.deep.equal([{ n: 1 }]);
		expect(await queryAll(b.db, 'select n from Counters'), 'B\'s increment left its view').to.deep.equal([{ n: 1 }]);
	});

	it('both insert the same row under a natural key: insert or ignore commits already applied on the second, a plain insert still fails with constraint', async () => {
		const { a, b } = await twoOfflineMachines(createUsers);
		a.plugin.offline.enter();
		b.plugin.offline.enter();

		const ignoreOnA = await queuedOn(a, `insert or ignore into Users (name, bio) values ('ann', 'a')`);
		const plainOnA = await queuedOn(a, `insert into Users (name, bio) values ('bob', 'b')`);
		const ignoreOnB = await queuedOn(b, `insert or ignore into Users (name, bio) values ('ann', 'a')`);
		const plainOnB = await queuedOn(b, `insert into Users (name, bio) values ('bob', 'b')`);
		await drain(a);
		await drain(b);

		expect(committedOn(a, ignoreOnA)?.effect).to.equal('applied');
		expect(committedOn(a, plainOnA)?.effect).to.equal('applied');
		expect(committedOn(b, ignoreOnB)?.effect, 'the row it wanted exists, and the disposition says that is not an error').to.equal('already-applied');
		expect(failedOn(b, plainOnB)?.reason, 'SQL says a duplicate is an error').to.equal('constraint');
		const users = [{ name: 'ann', bio: 'a' }, { name: 'bob', bio: 'b' }];
		expect(await queryAll(a.db, 'select name, bio from Users order by name')).to.deep.equal(users);
		expect(await queryAll(b.db, 'select name, bio from Users order by name')).to.deep.equal(users);
	});

	it('both plainly insert the same row into a content-keyed table: the second commits already applied; the same key under other content still fails with constraint', async () => {
		const { a, b } = await twoOfflineMachines(createBlobs);
		a.plugin.offline.enter();
		b.plugin.offline.enter();

		const sameOnA = await queuedOn(a, `insert into Blobs (hash, body) values ('h1', 'payload')`);
		const otherOnA = await queuedOn(a, `insert into Blobs (hash, body) values ('h2', 'from-a')`);
		const sameOnB = await queuedOn(b, `insert into Blobs (hash, body) values ('h1', 'payload')`);
		const otherOnB = await queuedOn(b, `insert into Blobs (hash, body) values ('h2', 'from-b')`);
		await drain(a);
		await drain(b);

		expect(committedOn(a, sameOnA)?.effect).to.equal('applied');
		expect(committedOn(a, otherOnA)?.effect).to.equal('applied');
		expect(committedOn(b, sameOnB)?.effect, 'the key is a function of the content, so the row the rival inserted IS this write').to.equal('already-applied');
		expect(failedOn(b, otherOnB)?.reason, 'the variant compares the whole row').to.equal('constraint');
		const blobs = [{ hash: 'h1', body: 'payload' }, { hash: 'h2', body: 'from-a' }];
		expect(await queryAll(a.db, 'select hash, body from Blobs order by hash')).to.deep.equal(blobs);
		expect(await queryAll(b.db, 'select hash, body from Blobs order by hash')).to.deep.equal(blobs);
	});
});

describe('Offline mode: a two-machine group with one member away', function () {
	this.timeout(60_000);

	it('a write on the machine left alone is queued and sent nowhere, a live read there serves it, and it drains as soon as the partner returns', async () => {
		// A re-check no sooner than 30 s (60 s less at most half of jitter): only the gate's wake can
		// explain a drain within the few seconds this case waits.
		const { mesh, partner, a, b, events, gate, statuses } = await twoMachines({ recheck: { baseMs: 60_000, maxMs: 60_000 } });
		try {
			a.plugin.offline.enter();
			partner.leave(mesh);
			const sendsBefore = partner.sends;

			await a.db.exec(`insert into Notes (id, body) values (2, 'B away')`);
			await waitFor(() => statuses.some(status => status.kind === 'queued' && status.waitingFor === 'cohort'),
				{ description: 'the entry to wait for its cohort' });
			expect(await notesOf(a), 'a live read on A serves the queued row').to.deep.equal([{ id: 1, body: 'both present' }, { id: 2, body: 'B away' }]);
			expect(a.plugin.offline.queueState().readsServedLocally).to.equal(true);
			expect(partner.sends - sendsBefore, 'nothing sent: not committed on A alone, nor on B').to.equal(0);

			partner.return(mesh);
			events.dispatchEvent(new Event('peer:identify'));
			await waitFor(() => statuses.some(status => status.kind === 'committed'), { description: 'the drain to commit on the wake', timeoutMs: 10_000 });

			expect(kindRuns(statuses)).to.deep.equal(['queued', 'submitting', 'committed']);
			expect(statuses.filter(status => status.kind === 'submitting'), 'submitted once').to.have.length(1);
			expect(new Set(statuses.map(status => status.transactionId)).size, 'one transaction throughout').to.equal(1);
			expect(await notesOf(b)).to.deep.equal([{ id: 1, body: 'both present' }, { id: 2, body: 'B away' }]);
		} finally {
			gate.stop();
		}
	});

	it('an entry that outlives expireAfterMs while the partner is away fails as expired, never sent', async () => {
		const { mesh, partner, a, b, gate, statuses } = await twoMachines({ expireAfterMs: 300, recheck: { baseMs: 50, maxMs: 100 } });
		try {
			a.plugin.offline.enter();
			partner.leave(mesh);
			const sendsBefore = partner.sends;

			await a.db.exec(`insert into Notes (id, body) values (2, 'expires')`);
			await waitFor(() => statuses.some(status => status.kind === 'failed'), { description: 'the entry to expire' });

			const failed = statuses.find((status): status is FailedStatus => status.kind === 'failed')!;
			expect(failed.reason).to.equal('expired');
			expect(failed.changedTables).to.deep.equal(['main.Notes']);
			expect(statuses.some(status => status.kind === 'submitting'), 'never submitted').to.equal(false);
			expect(partner.sends - sendsBefore, 'nothing sent').to.equal(0);
			expect(await notesOf(a), 'its row has left A\'s view').to.deep.equal([{ id: 1, body: 'both present' }]);

			partner.return(mesh);
			expect(await countTreeEntries(b.plugin, NOTES_URI), 'B never received it').to.equal(1);
		} finally {
			gate.stop();
		}
	});
});
