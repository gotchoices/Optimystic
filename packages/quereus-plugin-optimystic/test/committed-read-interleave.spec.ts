/**
 * Interleave probe for the pinned committed read view (ticket
 * `committed-read-pinned-snapshot`).
 *
 * A committed (`committed.<Table>`) scan used to read through the SAME block cache the
 * live collection mutates: a live read in the same statement runs `collection.update()`,
 * which clears cached blocks when another writer has committed, and the committed scan
 * would then finish its walk against post-commit blocks — a row set from two different
 * points in time.
 *
 * This spec drives that interleave end-to-end through the plugin, in ONE statement:
 * a `committed.Usage` scan whose per-row correlated subquery scans live `Usage` (each
 * live scan calls `collection.update()`), pulled row-by-row via `db.eval`, with a second
 * Database instance (sharing the same storage) committing inserts and a delete between
 * pulls. The committed scan must return exactly the rows that were committed when it
 * began — no mid-scan rows, no mid-scan disappearances, and never the in-flight row.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage, StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';

type Row = Record<string, SqlValue>;

/** Build a `local`-style transactor over the supplied raw storage, shared across
 * Database instances so each side sees the other's commits (same shape as
 * catalog-hydration.spec.ts). */
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

describe('Committed-read interleave (live scan + committed scan in one statement)', function () {
	this.timeout(30_000);

	it('a committed scan is unchanged by a commit that lands (and is pulled in by update()) mid-scan', async () => {
		const storage = new MemoryRawStorage();
		const shared = buildSharedLocalTransactor(storage);

		// Writer/reader database: creates the table and runs the probe statement.
		const dbA = new Database();
		registerWithSharedTransactor(dbA, shared);
		await dbA.exec(`
			create table Usage (
				k integer primary key,
				v text
			) using optimystic('tree://interleave/usage')
		`);

		const initialKeys: number[] = [];
		const values: string[] = [];
		for (let k = 1; k <= 200; k++) {
			initialKeys.push(k);
			values.push(`(${k}, 'v${k}')`);
		}
		await dbA.exec(`insert into Usage (k, v) values ${values.join(', ')}`);

		// External writer: a second Database over the SAME storage.
		const dbB = new Database();
		const pluginB = registerWithSharedTransactor(dbB, shared);
		await pluginB.hydrate(dbB);

		try {
			// Open a transaction and stage a row so the committed view really is the
			// captured pre-transaction snapshot (a clean tree would read live directly).
			await dbA.exec('begin');
			await dbA.exec(`insert into Usage (k, v) values (100000, 'inflight')`);

			// ONE statement interleaving both read modes: the outer scan is committed,
			// the correlated subquery scans live Usage — each evaluation runs
			// collection.update(), which is the cache-clearing arm under probe.
			const probeSql = `
				select U.k as k, (select count(*) from Usage L where L.k <= U.k) as live
				from committed.Usage U
			`;
			const iter = dbA.eval(probeSql)[Symbol.asyncIterator]() as AsyncIterator<Row>;
			const rows: Row[] = [];

			const first = await iter.next();
			expect(first.done, 'probe scan yielded no rows').to.equal(false);
			rows.push(first.value);

			// Mid-scan external commit: new rows past the scan frontier, plus deletion of
			// a committed row the scan has not reached yet.
			await dbB.exec(`insert into Usage (k, v) values (5001, 'mid'), (5002, 'mid'), (5003, 'mid')`);
			await dbB.exec(`delete from Usage where k = 150`);

			for (let r = await iter.next(); !r.done; r = await iter.next()) {
				rows.push(r.value);
			}
			await dbA.exec('rollback');

			// The committed view was created before the mid-scan commit: it must show
			// exactly the initial 200 keys — k=150 still present, no 5001..5003, and
			// never the in-flight k=100000. (Numeric sort: the vtab stores integer PKs
			// as encoded strings, so the scan itself yields lexicographic key order.)
			const keys = rows.map(r => Number(r.k)).sort((a, b) => a - b);
			expect(keys).to.deep.equal(initialKeys);
		} finally {
			dbA.close();
			dbB.close();
		}
	});
});
