import { expect } from 'chai';
import type { BlockId, ActionId } from '@optimystic/db-core';
import { delay } from '@optimystic/db-core/test';
import { runRawStorageConformance } from '../src/testing/raw-storage-conformance.js';
import { MemoryBatchBackend, type MemoryCommittedBatch } from '../src/testing/memory-batch-backend.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { WriteGroupDriver } from '../src/storage/write-group-driver.js';
import { StoreFailedError, type SetTimer } from '../src/storage/write-group.js';
import type { BatchBackend } from '../src/storage/batch-backend.js';
import type { StoreIdentity } from '../src/storage/store-identity.js';
import { collect } from './support/cache-test-helpers.js';

// --- Backend parity: the overlay driver over the memory backend behaves like every other backend ---
//
// Registered persistent, with the reopen a second driver over the SAME backend: what the first
// driver's `close` flushed is exactly what the second can read, so the reopen case proves `close`
// hands every unflushed write to the backend.
runRawStorageConformance('WriteGroupDriver over memory', async () => {
	const backend = new MemoryBatchBackend();
	const opened: KvRawStorage[] = [];
	const open = (): KvRawStorage => {
		const storage = new KvRawStorage(new WriteGroupDriver(backend));
		opened.push(storage);
		return storage;
	};
	return {
		storage: open(),
		reopen: async () => open(),
		cleanup: async () => { for (const storage of opened) await storage.close?.(); }
	};
}, { persistent: true });

// --- The group commit itself ---

const B = 'block' as BlockId;
const encoder = new TextEncoder();
const bytes = (s: string): Uint8Array => encoder.encode(s);
const text = (b: Uint8Array | undefined): string | undefined => b === undefined ? undefined : new TextDecoder().decode(b);
const neverFires: SetTimer = () => () => undefined;

/** A backend whose next commit parks until `release()`; `started` resolves once that commit has begun. */
function parkableBackend(): { backend: MemoryBatchBackend; park: () => Promise<void>; release: () => void } {
	let gate: Promise<void> | undefined;
	let open: (() => void) | undefined;
	let reached: (() => void) | undefined;
	const backend = new MemoryBatchBackend({
		beforeApply: () => {
			const held = gate;
			gate = undefined;
			reached?.();
			return held;
		}
	});
	return {
		backend,
		park: () => {
			gate = new Promise<void>(res => { open = res; });
			return new Promise<void>(res => { reached = res; });
		},
		release: () => open?.(),
	};
}

const summary = (batch: MemoryCommittedBatch): [string, string][] =>
	batch.entries.map(e => [e.key.store, e.value === undefined ? '<delete>' : text(e.value)!]);

describe('WriteGroupDriver', () => {
	it('a write resolves before any commit and is served from memory; flush hands the group to one commit in resolution order', async () => {
		const backend = new MemoryBatchBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putMetadata(B, bytes('meta'));
		await driver.putPending(B, 'a1' as ActionId, bytes('pend'));
		await driver.deletePending(B, 'a1' as ActionId);
		expect(backend.committed, 'nothing reached the backend before a flush').to.have.length(0);
		expect(text(await driver.getMetadata(B))).to.equal('meta');
		expect(await driver.getPending(B, 'a1' as ActionId), 'the overlay delete answers without the backend').to.equal(undefined);

		await driver.flush();
		expect(backend.committed).to.have.length(1);
		expect(summary(backend.committed[0]!)).to.deep.equal([['metadata', 'meta'], ['pending', 'pend'], ['pending', '<delete>']]);
		expect(text(await driver.getMetadata(B)), 'served by the backend once the overlay dropped it').to.equal('meta');

		await driver.flush();
		expect(backend.committed, 'a group that wrote nothing costs no commit').to.have.length(1);
	});

	it('a flush with nothing to commit while a commit is in flight waits for that commit', async () => {
		const { backend, park, release } = parkableBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putMetadata(B, bytes('m'));
		const started = park();
		const first = driver.flush();
		await started;

		let secondDone = false;
		const second = driver.flush().then(() => { secondDone = true; });
		await delay(5);
		expect(secondDone, 'resolves only once the in-flight commit, which holds its writes, has').to.equal(false);

		release();
		await first;
		await second;
		expect(backend.committed).to.have.length(1);
	});

	it('flushes arriving while a commit is in flight share the next commit: two commits for three flushes', async () => {
		const { backend, park, release } = parkableBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putMetadata('b1' as BlockId, bytes('1'));
		const started = park();
		const first = driver.flush();
		await started;

		await driver.putMetadata('b2' as BlockId, bytes('2'));
		const second = driver.flush();
		await driver.putMetadata('b3' as BlockId, bytes('3'));
		const third = driver.flush();

		release();
		await Promise.all([first, second, third]);
		expect(backend.committed.map(summary)).to.deep.equal([
			[['metadata', '1']],
			[['metadata', '2'], ['metadata', '3']],
		]);
	});

	it('a key written again after its batch was sealed is still served from memory when that batch commits', async () => {
		const { backend, park, release } = parkableBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putMetadata(B, bytes('v1'));
		const started = park();
		const first = driver.flush();
		await started;
		await driver.putMetadata(B, bytes('v2'));

		release();
		await first;
		expect(text(await backend.get({ store: 'metadata', blockId: B })), 'the backend holds the sealed batch').to.equal('v1');
		expect(text(await driver.getMetadata(B)), 'the later write outlives the earlier batch\'s overlay drop').to.equal('v2');

		await driver.flush();
		expect(text(await backend.get({ store: 'metadata', blockId: B }))).to.equal('v2');
	});

	it('a delete in the overlay hides a record the backend still holds, from reads and from listings', async () => {
		const backend = new MemoryBatchBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putPending(B, 'x' as ActionId, bytes('p'));
		await driver.putPending(B, 'kept' as ActionId, bytes('k'));
		await driver.flush();
		await driver.deletePending(B, 'x' as ActionId);

		expect(await backend.listPendingActionIds(B), 'the backend has not seen the delete').to.have.members(['x', 'kept']);
		expect(await driver.getPending(B, 'x' as ActionId)).to.equal(undefined);
		expect(await collect(driver.listPendingActionIds(B))).to.deep.equal(['kept']);
	});

	it('a rejected commit latches the store failed: later writes and flushes throw StoreFailedError, the overlay is kept', async () => {
		const backend = new MemoryBatchBackend({ beforeApply: () => { throw new Error('disk gone'); } });
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putMetadata(B, bytes('held'));

		const failed = await driver.flush().then(() => undefined, (err: unknown) => err);
		expect(failed).to.be.instanceOf(StoreFailedError);
		expect(((failed as StoreFailedError).cause as Error).message).to.equal('disk gone');

		for (const later of [driver.putMetadata(B, bytes('again')), driver.flush(), driver.promote(B, 'none' as ActionId)]) {
			expect(await later.then(() => undefined, (err: unknown) => err)).to.be.instanceOf(StoreFailedError);
		}
		expect(backend.committed).to.have.length(0);
		expect(text(await driver.getMetadata(B)), 'reads keep working, and the overlay still serves what the backend never took').to.equal('held');
	});

	it('rangeRevisions orders overlay rows with the backend rows, reversed when asked', async () => {
		const backend = new MemoryBatchBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putRevision(B, 1, bytes('a1'));
		await driver.putRevision(B, 3, bytes('a3'));
		await driver.flush();
		await driver.putRevision(B, 2, bytes('a2'));
		await driver.putRevision(B, 4, bytes('a4'));

		const revs = async (lo: number, hi: number, reverse: boolean): Promise<number[]> =>
			(await collect(driver.rangeRevisions(B, lo, hi, reverse))).map(([rev]) => rev);
		expect(await revs(1, 4, false)).to.deep.equal([1, 2, 3, 4]);
		expect(await revs(1, 4, true)).to.deep.equal([4, 3, 2, 1]);
		expect(await revs(2, 3, false), 'both bounds apply to overlay rows too').to.deep.equal([2, 3]);
	});

	it('listBlockIds yields the backend\'s blocks and those whose metadata is only in the overlay, once each', async () => {
		const backend = new MemoryBatchBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putMetadata('b1' as BlockId, bytes('1'));
		await driver.flush();
		await driver.putMetadata('b1' as BlockId, bytes('1 again'));
		await driver.putMetadata('b2' as BlockId, bytes('2'));

		expect(await collect(driver.listBlockIds!())).to.have.members(['b1', 'b2']);
	});

	it('the idle timer flushes a group nobody flushed; armed by the first write of a batch, disarmed by its seal', async () => {
		const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
		const setTimer: SetTimer = (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		};
		const backend = new MemoryBatchBackend();
		const driver = new WriteGroupDriver(backend, { setTimer, idleFlushMs: 250 });

		await driver.putMetadata('b1' as BlockId, bytes('1'));
		await driver.putMetadata('b2' as BlockId, bytes('2'));
		expect(timers.map(t => t.ms), 'one timer per open batch').to.deep.equal([250]);
		await driver.flush();
		expect(timers[0]!.cancelled, 'sealing the batch disarms it').to.equal(true);

		await driver.putMetadata('b3' as BlockId, bytes('3'));
		expect(timers).to.have.length(2);
		timers[1]!.fn();
		await driver.flush();
		expect(backend.committed.map(summary)).to.deep.equal([
			[['metadata', '1'], ['metadata', '2']],
			[['metadata', '3']],
		]);
	});

	it('close waits for the commit in flight, flushes the remainder once, then closes the backend', async () => {
		const { backend, park, release } = parkableBackend();
		const driver = new WriteGroupDriver(backend, { setTimer: neverFires });
		await driver.putMetadata('b1' as BlockId, bytes('1'));
		const started = park();
		void driver.flush();
		await started;
		await driver.putMetadata('b2' as BlockId, bytes('2'));

		const closing = driver.close();
		await delay(5);
		expect(backend.closed, 'not closed under a commit in flight').to.equal(false);

		release();
		await closing;
		expect(backend.committed.map(summary)).to.deep.equal([[['metadata', '1']], [['metadata', '2']]]);
		expect(backend.closed).to.equal(true);
	});

	it('forwards storeIdentity, listBlockIds and approximateBytesUsed only when the backend has them, and the backend\'s durability', async () => {
		const memory = new MemoryBatchBackend();
		const bare: BatchBackend = {
			durability: 'process-crash',
			get: key => memory.get(key),
			rangeRevisions: (blockId, lo, hi) => memory.rangeRevisions(blockId, lo, hi),
			listPendingActionIds: blockId => memory.listPendingActionIds(blockId),
			commit: (entries, options) => memory.commit(entries, options),
			sync: () => memory.sync(),
		};
		const overBare = new WriteGroupDriver(bare);
		expect(overBare.durability).to.equal('process-crash');
		expect(overBare.storeIdentity, 'no stub').to.equal(undefined);
		expect(overBare.listBlockIds, 'no stub').to.equal(undefined);
		expect(overBare.approximateBytesUsed, 'no stub').to.equal(undefined);

		class Identified extends MemoryBatchBackend {
			storeIdentity(): StoreIdentity { return 'memory-batch:test'; }
		}
		const overFull = new WriteGroupDriver(new Identified());
		expect(overFull.storeIdentity!()).to.equal('memory-batch:test');
		expect(typeof overFull.listBlockIds).to.equal('function');
		expect(typeof overFull.approximateBytesUsed).to.equal('function');
	});
});
