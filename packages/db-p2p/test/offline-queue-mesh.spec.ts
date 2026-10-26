/**
 * The offline-sync queue (`OfflineQueue` in `packages/db-core/src/offline/queue.ts`) on a real
 * two-member cohort, for the one path `TestTransactor` never takes: an entry over two collections
 * pended and committed as one consensus record per phase (`pendMany` / `commitMany`), see
 * docs/offline-sync.md §One entry, one network transaction. Everything else the queue does is pinned
 * on `TestTransactor` in `packages/db-core/test/offline-queue.spec.ts`.
 *
 * Node A's queue drains an entry over two trees, a "table" and its "index" (two collection ids),
 * with no reachability port, so the cohort is always reachable; node B reads the result through its
 * own transactor.
 */

import { expect } from 'chai';
import {
	Log,
	OfflineQueue,
	Tree,
	TreeKeyTakenError,
	type CollectionId,
	type EntryStatus,
	type IRepo,
	type ITransactor,
	type InFlightAttempt,
	type LogEntry,
} from '@optimystic/db-core';
import { buildNetworkTransactors, createMesh } from '../src/testing/mesh-harness.js';

interface Row {
	key: string;
	value: string;
}

const keyOf = (row: Row): string => row.key;
const row = (key: string, value: string): Row => ({ key, value });

const TABLE = 'offline-mesh/users';
const INDEX = 'offline-mesh/users/index/by-name';

type FailedStatus = Extract<EntryStatus, { kind: 'failed' }>;

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

/** A two-member mesh, each node's transactor counting the batches it sends, and both trees seeded
 * with one row through node B, so node A's handles open over committed collections. */
async function twoNodes(batches: BatchCounter): Promise<{ a: ITransactor; b: ITransactor }> {
	const mesh = await createMesh(2, { responsibilityK: 2, clusterSize: 2 });
	const transactors = buildNetworkTransactors(mesh, { wrapRepo: batches.wrap });
	const a = transactors.get(mesh.nodes[0]!.peerId.toString())!;
	const b = transactors.get(mesh.nodes[1]!.peerId.toString())!;
	for (const id of [TABLE, INDEX]) {
		const seeded = await Tree.createOrOpen<string, Row>(b, id, keyOf);
		await seeded.replace([['seed', row('seed', 'seed')]]);
	}
	return { a, b };
}

/** An offline queue over `transactor`, recording every status and every attempt its write-ahead hook
 * sees; `beforeSend` runs inside the hook, after the attempt is built and before it is sent. */
function openQueue(transactor: ITransactor, beforeSend?: () => Promise<void>) {
	const statuses: EntryStatus[] = [];
	const recorded: ReadonlyMap<CollectionId, InFlightAttempt>[] = [];
	const queue = new OfflineQueue(transactor, {
		recordAttempt: async (_entryId, attempts) => {
			recorded.push(attempts);
			await beforeSend?.();
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

describe('OfflineQueue on a two-member mesh', function () {
	this.timeout(30_000);

	it('drains an entry over a table and its index as one record per phase: node B reads both rows, and each log holds one entry under the entry\'s action id', async () => {
		const batches = new BatchCounter();
		const { a, b } = await twoNodes(batches);
		const { queue, statuses, recorded } = openQueue(a);
		const table = await openTree(a, queue, TABLE);
		const index = await openTree(a, queue, INDEX);
		await table.stage([['u1', row('u1', 'Ada')]]);
		await index.stage([['Ada', row('Ada', 'u1')]]);

		expect(queue.enqueue([table.getCollection(), index.getCollection()], { id: 'E1' })).to.not.equal(undefined);
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
		const { a, b } = await twoNodes(batches);
		const rival = await Tree.createOrOpen<string, Row>(b, TABLE, keyOf);
		let rivalDue = true;
		const { queue, statuses, recorded } = openQueue(a, async () => {
			if (!rivalDue) return;
			rivalDue = false;
			await rival.replace([['u1', row('u1', 'Rival')]]);
		});
		const table = await openTree(a, queue, TABLE);
		const index = await openTree(a, queue, INDEX);
		await table.stage([['u1', row('u1', 'Ada'), { kind: 'absent' }]]);
		await index.stage([['Ada', row('Ada', 'u1')]]);

		queue.enqueue([table.getCollection(), index.getCollection()], { id: 'E1' });
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
