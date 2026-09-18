/**
 * Regression coverage for LEGACY (default, no-coordinator) commit atomicity across trees.
 *
 * A legacy commit that has several trees to push (a table and its index here) pends EVERY
 * tree before committing ANY, through a per-commit `TransactionCoordinator` over exactly
 * those trees (`TransactionBridge.commitBatchLegacy`). So:
 *
 * - a failure at PEND — the common failure class: a rival took a key, a unique value, or
 *   changed a row this write read; here, an injected hard pend rejection — leaves nothing
 *   durable and rolls back cleanly with a plain error;
 * - a permanent failure at COMMIT after every pend succeeded — the residual session mode
 *   shares — half-lands: the committed tree keeps its rows (memory keeps matching storage),
 *   the failed tree is reverted to its pre-transaction snapshot, and the bridge raises
 *   db-core's `CoordinatorPartialCommitError` (not the fallback sweep's `PartialCommitError`)
 *   and latches degraded. It does NOT silently revert the persisted tree — before the
 *   honest-failure work the failure path restored EVERY dirty tree's snapshot, which made
 *   memory disagree with storage AND falsely reported the transaction as rolled back;
 * - a successful multi-tree commit reads back identically through a fresh handle, including
 *   after a history that mixes single-tree commits (the per-tree `sync()` log-entry shape)
 *   with batched ones (the coordinator's, which names the participants on each entry).
 *
 * These tests run against a real `FileRawStorage`-backed `StorageRepo` (wrapped by the
 * selective-failure transactor), and reopen the storage to assert on-disk state matches the
 * reported outcome.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { CoordinatorPartialCommitError, KeyRange } from '@optimystic/db-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { makeSelectiveFailureTransactor } from './selective-failure-transactor.js';

/** Register the optimystic plugin against a fresh Database wired to the `local`
 * transactor. The injected transactor (registered under the `local:test` key) is
 * returned as the SAME instance the vtab uses. */
function createDbWithInjected(dir: string) {
	const db = new Database();
	const config = {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => new FileRawStorage(dir),
	} as unknown as Record<string, SqlValue>;
	const plugin = register(db, config);
	const injected = makeSelectiveFailureTransactor(new FileRawStorage(dir));
	// Pre-register under the transactor cache key the factory computes for
	// (transactor='local', keyNetwork='test'), so getOrCreateTransactor returns
	// our instance instead of building a plain local transactor.
	plugin.collectionFactory.registerTransactor('local:test', injected.transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin, injected };
}

/** Register the plugin over the same dir with a plain `local` transactor (no
 * injected failure) — used to reopen and read committed on-disk state. */
function createDbPlain(dir: string) {
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

async function selectCount(db: Database, sql: string): Promise<number> {
	for await (const row of db.eval(sql)) {
		return Number((row as { c: number }).c);
	}
	throw new Error('count query returned no rows');
}

async function selectRows(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) rows.push(row as Record<string, SqlValue>);
	return rows;
}

/** Count materialised entries in the tree at `collectionUri`, reading the real
 * committed storage via the plugin's collection factory. */
async function countTreeEntries(
	plugin: ReturnType<typeof register>,
	dir: string,
	collectionUri: string,
): Promise<number> {
	const tree = await plugin.collectionFactory.createOrGetCollection({
		collectionUri,
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json',
		rawStorageFactory: () => new FileRawStorage(dir),
	});
	await tree.update();
	let n = 0;
	for await (const treePath of tree.range(new KeyRange<string>(undefined, undefined, true))) {
		if (tree.isValid(treePath)) n++;
	}
	return n;
}

/** Reopen the storage dir in a fresh (plain) Database and run `read` against it.
 * The injected transactor writes through a bare `FileRawStorage`, BEHIND the plugin's read
 * cache, so this reopen must not inherit a warm cache from an earlier one: the read cache is
 * shared per directory for as long as any lease is held, so release ours before returning. */
async function reopen<T>(dir: string, read: (db: Database) => Promise<T>): Promise<T> {
	const { db, plugin } = createDbPlain(dir);
	try {
		await plugin.hydrate(db);
		return await read(db);
	} finally {
		db.close();
		await plugin.dispose();
	}
}

const reopenCount = (dir: string, countSql: string): Promise<number> => reopen(dir, db => selectCount(db, countSql));

/** Run `fn`, returning the thrown error (fails if it unexpectedly resolves). */
async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected operation to throw, but it resolved');
}

/** The first error of class `cls` in `error`'s cause chain, or undefined. The vtab wraps the
 * bridge's error in `Commit transaction failed: …` with the original as `cause`. */
function findCause<T>(error: unknown, cls: new (...args: never[]) => T): T | undefined {
	for (let cursor: unknown = error; cursor instanceof Error; cursor = cursor.cause) {
		if (cursor instanceof cls) return cursor;
	}
	return undefined;
}

const messageOf = (error: unknown): string => String((error as Error)?.message ?? error);
const isIndexTree = (collectionId: string): boolean => collectionId.includes('/index/');

describe('Legacy-mode commit atomicity across trees (local/FileRawStorage)', function () {
	this.timeout(20000);

	let dir: string;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), 'optimystic-legacy-commit-atomicity', randomUUID());
		await fs.mkdir(dir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	/** `Item(id, cat)` with a plain index on `cat` and one committed row, so the next insert
	 * pushes two trees that both already have committed state. */
	async function itemWithIndex(db: Database, plugin: ReturnType<typeof register>, uri: string): Promise<void> {
		await db.exec(`create table Item (id integer primary key, cat text) using optimystic('${uri}')`);
		await db.exec(`create index idx_item_cat on Item (cat)`);
		await db.exec(`insert into Item (id, cat) values (1, 'a')`);
		expect(await selectCount(db, 'select count(*) as c from Item')).to.equal(1);
		expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_item_cat`)).to.equal(1);
	}

	it('index-tree PEND failure: nothing persisted, clean rollback with a plain error, reopen shows the pre-transaction state', async () => {
		const uri = 'tree://legacy/item';
		const { db, plugin, injected } = createDbWithInjected(dir);
		try {
			await itemWithIndex(db, plugin, uri);

			// Every tree is pended before any is committed, so a refused pend on the index
			// tree — the SECOND tree in the old per-tree sweep — leaves the main table's
			// row unwritten too.
			injected.arm({ phase: 'pend', matches: isIndexTree });
			const err = await captureThrow(() => db.exec(`insert into Item (id, cat) values (2, 'b')`));
			injected.disarm();
			expect(injected.tripped, 'the injected index-tree pend refusal tripped').to.be.greaterThan(0);

			// A clean failure: no partial-commit signal of either kind, no degraded latch.
			expect(messageOf(err).toLowerCase()).to.not.contain('not atomic');
			expect(findCause(err, CoordinatorPartialCommitError)).to.equal(undefined);
			expect(plugin.txnBridge.isDegraded()).to.equal(false);

			// The rejected row left no trace in memory or in either tree.
			expect(await selectCount(db, 'select count(*) as c from Item')).to.equal(1);
			expect(await countTreeEntries(plugin, dir, uri)).to.equal(1);
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_item_cat`)).to.equal(1);

			// The handle is not wedged: the same insert lands once the failure is gone.
			await db.exec(`insert into Item (id, cat) values (2, 'b')`);
			expect(await selectCount(db, 'select count(*) as c from Item')).to.equal(2);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from Item')).to.equal(2);
	});

	it('index-tree COMMIT failure after every pend succeeded (the residual): loud CoordinatorPartialCommitError; persisted main table NOT silently reverted; index reverted', async () => {
		const uri = 'tree://legacy/widget';
		const { db, plugin, injected } = createDbWithInjected(dir);
		try {
			await itemWithIndex(db, plugin, uri);

			// Both trees pend; the main table's commit lands; the index tree's commit throws
			// on every forward-recovery retry, so it is lost for good.
			injected.arm({ phase: 'commit', matches: isIndexTree });
			const err = await captureThrow(() => db.exec(`insert into Item (id, cat) values (2, 'b')`));
			injected.disarm();
			expect(injected.tripped, 'the coordinator retried the thrown commit before giving up').to.equal(3);

			// Loud, honest error — not a false "rolled back" success. It is db-core's
			// partial-commit signal, naming both halves; it survives the module's
			// `Commit transaction failed: …` wrapping as the cause.
			expect(messageOf(err).toLowerCase()).to.contain('not atomic');
			const partial = findCause(err, CoordinatorPartialCommitError);
			expect(partial, 'a commit-phase split surfaces as CoordinatorPartialCommitError').to.not.equal(undefined);
			expect([...partial!.committedCollections]).to.deep.equal(['legacy/widget']);
			expect([...partial!.failedCollections]).to.deep.equal(['legacy/widget/index/idx_item_cat']);
			expect(plugin.txnBridge.isDegraded(), 'the bridge latched the split').to.equal(true);

			// The main table's row DID durably persist; its in-memory view must NOT be
			// reverted (that would disagree with storage).
			expect(await selectCount(db, 'select count(*) as c from Item')).to.equal(2);

			// The index tree's commit failed and never persisted; it was reverted in-memory
			// to its pre-transaction snapshot, so it still holds only row 1.
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_item_cat`)).to.equal(1);
		} finally {
			db.close();
		}

		// Reopen: on-disk state matches the reported outcome — main table has the
		// row (split persistence), the index does not. This is the documented
		// residual limitation, surfaced honestly rather than hidden.
		expect(await reopenCount(dir, 'select count(*) as c from Item')).to.equal(2);
	});

	it('a successful multi-tree commit, after a history of single-tree commits, reopens to identical rows through a fresh handle', async () => {
		const uri = 'tree://legacy/gadget';
		const { db, plugin } = createDbWithInjected(dir);
		try {
			// Single-tree commits first: the table alone (one tree, `sync()`), then the index
			// backfill flush. Their log entries have the per-tree sync's shape.
			await db.exec(`create table Item (id integer primary key, cat text) using optimystic('${uri}')`);
			await db.exec(`insert into Item (id, cat) values (1, 'a')`);
			await db.exec(`create index idx_item_cat on Item (cat)`);
			// Then batched commits: one row, and a multi-statement transaction.
			await db.exec(`insert into Item (id, cat) values (2, 'b')`);
			await db.exec(`begin; insert into Item (id, cat) values (3, 'a'); update Item set cat = 'c' where id = 2; commit;`);

			expect(await selectRows(db, 'select id, cat from Item order by id')).to.deep.equal([
				{ id: 1, cat: 'a' }, { id: 2, cat: 'c' }, { id: 3, cat: 'a' },
			]);
			expect(await countTreeEntries(plugin, dir, uri)).to.equal(3);
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_item_cat`)).to.equal(3);
			expect(plugin.txnBridge.isDegraded()).to.equal(false);
		} finally {
			db.close();
		}

		// A fresh handle over the mixed history reads the same rows, by full scan and
		// through the index.
		const reread = await reopen(dir, async fresh => ({
			all: await selectRows(fresh, 'select id, cat from Item order by id'),
			byCat: await selectRows(fresh, `select id from Item where cat = 'a' order by id`),
		}));
		expect(reread.all).to.deep.equal([{ id: 1, cat: 'a' }, { id: 2, cat: 'c' }, { id: 3, cat: 'a' }]);
		expect(reread.byCat).to.deep.equal([{ id: 1 }, { id: 3 }]);
	});
});
