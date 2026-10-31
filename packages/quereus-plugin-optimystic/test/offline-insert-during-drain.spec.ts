/**
 * An insert made in offline mode while the queue drains earlier inserts into the same table
 * (GitHub #50; docs/internals.md §The offline queue). The vtab's write path and the drain share one
 * collection per tree, and every drained entry replays what is still staged, rebuilding the tree from
 * fresh block ids beneath the insert's own point reads and unique probe, which are not latched.
 *
 * Over the in-memory `TestTransactor` every await on the drain's path settles without real I/O, so the
 * drain advances one microtask at a time, interleaved with the insert's own steps — the shape that
 * failed within the first hundred inserts with `Path is invalid due to mutation of the tree` or
 * `Missing block`, and that a journal waiting on a disk never showed. A table with a unique column and
 * an index takes the most point reads and probe scans per insert, so it is the one case kept.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { TestTransactor } from '@optimystic/db-core/test';
import register from '../dist/plugin.js';
import { queryAll, expectIndexAgreesWithScan } from './query-helpers.js';

const INSERTS = 300;

function createOfflineDb(): { db: Database; plugin: ReturnType<typeof register> } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local', default_key_network: 'test', enable_cache: false,
		offline: { allowSoloCommit: true },
	} as unknown as Record<string, SqlValue>);
	// The db-core test double rather than the plugin's `test` transactor: its awaits settle without
	// the storage layer's flush, which is what lets the drain interleave with the insert microtask
	// by microtask.
	plugin.collectionFactory.registerTransactor('local:test', new TestTransactor());
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	return { db, plugin };
}

describe('Offline mode: an insert while the queue drains the same table', function () {
	this.timeout(60_000);

	it('every autocommit insert into a table with a unique column and an index succeeds, and all of them drain', async () => {
		const { db, plugin } = createOfflineDb();
		await db.exec(`create table item (id integer primary key, name text unique, cat text) using optimystic('tree://offline-drain/item')`);
		await db.exec('create index item_cat on item (cat)');
		plugin.offline.enter();

		for (let i = 0; i < INSERTS; i++) {
			await db.exec(`insert into item (id, name, cat) values (${i}, 'n${i}', 'c${i % 7}')`);
		}
		await plugin.offline.whenDrained();

		expect(await queryAll(db, 'select count(*) as n from item'), 'every insert landed').to.deep.equal([{ n: INSERTS }]);
		await expectIndexAgreesWithScan(db, 'item', 'cat');
	});
});
