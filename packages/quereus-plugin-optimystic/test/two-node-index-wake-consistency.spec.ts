/**
 * A watch on the second machine of a two-machine group wakes for the first machine's insert only once
 * the table AND its index have landed there — GitHub #47, the Sereus report, reproduced on the
 * in-process mesh.
 *
 * A row's insert pends and commits the table and the index as separate consensus records under one
 * action id, so node 1 applies them as two `StorageRepo.commit` calls. Before the storage-side hold
 * (`StorageRepo.emitCollectionChanges`), node 1's vtab was woken by the table's commit, looked the row
 * up through the index from node 1's own replica — which did not hold the index's commit yet — and
 * found nothing; the index's own event wakes nobody, so the app saw the row at its next poll or never.
 *
 * To make the gap deterministic rather than a race, node 1's apply of the index's commit is made to lag
 * its apply of the table's: every cluster delivery to node 1 carrying a commit of the index's log tail
 * waits on a gate that node 1's wake handler releases after it has run its lookups (or a fallback
 * delay, since with the hold in place the handler does not run until the index lands). The second
 * case runs the same scenario with the hold disabled and observes the gap, so the first case cannot
 * pass for want of the race it is meant to close.
 */

import { expect } from 'chai';
import { defaultCollectionUri } from '../dist/index.js';
import type { Database, SqlValue } from '@quereus/quereus';
import { Collection, type BlockId, type ClusterRecord, type CollectionId } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { collectionIdOf } from './trace-helpers.js';
import { createMeshDbNode, startMockMesh, type MockMeshOptions } from './mesh-node-harness.js';

type Row = Record<string, SqlValue>;

/** Where a `main.T` declared without an explicit URI would live — spelled out so both nodes agree. */
const TABLE_URI = defaultCollectionUri('main', 'T');
const INDEX_URI = `${TABLE_URI}/index/TByK`;
const INDEX_COLLECTION_ID = collectionIdOf(INDEX_URI) as CollectionId;

const createTableSql = `create table T (Id integer primary key, K text) using optimystic('${TABLE_URI}')`;
const createIndexSql = `create index TByK on T (K)`;

/** How long node 1's apply of the index's commit lags the table's when nothing releases it sooner — well over an in-process wake handler's run. */
const INDEX_LAG_FALLBACK_MS = 400;
/** The control's fallback is a safety net only: there the wake handler always runs and releases the gate itself. */
const CONTROL_FALLBACK_MS = 10_000;

async function collect(db: Database, sql: string): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(row as Row);
	}
	return rows;
}

/** What node 1's wake handler found for the row it was told to look for. */
interface Wake {
	id: number;
	byPrimaryKey: boolean;
	byIndex: boolean;
}

/** A promise a held delivery waits on: released by the wake handler, or after `fallbackMs` when the handler does not run. */
function gate(fallbackMs: number): { promise: Promise<void>; release(): void } {
	let open!: () => void;
	const promise = new Promise<void>(resolve => { open = resolve; });
	const timer = setTimeout(() => open(), fallbackMs);
	return { promise, release: () => { clearTimeout(timer); open(); } };
}

/** Whether any of `records` commits the collection whose log tail is `tailId`. */
function commitsTail(records: readonly ClusterRecord[], tailId: BlockId): boolean {
	return records.some(record => record.message.operations.some(op => 'commit' in op && op.commit.tailId === tailId));
}

interface Scenario {
	/** Every wake node 1's handler ran, in order. */
	readonly wakes: readonly Wake[];
	/** Insert row `id` on node 0 and wait for node 1 to wake for it. */
	insert(id: number): Promise<void>;
	close(): Promise<void>;
}

/**
 * Table `T (Id primary key, K)` with index `TByK on T (K)`, created on node 0 and declared on node 1;
 * node 1 watches `select Id, K from T` and, at every wake, looks the newest row up by primary key and
 * through the index. Node 1's apply of the index's commit lags its apply of the table's by at least the
 * handler's run, or `indexLagFallbackMs`.
 */
async function scenario(meshOptions: MockMeshOptions, indexLagFallbackMs: number): Promise<Scenario> {
	// `notifyLocalChanges` is what lets node 1's vtab hear node 1's storage; `selfFirstReads` is what makes
	// node 1's lookups read node 1's own replica, as a real node does — served by node 0, which already holds
	// everything, the lookup would find the row whether or not the hold exists.
	const { mesh, transactorFor } = await startMockMesh(2, { notifyLocalChanges: true, selfFirstReads: true, ...meshOptions });
	const writer = createMeshDbNode(transactorFor(0));
	const watcher = createMeshDbNode(transactorFor(1));

	await writer.db.exec(createTableSql);
	await writer.db.exec(createIndexSql);
	// The index's log exists only once something has committed to it; its tail is how the delivery hold
	// below recognizes the index's commit records.
	await writer.db.exec(`insert into T (Id, K) values (0, 'k-0')`);
	await watcher.db.exec(createTableSql);
	await watcher.db.exec(createIndexSql);
	const indexTail = await Collection.readCommittedTail(transactorFor(0), INDEX_COLLECTION_ID);
	expect(indexTail, 'the index collection has a committed tail after the seed insert').to.not.equal(undefined);

	const watcherPeer = mesh.nodes[1]!.peerId.toString();
	let latestId = 0;
	let indexLag: ReturnType<typeof gate> | undefined;
	mesh.failures.onClusterDelivery = async (target, record, carried) => {
		if (target === watcherPeer && indexLag !== undefined && commitsTail([record, ...carried], indexTail!.tailId)) {
			await indexLag.promise;
		}
	};

	const wakes: Wake[] = [];
	const subscription = watcher.db.watch(watcher.db.prepare('select Id, K from T').getChangeScope(), async () => {
		const id = latestId;
		const byPrimaryKey = (await collect(watcher.db, `select Id from T where Id = ${id}`)).length === 1;
		const byIndex = (await collect(watcher.db, `select Id from T where K = 'k-${id}'`)).length === 1;
		wakes.push({ id, byPrimaryKey, byIndex });
		indexLag?.release();
	});

	return {
		wakes,
		async insert(id: number): Promise<void> {
			latestId = id;
			indexLag = gate(indexLagFallbackMs);
			await writer.db.exec(`insert into T (Id, K) values (${id}, 'k-${id}')`);
			await waitFor(() => wakes.some(wake => wake.id === id), { timeoutMs: 15_000, description: `node 1's watch woke for row ${id}` });
			indexLag.release();
			indexLag = undefined;
		},
		async close(): Promise<void> {
			subscription.unsubscribe();
			mesh.failures.onClusterDelivery = undefined;
			await watcher.db.close();
			await writer.db.close();
		}
	};
}

describe('Two-node watch wake sees the table and its index together (GitHub #47)', function () {
	this.timeout(60_000);

	it('every wake on the storing sibling that finds the row by primary key also finds it through the index', async () => {
		const run = await scenario({}, INDEX_LAG_FALLBACK_MS);
		try {
			const rows = [1, 2, 3, 4];
			for (const id of rows) {
				await run.insert(id);
			}
			for (const wake of run.wakes) {
				expect(!wake.byPrimaryKey || wake.byIndex,
					`the wake for row ${wake.id} found it by primary key (${wake.byPrimaryKey}) but not through the index (${wake.byIndex})`).to.equal(true);
			}
			for (const id of rows) {
				expect(run.wakes.some(wake => wake.id === id && wake.byIndex), `row ${id} was seen through the index at some wake`).to.equal(true);
			}
		} finally {
			await run.close();
		}
	});

	it('control: with the hold disabled, the wake that finds the row by primary key misses it through the index', async () => {
		const run = await scenario({ changeHoldMs: 0 }, CONTROL_FALLBACK_MS);
		try {
			await run.insert(1);
			expect(run.wakes.some(wake => wake.id === 1 && wake.byPrimaryKey && !wake.byIndex),
				`without the hold the table's event wakes node 1 before the index lands there; wakes: ${JSON.stringify(run.wakes)}`).to.equal(true);
		} finally {
			await run.close();
		}
	});
});
