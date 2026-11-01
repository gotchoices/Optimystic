// Polyfill IndexedDB into the Node test environment before importing `idb`.
import 'fake-indexeddb/auto';
import { expect } from 'chai';
import { IndexedDBRawStorage, IndexedDBJournalStore } from '../src/indexeddb-storage.js';
import { openOptimysticWebDb, JOURNAL_MARK_KEY, type OptimysticWebDBHandle } from '../src/db.js';
import { runRawStorageConformance, type ConformanceHarness } from '@optimystic/db-p2p/testing/conformance';
import type { BlockId, ActionId } from '@optimystic/db-core';
import type { BlockMetadata, SetTimer } from '@optimystic/db-p2p';
import { spyTransactions, type TransactionCall } from './support/spy-transactions.js';

let dbCounter = 0;

function freshDbName(): string {
	return `optimystic-idb-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`;
}

async function freshDb(): Promise<OptimysticWebDBHandle> {
	return openOptimysticWebDb(freshDbName());
}

// `fake-indexeddb` honours `durability` on a transaction but does not put the property on
// `IDBTransaction.prototype`, so detection says no; the override puts every store on the journal
// path a strict-capable browser takes. See `supportsStrictDurability`.
const STRICT = { strictDurability: true } as const;

// ---------------------------------------------------------------------------
// Shared parity suite. Proves IndexedDBRawStorage (KvRawStorage over
// WriteGroupDriver over JournalBatchBackend over IndexedDBJournalStore) behaves
// identically to every other backend — round-trips, listRevisions ordering,
// promote atomicity + the exact missing-pend error, clone-on-store/read
// (structural via the byte boundary), drain-before-yield iteration, the
// BlockStorage parity slice, and the flush-then-reopen case. Runs against
// `fake-indexeddb`; production is the browser, both satisfy the handle
// interface. Each case gets a fresh, uniquely-named db; cleanup closes the
// storage (which applies what it still holds and disarms its timers, which must
// not fire on a closed handle), then the handle. Reopen closes the handle and
// opens the same name again through the package's own opener.
// ---------------------------------------------------------------------------
runRawStorageConformance('IndexedDB', async (): Promise<ConformanceHarness> => {
	const name = freshDbName();
	let db = await openOptimysticWebDb(name);
	let storage = new IndexedDBRawStorage(db, STRICT);
	return {
		storage,
		reopen: async () => {
			db.close();
			db = await openOptimysticWebDb(name);
			storage = new IndexedDBRawStorage(db, STRICT);
			return storage;
		},
		cleanup: async () => {
			await storage.close();
			db.close();
		}
	};
}, { persistent: true });

// ---------------------------------------------------------------------------
// IndexedDB-only tests the shared suite does not cover.
// ---------------------------------------------------------------------------
describe('IndexedDB store specifics', () => {
	let db: OptimysticWebDBHandle;

	beforeEach(async () => {
		db = await freshDb();
	});

	afterEach(() => {
		db.close();
	});

	/** One applied record holding `entries`, as the journal backend's strict apply writes it. */
	const applyOne = (store: IndexedDBJournalStore, entries: { key: Parameters<IndexedDBJournalStore['get']>[0]; value: Uint8Array }[]): Promise<void> =>
		store.applyJournal([{ seq: 1, entries }], 1, []);

	// The shared suite has no getApproximateBytesUsed case; navigator.storage is
	// generally absent under Node + fake-indexeddb, so we expect 0. In a real
	// browser the value is > 0; the contract here is "doesn't throw, returns a
	// number >= 0."
	it('getApproximateBytesUsed returns a number', async () => {
		const storage = new IndexedDBRawStorage(db, STRICT);
		const used = await storage.getApproximateBytesUsed();
		expect(used).to.be.a('number');
		expect(used).to.be.at.least(0);
	});

	// Structured-clone byte fidelity is IndexedDB-specific: a stored Uint8Array
	// must come back AS a Uint8Array (not an ArrayBuffer / DataView), byte-for-byte,
	// or the kernel's decode would drift. Assert it at the store's byte boundary
	// directly. (The conformance round-trip/clone cases catch this indirectly via
	// decode; this pins the exact type + bytes.)
	it('stores and returns a byte-identical Uint8Array (structured-clone fidelity)', async () => {
		const store = new IndexedDBJournalStore(db, STRICT);
		const key = { store: 'metadata', blockId: 'bytes-block' as BlockId } as const;
		const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
		await applyOne(store, [{ key, value: bytes }]);

		const got = await store.get(key);
		expect(got).to.be.instanceOf(Uint8Array);
		expect(Array.from(got!)).to.deep.equal([0, 1, 2, 250, 255, 128]);
	});

	// The pending scan relies on IndexedDB array-key ordering: the
	// `[blockId] .. [blockId, []]` bound must capture every `[blockId, actionId]`
	// key for the block and nothing from a neighbouring block whose id sorts
	// adjacently. Exercise it directly at the store level.
	it('listPendingActionIds captures all of a block and leaks no neighbour', async () => {
		const store = new IndexedDBJournalStore(db, STRICT);
		const value = new Uint8Array([1]);
		const pending = (blockId: string, actionId: string) => ({ store: 'pending', blockId: blockId as BlockId, actionId: actionId as ActionId } as const);
		// `block-10` sorts adjacent to `block-1` under string comparison; it must
		// not leak into `block-1`'s pending listing.
		await applyOne(store, [
			{ key: pending('block-1', 'a'), value },
			{ key: pending('block-1', 'b'), value },
			{ key: pending('block-10', 'x'), value },
		]);

		const ids = await store.listPendingActionIds('block-1' as BlockId);
		expect(ids.sort()).to.deep.equal(['a', 'b']);
	});

	// `JournalStore.readJournal`'s contract: a record the store cannot read is left out, so recovery
	// treats its number as a gap. A record is stored by structured clone with no codec, so the check
	// is on its shape; a mark that is not a non-negative integer reads as 0.
	it('readJournal leaves out a value that is not a record and reads a malformed mark as 0', async () => {
		const store = new IndexedDBJournalStore(db, STRICT);
		const key = { store: 'metadata', blockId: 'journaled' as BlockId } as const;
		const record = (seq: number) => ({ seq, entries: [{ key, value: new Uint8Array([seq]) }] });
		await store.appendJournal(record(1));
		await db.put('journal', { seq: 2, entries: [{ key: { store: 'nowhere', blockId: 'x' }, value: new Uint8Array() }] } as never, 2);
		await store.appendJournal(record(3));
		await db.put('journal', 'not a number' as never, JOURNAL_MARK_KEY);

		const { appliedThrough, records } = await store.readJournal();
		expect(appliedThrough).to.equal(0);
		expect(records.map(r => r.seq)).to.deep.equal([1, 3]);
	});
});

// ---------------------------------------------------------------------------
// The window. A relaxed flush appends its group as one relaxed transaction on
// the journal store; the apply — one strict transaction over the data stores
// and the journal — comes by the deadline, from the timer, or sooner from a
// strict flush, and one apply covers every group appended since the last.
// `fake-indexeddb` has no disk, so what is checked is which durability each
// transaction asked for, through a spy on the handle; the timer is fired by
// hand.
// ---------------------------------------------------------------------------
describe('IndexedDB sync by the window', () => {
	const A = 'block-a' as BlockId;
	const B = 'block-b' as BlockId;
	const C = 'block-c' as BlockId;
	const metaFor = (rev: number): BlockMetadata => ({ ranges: [[1, rev]], latest: { rev, actionId: `tx-${rev}` as ActionId } });
	const DATA_AND_JOURNAL = ['journal', 'materialized', 'metadata', 'pending', 'proofs', 'revisions', 'transactions'];
	/** A write transaction as `[the stores it covered, the durability it asked for]`. */
	const shape = (call: TransactionCall): [readonly string[], string | undefined] => [call.stores, call.durability];
	const RELAXED_APPEND: [readonly string[], string | undefined] = [['journal'], 'relaxed'];
	const STRICT_APPLY: [readonly string[], string | undefined] = [DATA_AND_JOURNAL, 'strict'];

	interface Harness {
		/** The real handle, for a reader with no overlay and for closing. */
		readonly handle: OptimysticWebDBHandle;
		readonly storage: IndexedDBRawStorage;
		/** Every `readwrite` transaction the storage opened, in order. */
		writes(): TransactionCall[];
		/** Timers armed and not cancelled: the group's idle flush while a batch is open, the backend's deadline while a record is held. */
		armed(): number;
		/** Fire every armed timer, as if its time had come. */
		fireTimers(): void;
	}

	async function open(): Promise<Harness> {
		const handle = await freshDb();
		const { db, calls } = spyTransactions(handle);
		let timers: (() => void)[] = [];
		const setTimer: SetTimer = (fn) => {
			timers.push(fn);
			return () => { timers = timers.filter(t => t !== fn); };
		};
		const storage = new IndexedDBRawStorage(db, { ...STRICT, setTimer });
		return {
			handle,
			storage,
			writes: () => calls.filter(call => call.mode === 'readwrite'),
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

	it('a relaxed group is appended relaxed and applied strictly when its deadline is due', async () => {
		const h = await open();
		try {
			await h.storage.saveMetadata(A, metaFor(1));
			await h.storage.flush({ withinMs: 5000 });
			expect(h.writes().map(shape), 'one relaxed transaction on the journal alone').to.deep.equal([RELAXED_APPEND]);
			expect(await h.storage.getMetadata(A), 'the overlay serves the group meanwhile').to.deep.equal(metaFor(1));
			// Read raw: a second storage over the handle would run recovery, which is the apply itself.
			expect(await h.handle.get('metadata', A), 'the data stores do not hold it yet').to.equal(undefined);
			expect(await h.handle.getAllKeys('journal'), 'the journal holds the record and no mark').to.deep.equal([1]);
			const durable = h.storage.whenDurable();
			expect(await settles(durable), 'not durable before the deadline').to.equal(false);
			expect(h.armed(), 'one timer, for the deadline').to.equal(1);

			h.fireTimers();
			await durable;
			expect(h.writes().map(shape), 'the apply is one strict transaction over the data stores and the journal').to.deep.equal([RELAXED_APPEND, STRICT_APPLY]);
			expect(h.armed(), 'the apply disarmed the timer').to.equal(0);
			expect(await new IndexedDBRawStorage(h.handle, STRICT).getMetadata(A), 'applied to the data stores').to.deep.equal(metaFor(1));
			expect(await h.handle.getAllKeys('journal'), 'the record is gone and the mark set').to.deep.equal([JOURNAL_MARK_KEY]);
			expect(await h.handle.get('journal', JOURNAL_MARK_KEY)).to.equal(1);
		} finally {
			await h.storage.close();
			h.handle.close();
		}
	});

	it('a strict flush applies the groups held and its own in one strict transaction', async () => {
		const h = await open();
		try {
			await h.storage.saveMetadata(A, metaFor(1));
			await h.storage.flush({ withinMs: 5000 });
			const earlier = h.storage.whenDurable();

			await h.storage.saveMetadata(C, metaFor(3));
			await h.storage.flush();
			await earlier;
			expect(h.writes().map(shape), 'the strict group journals nothing of its own').to.deep.equal([RELAXED_APPEND, STRICT_APPLY]);
			expect(h.armed(), 'the apply disarmed the deadline timer').to.equal(0);
			const reader = new IndexedDBRawStorage(h.handle, STRICT);
			expect(await reader.getMetadata(A), 'the held group is applied').to.deep.equal(metaFor(1));
			expect(await reader.getMetadata(C), 'and the strict one').to.deep.equal(metaFor(3));
			expect(await settles(h.storage.whenDurable()), 'everything flushed is durable').to.equal(true);
		} finally {
			await h.storage.close();
			h.handle.close();
		}
	});

	it('journaled groups survive the page going away: the next open applies them', async () => {
		const h = await open();
		try {
			await h.storage.saveMetadata(A, metaFor(1));
			await h.storage.flush({ withinMs: 5000 });
			await h.storage.saveMetadata(B, metaFor(2));
			await h.storage.flush({ withinMs: 5000 });
			expect(h.writes().map(shape)).to.deep.equal([RELAXED_APPEND, RELAXED_APPEND]);

			// A second storage over the same handle, the first never closed: what a tab closing leaves
			// behind is the two completed journal transactions, which the next open's recovery applies.
			const next = new IndexedDBRawStorage(h.handle, STRICT);
			expect(await next.getMetadata(A)).to.deep.equal(metaFor(1));
			expect(await next.getMetadata(B)).to.deep.equal(metaFor(2));
			expect(await h.handle.getAllKeys('journal'), 'recovery deleted the records it applied').to.deep.equal([JOURNAL_MARK_KEY]);
			expect(await h.handle.get('journal', JOURNAL_MARK_KEY)).to.equal(2);
			await next.close();
		} finally {
			// The first storage is deliberately not closed: its timers are the harness's and never fire,
			// and closing it would run the second apply over one store that Invariant 5 forbids.
			h.handle.close();
		}
	});
});
