/**
 * End-to-end regression for bug-external-commit-invisible-after-staged-txn:
 * `Collection.updateInternal` (packages/db-core/src/collection/collection.ts) used to
 * replay conflicting pending actions BEFORE advancing its revision cursor. A node with
 * an open transaction that had staged (but not synced) a change to a row would, on
 * discovering a concurrent external commit to that same row, re-cache the PRE-commit
 * content — and nothing ever invalidated it again. The loss was permanent: it survived
 * even after the node cancelled its own transaction.
 *
 * This drives the ticket's exact shape through the plugin: two `Database` instances
 * share one `StorageRepo`/`MemoryRawStorage` transactor. A opens a transaction and
 * stages an update to a row, B commits a conflicting update to the SAME row, A rolls
 * back, and A's next LIVE read must show B's committed value — checked twice, since the
 * persistence of the loss (not just a transient miss) is the interesting half.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

/** Build a `local`-style transactor over the supplied raw storage, shared across
 * Database instances so each side sees the other's commits (same shape as
 * committed-read-interleave.spec.ts). */
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

function registerWithSharedTransactor(db: Database, transactor: ITransactor) {
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

describe('External commit visibility after a staged, then rolled-back, transaction', function () {
	this.timeout(30_000);

	it("A's reads keep seeing B's commit after A rolls back its own staged (conflicting) change", async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		await dbA.exec(`
			create table Item (
				k integer primary key,
				v text
			) using optimystic('tree://external-commit/item')
		`);
		await dbA.exec(`insert into Item (k, v) values (1, 'seed')`);

		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		await pluginB.hydrate(dbB);

		try {
			await dbA.exec('begin');
			// A stages a change on the SAME row B will commit next, so the two conflict
			// on the same underlying block.
			await dbA.exec(`update Item set v = 'a-staged' where k = 1`);

			// B commits a different value to the SAME row while A's transaction is open.
			await dbB.exec(`update Item set v = 'b-committed' where k = 1`);

			// A LIVE read INSIDE the still-open transaction: every vtab read pulls
			// (`collection.update()`), and this is the one that must observe the pending
			// conflict and replay it — the moment the bug re-caches pre-commit content.
			// A's own staged value masks the result here (this SELECT is expected to
			// return 'a-staged'), but it is what forces the replay to run while A's
			// conflicting pending action is still in place.
			const inTxn = await collectRows(dbA.eval(`select v from Item where k = 1`));
			expect(inTxn.map(r => r.v)).to.deep.equal(['a-staged']);

			await dbA.exec('rollback');

			// A's next LIVE read must observe B's committed value — not the pre-commit
			// seed content the conflict replay may have re-cached, and not A's own
			// rolled-back staged value.
			const first = await collectRows(dbA.eval(`select v from Item where k = 1`));
			expect(first.map(r => r.v)).to.deep.equal(['b-committed']);

			// Read again: the persistence of the loss (not just a transient miss) is the
			// interesting half of this regression.
			const second = await collectRows(dbA.eval(`select v from Item where k = 1`));
			expect(second.map(r => r.v)).to.deep.equal(['b-committed']);
		} finally {
			dbA.close();
			dbB.close();
		}
	});
});
