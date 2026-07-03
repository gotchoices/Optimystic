/**
 * Regression coverage for LEGACY (default, no-coordinator) commit atomicity
 * across trees (see implement ticket `optimystic-legacy-commit-not-atomic`).
 *
 * Legacy commit flushes each dirty tree (main table + each secondary index) with
 * an independent `tree.sync()` — its own pend+commit against the transactor. Those
 * flushes are NOT one atomic unit. If the flush of the SECOND tree fails after the
 * FIRST has already durably committed, the first tree is written and the second is
 * not — a real split on disk that cannot be un-done locally.
 *
 * Before the fix, the failure path called `rollbackTransaction()`, which restored
 * the in-memory snapshot of EVERY dirty tree — including the already-committed one.
 * That diverged memory from storage (memory said "not applied", storage said
 * "applied") AND falsely reported the transaction as rolled back.
 *
 * After the fix:
 * - a post-first-tree failure raises a loud `PartialCommitError` and does NOT
 *   silently revert the persisted tree in memory (memory keeps matching storage);
 * - a FIRST-tree failure (nothing persisted) still rolls back cleanly.
 *
 * These tests run against a real `FileRawStorage`-backed `StorageRepo` (wrapped by
 * an injected transactor that fails a targeted commit), and reopen the storage to
 * assert on-disk state matches the reported outcome.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { KeyRange } from '@optimystic/db-core';
import { StorageRepo, BlockStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import register from '../dist/plugin.js';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/**
 * An injected transactor that wraps a real `StorageRepo` over `FileRawStorage`,
 * but can be told to FAIL a targeted `commit` to simulate a mid-sweep flush
 * failure. Failure is scoped by log-tail block id, so it targets a specific
 * collection regardless of how many commits that collection's sync issues.
 *
 * - `arm('second')`: the next commit whose `tailId` differs from the FIRST tail
 *   committed while armed throws (i.e. the second collection in the sweep). Used
 *   to leave the first tree persisted and the second not.
 * - `arm('first')`: the very first commit while armed throws (nothing persists).
 *
 * A commit "throws" (rather than returning `{ success: false }`) so the collection
 * sync fails FAST — a returned stale-failure would trigger ~10 backoff retries.
 */
function makeInjectedTransactor(dir: string) {
	const rawStorage = new FileRawStorage(dir);
	const storageRepo = new StorageRepo((blockId: string) => new BlockStorage(blockId, rawStorage));

	let mode: 'off' | 'first' | 'second' = 'off';
	let firstTail: string | undefined;
	let tripped = false;

	const transactor = {
		async get(blockGets: any) { return storageRepo.get(blockGets); },
		async getStatus(_refs: any) { throw new Error('getStatus not implemented in injected transactor'); },
		async pend(request: any) { return storageRepo.pend(request); },
		async commit(request: any) {
			if (mode !== 'off' && !tripped) {
				const tail = request.tailId as string;
				if (mode === 'first') {
					tripped = true;
					throw new Error('injected commit failure (first tree)');
				}
				// mode === 'second'
				if (firstTail === undefined) {
					firstTail = tail;
				} else if (tail !== firstTail) {
					tripped = true;
					throw new Error('injected commit failure (second tree)');
				}
			}
			return storageRepo.commit(request);
		},
		async cancel(trxRef: any) { return storageRepo.cancel(trxRef); },
		onCollectionChange: storageRepo.onCollectionChange.bind(storageRepo),
	};

	return {
		transactor,
		arm(m: 'first' | 'second') { mode = m; firstTail = undefined; tripped = false; },
		disarm() { mode = 'off'; },
		get tripped() { return tripped; },
	};
}

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
	const injected = makeInjectedTransactor(dir);
	// Pre-register under the transactor cache key the factory computes for
	// (transactor='local', keyNetwork='test'), so getOrCreateTransactor returns
	// our instance instead of building a plain local transactor.
	plugin.collectionFactory.registerTransactor('local:test', injected.transactor as any);
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

/** Reopen the storage dir in a fresh (plain) Database and return the count of `sql`. */
async function reopenCount(dir: string, countSql: string): Promise<number> {
	const { db, plugin } = createDbPlain(dir);
	try {
		await plugin.hydrate(db);
		return await selectCount(db, countSql);
	} finally {
		db.close();
	}
}

/** Run `fn`, returning the thrown error (fails if it unexpectedly resolves). */
async function captureThrow(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected operation to throw, but it resolved');
}

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

	it('second-tree commit failure: persisted main table is NOT silently reverted; loud partial-commit error; index untouched', async () => {
		const uri = 'tree://legacy/item';
		const { db, plugin, injected } = createDbWithInjected(dir);
		try {
			await db.exec(`create table Item (id integer primary key, cat text) using optimystic('${uri}')`);
			await db.exec(`create index idx_item_cat on Item (cat)`);
			await db.exec(`insert into Item (id, cat) values (1, 'a')`);
			expect(await selectCount(db, 'select count(*) as c from Item')).to.equal(1);
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_item_cat`)).to.equal(1);

			// Arm the injected transactor to fail the SECOND tree's commit. The sweep
			// flushes the main table first (durably committed) then the index (fails).
			injected.arm('second');
			const err = await captureThrow(() => db.exec(`insert into Item (id, cat) values (2, 'b')`));
			expect(injected.tripped, 'injected second-tree commit should have tripped').to.equal(true);

			// Loud, honest error — not a false "rolled back" success. The message
			// survives the module's `Commit transaction failed: …` wrapping.
			expect(String((err as Error)?.message ?? err).toLowerCase()).to.contain('not atomic');

			// The main table's row DID durably persist; its in-memory view must NOT be
			// reverted (that would disagree with storage). Pre-fix this read returned 1.
			expect(await selectCount(db, 'select count(*) as c from Item')).to.equal(2);

			// The index tree's flush failed and never persisted; it was reverted
			// in-memory to its pre-transaction snapshot, so it still holds only row 1.
			expect(await countTreeEntries(plugin, dir, `${uri}/index/idx_item_cat`)).to.equal(1);
		} finally {
			db.close();
		}

		// Reopen: on-disk state matches the reported outcome — main table has the
		// row (split persistence), the index does not. This is the documented
		// residual limitation, surfaced honestly rather than hidden.
		expect(await reopenCount(dir, 'select count(*) as c from Item')).to.equal(2);
	});

	it('first-tree commit failure: nothing persisted, clean rollback (no partial-commit error)', async () => {
		const uri = 'tree://legacy/widget';
		const { db, injected } = createDbWithInjected(dir);
		try {
			await db.exec(`create table Widget (id integer primary key, cat text) using optimystic('${uri}')`);
			await db.exec(`create index idx_widget_cat on Widget (cat)`);
			await db.exec(`insert into Widget (id, cat) values (1, 'a')`);
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);

			// Fail the FIRST tree's commit — nothing reaches storage this commit.
			injected.arm('first');
			const err = await captureThrow(() => db.exec(`insert into Widget (id, cat) values (2, 'b')`));
			expect(injected.tripped).to.equal(true);
			// A first-tree failure is a genuine clean rollback, NOT a partial commit.
			expect(String((err as Error)?.message ?? err).toLowerCase()).to.not.contain('not atomic');

			// Clean rollback: the rejected row left no trace in memory.
			expect(await selectCount(db, 'select count(*) as c from Widget')).to.equal(1);
		} finally {
			db.close();
		}

		expect(await reopenCount(dir, 'select count(*) as c from Widget')).to.equal(1);
	});
});
