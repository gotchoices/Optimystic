import { expect } from 'chai';
import type { ActionId, BlockId } from '@optimystic/db-core';
import { runRawStorageConformance } from '../src/testing/raw-storage-conformance.js';
import { MemoryJournalStore, type MemoryJournalApply } from '../src/testing/memory-journal-store.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { WriteGroupDriver } from '../src/storage/write-group-driver.js';
import { JournalBatchBackend, type JournalRecord } from '../src/storage/journal-batch-backend.js';
import { decodeJournalRecord, encodeJournalRecord, JournalRecordDecodeError } from '../src/storage/journal-record-codec.js';
import { StoreFailedError, type SetTimer } from '../src/storage/write-group.js';

// --- Backend parity: the composition behaves like every other backend ---
//
// Registered persistent, with the reopen a fresh backend and driver over the SAME store: the
// first driver's `close` applies everything held, and the second's open finds an empty journal.
runRawStorageConformance('WriteGroupDriver over JournalBatchBackend over memory', async () => {
	const store = new MemoryJournalStore();
	const opened: KvRawStorage[] = [];
	const open = (): KvRawStorage => {
		const storage = new KvRawStorage(new WriteGroupDriver(new JournalBatchBackend(store)));
		opened.push(storage);
		return storage;
	};
	return {
		storage: open(),
		reopen: async () => open(),
		cleanup: async () => { for (const storage of opened) await storage.close?.(); }
	};
}, { persistent: true });

// --- The journal itself ---

const encoder = new TextEncoder();
const bytes = (s: string): Uint8Array => encoder.encode(s);
const text = (b: Uint8Array | undefined): string | undefined => b === undefined ? undefined : new TextDecoder().decode(b);
const neverFires: SetTimer = () => () => undefined;
const block = (name: string): BlockId => name as BlockId;
const metadata = (name: string): { store: 'metadata'; blockId: BlockId } => ({ store: 'metadata', blockId: block(name) });

const seqs = (records: readonly JournalRecord[]): number[] => records.map(record => record.seq);
/** One apply as `[the seqs applied, the mark set, the seqs discarded]`. */
const summary = (apply: MemoryJournalApply): [number[], number, readonly number[]] => [seqs(apply.apply), apply.appliedThrough, apply.discard];

/**
 * A driver over a journal backend over `store`, with the backend's deadline timers caught for the
 * test to fire by hand and a clock that stands still, so a deadline is never due on its own; the
 * driver's own idle timer never fires. `open` builds another over the same store, as a restart would.
 */
function harness(store = new MemoryJournalStore()) {
	const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const setTimer: SetTimer = (fn, ms) => {
		const timer = { fn, ms, cancelled: false };
		timers.push(timer);
		return () => { timer.cancelled = true; };
	};
	const open = (): WriteGroupDriver => new WriteGroupDriver(new JournalBatchBackend(store, { setTimer, now: () => 0 }), { setTimer: neverFires });
	return { store, timers, open, driver: open() };
}

/** Write one metadata value and flush with the window given (strict when absent). */
async function group(driver: WriteGroupDriver, name: string, withinMs?: number): Promise<void> {
	await driver.putMetadata(block(name), bytes(name));
	await driver.flush(withinMs === undefined ? undefined : { withinMs });
}

describe('JournalBatchBackend', () => {
	it('relaxed groups are journaled, not applied, and applied together in order when their deadline is due', async () => {
		const { store, timers, driver } = harness();
		await group(driver, 'b1', 5000);
		await group(driver, 'b2', 5000);

		expect(seqs(store.appended)).to.deep.equal([1, 2]);
		expect(store.applied, 'nothing applied before the deadline').to.deep.equal([]);
		expect(await store.get(metadata('b1')), 'the store\'s reads do not reflect a journaled record').to.equal(undefined);
		expect(text(await driver.getMetadata(block('b1'))), 'the overlay serves it meanwhile').to.equal('b1');
		expect(timers.filter(t => !t.cancelled).map(t => t.ms), 'one timer, for the earliest deadline').to.deep.equal([5000]);

		timers[0]!.fn();
		await driver.whenDurable();
		expect(store.applied.map(summary)).to.deep.equal([[[1, 2], 2, []]]);
		expect(store.journalSeqs, 'the apply deleted the records it applied').to.deep.equal([]);
		expect(text(await store.get(metadata('b2')))).to.equal('b2');
	});

	it('a strict flush applies every held record and its own group in one apply, and never journals its own group', async () => {
		const { store, driver } = harness();
		await group(driver, 'b1', 5000);
		await group(driver, 'b2');

		expect(seqs(store.appended)).to.deep.equal([1]);
		expect(store.applied.map(summary)).to.deep.equal([[[1, 2], 2, []]]);
		expect(text(await store.get(metadata('b1')))).to.equal('b1');
		expect(text(await store.get(metadata('b2')))).to.equal('b2');
	});

	it('a power cut that loses a middle record keeps the groups before it and none after; the sequence continues after the prefix', async () => {
		const { store, driver, open } = harness();
		for (const name of ['b1', 'b2', 'b3']) await group(driver, name, 5000);
		expect(seqs(store.appended)).to.deep.equal([1, 2, 3]);
		store.powerLoss({ lose: [2] });

		const fresh = open();
		expect(text(await fresh.getMetadata(block('b1'))), 'the prefix before the gap').to.equal('b1');
		expect(await fresh.getMetadata(block('b2')), 'the lost record').to.equal(undefined);
		expect(await fresh.getMetadata(block('b3')), 'and everything after it').to.equal(undefined);
		expect(store.applied.map(summary), 'one apply: the prefix applied, the rest discarded').to.deep.equal([[[1], 1, [3]]]);
		expect(store.journalSeqs).to.deep.equal([]);

		await group(fresh, 'b4', 5000);
		expect(store.appended[store.appended.length - 1]!.seq, 'the next group takes the number after the prefix').to.equal(2);
		expect(text(await fresh.getMetadata(block('b4')))).to.equal('b4');
		await fresh.flush();
		expect(store.applied.map(summary)).to.deep.equal([[[1], 1, [3]], [[2], 2, []]]);
		expect(text(await store.get(metadata('b4')))).to.equal('b4');
	});

	it('a process crash loses nothing that was flushed: a fresh backend applies every held record at open', async () => {
		const { store, driver, open } = harness();
		await group(driver, 'b1', 5000);
		await group(driver, 'b2', 5000);

		const fresh = open();
		expect(text(await fresh.getMetadata(block('b1')))).to.equal('b1');
		expect(text(await fresh.getMetadata(block('b2')))).to.equal('b2');
		expect(store.applied.map(summary)).to.deep.equal([[[1, 2], 2, []]]);
		expect(store.mark).to.equal(2);
	});

	it('on a store that cannot sync, every group is applied at once and nothing is journaled', async () => {
		const { store, driver } = harness(new MemoryJournalStore({ durability: 'process-crash' }));
		await group(driver, 'b1', 5000);

		expect(driver.durability).to.equal('process-crash');
		expect(store.appended).to.deep.equal([]);
		expect(store.applied.map(summary)).to.deep.equal([[[1], 1, []]]);
		expect(text(await store.get(metadata('b1')))).to.equal('b1');
		await driver.whenDurable();
	});

	it('a deferred apply that rejects fails the held durables and latches the backend', async () => {
		const { driver, timers } = harness(new MemoryJournalStore({ beforeApply: () => { throw new Error('disk gone'); } }));
		await group(driver, 'b1', 5000);
		const whenDurable = driver.whenDurable();

		timers[0]!.fn();
		const failure = await whenDurable.then(() => undefined, (err: unknown) => err);
		expect(failure).to.be.instanceOf(StoreFailedError);
		expect(((failure as StoreFailedError).cause as Error).message).to.equal('disk gone');
		const later = await driver.flush().then(() => undefined, (err: unknown) => err);
		expect(later, 'every later flush is refused').to.be.instanceOf(StoreFailedError);
		expect(text(await driver.getMetadata(block('b1'))), 'the overlay keeps serving what was never applied').to.equal('b1');
	});
});

describe('journal record codec', () => {
	it('round-trips a record holding puts and a delete, with a seq above 32 bits', () => {
		const record: JournalRecord = {
			seq: 2 ** 40 + 7,
			entries: [
				{ key: { store: 'metadata', blockId: block('b') }, value: bytes('meta') },
				{ key: { store: 'revisions', blockId: block('b'), rev: 3 }, value: bytes('tx:a') },
				{ key: { store: 'pending', blockId: block('b'), actionId: 'tx:a' as ActionId } },
			],
		};
		const decoded = decodeJournalRecord(encodeJournalRecord(record));
		expect(decoded.seq).to.equal(record.seq);
		expect(decoded.entries.map(e => [e.key, text(e.value)])).to.deep.equal(record.entries.map(e => [e.key, text(e.value)]));
	});

	it('refuses an unknown version and a length that runs past the end', () => {
		const encoded = encodeJournalRecord({ seq: 1, entries: [{ key: { store: 'metadata', blockId: block('b') }, value: bytes('v') }] });
		expect(() => decodeJournalRecord(encoded.subarray(0, encoded.length - 1))).to.throw(JournalRecordDecodeError);
		const wrongVersion = Uint8Array.from(encoded);
		wrongVersion[0] = 9;
		expect(() => decodeJournalRecord(wrongVersion)).to.throw(JournalRecordDecodeError);
	});
});
