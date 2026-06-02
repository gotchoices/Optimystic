/**
 * Reactive watch bridge: optimystic collection-change notifications →
 * Quereus watch invalidation (ticket `optimystic-vtab-reactive-watch-bridge`).
 *
 * Flow under test:
 *   StorageRepo.commit → CollectionChangeEvent → transactor.onCollectionChange
 *   → vtab listener → db.notifyExternalChange → Quereus watchers fire.
 *
 * Everything runs in-process with the `local` transactor. Because the factory
 * caches a transactor per (transactor, keyNetwork), every collection opened
 * through one plugin instance shares ONE StorageRepo — the shared store. A
 * write driven directly through the factory (NOT through the Database's SQL
 * path) models a REMOTE author: it never touches this Database's commit change
 * log, so the ONLY way a watcher can wake is via the storage-notification →
 * notifyExternalChange bridge this ticket adds.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { WatchEvent } from '@quereus/quereus';
import register from '../dist/plugin.js';
import type { ParsedOptimysticTreeOptions as ParsedOptimysticOptions } from '../dist/index.js';
import type { CollectionChangeEvent } from '@optimystic/db-core';

type Plugin = ReturnType<typeof register>;

/** Fresh Database + registered optimystic plugin backed by the `local` transactor. */
function setup(): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
	});
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

/** Options that resolve to the shared `local`/`test` transactor for a given URI. */
function localOptions(collectionUri: string): ParsedOptimysticOptions {
	return {
		collectionUri,
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json',
	};
}

/**
 * Commit a row to `collectionUri` directly through the factory (bypassing the
 * Database SQL path) — models a remote/out-of-band author writing to the shared
 * store.
 */
async function externalCommit(plugin: Plugin, collectionUri: string, key: string, value: string): Promise<void> {
	const collection = await plugin.collectionFactory.createOrGetCollection(localOptions(collectionUri));
	await collection.replace([[key, [key, JSON.stringify(value)]]]);
}

/** Poll `pred` until true or timeout; returns its final value. */
async function waitUntil(pred: () => boolean, timeoutMs = 1000, stepMs = 5): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (pred()) return true;
		await new Promise(resolve => setTimeout(resolve, stepMs));
	}
	return pred();
}

describe('Reactive watch bridge (collection change → Database.watch)', function () {
	this.timeout(10000);

	it('wakes a full-table watcher on an external commit to the same collection', async () => {
		const { db, plugin } = setup();
		try {
			await db.exec("create table t (id text primary key, v text) using optimystic('tree://reactive-wake/t')");
			const scope = db.prepare('select * from t').getChangeScope();
			const events: WatchEvent[] = [];
			const sub = db.watch(scope, e => { events.push(e); });

			await externalCommit(plugin, 'tree://reactive-wake/t', 'r1', 'hello');

			const fired = await waitUntil(() => events.length > 0);
			sub.unsubscribe();

			expect(fired, 'watcher should fire on external commit').to.equal(true);
			const ev = events[0]!;
			expect(ev.matched.some(m => m.watch.table.table === 't')).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('does not wake a watcher when a different collection changes', async () => {
		const { db, plugin } = setup();
		try {
			await db.exec("create table t (id text primary key, v text) using optimystic('tree://reactive-scope/t')");
			// A second table so the foreign commit DOES emit (u's vtab is subscribed);
			// the watcher on t must still not fire — proving table-level scoping.
			await db.exec("create table u (id text primary key, v text) using optimystic('tree://reactive-scope/u')");
			const events: WatchEvent[] = [];
			const sub = db.watch(db.prepare('select * from t').getChangeScope(), e => { events.push(e); });

			await externalCommit(plugin, 'tree://reactive-scope/u', 'r1', 'hi');

			// Give any erroneous wake a chance to land before asserting absence.
			await waitUntil(() => events.length > 0, 250);
			sub.unsubscribe();

			expect(events).to.have.length(0);
		} finally {
			await db.close();
		}
	});

	it('surfaces the watched key in hits for a row-scoped watch after an external commit', async () => {
		const { db, plugin } = setup();
		try {
			await db.exec("create table t (id text primary key, v text) using optimystic('tree://reactive-row/t')");
			const scope = db.prepare("select * from t where id = 'x'").getChangeScope();
			const events: WatchEvent[] = [];
			const sub = db.watch(scope, e => { events.push(e); });

			await externalCommit(plugin, 'tree://reactive-row/t', 'x', 'val');

			const fired = await waitUntil(() => events.length > 0);
			sub.unsubscribe();

			expect(fired, 'row-scoped watcher should fire').to.equal(true);
			const hits = events[0]!.matched.flatMap(m => m.hits.map(h => h[0]));
			expect(hits).to.include('x');
		} finally {
			await db.close();
		}
	});

	it('stops waking a watcher after its subscription is unsubscribed', async () => {
		const { db, plugin } = setup();
		try {
			await db.exec("create table t (id text primary key, v text) using optimystic('tree://reactive-unsub/t')");
			const events: WatchEvent[] = [];
			const sub = db.watch(db.prepare('select * from t').getChangeScope(), e => { events.push(e); });

			await externalCommit(plugin, 'tree://reactive-unsub/t', 'r1', 'a');
			await waitUntil(() => events.length > 0);
			expect(events.length, 'first external commit wakes the watcher').to.equal(1);

			sub.unsubscribe();
			await externalCommit(plugin, 'tree://reactive-unsub/t', 'r2', 'b');
			await waitUntil(() => events.length > 1, 250);

			expect(events.length, 'no further wakeups after unsubscribe').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('removes the storage listener on destroy (drop table) — no leaked wakeups', async () => {
		const { db, plugin } = setup();
		try {
			await db.exec("create table t (id text primary key, v text) using optimystic('tree://reactive-drop/t')");

			// Spy on notifyExternalChange so we can distinguish "listener removed"
			// from "fired but matched no watcher" (a leak would still call it).
			let externalCalls = 0;
			const original = db.notifyExternalChange.bind(db);
			(db as unknown as { notifyExternalChange: Database['notifyExternalChange'] }).notifyExternalChange =
				(tableName: string, schemaName?: string) => {
					externalCalls++;
					return original(tableName, schemaName);
				};

			// Before drop: an external commit drives notifyExternalChange.
			await externalCommit(plugin, 'tree://reactive-drop/t', 'r1', 'a');
			await waitUntil(() => externalCalls > 0);
			expect(externalCalls, 'storage listener active before drop').to.equal(1);

			await db.exec('drop table t');

			// After drop: the storage listener is gone — no further dispatch.
			await externalCommit(plugin, 'tree://reactive-drop/t', 'r2', 'b');
			await waitUntil(() => externalCalls > 1, 250);

			expect(externalCalls, 'no notifyExternalChange after drop (listener removed)').to.equal(1);
		} finally {
			await db.close();
		}
	});

	it('maps the collection URI to the canonical collection id carried by change events', async () => {
		const { db, plugin } = setup();
		try {
			const factory = plugin.collectionFactory;
			const options = localOptions('tree://reactive-map/c');

			// The canonical id is the URI path (matches parseCollectionId).
			expect(factory.getCollectionId(options)).to.equal('reactive-map/c');

			// ...and it equals the collectionId stamped on emitted change events.
			const captured: CollectionChangeEvent[] = [];
			const unsub = await factory.subscribeToCollectionChanges(
				options,
				factory.getCollectionId(options),
				(e: CollectionChangeEvent) => { captured.push(e); }
			);

			await externalCommit(plugin, 'tree://reactive-map/c', 'r1', 'a');
			const fired = await waitUntil(() => captured.length > 0);
			unsub();

			expect(fired, 'direct subscription should receive the event').to.equal(true);
			expect(captured[0]!.collectionId).to.equal('reactive-map/c');
		} finally {
			await db.close();
		}
	});
});
