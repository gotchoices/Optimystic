/**
 * The offline-sync queue (`OfflineQueue` in `packages/db-core/src/offline/queue.ts`) on a real
 * two-member cohort, for the paths `TestTransactor` never takes: an entry over two collections
 * pended and committed as one consensus record per phase (`pendMany` / `commitMany`), see
 * docs/offline-sync.md §One entry, one network transaction; and the solo refusal, a lone coordinator
 * declining to commit an entry while it knows its partner is missing, see docs/offline-sync.md §When
 * to submit: the reachability gate. Everything else the queue does is pinned on `TestTransactor` in
 * `packages/db-core/test/offline-queue.spec.ts`.
 *
 * Node A's queue drains its entries with no reachability port, so the gate always says the cohort is
 * reachable and only the refusal stands between the drain and a lone commit; node B reads the result
 * through its own transactor.
 */

import { expect } from 'chai';
import {
	Log,
	OfflineQueue,
	PromiseShortfallError,
	Tree,
	TreeKeyTakenError,
	type BlockId,
	type CollectionId,
	type EntryStatus,
	type IRepo,
	type ITransactor,
	type InFlightAttempt,
	type LogEntry,
} from '@optimystic/db-core';
import { buildNetworkTransactors, createMesh, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;
const row = (key: string, value: string): Row => ({ key, value });

const TABLE = 'offline-mesh/users';
const INDEX = 'offline-mesh/users/index/by-name';
/** A collection node A creates itself, never written before the solo-refusal cases. */
const NOTES = 'offline-mesh/notes';

type FailedStatus = Extract<EntryStatus, { kind: 'failed' }>;
type QueuedStatus = Extract<EntryStatus, { kind: 'queued' }>;
type CommittedStatus = Extract<EntryStatus, { kind: 'committed' }>;

/** Counts the batched requests any coordinator receives, so a case can say its entry went as one
 * record per phase rather than one request per collection. */
class BatchCounter {
	pends = 0;
	commits = 0;

	readonly wrap = (repo: IRepo): IRepo => {
		const pendMany = repo.pendMany?.bind(repo);
		const commitMany = repo.commitMany?.bind(repo);
		return {
			get: (blockGets, options) => repo.get(blockGets, options),
			pend: (request, options) => repo.pend(request, options),
			cancel: (actionRef, options) => repo.cancel(actionRef, options),
			commit: (request, options) => repo.commit(request, options),
			...(pendMany ? { pendMany: (...args: Parameters<typeof pendMany>) => { this.pends++; return pendMany(...args); } } : {}),
			...(commitMany ? { commitMany: (...args: Parameters<typeof commitMany>) => { this.commits++; return commitMany(...args); } } : {}),
		};
	};
}

/**
 * Cuts node B off from node A, and back. While cut, each node's own key-network view holds only itself
 * and names the other as a cohort member it could not place (`failures.partitionSides`, which the mesh's
 * `absentCohortMembers` reads), cluster traffic to B fails (`failures.failingPeers`), and every repo
 * request a transactor sends to B throws, as a dropped connection does — so node A's transactor
 * coordinates through A, whose cohort is A alone.
 */
class PartnerCut {
	private unreachable: string | undefined;

	readonly wrap = (repo: IRepo, node: MeshNode): IRepo => {
		const reach = <T>(call: () => Promise<T>): Promise<T> => this.unreachable === node.peerId.toString()
			? Promise.reject(new Error(`${node.peerId.toString()} is unreachable`))
			: call();
		const pendMany = repo.pendMany?.bind(repo);
		const commitMany = repo.commitMany?.bind(repo);
		return {
			get: (blockGets, options) => reach(() => repo.get(blockGets, options)),
			pend: (request, options) => reach(() => repo.pend(request, options)),
			cancel: (actionRef, options) => reach(() => repo.cancel(actionRef, options)),
			commit: (request, options) => reach(() => repo.commit(request, options)),
			...(pendMany ? { pendMany: (...args: Parameters<typeof pendMany>) => reach(() => pendMany(...args)) } : {}),
			...(commitMany ? { commitMany: (...args: Parameters<typeof commitMany>) => reach(() => commitMany(...args)) } : {}),
		};
	};

	sever(mesh: Mesh): void {
		const [a, b] = mesh.nodes.map(node => node.peerId.toString());
		mesh.failures.partitionSides = [new Set([a!]), new Set([b!])];
		mesh.failures.failingPeers = new Set([b!]);
		this.unreachable = b;
	}

	heal(mesh: Mesh): void {
		mesh.failures.partitionSides = undefined;
		mesh.failures.failingPeers = undefined;
		this.unreachable = undefined;
	}
}

/** A two-member mesh, each node's transactor reaching the others through `wrapRepo`, and each of
 * `seeded` written with one row through node B, so node A's handles open over committed collections. */
async function twoNodes(wrapRepo: (repo: IRepo, node: MeshNode) => IRepo, seeded: readonly CollectionId[] = [TABLE, INDEX]): Promise<{ mesh: Mesh; a: ITransactor; b: ITransactor }> {
	const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2 });
	const transactors = buildNetworkTransactors(mesh, { wrapRepo });
	const a = transactors.get(mesh.nodes[0]!.peerId.toString())!;
	const b = transactors.get(mesh.nodes[1]!.peerId.toString())!;
	for (const id of seeded) {
		const seed = await Tree.createOrOpen<string, Row>(b, id, keyOf);
		await seed.replace([['seed', row('seed', 'seed')]]);
	}
	return { mesh, a, b };
}

/** An offline queue over `transactor`, recording every status and every attempt its journal's
 * write-ahead sees; `beforeSend` runs inside the journal's `driving`, after the attempt is built and
 * before it is sent. */
function openQueue(options: { beforeSend?: () => Promise<void>; allowSoloCommit?: boolean } = {}) {
	const { beforeSend, allowSoloCommit } = options;
	const statuses: EntryStatus[] = [];
	const recorded: ReadonlyMap<CollectionId, InFlightAttempt>[] = [];
	const queue = new OfflineQueue({
		...(allowSoloCommit === undefined ? {} : { allowSoloCommit }),
		journal: {
			queued: async () => {},
			driving: async (_entryId, state) => {
				recorded.push(state.attempts);
				await beforeSend?.();
			},
			settled: async () => {},
		},
	});
	queue.onStatus(status => statuses.push(status));
	return { queue, statuses, recorded };
}

function openTree(transactor: ITransactor, queue: OfflineQueue, id: CollectionId): Promise<Tree<string, Row>> {
	return Tree.createOrOpen<string, Row>(transactor, id, keyOf, undefined, undefined, {
		onSealedRefused: queue.onSealedRefused,
	});
}

/** The committed log entries of `id` under `actionId`, read through a fresh handle over `transactor`. */
async function entriesUnder(transactor: ITransactor, id: CollectionId, actionId: string): Promise<LogEntry<unknown>[]> {
	const fresh = await Tree.createOrOpen<string, Row>(transactor, id, keyOf);
	const log = await Log.open<unknown>(fresh.getCollection().tracker, id);
	const found: LogEntry<unknown>[] = [];
	for await (const logEntry of log!.select()) {
		if (logEntry.action?.actionId === actionId) found.push(logEntry);
	}
	return found;
}

async function readOn(transactor: ITransactor, id: CollectionId, key: string): Promise<Row | undefined> {
	return (await Tree.createOrOpen<string, Row>(transactor, id, keyOf)).get(key);
}

/** The revision of `blockId` committed in `node`'s own storage, read without consulting anyone. */
async function committedRevOn(node: MeshNode, blockId: BlockId): Promise<number | undefined> {
	return (await node.storageRepo.get({ blockIds: [blockId] }))[blockId]?.state.latest?.rev;
}

/** The next status `queue` emits that `matches`. */
function nextStatus<T extends EntryStatus>(queue: OfflineQueue, matches: (status: EntryStatus) => status is T): Promise<T> {
	return new Promise(resolve => {
		const unsubscribe = queue.onStatus(status => {
			if (matches(status)) {
				unsubscribe();
				resolve(status);
			}
		});
	});
}

const waitingForCohort = (status: EntryStatus): status is QueuedStatus => status.kind === 'queued' && status.waitingFor === 'cohort';
const committed = (status: EntryStatus): status is CommittedStatus => status.kind === 'committed';

describe('OfflineQueue on a two-member mesh', function () {
	this.timeout(30_000);

	it('drains an entry over a table and its index as one record per phase: node B reads both rows, and each log holds one entry under the entry\'s action id', async () => {
		const batches = new BatchCounter();
		const { a, b } = await twoNodes(batches.wrap);
		const { queue, statuses, recorded } = openQueue();
		const table = await openTree(a, queue, TABLE);
		const index = await openTree(a, queue, INDEX);
		await table.stage([['u1', row('u1', 'Ada')]]);
		await index.stage([['Ada', row('Ada', 'u1')]]);

		expect(await queue.enqueue([table.getCollection(), index.getCollection()], { id: 'E1' })).to.not.equal(undefined);
		await queue.whenDrained();

		expect(statuses.map(s => s.kind)).to.deep.equal(['queued', 'submitting', 'committed']);
		expect(batches.pends, 'pended as one record').to.be.at.least(1);
		expect(batches.commits, 'committed as one record').to.be.at.least(1);
		const actionId = recorded[0]!.get(TABLE)!.actionId;
		expect(recorded[0]!.get(INDEX)!.actionId, 'one action id for the entry').to.equal(actionId);
		expect(await entriesUnder(b, TABLE, actionId)).to.have.length(1);
		expect(await entriesUnder(b, INDEX, actionId)).to.have.length(1);
		expect(await readOn(b, TABLE, 'u1')).to.deep.equal(row('u1', 'Ada'));
		expect(await readOn(b, INDEX, 'Ada')).to.deep.equal(row('Ada', 'u1'));
		await queue.dispose();
	});

	it('fails the entry with constraint when a rival on node B takes the table key between the entry\'s refresh and its pend: the batched pend is refused, and node B holds nothing under the entry\'s action id in either collection', async () => {
		const batches = new BatchCounter();
		const { a, b } = await twoNodes(batches.wrap);
		const rival = await Tree.createOrOpen<string, Row>(b, TABLE, keyOf);
		let rivalDue = true;
		const { queue, statuses, recorded } = openQueue({
			beforeSend: async () => {
				if (!rivalDue) return;
				rivalDue = false;
				await rival.replace([['u1', row('u1', 'Rival')]]);
			}
		});
		const table = await openTree(a, queue, TABLE);
		const index = await openTree(a, queue, INDEX);
		await table.stage([['u1', row('u1', 'Ada'), { kind: 'absent' }]]);
		await index.stage([['Ada', row('Ada', 'u1')]]);

		await queue.enqueue([table.getCollection(), index.getCollection()], { id: 'E1' });
		await queue.whenDrained();

		const failed = statuses.find((s): s is FailedStatus => s.kind === 'failed' && s.entryId === 'E1');
		expect(failed?.reason).to.equal('constraint');
		expect(failed?.error).to.be.instanceOf(TreeKeyTakenError);
		expect(failed?.changedCollections, 'both segments were dropped').to.have.members([TABLE, INDEX]);
		expect(failed?.committedCollections, 'nothing of it committed').to.equal(undefined);
		expect(recorded, 'one attempt was sent before the refusal').to.have.length(1);
		expect(batches.pends, 'pended as one record').to.be.at.least(1);
		const actionId = recorded[0]!.get(TABLE)!.actionId;
		expect(await entriesUnder(b, TABLE, actionId)).to.have.length(0);
		expect(await entriesUnder(b, INDEX, actionId)).to.have.length(0);
		expect(await readOn(b, TABLE, 'u1')).to.deep.equal(row('u1', 'Rival'));
		expect(await readOn(b, INDEX, 'Ada')).to.equal(undefined);
		expect(await table.get('u1'), 'node A\'s view shows the rival\'s row').to.deep.equal(row('u1', 'Rival'));
		await queue.dispose();
	});
});

describe('OfflineQueue on a two-member mesh: an entry is not committed by node A alone', function () {
	this.timeout(30_000);

	/** Node A with `NOTES` open (created by A, so nothing of it is committed anywhere), then cut off from
	 * node B, and a queue over A with one note staged and enqueued. */
	async function cutOffWithOneNote(queueOptions: { allowSoloCommit?: boolean } = {}) {
		const cut = new PartnerCut();
		const { mesh, a, b } = await twoNodes(cut.wrap, []);
		const { queue, statuses } = openQueue(queueOptions);
		const notes = await openTree(a, queue, NOTES);
		cut.sever(mesh);
		await notes.stage([['n1', row('n1', 'offline')]]);
		return { cut, mesh, a, b, queue, statuses, notes };
	}

	it('while node A knows node B is missing, the entry waits for its cohort instead of committing alone, and drains once B is back', async () => {
		const { cut, mesh, a, b, queue, statuses, notes } = await cutOffWithOneNote();
		const [nodeA, nodeB] = mesh.nodes;

		const waiting = nextStatus(queue, waitingForCohort);
		await queue.enqueue([notes.getCollection()], { id: 'E1' });
		const queued = await waiting;

		expect(queued.attempts, 'it was sent, and refused').to.be.at.least(1);
		expect(queued.lastError).to.be.instanceOf(PromiseShortfallError);
		const refusal = queued.lastError as PromiseShortfallError;
		expect(refusal.soloRefused).to.equal('absent-members');
		expect(refusal.silentPeers).to.deep.equal([nodeB!.peerId.toString()]);
		expect(statuses.some(committed), 'never settled by a lone commit').to.equal(false);
		expect(await committedRevOn(nodeA!, NOTES), 'node A committed nothing of the collection').to.equal(undefined);
		expect(await committedRevOn(nodeB!, NOTES), 'node B committed nothing of the collection').to.equal(undefined);

		cut.heal(mesh);
		const settled = nextStatus(queue, committed);
		queue.wake();
		const done = await settled;
		await queue.whenDrained();

		expect(done.durability.collections.get(NOTES)?.quorum, 'committed by the cohort of two').to.equal('full');
		expect(await readOn(b, NOTES, 'n1')).to.deep.equal(row('n1', 'offline'));
		expect(await readOn(a, NOTES, 'n1')).to.deep.equal(row('n1', 'offline'));
		await queue.dispose();
	});

	it('a queue built with allowSoloCommit commits the entry alone, at local, naming node B as owed', async () => {
		const { mesh, queue, notes } = await cutOffWithOneNote({ allowSoloCommit: true });
		const nodeB = mesh.nodes[1]!;

		const settled = nextStatus(queue, committed);
		await queue.enqueue([notes.getCollection()], { id: 'E1' });
		const done = await settled;
		await queue.whenDrained();

		const durability = done.durability.collections.get(NOTES);
		expect(durability?.quorum).to.equal('local');
		expect(durability?.unconfirmed).to.deep.equal([nodeB.peerId.toString()]);
		await queue.dispose();
	});

	it('a node that is genuinely alone commits the entry at local, with nobody owed', async () => {
		const mesh = await createMesh(1, { responsibilityK: 1, clusterSize: 1 });
		const solo = buildNetworkTransactors(mesh).get(mesh.nodes[0]!.peerId.toString())!;
		const { queue } = openQueue();
		const notes = await openTree(solo, queue, NOTES);
		await notes.stage([['n1', row('n1', 'alone')]]);

		const settled = nextStatus(queue, committed);
		await queue.enqueue([notes.getCollection()], { id: 'E1' });
		const done = await settled;
		await queue.whenDrained();

		const durability = done.durability.collections.get(NOTES);
		expect(durability?.quorum).to.equal('local');
		expect(durability?.unconfirmed).to.deep.equal([]);
		expect(await readOn(solo, NOTES, 'n1')).to.deep.equal(row('n1', 'alone'));
		await queue.dispose();
	});
});
