/**
 * A watch on the second machine of a two-machine group wakes for the first machine's insert only once
 * the table AND its index have landed there — GitHub #47, the Sereus report, reproduced on the
 * in-process mesh.
 *
 * A row's insert commits the table and the index under one action id. Whether the two travel in one
 * consensus record (the batched commit) or in two (when they cannot go as one), node 1 applies them as
 * two `StorageRepo.commit` calls, the table's first. Before the storage-side hold
 * (`StorageRepo.emitCollectionChanges`), node 1's vtab was woken by the table's commit, looked the row
 * up through the index from node 1's own replica — which did not hold the index's commit yet — and
 * found nothing; the index's own event wakes nobody, so the app saw the row at its next poll or never.
 *
 * To make the gap deterministic rather than a race, node 1's apply of the index's commit is made to lag
 * its apply of the table's: node 1's storage holds every commit of the index's log tail on a gate that
 * node 1's wake handler releases after it has run its lookups, or a fallback delay when the handler
 * does not run before the index lands. The gate sits at storage rather than on the cluster delivery
 * because a batched record delivers both commits at once, and it covers BOTH storage seams — the
 * public `commit` and the write group a member applies a record's commits inside — since a gate on
 * `commit` alone is one a batched apply walks straight past.
 *
 * The second case runs the same scenario with the hold disabled. On this mesh the table and the index
 * travel in ONE consensus record, which node 1 applies inside one storage write group: neither event
 * fires until the group's single flush, by which time both have landed. So the wake sees both with the
 * hold or without it, and that is what the control pins — it fails if a record's collections ever go
 * back to a flush and an emission each.
 *
 * NOTE: no case here reproduces #47's original race any more. That race needs the table's event to
 * fire while the index is still unlanded, and a one-record action cannot do it. The hold still closes
 * the race where an action's collections travel as SEPARATE records, and that shape is pinned at the
 * storage tier (`packages/db-p2p/test/action-change-hold.spec.ts`, and the hold cases in
 * `packages/db-p2p/test/storage-repo.spec.ts`) rather than here. To reproduce the race end to end
 * again, this scenario would have to make the table and the index land in different records.
 */

import { expect } from 'chai';
import { defaultCollectionUri } from '../dist/index.js';
import type { Database, SqlValue } from '@quereus/quereus';
import { Collection, type CollectionId, type CommitRequest } from '@optimystic/db-core';
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

/**
 * How long node 1's apply of the index's commit lags the table's before the gate releases itself.
 * Well over an in-process wake handler's run — and for a one-record action it is always what
 * releases, since the handler cannot run until the whole group has landed and flushed.
 */
const INDEX_LAG_FALLBACK_MS = 400;

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

	let latestId = 0;
	let indexLag: ReturnType<typeof gate> | undefined;
	const watcherStorage = mesh.nodes[1]!.storageRepo;
	const applyCommit = watcherStorage.commit.bind(watcherStorage);
	const applyInOneGroup = watcherStorage.applyInOneGroup.bind(watcherStorage);
	const lagTheIndex = async (request: CommitRequest): Promise<void> => {
		if (indexLag !== undefined && request.tailId === indexTail!.tailId) {
			await indexLag.promise;
		}
	};
	watcherStorage.commit = async (request, options, apply) => {
		await lagTheIndex(request);
		return await applyCommit(request, options, apply);
	};
	// A cohort member applies a consensus record's commits inside ONE storage write group, whose
	// handle writes under each request's latches without going through `commit` — so the gate has to
	// cover the group too, or node 1 applies the index's commit at once and the lag never happens.
	watcherStorage.applyInOneGroup = (apply, body) => applyInOneGroup(apply, group => body({
		pend: group.pend,
		commit: async (request, options, proof) => {
			await lagTheIndex(request);
			return await group.commit(request, options, proof);
		}
	}));

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
			watcherStorage.commit = applyCommit;
			watcherStorage.applyInOneGroup = applyInOneGroup;
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

	it('control: with the hold disabled, the record\'s one write group still lands the index before the wake', async () => {
		const run = await scenario({ changeHoldMs: 0 }, INDEX_LAG_FALLBACK_MS);
		try {
			await run.insert(1);
			expect(run.wakes.some(wake => wake.id === 1 && wake.byPrimaryKey && !wake.byIndex),
				`no wake may find the row by primary key alone; wakes: ${JSON.stringify(run.wakes)}`).to.equal(false);
			expect(run.wakes.some(wake => wake.id === 1 && wake.byIndex),
				`the wake finds the row through the index; wakes: ${JSON.stringify(run.wakes)}`).to.equal(true);
		} finally {
			await run.close();
		}
	});
});
