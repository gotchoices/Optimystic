import { expect } from 'chai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRawStorage } from '../src/sqlite-storage.js';
import { openTestDb, openTestFileDb } from './node-sqlite-driver.js';
import type { SqliteDb } from '../src/db.js';
import { runRawStorageConformance, type ConformanceHarness } from '@optimystic/db-p2p/testing/conformance';
import type { BlockId, ActionId } from '@optimystic/db-core';
import { StoreFailedError, type BlockMetadata, type SetTimer } from '@optimystic/db-p2p';

// ---------------------------------------------------------------------------
// Shared parity suite. Proves SqliteRawStorage (KvRawStorage over
// WriteGroupDriver over SqliteBatchBackend) behaves identically to every other
// backend — round-trips, listRevisions ordering, promote atomicity + the exact
// missing-pend error, clone-on-store/read (structural via the byte boundary),
// drain-before-yield iteration, the BlockStorage parity slice, and the
// flush-then-reopen case. Runs against `node:sqlite`; production is
// NativeScript SQLite, both satisfy `SqliteDb`. Each case gets a fresh
// file-backed db in its own temp dir, so reopen can close it and open the same
// file again; cleanup closes the storage (which flushes what it still holds and
// disarms its timers, which must not fire on a closed handle), then the handle,
// then removes the dir.
// ---------------------------------------------------------------------------
runRawStorageConformance('SQLite', async (): Promise<ConformanceHarness> => {
	const dir = await mkdtemp(join(tmpdir(), 'optimystic-sqlite-conformance-'));
	const file = join(dir, 'optimystic.db');
	let db = await openTestFileDb(file);
	let storage = new SqliteRawStorage(db);
	return {
		storage,
		reopen: async () => {
			await db.close();
			db = await openTestFileDb(file);
			storage = new SqliteRawStorage(db);
			return storage;
		},
		cleanup: async () => {
			await storage.close();
			await db.close();
			await rm(dir, { recursive: true, force: true });
		}
	};
}, { persistent: true });

// ---------------------------------------------------------------------------
// SQLite-only tests the shared suite does not cover: the value columns are BLOB
// (a TEXT column would UTF-8-coerce non-ASCII JSON bytes and corrupt them), and
// getApproximateBytesUsed is the optional PRAGMA passthrough the shared suite
// skips.
// ---------------------------------------------------------------------------
describe('SQLite driver specifics', () => {
	let db: SqliteDb;
	let storage: SqliteRawStorage;

	beforeEach(async () => {
		db = await openTestDb();
		storage = new SqliteRawStorage(db);
	});

	afterEach(async () => {
		await storage.close();
		await db.close();
	});

	it('round-trips non-ASCII metadata through the BLOB value column', async () => {
		// A TEXT/JSON-string column would risk mangling multi-byte UTF-8; the BLOB
		// column stores the kernel's exact bytes. The actionId carries the non-ASCII
		// payload so the round-trip has to survive the byte boundary.
		const blockId = 'blob-block' as BlockId;
		const actionId = 'tx:café—🔒—Ω' as ActionId;
		const meta: BlockMetadata = { ranges: [[1, 5]], latest: { rev: 4, actionId } };

		await storage.saveMetadata(blockId, meta);
		await storage.flush();
		expect(await new SqliteRawStorage(db).getMetadata(blockId), 'read back from the table by a store with an empty overlay').to.deep.equal(meta);
	});

	it('getApproximateBytesUsed returns a non-negative number', async () => {
		const used = await storage.getApproximateBytesUsed();
		expect(used).to.be.a('number');
		expect(used).to.be.at.least(0);
	});
});

// ---------------------------------------------------------------------------
// The window. A relaxed flush commits its group as one transaction under
// `synchronous = NORMAL`; the sync — one commit under `FULL` — comes by the
// deadline, from the timer, or sooner from a strict flush, and one sync covers
// every group committed since the last. Statements are counted through the
// test driver's hook; the timer is fired by hand.
// ---------------------------------------------------------------------------
describe('SQLite sync by the window', () => {
	const A = 'block-a' as BlockId;
	const B = 'block-b' as BlockId;
	const C = 'block-c' as BlockId;
	const metaFor = (rev: number): BlockMetadata => ({ ranges: [[1, rev]], latest: { rev, actionId: `tx-${rev}` as ActionId } });

	interface Harness {
		readonly db: SqliteDb;
		readonly storage: SqliteRawStorage;
		/** Commits made under `synchronous = FULL`: the syncs. */
		fullCommits(): number;
		/** Every `COMMIT` the connection ran: one per group, plus one per sync that was not a group's own. */
		commits(): number;
		/** Timers armed and not cancelled: the group's idle flush while a batch is open, the backend's deadline while a batch is held. */
		armed(): number;
		/** Fire every armed timer, as if its time had come. */
		fireTimers(): void;
		/** From now on, the connection refuses to go to `synchronous = FULL`: every sync fails with this error. */
		failSyncs(error: Error): void;
	}

	async function open(): Promise<Harness> {
		const executed: string[] = [];
		let syncFailure: Error | undefined;
		let timers: (() => void)[] = [];
		const setTimer: SetTimer = (fn) => {
			timers.push(fn);
			return () => { timers = timers.filter(t => t !== fn); };
		};
		const db = await openTestDb({
			onExec: sql => {
				if (syncFailure && sql === 'PRAGMA synchronous = FULL') throw syncFailure;
				executed.push(sql);
			},
		});
		const storage = new SqliteRawStorage(db, { setTimer });
		return {
			db,
			storage,
			fullCommits: () => executed.filter(sql => sql === 'PRAGMA synchronous = FULL').length,
			commits: () => executed.filter(sql => sql === 'COMMIT').length,
			armed: () => timers.length,
			fireTimers: () => {
				const due = timers;
				timers = [];
				for (const fn of due) fn();
			},
			failSyncs: (error) => { syncFailure = error; },
		};
	}

	/** The rejection of `promise`, which must reject. */
	async function rejection(promise: Promise<unknown>): Promise<unknown> {
		try {
			await promise;
		} catch (err) {
			return err;
		}
		throw new Error('expected a rejection');
	}

	/** Whether `promise` settles within a few ms; a rejection fails the test. */
	const settles = (promise: Promise<void>): Promise<boolean> => Promise.race([
		promise.then(() => true),
		new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 10); }),
	]);

	/** Two groups, each flushed with a 5 s window: two transactions, no sync yet. */
	async function twoRelaxedGroups(h: Harness): Promise<void> {
		await h.storage.saveMetadata(A, metaFor(1));
		await h.storage.flush({ withinMs: 5000 });
		await h.storage.saveMetadata(B, metaFor(2));
		await h.storage.flush({ withinMs: 5000 });
		expect(h.commits(), 'one transaction per group').to.equal(2);
		expect(h.fullCommits(), 'neither group synced').to.equal(0);
	}

	it('relaxed groups commit unsynced and share one sync when the deadline is due', async () => {
		const h = await open();
		try {
			await twoRelaxedGroups(h);
			const reader = new SqliteRawStorage(h.db);
			expect(await reader.getMetadata(A), 'the first group is in the database').to.deep.equal(metaFor(1));
			expect(await reader.getMetadata(B), 'the second group is in the database').to.deep.equal(metaFor(2));
			const durable = h.storage.whenDurable();
			expect(await settles(durable), 'not durable before the deadline').to.equal(false);
			expect(h.armed(), 'one timer, for the earliest deadline').to.equal(1);

			h.fireTimers();
			await durable;
			expect(h.fullCommits(), 'one FULL commit synced both groups').to.equal(1);
			expect(h.commits(), 'the sync was a transaction of its own').to.equal(3);
			expect(h.armed(), 'the sync disarmed the timer').to.equal(0);
		} finally {
			await h.storage.close();
			await h.db.close();
		}
	});

	it('a strict flush after relaxed ones syncs once and settles all of them', async () => {
		const h = await open();
		try {
			await twoRelaxedGroups(h);
			const earlier = h.storage.whenDurable();

			await h.storage.saveMetadata(C, metaFor(3));
			await h.storage.flush();
			await earlier;
			expect(h.fullCommits(), "the strict group's own commit was the one sync").to.equal(1);
			expect(h.commits(), 'no transaction beyond the three groups').to.equal(3);
			expect(h.armed(), 'the sync disarmed the deadline timer').to.equal(0);
			expect(await settles(h.storage.whenDurable()), 'everything flushed is durable').to.equal(true);
		} finally {
			await h.storage.close();
			await h.db.close();
		}
	});

	it('a failed deferred sync rejects the durables it covered and latches the store', async () => {
		// Rule 5 of the flush contract: a sync that failed may have lost what the operating system
		// already dropped, so the store refuses everything from then on rather than retry; the groups
		// the failed sync covered were waiting on it, and must not wait for ever.
		const h = await open();
		try {
			await twoRelaxedGroups(h);
			const durable = h.storage.whenDurable();
			const disk = new Error('disk gone');
			h.failSyncs(disk);
			h.fireTimers();

			const refused = await rejection(durable);
			expect(refused, 'the covered durable rejects with the store failure').to.be.instanceOf(StoreFailedError);
			expect((refused as StoreFailedError).cause, 'carrying the fault underneath, not a wrapper').to.equal(disk);
			expect(await h.storage.getMetadata(A), 'the overlay still serves what the store never synced').to.deep.equal(metaFor(1));
			expect(await rejection(h.storage.flush()), 'every later flush is refused').to.be.instanceOf(StoreFailedError);
			expect(await rejection(h.storage.saveMetadata(C, metaFor(3))), 'and every later write').to.be.instanceOf(StoreFailedError);
			expect(h.armed(), 'the latch disarmed the deadline timer').to.equal(0);
		} finally {
			expect(await rejection(h.storage.close()), 'close reports the latch').to.be.instanceOf(StoreFailedError);
			await h.db.close();
		}
	});
});
