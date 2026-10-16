import { expect } from 'chai';
import { LevelDBJournalStore, LevelDBRawStorage } from '../src/leveldb-storage.js';
import { openAtPath, openTestDb, type TestDbHandle } from './classic-level-driver.js';
import { drain, type LevelDBLike } from '../src/leveldb-like.js';
import {
	TAG_JOURNAL,
	TAG_METADATA,
	decodeJournalMark,
	encodeJournalMark,
	isJournalMarkKey,
	journalMarkKey,
	journalRange,
	journalRecordKey,
	metadataKey,
	seqFromJournalKey,
} from '../src/keys.js';
import { makeProof, runRawStorageConformance, type ConformanceHarness } from '@optimystic/db-p2p/testing/conformance';
import type { ActionId, BlockHeader, BlockId, IBlock, Transform } from '@optimystic/db-core';
import { StoreFailedError, encodeJournalRecord, type BlockMetadata, type SetTimer } from '@optimystic/db-p2p';
import { spyBatchWrites, type BatchWrite } from './support/spy-batch-writes.js';

const blockId = 'block-1' as BlockId;
const actionId = 'action-1' as ActionId;

const makeBlock = (id: string): IBlock => {
	const header: BlockHeader = {
		id: id as BlockId,
		type: 'test',
		collectionId: 'collection-1' as BlockId,
	};
	return { header };
};

const makeTransform = (): Transform => ({ insert: makeBlock(blockId) });

// ---------------------------------------------------------------------------
// Shared parity suite. Proves LevelDBRawStorage (KvRawStorage over
// WriteGroupDriver over JournalBatchBackend over LevelDBJournalStore) behaves
// identically to every other backend — round-trips, listRevisions ordering,
// promote atomicity + the exact missing-pend error, clone-on-store/read (now
// structural via the byte boundary), drain-before-yield iteration, the
// BlockStorage parity slice, and the flush-then-reopen case. Runs against
// `classic-level`; production uses `rn-leveldb`, both satisfy `LevelDBLike`.
// Each case gets a fresh file-backed db in an isolated temp dir; cleanup closes
// the storage (which applies what it still holds and disarms its timers, which
// must not fire on a closed handle), then the handle. reopen closes the handle
// first: LevelDB holds a lock on its directory.
// ---------------------------------------------------------------------------
runRawStorageConformance('LevelDB', async (): Promise<ConformanceHarness> => {
	const handle = await openTestDb();
	let storage = new LevelDBRawStorage(handle.db);
	let reopened: LevelDBLike | undefined;
	return {
		storage,
		reopen: async () => {
			await handle.db.close();
			reopened = await openAtPath(handle.path);
			storage = new LevelDBRawStorage(reopened);
			return storage;
		},
		cleanup: async () => {
			await storage.close();
			await reopened?.close();
			await handle.cleanup();
		},
	};
}, { persistent: true });

// ---------------------------------------------------------------------------
// LevelDB-only tests the shared suite does not cover: the tag-range byte-key
// boundary (only TAG_METADATA keys decode as block ids), what a failed batch
// leaves behind, the optional full-scan getApproximateBytesUsed (which the
// shared suite skips entirely as an optional passthrough), and what readJournal
// leaves out.
// ---------------------------------------------------------------------------
describe('LevelDB store specifics', () => {
	let handle: TestDbHandle;
	let storage: LevelDBRawStorage;

	beforeEach(async () => {
		handle = await openTestDb();
		storage = new LevelDBRawStorage(handle.db);
	});

	afterEach(async () => {
		try {
			await storage.close();
		} catch (err) {
			// A storage the case latched failed refuses its closing flush; the handle is closed regardless.
			if (!(err instanceof StoreFailedError)) throw err;
		}
		await handle.cleanup();
	});

	it('listBlockIds enumerates only TAG_METADATA keys — higher-tag keys are not decoded as block ids', async () => {
		// Rows in every OTHER store (pending / revision / transaction / materialized / proofs) but
		// NO metadata. These keys sort above the metadata range (tags 0x02..0x06 vs 0x01), so the
		// metadataRange upper bound (0x02) must exclude them — none may surface as a block id.
		await storage.savePendingTransaction('only-pending' as BlockId, actionId, makeTransform());
		await storage.saveRevision('only-rev' as BlockId, 1, actionId);
		await storage.saveTransaction('only-tx' as BlockId, actionId, makeTransform());
		await storage.saveMaterializedBlock('only-mat' as BlockId, actionId, makeBlock('only-mat'));
		await storage.saveBlockProof('only-proof' as BlockId, 1, makeProof('only-proof'));
		// One genuinely committed block for contrast.
		await storage.saveMetadata('committed' as BlockId, { ranges: [[1, 1]], latest: { rev: 1, actionId } });
		// Applied, so the listing below is the tag scan and not the overlay's merge.
		await storage.flush();

		const out = new Set<string>();
		for await (const id of storage.listBlockIds()) out.add(id);
		expect(out).to.deep.equal(new Set(['committed']));
	});

	it('a batch write that fails leaves the database untouched and latches the storage', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());
		await storage.flush();

		// Decorate the underlying batch() so the next write() throws. The promote is two entries of
		// one batch; a failure in it must leave both rows as they were on disk — no half-written
		// state — and the storage refuses every later flush (rule 5 of the flush contract).
		const realDb = handle.db;
		const originalBatch = realDb.batch.bind(realDb);
		realDb.batch = () => {
			const inner = originalBatch();
			const wrapper = {
				put(k: Uint8Array, v: Uint8Array) {
					inner.put(k, v);
					return wrapper;
				},
				delete(k: Uint8Array) {
					inner.delete(k);
					return wrapper;
				},
				async write() {
					throw new Error('simulated batch failure');
				},
			};
			return wrapper;
		};

		try {
			await storage.promotePendingTransaction(blockId, actionId);
			await storage.flush();
			expect.fail('expected the simulated failure to propagate');
		} catch (err) {
			expect(err).to.be.instanceOf(StoreFailedError);
			expect(((err as StoreFailedError).cause as Error).message).to.equal('simulated batch failure');
		} finally {
			realDb.batch = originalBatch;
		}

		// On disk, read by a storage with an empty overlay: the pending row is still there and no
		// transaction row was created.
		const reader = new LevelDBRawStorage(handle.db);
		expect(await reader.getPendingTransaction(blockId, actionId)).to.deep.equal(makeTransform());
		expect(await reader.getTransaction(blockId, actionId)).to.equal(undefined);
		await reader.close();
	});

	it('getApproximateBytesUsed returns a non-negative number', async () => {
		await storage.saveMetadata(blockId, { ranges: [], latest: undefined });
		await storage.flush();
		const used = await storage.getApproximateBytesUsed();
		expect(used).to.be.a('number');
		expect(used).to.be.greaterThan(0);
	});

	it('getApproximateBytesUsed returns 0 for an empty database', async () => {
		expect(await storage.getApproximateBytesUsed()).to.equal(0);
	});

	// `JournalStore.readJournal`'s contract: a record the store cannot trust is left out, so recovery
	// treats its number as a gap — one whose bytes do not decode, and one filed under a key naming a
	// different number than the record carries; a mark that is not 8 bytes reads as 0.
	it('readJournal leaves out a record it cannot trust and reads a malformed mark as 0', async () => {
		const store = new LevelDBJournalStore(handle.db);
		const key = { store: 'metadata', blockId: 'journaled' as BlockId } as const;
		const record = (seq: number) => ({ seq, entries: [{ key, value: new Uint8Array([seq]) }] });
		await store.appendJournal(record(1));
		await handle.db.batch()
			.put(journalRecordKey(2), new Uint8Array([0xff, 1, 2]))
			.put(journalRecordKey(3), encodeJournalRecord(record(5)))
			.put(journalMarkKey(), new Uint8Array([7]))
			.write();
		await store.appendJournal(record(4));

		const { appliedThrough, records } = await store.readJournal();
		expect(appliedThrough).to.equal(0);
		expect(records.map(r => r.seq)).to.deep.equal([1, 4]);
	});
});

// ---------------------------------------------------------------------------
// The window. A relaxed flush appends its group as one unsynced batch on the
// journal's tag; the apply — one synced batch over the data tags and the
// journal — comes by the deadline, from the timer, or sooner from a strict
// flush, and one apply covers every group appended since the last. Nothing here
// cuts the power, so what is checked is which batches were written and whether
// each asked to sync, through a spy on the handle; the timer is fired by hand.
// ---------------------------------------------------------------------------
describe('LevelDB sync by the window', () => {
	const A = 'block-a' as BlockId;
	const B = 'block-b' as BlockId;
	const metaFor = (rev: number): BlockMetadata => ({ ranges: [[1, rev]], latest: { rev, actionId: `tx-${rev}` as ActionId } });
	const UNSYNCED_APPEND: BatchWrite = { sync: false, tags: [TAG_JOURNAL] };
	const SYNCED_APPLY: BatchWrite = { sync: true, tags: [TAG_METADATA, TAG_JOURNAL] };

	interface Harness {
		/** The real handle, for reading raw and for closing. */
		readonly handle: TestDbHandle;
		readonly storage: LevelDBRawStorage;
		/** Every batch the storage wrote, in order. */
		readonly writes: BatchWrite[];
		/** Timers armed and not cancelled: the group's idle flush while a batch is open, the backend's deadline while a record is held. */
		armed(): number;
		/** Fire every armed timer, as if its time had come. */
		fireTimers(): void;
	}

	async function open(canSync?: boolean): Promise<Harness> {
		const handle = await openTestDb();
		const { db, writes } = spyBatchWrites(handle.db, { canSync });
		let timers: (() => void)[] = [];
		const setTimer: SetTimer = (fn) => {
			timers.push(fn);
			return () => { timers = timers.filter(t => t !== fn); };
		};
		const storage = new LevelDBRawStorage(db, { setTimer });
		return {
			handle,
			storage,
			writes,
			armed: () => timers.length,
			fireTimers: () => {
				const due = timers;
				timers = [];
				for (const fn of due) fn();
			},
		};
	}

	/** Whether `promise` settles within a few ms; a rejection fails the test. */
	const settles = (promise: Promise<void>): Promise<boolean> => Promise.race([
		promise.then(() => true),
		new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 10); }),
	]);

	/** The journal's keys read straight off the handle: each record's number, and `'mark'` for the mark. */
	async function journalKeys(db: LevelDBLike): Promise<(number | 'mark')[]> {
		const range = journalRange();
		const entries = await drain(db.iterator({ gte: range.gte, lt: range.lt, keys: true }));
		return entries.map(([key]) => isJournalMarkKey(key) ? 'mark' : seqFromJournalKey(key)!);
	}

	async function mark(db: LevelDBLike): Promise<number | undefined> {
		const value = await db.get(journalMarkKey());
		return value === undefined ? undefined : decodeJournalMark(value);
	}

	it('a relaxed group is appended unsynced and applied synced when its deadline is due', async () => {
		const h = await open();
		try {
			await h.storage.saveMetadata(A, metaFor(1));
			await h.storage.flush({ withinMs: 5000 });
			expect(h.writes, 'one unsynced batch on the journal alone').to.deep.equal([UNSYNCED_APPEND]);
			expect(await h.storage.getMetadata(A), 'the overlay serves the group meanwhile').to.deep.equal(metaFor(1));
			// Read raw: a second storage over the handle would run recovery, which is the apply itself.
			expect(await h.handle.db.get(metadataKey(A)), 'the data tags do not hold it yet').to.equal(undefined);
			expect(await journalKeys(h.handle.db), 'the journal holds the record and no mark').to.deep.equal([1]);
			const durable = h.storage.whenDurable();
			expect(await settles(durable), 'not durable before the deadline').to.equal(false);
			expect(h.armed(), 'one timer, for the deadline').to.equal(1);

			h.fireTimers();
			await durable;
			expect(h.writes, 'the apply is one synced batch over the data tags and the journal').to.deep.equal([UNSYNCED_APPEND, SYNCED_APPLY]);
			expect(h.armed(), 'the apply disarmed the timer').to.equal(0);
			const reader = new LevelDBRawStorage(h.handle.db);
			expect(await reader.getMetadata(A), 'applied to the data tags').to.deep.equal(metaFor(1));
			await reader.close();
			expect(await journalKeys(h.handle.db), 'the record is gone and the mark set').to.deep.equal(['mark']);
			expect(await mark(h.handle.db)).to.equal(1);
		} finally {
			await h.storage.close();
			await h.handle.cleanup();
		}
	});

	it('journaled groups survive the process going away: the next open applies them', async () => {
		const h = await open();
		try {
			await h.storage.saveMetadata(A, metaFor(1));
			await h.storage.flush({ withinMs: 5000 });
			await h.storage.saveMetadata(B, metaFor(2));
			await h.storage.flush({ withinMs: 5000 });
			expect(h.writes).to.deep.equal([UNSYNCED_APPEND, UNSYNCED_APPEND]);

			// A second storage over the same handle, the first never closed: what the process going
			// away leaves behind is the two appended records, which the next open's recovery applies.
			const next = new LevelDBRawStorage(h.handle.db);
			expect(await next.getMetadata(A)).to.deep.equal(metaFor(1));
			expect(await next.getMetadata(B)).to.deep.equal(metaFor(2));
			expect(await journalKeys(h.handle.db), 'recovery deleted the records it applied').to.deep.equal(['mark']);
			expect(await mark(h.handle.db)).to.equal(2);
			await next.close();
		} finally {
			// The first storage is deliberately not closed: its timers are the harness's and never fire,
			// and closing it would run a second apply over one store that Invariant 5 forbids.
			await h.handle.cleanup();
		}
	});

	it('on a handle that cannot sync, a flushed group is one unsynced batch and nothing is journaled', async () => {
		const h = await open(false);
		try {
			expect(h.storage.durability).to.equal('process-crash');
			await h.storage.saveMetadata(A, metaFor(1));
			await h.storage.flush({ withinMs: 5000 });
			expect(h.writes, 'one unsynced apply of the group itself: the data tag and the mark, no append').to.deep.equal([{ sync: false, tags: [TAG_METADATA, TAG_JOURNAL] }]);
			expect(h.armed(), 'nothing held, so no deadline timer').to.equal(0);
			expect(await settles(h.storage.whenDurable()), 'as durable as the handle allows at once').to.equal(true);
			expect(await journalKeys(h.handle.db), 'no record was ever appended').to.deep.equal(['mark']);
			expect(await mark(h.handle.db)).to.equal(1);
			expect(await h.handle.db.get(metadataKey(A)), 'applied to the data tags').to.not.equal(undefined);
		} finally {
			await h.storage.close();
			await h.handle.cleanup();
		}
	});

	it('the mark survives its encoding above 32 bits: what an apply writes is what readJournal reads', async () => {
		const handle = await openTestDb();
		try {
			const store = new LevelDBJournalStore(handle.db);
			await store.applyJournal([], 2 ** 40 + 3, []);
			expect(await handle.db.get(journalMarkKey())).to.deep.equal(encodeJournalMark(2 ** 40 + 3));
			expect((await store.readJournal()).appliedThrough).to.equal(2 ** 40 + 3);
		} finally {
			await handle.cleanup();
		}
	});
});
