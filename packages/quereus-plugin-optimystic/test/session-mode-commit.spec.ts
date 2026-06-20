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
 * transforms ARE what consensus commits. With the bug present, the commit tests
 * below FAIL (silent drop): post-commit reads through a FRESH tree on the same
 * transactor see nothing.
 *
 * Transactor choice: these tests drive the REAL coordinator GATHER/PEND/COMMIT
 * consensus path through the StorageRepo of the in-memory `test` transactor.
 * In-memory (not `local`/`FileRawStorage`) keeps this suite fast and dependency-
 * free; db-core stamps transaction ids as `tx:<hash>` / `stamp:<hash>`, whose
 * colon was once illegal in a db-p2p-storage-fs filename on Windows. That is now
 * fixed (FileRawStorage percent-encodes the colon — ticket
 * `optimystic-filestorage-colon-actionid-windows`), and the single on-disk
 * reopen test below exercises `local`/`FileRawStorage` durability on ALL
 * platforms.
 *
 * A second composition hazard this suite exercises and documents: a host must
 * supply a NON-re-entrant schema-hash provider. `TransactionBridge.beginTransaction`
 * awaits the provider, and `QuereusEngine.getSchemaHash()` lazily runs
 * `select … from schema()` against the SAME db — issuing that nested query while
 * a statement's implicit BEGIN is in flight deadlocks. The fix is to keep the
 * engine's hash cache warm out of band (it already invalidates on schema change);
 * `enableSessionMode` below pre-warms it after DDL and never recomputes mid-DML.
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

/** Options that resolve to the cached in-memory `test:test` transactor. */
function memOptions() {
	return {
		collectionUri: 'tree://unused',
		transactor: 'test',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
	};
}

/** Register the optimystic plugin against a fresh Database wired to the in-memory
 * `test` transactor. A fresh Tree opened on the same cached transactor reads the
 * same committed blocks, which is how the durability assertions verify that
 * consensus actually persisted past the committing collection's tracker. */
function createDb(): { db: Database; plugin: Plugin } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'test',
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

/**
 * Wire the bridge for distributed-consensus (session) mode the way a host would:
 * build a `TransactionCoordinator` from the bridge's LIVE collection registry
 * (so the coordinator and vtab share one set of `Collection` instances) plus a
 * `QuereusEngine`, and hand them to `configureTransactionMode`.
 *
 * Pre-warms the engine's schema-hash cache AFTER all DDL so that the provider
 * `beginTransaction` awaits never triggers a re-entrant `db.eval` (which would
 * deadlock — see file header). Returns a disposer for the engine subscription.
 *
 * Call AFTER the table (+ indexes) exist so the shared transactor is cached and
 * the main/index collections are registered.
 */
async function enableSessionMode(db: Database, plugin: Plugin): Promise<() => void> {
	const transactor = await plugin.collectionFactory.getOrCreateTransactor(memOptions());
	const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
	const engine = new QuereusEngine(db, coordinator);
	// Warm the cache outside any statement; the provider then returns it without
	// re-entering the db while a transaction is opening.
	await engine.getSchemaHash();
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

/** Count materialised entries in the tree at `collectionUri` by opening a FRESH
 * tree on the same cached transactor — so the count reflects what consensus
 * committed to the StorageRepo, not the vtab's in-flight tracker. */
async function countTreeEntries(plugin: Plugin, collectionUri: string): Promise<number> {
	const tree = await plugin.collectionFactory.createOrGetCollection({ ...memOptions(), collectionUri });
	await tree.update();
	let n = 0;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) n++;
	}
	return n;
}

describe('Session-mode commit/rollback composition (real consensus, in-memory)', function () {
	this.timeout(20000);

	it('commits an insert-only session transaction across main + index durably', async () => {
		const uri = 'tree://session/store';
		const { db, plugin } = createDb();
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Store (id integer primary key, cat text) using optimystic('${uri}')`);
			await db.exec(`create index idx_store_cat on Store (cat)`);

			dispose = await enableSessionMode(db, plugin);
			expect(plugin.txnBridge.isTransactionModeEnabled(), 'session mode enabled').to.be.true;

			// One explicit transaction inserting across the main table AND the index.
			await db.exec('begin');
			await db.exec(`insert into Store (id, cat) values (1, 'a')`);
			await db.exec(`insert into Store (id, cat) values (2, 'b')`);
			await db.exec(`insert into Store (id, cat) values (3, 'a')`);
			await db.exec('commit');

			// In-session reads (which pull the committed log) see the rows, including
			// via the secondary index (cat).
			expect(await selectCount(db, 'select count(*) as c from Store')).to.equal(3);
			expect(await selectCount(db, `select count(*) as c from Store where cat = 'a'`)).to.equal(2);
			expect(await selectCount(db, `select count(*) as c from Store where cat = 'b'`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Store where cat = 'q'`)).to.equal(0);

			// Durability: a FRESH tree on the same transactor (bypassing the vtab's
			// tracker) sees the committed main rows AND index entries. With the
			// disjoint-map bug these are 0 (silent drop). Insert-only, so the index
			// entry count is exact (no update/delete orphans — see next test).
			expect(await countTreeEntries(plugin, uri), 'main rows persisted via consensus').to.equal(3);
			expect(await countTreeEntries(plugin, `${uri}/index/idx_store_cat`), 'index entries persisted via consensus').to.equal(3);
		} finally {
			dispose?.();
			db.close();
		}
	});

	it('commits insert + update + delete on indexed rows (main-table + query correctness)', async () => {
		const uri = 'tree://session/mut';
		const { db, plugin } = createDb();
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Mut (id integer primary key, cat text) using optimystic('${uri}')`);
			await db.exec(`create index idx_mut_cat on Mut (cat)`);
			dispose = await enableSessionMode(db, plugin);

			await db.exec('begin');
			await db.exec(`insert into Mut (id, cat) values (1, 'a')`);
			await db.exec(`insert into Mut (id, cat) values (2, 'b')`);
			await db.exec(`insert into Mut (id, cat) values (3, 'c')`);
			await db.exec('commit');

			// Update + delete across the index in subsequent committed transactions:
			// net rows {1:'a', 2:'z'}.
			await db.exec(`update Mut set cat = 'z' where id = 2`);
			await db.exec(`delete from Mut where id = 3`);

			// Main-table state and index-routed queries must be correct after
			// committed update + delete.
			expect(await selectCount(db, 'select count(*) as c from Mut')).to.equal(2);
			expect(await selectCount(db, `select count(*) as c from Mut where cat = 'a'`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Mut where cat = 'z'`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Mut where cat = 'b'`)).to.equal(0);
			expect(await selectCount(db, `select count(*) as c from Mut where cat = 'c'`)).to.equal(0);

			expect(await countTreeEntries(plugin, uri), 'main rows reflect update + delete').to.equal(2);
			// Index must contain exactly 2 live entries (a/1, z/2) — no orphans
			// for the old 'b' (updated to 'z') or 'c' (deleted) values.
			expect(
				await countTreeEntries(plugin, `${uri}/index/idx_mut_cat`),
				'index entries match live rows after update + delete',
			).to.equal(2);
		} finally {
			dispose?.();
			db.close();
		}
	});

	it('commits multiple sequential session transactions on the same collection', async () => {
		const uri = 'tree://session/seq';
		const { db, plugin } = createDb();
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Seq (id integer primary key, v text) using optimystic('${uri}')`);
			dispose = await enableSessionMode(db, plugin);

			await db.exec(`insert into Seq (id, v) values (1, 'one')`);
			expect(await selectCount(db, 'select count(*) as c from Seq')).to.equal(1);

			// Second session-mode commit on the same long-lived collection: a stale
			// tracker (un-reset after the first commit) or a lingering re-applied
			// pending action would corrupt this.
			await db.exec(`insert into Seq (id, v) values (2, 'two')`);
			expect(await selectCount(db, 'select count(*) as c from Seq')).to.equal(2);

			await db.exec(`update Seq set v = 'ONE' where id = 1`);
			expect(await selectCount(db, `select count(*) as c from Seq where v = 'ONE'`)).to.equal(1);

			expect(await countTreeEntries(plugin, uri), 'both rows persisted via consensus').to.equal(2);
		} finally {
			dispose?.();
			db.close();
		}
	});

	it('rolls back a deferred-CHECK rejection in session mode (no rows, no orphaned index)', async () => {
		const uri = 'tree://session/widget';
		const { db, plugin } = createDb();
		let dispose: (() => void) | undefined;
		try {
			await db.exec(
				`create table Widget (id integer primary key, cat text,
					check ((select count(*) from Widget) <= 1))
					using optimystic('${uri}')`,
			);
			await db.exec(`create index idx_widget_cat on Widget (cat)`);

			dispose = await enableSessionMode(db, plugin);

			// First insert commits via consensus (count = 1 passes the CHECK).
			await db.exec(`insert into Widget (id, cat) values (1, 'a')`);
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);

			// Second insert: the deferred CHECK sees count = 2 at commit and throws.
			// Quereus dispatches rollback; the coordinator (single owner of tracker
			// rollback in session mode) must revert the staged row + index entry.
			await expectThrows(() => db.exec(`insert into Widget (id, cat) values (2, 'b')`));

			// In-session: the violating row + its index entry were reverted.
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);
			// Durability: only the first row's index entry persisted — no orphan.
			expect(await countTreeEntries(plugin, `${uri}/index/idx_widget_cat`)).to.equal(1);
			expect(await countTreeEntries(plugin, uri)).to.equal(1);
		} finally {
			dispose?.();
			db.close();
		}
	});

	it('rolls back an explicit multi-statement session transaction on ROLLBACK', async () => {
		const uri = 'tree://session/acct';
		const { db, plugin } = createDb();
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Acct (id integer primary key, bal integer) using optimystic('${uri}')`);
			dispose = await enableSessionMode(db, plugin);

			await db.exec(`insert into Acct (id, bal) values (1, 100)`);

			// Stage mutations then explicitly ROLLBACK — none may survive.
			await db.exec('begin');
			await db.exec(`update Acct set bal = 999 where id = 1`);
			await db.exec(`insert into Acct (id, bal) values (2, 50)`);
			await db.exec('rollback');

			expect(await selectCount(db, 'select count(*) as c from Acct')).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Acct where bal = 100`)).to.equal(1);
			expect(await selectCount(db, `select count(*) as c from Acct where bal = 999`)).to.equal(0);
			expect(await countTreeEntries(plugin, uri), 'only the pre-rollback row persisted').to.equal(1);
		} finally {
			dispose?.();
			db.close();
		}
	});
});

/**
 * On-disk durability across a full reopen (fresh Database + factory + transactor)
 * through the consensus path. Previously skipped on win32 because db-p2p-storage-fs
 * was writing raw `tx:<hash>.json` filenames (colon illegal on Windows). Fixed by
 * percent-encoding colons in `FileRawStorage` path helpers.
 */
const reopenIt = it;
describe('Session-mode commit reopen durability (local/FileRawStorage, all platforms)', function () {
	this.timeout(20000);

	let dir: string;
	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-session-reopen', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	function createFsDb(d: string): { db: Database; plugin: Plugin } {
		const db = new Database();
		const config = {
			default_transactor: 'local',
			default_key_network: 'test',
			enable_cache: false,
			rawStorageFactory: () => new FileRawStorage(d),
		} as unknown as Record<string, SqlValue>;
		const plugin = register(db, config);
		for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
		for (const func of plugin.functions) db.registerFunction(func.schema);
		return { db, plugin };
	}

	async function enableFsSessionMode(db: Database, plugin: Plugin, d: string): Promise<() => void> {
		const transactor = await plugin.collectionFactory.getOrCreateTransactor({
			collectionUri: 'tree://unused', transactor: 'local', keyNetwork: 'test',
			libp2pOptions: {}, cache: false, encoding: 'json', rawStorageFactory: () => new FileRawStorage(d),
		});
		const coordinator = new TransactionCoordinator(transactor, plugin.txnBridge.getCollectionRegistry());
		const engine = new QuereusEngine(db, coordinator);
		await engine.getSchemaHash();
		plugin.txnBridge.configureTransactionMode(coordinator, engine, () => engine.getSchemaHash());
		return () => engine.dispose();
	}

	reopenIt('a committed session-mode transaction survives reopen from disk', async () => {
		const uri = 'tree://session/disk';
		const { db, plugin } = createFsDb(dir);
		let dispose: (() => void) | undefined;
		try {
			await db.exec(`create table Disk (id integer primary key, v text) using optimystic('${uri}')`);
			dispose = await enableFsSessionMode(db, plugin, dir);

			await db.exec('begin');
			await db.exec(`insert into Disk (id, v) values (1, 'a')`);
			await db.exec(`insert into Disk (id, v) values (2, 'b')`);
			await db.exec('commit');

			expect(await selectCount(db, 'select count(*) as c from Disk')).to.equal(2);
		} finally {
			dispose?.();
			db.close();
		}

		// Reopen a brand-new Database over the same dir — reads on-disk blocks.
		const { db: db2, plugin: plugin2 } = createFsDb(dir);
		try {
			await plugin2.hydrate(db2);
			expect(await selectCount(db2, 'select count(*) as c from Disk')).to.equal(2);
		} finally {
			db2.close();
		}
	});
});

describe('Staging-refactor unit gaps (Tree.restore no-op + bridge collection registry)', function () {
	this.timeout(20000);

	it('Tree.restore is a safe no-op on a never-staged tree and on an already-synced tree', async () => {
		const { db, plugin } = createDb();
		try {
			const tree = await plugin.collectionFactory.createOrGetCollection({ ...memOptions(), collectionUri: 'tree://gaps/noop' });

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
		const { db, plugin } = createDb();
		try {
			await db.exec(`create table Reg (id integer primary key, a text, b text) using optimystic('${uri}')`);
			await db.exec(`create index idx_reg_a on Reg (a)`);
			await db.exec(`create index idx_reg_b on Reg (b)`);

			const registry = plugin.txnBridge.getCollectionRegistry();
			const mainId = plugin.collectionFactory.getCollectionId({ ...memOptions(), collectionUri: uri });
			const idxAId = plugin.collectionFactory.getCollectionId({ ...memOptions(), collectionUri: `${uri}/index/idx_reg_a` });
			const idxBId = plugin.collectionFactory.getCollectionId({ ...memOptions(), collectionUri: `${uri}/index/idx_reg_b` });

			expect(registry.has(mainId), 'main table collection registered').to.be.true;
			expect(registry.has(idxAId), 'index idx_reg_a collection registered').to.be.true;
			expect(registry.has(idxBId), 'index idx_reg_b collection registered').to.be.true;
		} finally {
			db.close();
		}
	});
});
