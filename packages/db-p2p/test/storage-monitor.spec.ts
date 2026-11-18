import { expect } from 'chai';
import { StorageMonitor } from '../src/storage/storage-monitor.js';
import type { IRawStorage } from '../src/storage/i-raw-storage.js';
import type { IPieceStore } from '../src/blob/piece-store.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { conformancePieceId } from '../src/testing/piece-store-conformance.js';

/**
 * Builds a minimal `IRawStorage` stub. All persistence-shaped methods throw to
 * make accidental usage loud — `StorageMonitor` only consults
 * `getApproximateBytesUsed`, so the rest are unreachable in this suite.
 */
function makeStorage(overrides: Partial<IRawStorage> = {}): IRawStorage {
	const reject = () => { throw new Error('not implemented in test stub'); };
	return {
		getMetadata: reject as any,
		saveMetadata: reject as any,
		getRevision: reject as any,
		saveRevision: reject as any,
		listRevisions: reject as any,
		getPendingTransaction: reject as any,
		savePendingTransaction: reject as any,
		deletePendingTransaction: reject as any,
		listPendingTransactions: reject as any,
		getTransaction: reject as any,
		saveTransaction: reject as any,
		getBlockProof: reject as any,
		saveBlockProof: reject as any,
		getProofEntry: reject as any,
		saveProofEntry: reject as any,
		getCommitProof: reject as any,
		saveCommitProof: reject as any,
		getMaterializedBlock: reject as any,
		saveMaterializedBlock: reject as any,
		promotePendingTransaction: reject as any,
		flush: reject as any,
		whenDurable: reject as any,
		durability: 'none',
		...overrides
	};
}

describe('StorageMonitor', () => {
	describe('getCapacity (no overrides)', () => {
		it('reflects the storage backend\'s reported bytes used', async () => {
			const totalBytes = 1024 * 1024;
			const reportedUsed = 256 * 1024;
			const storage = makeStorage({
				getApproximateBytesUsed: async () => reportedUsed
			});

			const monitor = new StorageMonitor(storage, { totalBytes });
			const capacity = await monitor.getCapacity();

			expect(capacity.total).to.equal(totalBytes);
			expect(capacity.used).to.equal(reportedUsed);
			expect(capacity.available).to.equal(totalBytes - reportedUsed);
		});

		it('treats backends without getApproximateBytesUsed as zero used', async () => {
			const storage = makeStorage(); // no getApproximateBytesUsed
			const monitor = new StorageMonitor(storage);
			const capacity = await monitor.getCapacity();

			expect(capacity.used).to.equal(0);
			expect(capacity.available).to.equal(capacity.total);
		});

		it('clamps used bytes to the configured total', async () => {
			const totalBytes = 1000;
			const storage = makeStorage({
				getApproximateBytesUsed: async () => 5000 // overshoot
			});

			const monitor = new StorageMonitor(storage, { totalBytes });
			const capacity = await monitor.getCapacity();

			expect(capacity.used).to.equal(totalBytes);
			expect(capacity.available).to.equal(0);
		});

		it('floors negative reports at zero', async () => {
			const totalBytes = 1000;
			const storage = makeStorage({
				getApproximateBytesUsed: async () => -100
			});

			const monitor = new StorageMonitor(storage, { totalBytes });
			const capacity = await monitor.getCapacity();

			expect(capacity.used).to.equal(0);
			expect(capacity.available).to.equal(totalBytes);
		});
	});

	describe('getCapacity (with overrides)', () => {
		it('honors usedBytes override and ignores the backend', async () => {
			let backendCalled = false;
			const storage = makeStorage({
				getApproximateBytesUsed: async () => {
					backendCalled = true;
					return 999_999;
				}
			});

			const monitor = new StorageMonitor(storage, {
				totalBytes: 1000,
				usedBytes: 250
			});
			const capacity = await monitor.getCapacity();

			expect(capacity.total).to.equal(1000);
			expect(capacity.used).to.equal(250);
			expect(capacity.available).to.equal(750);
			expect(backendCalled).to.equal(false);
		});

		it('honors availableBytes override', async () => {
			const storage = makeStorage();
			const monitor = new StorageMonitor(storage, {
				totalBytes: 1000,
				availableBytes: 600
			});

			const capacity = await monitor.getCapacity();
			expect(capacity.available).to.equal(600);
			expect(capacity.used).to.equal(400);
		});
	});

	describe('piece bytes', () => {
		const blockBytes = 1000;
		const pieceBytes = 300;
		const blockStore = (): IRawStorage => makeStorage({
			getApproximateBytesUsed: async () => blockBytes,
			getStoreIdentity: () => 'file:/node/blocks'
		});

		/** An `IPieceStore` at `identity` reporting `pieceBytes`; StorageMonitor reads only those two. */
		const pieceStoreAt = (identity: string): IPieceStore => {
			const reject = () => { throw new Error('not implemented in test stub'); };
			return {
				has: reject, get: reject, put: reject, delete: reject, list: reject, flush: reject,
				bytesUsed: async () => pieceBytes,
				durability: 'power-loss',
				storeIdentity: () => identity
			};
		};

		it("adds the piece store's figure when its identity is absent or differs from the block store's", async () => {
			const memory = new MemoryPieceStore();
			const bytes = new Uint8Array(pieceBytes);
			await memory.put(await conformancePieceId(bytes), bytes);

			for (const pieces of [memory, pieceStoreAt('file:/elsewhere')]) {
				const monitor = new StorageMonitor(blockStore(), { usedBytesCacheTtlMs: 0 }, pieces);
				expect((await monitor.getCapacity()).used).to.equal(blockBytes + pieceBytes);
			}
		});

		it("leaves the piece store's figure out when the block store already measures its location", async () => {
			const monitor = new StorageMonitor(blockStore(), { usedBytesCacheTtlMs: 0 }, pieceStoreAt('file:/node/blocks'));
			expect((await monitor.getCapacity()).used).to.equal(blockBytes);
		});
	});

	describe('used-bytes cache (TTL)', () => {
		/** A `getApproximateBytesUsed` spy that counts calls and returns a fixed value. */
		function spyStorage(returnValue = 256): { storage: IRawStorage; calls: () => number } {
			let calls = 0;
			const storage = makeStorage({
				getApproximateBytesUsed: async () => {
					calls++;
					return returnValue;
				}
			});
			return { storage, calls: () => calls };
		}

		it('serves two calls within the TTL from one scan', async () => {
			const { storage, calls } = spyStorage();
			let clock = 1000;
			const monitor = new StorageMonitor(storage, {
				totalBytes: 1024,
				usedBytesCacheTtlMs: 60_000,
				now: () => clock
			});

			await monitor.getCapacity();
			clock += 30_000; // still inside the 60s window
			await monitor.getCapacity();

			expect(calls()).to.equal(1);
		});

		it('re-scans once the injected clock passes the TTL', async () => {
			const { storage, calls } = spyStorage();
			let clock = 1000;
			const monitor = new StorageMonitor(storage, {
				totalBytes: 1024,
				usedBytesCacheTtlMs: 60_000,
				now: () => clock
			});

			await monitor.getCapacity();
			clock += 60_001; // past expiry
			await monitor.getCapacity();

			expect(calls()).to.equal(2);
		});

		it('never scans when usedBytes override is supplied', async () => {
			const { storage, calls } = spyStorage();
			const monitor = new StorageMonitor(storage, {
				totalBytes: 1000,
				usedBytes: 250
			});

			await monitor.getCapacity();
			await monitor.getCapacity();

			expect(calls()).to.equal(0);
		});

		it('scans on every call when the TTL is 0 (caching disabled)', async () => {
			const { storage, calls } = spyStorage();
			const monitor = new StorageMonitor(storage, {
				totalBytes: 1024,
				usedBytesCacheTtlMs: 0
			});

			await monitor.getCapacity();
			await monitor.getCapacity();

			expect(calls()).to.equal(2);
		});

		it('single-flights concurrent misses on a cold cache', async () => {
			const { storage, calls } = spyStorage();
			const monitor = new StorageMonitor(storage, {
				totalBytes: 1024,
				usedBytesCacheTtlMs: 60_000
			});

			const [a, b] = await Promise.all([monitor.getCapacity(), monitor.getCapacity()]);

			expect(calls()).to.equal(1);
			expect(a.used).to.equal(b.used);
		});

		it('does not cache or wedge on a scan error; the next call retries', async () => {
			let calls = 0;
			const storage = makeStorage({
				getApproximateBytesUsed: async () => {
					calls++;
					if (calls === 1) {
						throw new Error('scan boom');
					}
					return 256;
				}
			});
			const monitor = new StorageMonitor(storage, {
				totalBytes: 1024,
				usedBytesCacheTtlMs: 60_000
			});

			let threw = false;
			try {
				await monitor.getCapacity();
			} catch {
				threw = true;
			}
			expect(threw).to.equal(true);

			// Slot cleared, nothing cached: the retry scans and succeeds.
			const capacity = await monitor.getCapacity();
			expect(calls).to.equal(2);
			expect(capacity.used).to.equal(256);
		});
	});
});
