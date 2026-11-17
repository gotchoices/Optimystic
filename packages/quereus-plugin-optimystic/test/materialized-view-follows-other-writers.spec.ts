/**
 * GitHub #58: a materialized view over an Optimystic table follows rows another writer commits.
 *
 * Two `Database`s share one `StorageRepo` — the node's own storage, so each hears every commit applied
 * to it, its own included, as the `local` transactor does. A holds the view. A commit B makes must
 * reach A's view once A's follower has settled (`MaterializedViewFollower` in
 * `src/optimystic-adapter/materialized-view-follower.ts`); A's own commits must not rebuild it, and a
 * rebuild owed while A holds an explicit transaction open waits for it to end. Rebuilds are counted by
 * A's `materialized_view_refreshed` schema events.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { ITransactor } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { buildSharedNotifyingTransactor } from './shared-local-transactor.js';

type Row = Record<string, SqlValue>;

const collectRows = async (iter: AsyncIterable<Row>): Promise<Row[]> => {
	const rows: Row[] = [];
	for await (const row of iter) rows.push(row);
	return rows;
};

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

/** A, holding `ChitTotal` over `Chit`, and B, a second writer of `Chit`; plus A's rebuild count. */
async function twoWriters() {
	const shared = buildSharedNotifyingTransactor(new MemoryRawStorage());
	const dbA = new Database();
	const pluginA = registerWithSharedTransactor(dbA, shared);
	await dbA.exec(`create table Chit (Id integer primary key, Side text, Units integer) using optimystic('tree://mv-follow/chit')`);
	await dbA.exec(`insert into Chit (Id, Side, Units) values (1, 'left', 5)`);
	await dbA.exec('create materialized view ChitTotal as select Side, sum(Units) as Units from Chit group by Side');

	const dbB = new Database();
	const pluginB = registerWithSharedTransactor(dbB, shared);
	await pluginB.hydrate(dbB);

	const rebuilds = { count: 0 };
	dbA.schemaManager.getChangeNotifier().addListener(event => {
		if (event.type === 'materialized_view_refreshed') rebuilds.count++;
	});
	const close = async () => {
		await dbA.close();
		await dbB.close();
		await pluginA.dispose();
		await pluginB.dispose();
	};
	return { dbA, dbB, pluginA, rebuilds, close };
}

const totals = async (db: Database) =>
	(await collectRows(db.eval('select Side, Units from ChitTotal order by Side'))).map(row => [row.Side, row.Units]);

describe('A materialized view follows rows other writers commit', function () {
	this.timeout(30_000);

	it('rebuilds the view after another writer commits (GitHub #58)', async () => {
		const { dbA, dbB, pluginA, close } = await twoWriters();
		try {
			await dbB.exec(`insert into Chit (Id, Side, Units) values (2, 'left', 7)`);
			await pluginA.materializedViews.settled();

			expect(await totals(dbA)).to.deep.equal([['left', 12]]);
			const [sum] = await collectRows(dbA.eval('select sum(Units) as Total from Chit'));
			expect(sum!.Total).to.equal(12);

			await dbA.exec(`insert into Chit (Id, Side, Units) values (3, 'left', 1)`);
			expect(await totals(dbA)).to.deep.equal([['left', 13]]);
		} finally {
			await close();
		}
	});

	it("does not rebuild the view for this machine's own commits", async () => {
		const { dbA, pluginA, rebuilds, close } = await twoWriters();
		try {
			for (const id of [2, 3, 4]) {
				await dbA.exec(`insert into Chit (Id, Side, Units) values (${id}, 'right', ${id})`);
			}
			await pluginA.materializedViews.settled();

			expect(rebuilds.count).to.equal(0);
			expect(await totals(dbA)).to.deep.equal([['left', 5], ['right', 9]]);
		} finally {
			await close();
		}
	});

	it('waits out an explicit transaction, then rebuilds once', async () => {
		const { dbA, dbB, pluginA, rebuilds, close } = await twoWriters();
		try {
			await dbA.exec('begin');
			await dbB.exec(`insert into Chit (Id, Side, Units) values (2, 'left', 7)`);
			// Time for a follower that ignored the transaction to have rebuilt inside it.
			await new Promise(resolve => setTimeout(resolve, 100));
			expect(rebuilds.count, 'no rebuild inside the open transaction').to.equal(0);

			await dbA.exec('rollback');
			await pluginA.materializedViews.settled();

			expect(rebuilds.count).to.equal(1);
			expect(await totals(dbA)).to.deep.equal([['left', 12]]);
		} finally {
			await close();
		}
	});
});
