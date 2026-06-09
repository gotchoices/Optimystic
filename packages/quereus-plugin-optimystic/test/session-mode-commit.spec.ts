/**
 * Session/consensus-mode commit + rollback composition for the deferred-DML
 * staging refactor (see fix ticket
 * `optimystic-session-mode-commit-composition`).
 *
 * Background: the vtab's DML path STAGES mutations into collection trackers
 * (Tree.stage) instead of persisting inline, and TransactionBridge flushes them
 * at commit. In LEGACY mode the bridge flushes each dirty tree via tree.sync()
 * (covered by deferred-constraint-rollback.spec.ts / index-support.spec.ts). In
 * SESSION mode the bridge deliberately does NOT sync — it commits through a
 * `TransactionSession` → `TransactionCoordinator`, which pends/commits the staged
 * transforms through distributed consensus.
 *
 * The bug this suite pins: the coordinator reads transforms from ITS OWN
 * collection map. If that map is disjoint from the `Collection` instances the
 * vtab stages into, `coordinator.commit()` sees an empty map → "Nothing to
 * commit" → a committed session-mode transaction silently persists nothing. The
 * fix (Approach B) has the plugin register every staged collection (main table +
 * each index tree) into a live map shared with the coordinator, so the staged
 * transforms ARE what consensus commits.
 *
 * These tests wire a REAL `TransactionCoordinator` + `QuereusEngine` the way a
 * host would (via `plugin.txnBridge.configureTransactionMode`) against the
 * `local` transactor backed by a real `FileRawStorage` dir, so they exercise
 * genuine in-process consensus + persistence + reopen — not a mock. With the
 * disjoint-map bug present, the commit tests FAIL (silent drop).
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { KeyRange, TransactionCoordinator } from '@optimystic/db-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import { QuereusEngine } from '../dist/index.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

type Plugin = ReturnType<typeof register>;

/** Options that resolve to the cached `local:test` transactor over `dir`. */
function localOptions(dir: string) {
	return {
		collectionUri: 'tree://unused',
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
		rawStorageFactory: () => new FileRawStorage(dir),
	};
}

/** Register the optimystic plugin against a fresh Database wired to the `local`
 * transactor over a `FileRawStorage` rooted at `dir`. */
function createDb(dir: string): { db: Database; plugin: Plugin } {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => new FileRawStorage(dir),
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}

/**
 * Wire the bridge for distributed-consensus (session) mode the way a host would:
 * build a `TransactionCoordinator` from the bridge's LIVE collection registry
 * (so the coordinator and vtab share one set of `Collection` instances) plus a
 * `QuereusEngine`, and hand them to `configureTransactionMode`. Returns a
 * disposer for the engine's schema subscription.
 *
 * Call AFTER the table (+ indexes) exist so the shared transactor is already
 * cached and the main/index collections are registered — though the registry is
 * a live map, so anything registered later is still visible to the coordinator.
 */
async function enableSessionMode(db: Database, plugin: Plugin, dir: string): Promise<() => void> {
	const transactor = await plugin.collectionFactory.getOrCreateTransactor(localOptions(dir));
	const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(db, coordinator);
	plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
	return () => engine.dispose();
}

async function selectCount(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return Number((row as { c: number }).c);
	}
	throw new Error('count query returned no rows');
}

/** Assert that `fn` rejects; fail loudly if it unexpectedly resolves. */
async function expectThrows(fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch {
		return;
	}
	throw new Error('expected operation to throw, but it resolved');
}

/** Count materialised entries in the tree at `collectionUri` on the SAME cached
 * transactor the vtab used (reflects committed storage). */
async function countTreeEntries(plugin: Plugin, dir: string, collectionUri: string): Promise<number> {
	const tree = await plugin.collectionFactory.createOrGetCollection({
		...localOptions(dir),
		collectionUri,
	});
	await tree.update();
	let n = 0;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) n++;
	}
	return n;
}

/** Reopen the storage dir in a fresh (legacy) Database and return the count of `sql`. */
async function reopenCount(dir: string, countSql: string): Promise<number> {
	const { db, plugin } = createDb(dir);
	try {
		await plugin.hydrate(db);
		return await selectCount(db, countSql);
	} finally {
		db.close();
	}
}

describe('Session-mode commit/rollback composition (local transactor + real consensus)', function () {
	this.timeout(20000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-session-mode', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('commits a multi-DML session transaction (insert/update/delete across main + index) durably', async () => {
		const uri = 'tree://session/store';
		const { db, plugin } = createDb(dir);
		let dispose: (() => void) | undefined;
		try {
			await db.exec(
				`create table Store (id integer primary key, cat text)
					using optimystic('${uri}')`,
			);
			await db.exec(`create index idx_store_cat on Store (cat)`);

			dispose = await enableSessionMode(db, plugin, dir);
			expect(plugin.txnBridge.isTransactionModeEnabled(), 'session mode enabled').to.be.true;

			// One explicit transaction touching the main table AND the index via
			// insert, index-changing update, and delete. The coordinator must pend
			// + commit the staged transforms — net rows {1:'a', 2:'z'}.
			await db.exec('begin');
			await db.exec(`insert into Store (id, cat) values (1, 'a')`);
			await db.exec(`insert into Store (id, cat) values (2, 'b')`);
			await db.exec(`insert into Store (id, cat) values (3, 'a')`);
			await db.exec(`update Store set cat = 'z' where id = 2`);
			await db.exec(`delete from Store where id = 3`);
			await db.exec('commit');

			// In-session: the committed net effect is visible.
			expect(await selectCount(db, 'select count(*) as c from Store')).to.equal(2);
			expect(await selectCount(db, `select count(*) as c from Store where cat = 'a'`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Store where cat = 'z'`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Store where cat = 'b'`)).to.equal(0);

			// The index tree holds exactly the two surviving entries (no orphans).
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_store_cat`)).to.equal(2);
		} finally {
			dispose?.();
			db.close();
		}

		// Reopen: the consensus commit reached on-disk storage (this is the
		// assertion that FAILS under the silent-drop bug).
		expect(await reopenCount(dir, 'select count(*) as c from Store')).to.equal(2);
	});

	it('commits multiple sequential session transactions on the same collection', async () => {
		const uri = 'tree://session/seq';
		const { db, plugin } = createDb(dir);
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Seq (id integer primary key, v text) using optimystic('${uri}')`);
			dispose = await enableSessionMode(db, plugin, dir);

			// First session-mode commit.
			await db.exec(`insert into Seq (id, v) values (1, 'one')`);
			expect(await selectCount(db, 'select count(*) as c from Seq')).to.equal(1);

			// Second session-mode commit on the same long-lived collection: a stale
			// tracker (un-reset after the first commit) or a lingering re-applied
			// pending action would corrupt this count.
			await db.exec(`insert into Seq (id, v) values (2, 'two')`);
			expect(await selectCount(db, 'select count(*) as c from Seq')).to.equal(2);

			await db.exec(`update Seq set v = 'ONE' where id = 1`);
			expect(await selectCount(db, `select count(*) as c from Seq where v = 'ONE'`)).to.equal(1);
		} finally {
			dispose?.();
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from Seq')).to.equal(2);
	});

	it('rolls back a deferred-CHECK rejection in session mode (no rows, no orphaned index, in-session + reopen)', async () => {
		const uri = 'tree://session/widget';
		const { db, plugin } = createDb(dir);
		let dispose: (() => void) | undefined;
		try {
			await db.exec(
				`create table Widget (id integer primary key, cat text,
					check ((select count(*) from Widget) <= 1))
					using optimystic('${uri}')`,
			);
			await db.exec(`create index idx_widget_cat on Widget (cat)`);

			dispose = await enableSessionMode(db, plugin, dir);

			// First insert commits via consensus (count = 1 passes the CHECK).
			await db.exec(`insert into Widget (id, cat) values (1, 'a')`);
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);

			// Second insert: the deferred CHECK sees count = 2 at commit and throws.
			// Quereus dispatches rollback; the coordinator (single owner of tracker
			// rollback in session mode) must revert the staged row + index entry.
			await expectThrows(() => db.exec(`insert into Widget (id, cat) values (2, 'b')`));

			// In-session: the violating row + its index entry were reverted.
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_widget_cat`)).to.equal(1);
		} finally {
			dispose?.();
			db.close();
		}

		// Reopen: the rejected row never reached storage.
		expect(await reopenCount(dir, 'select count(*) as c from Widget')).to.equal(1);
	});

	it('rolls back an explicit multi-statement session transaction on ROLLBACK', async () => {
		const uri = 'tree://session/explicit';
		const { db, plugin } = createDb(dir);
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Acct (id integer primary key, bal integer) using optimystic('${uri}')`);
			dispose = await enableSessionMode(db, plugin, dir);

			await db.exec(`insert into Acct (id, bal) values (1, 100)`);

			// Stage mutations then explicitly ROLLBACK — none may survive.
			await db.exec('begin');
			await db.exec(`update Acct set bal = 999 where id = 1`);
			await db.exec(`insert into Acct (id, bal) values (2, 50)`);
			await db.exec('rollback');

			expect(await selectCount(db, 'select count(*) as c from Acct')).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Acct where bal = 100`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Acct where bal = 999`)).to.equal(0);
		} finally {
			dispose?.();
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from Acct where bal = 100')).to.equal(1);
	});
});

describe('Staging-refactor unit gaps (Tree.restore no-op + bridge collection registry)', function () {
	this.timeout(20000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-staging-gaps', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('Tree.restore is a safe no-op on a never-staged tree and on an already-synced tree', async () => {
		const { db, plugin } = createDb(dir);
		try {
			const tree = await plugin.collectionFactory.createOrGetCollection({
				...localOptions(dir),
				collectionUri: 'tree://gaps/noop',
			});

			// (a) Never-staged: snapshot then restore must not throw and must leave
			// the (empty) tree readable.
			const emptySnap = tree.snapshot();
			tree.restore(emptySnap);
			let count = 0;
			for await (const p of tree.range(new KeyRange<string>(undefined, undefined, true))) {
				if (tree.isValid(p)) count++;
			}
			expect(count, 'never-staged tree empty after restore').to.equal(0);

			// (b) Already-synced: stage a row, flush, then restore a fresh snapshot of
			// the now-clean tracker — a no-op that must leave the committed row intact.
			// Entry shape is [key, ...]; the tree's key extractor only reads entry[0].
			await tree.stage([['k1', ['k1', 'v1']]] as never);
			await tree.sync();
			const syncedSnap = tree.snapshot();
			tree.restore(syncedSnap);
			await tree.update();
			let after = 0;
			for await (const p of tree.range(new KeyRange<string>(undefined, undefined, true))) {
				if (tree.isValid(p)) after++;
			}
			expect(after, 'synced row survives a no-op restore').to.equal(1);
		} finally {
			db.close();
		}
	});

	it('the bridge registers the main table and each index collection', async () => {
		const uri = 'tree://gaps/reg';
		const { db, plugin } = createDb(dir);
		try {
			await db.exec(`create table Reg (id integer primary key, a text, b text) using optimystic('${uri}')`);
			await db.exec(`create index idx_reg_a on Reg (a)`);
			await db.exec(`create index idx_reg_b on Reg (b)`);

			const registry = plugin.txnBridge.getCollectionRegistry();
			const mainId = plugin.collectionFactory.getCollectionId({ ...localOptions(dir), collectionUri: uri });
			const idxAId = plugin.collectionFactory.getCollectionId({ ...localOptions(dir), collectionUri: `${uri}/index/idx_reg_a` });
			const idxBId = plugin.collectionFactory.getCollectionId({ ...localOptions(dir), collectionUri: `${uri}/index/idx_reg_b` });

			expect(registry.has(mainId), 'main table collection registered').to.be.true;
			expect(registry.has(idxAId), 'index idx_reg_a collection registered').to.be.true;
			expect(registry.has(idxBId), 'index idx_reg_b collection registered').to.be.true;
		} finally {
			db.close();
		}
	});
});
