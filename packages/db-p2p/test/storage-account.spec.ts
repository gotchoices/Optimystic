import { expect } from 'chai';
import { StorageAccount, cacheBudgetBytes, effectiveTotalBytes, type StorageAllotmentOptions, type StorageCapacity } from '../src/storage/storage-account.js';
import type { IRawStorage } from '../src/storage/i-raw-storage.js';
import type { NodeStorage } from '../src/storage/node-storage.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import type { IPieceStore } from '../src/blob/piece-store.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { conformancePieceId } from '../src/testing/piece-store-conformance.js';

/**
 * Builds a minimal `IRawStorage` stub. All persistence-shaped methods throw to
 * make accidental usage loud — `StorageAccount` only consults
 * `getApproximateBytesUsed` and `getApproximateBytesFree`, so the rest are
 * unreachable in this suite.
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
		deleteBlock: reject as any,
		flush: reject as any,
		whenDurable: reject as any,
		durability: 'none',
		...overrides
	};
}

/**
 * An account over `blocks`, with a whole `NodeStorage` around it: a real key-value store the account
 * never touches, and by default a memory piece store reporting 0 bytes (no identity, so its figure
 * is added — of nothing).
 */
function makeAccount(blocks: IRawStorage, options: StorageAllotmentOptions = {}, pieces?: IPieceStore): StorageAccount {
	const storage: NodeStorage = { blocks, kv: new MemoryKVStore(), pieces: pieces ?? new MemoryPieceStore() };
	return new StorageAccount(storage, options);
}

describe('effectiveTotalBytes', () => {
	it('takes the smaller of the figures it has, and nothing when it has neither', () => {
		const cases: Array<{ allotment?: number; location?: number; expected?: number; why: string }> = [
			{ allotment: 1000, location: undefined, expected: 1000, why: 'allotment only: the backend reports no free space' },
			{ allotment: undefined, location: 2000, expected: 2000, why: 'location only: no allotment was configured' },
			{ allotment: 1000, location: 2000, expected: 1000, why: 'both: the allotment is the binding limit' },
			{ allotment: 4000, location: 2000, expected: 2000, why: 'both: an over-promise is bounded by the disk' },
			{ allotment: undefined, location: undefined, expected: undefined, why: 'neither: the total is unknown, not 0' }
		];
		for (const { allotment, location, expected, why } of cases) {
			expect(effectiveTotalBytes(allotment, location), why).to.equal(expected);
		}
	});
});

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * Only the two figures `cacheBudgetBytes` reads. A capacity with no `totalBytes` is a node that
 * configured no allotment on a backend reporting no free space — a memory storage, or SQLite and
 * LevelDB handed an open handle.
 */
function capacityOf(totalBytes: number | undefined, usedBytes: number): StorageCapacity {
	return { totalBytes, usedBytes };
}

describe('cacheBudgetBytes', () => {
	it('takes the smallest of the declared cap, the share of the allotment and what the allotment leaves', () => {
		const cases: Array<{ declaredBytes: number; total?: number; used: number; cached: number; expected: number; why: string }> = [
			// An eighth of 64 GiB is 8 GiB, and nothing else is stored, so the host's own figure is the
			// binding one — which is every allotment above 2 GiB, so no existing deployment's cache shrinks.
			{ declaredBytes: 256 * MIB, total: 64 * GIB, used: 0, cached: 0, expected: 256 * MIB, why: 'the declared cap wins on a large allotment' },
			// A 1 GiB host is smaller than the phone the 256 MiB default was written for, so the share binds.
			{ declaredBytes: 256 * MIB, total: GIB, used: 0, cached: 0, expected: 128 * MIB, why: 'the share wins below a 2 GiB allotment' },
			// 1000 MiB of the 1 GiB allotment is already spent on something that is not cache, so what is
			// left is 24 MiB — less than the 128 MiB share, which is what makes the cache a tenant of the
			// allotment rather than something beside it.
			{ declaredBytes: 256 * MIB, total: GIB, used: 1000 * MIB, cached: 0, expected: 24 * MIB, why: 'what the allotment leaves wins when other use fills it' },
			// Already over the allotment: the leftover term is negative and the floor evicts every
			// cache-only blob that is not being read.
			{ declaredBytes: 256 * MIB, total: GIB, used: 2 * GIB, cached: 0, expected: 0, why: 'a node over its allotment gets nothing' },
			// Measures neither an allotment nor free space: today's flat budget, unchanged.
			{ declaredBytes: 256 * MIB, total: undefined, used: 900 * MIB, cached: 0, expected: 256 * MIB, why: 'an unknown total falls back to the declared cap' },
		];
		for (const { declaredBytes, total, used, cached, expected, why } of cases) {
			expect(cacheBudgetBytes({ declaredBytes, capacity: capacityOf(total, used), cachedBytes: cached }), why).to.equal(expected);
		}
	});

	it('leaves the cache its share when every measured byte IS the cache', () => {
		// Every measured byte is a cache-only blob: what the allotment leaves after everything ELSE is the
		// whole allotment, so the share binds. Subtracting the cache's own bytes is what makes that true —
		// without it the leftover reads as 0 and the cache shrinks itself to nothing on every pass.
		const budget = cacheBudgetBytes({ declaredBytes: 256 * MIB, capacity: capacityOf(GIB, GIB), cachedBytes: GIB });

		expect(budget).to.equal(128 * MIB);
	});
});

describe('StorageAccount', () => {
	describe('capacity', () => {
		it('reflects the storage backend\'s reported bytes used', async () => {
			const reportedUsed = 256 * 1024;
			const account = makeAccount(makeStorage({ getApproximateBytesUsed: async () => reportedUsed }), { bytes: 1024 * 1024 });
			const capacity = await account.capacity();

			expect(capacity.totalBytes).to.equal(1024 * 1024);
			expect(capacity.usedBytes).to.equal(reportedUsed);
			expect(capacity.availableBytes).to.equal(1024 * 1024 - reportedUsed);
		});

		it('treats backends without getApproximateBytesUsed as zero used', async () => {
			const account = makeAccount(makeStorage()); // no getApproximateBytesUsed, no allotment
			const capacity = await account.capacity();

			expect(capacity.usedBytes).to.equal(0);
			expect(capacity.totalBytes, 'no allotment and no free-space figure').to.equal(undefined);
			expect(capacity.availableBytes).to.equal(undefined);
		});

		it('reports a node past its allotment as over-used with nothing available', async () => {
			const account = makeAccount(makeStorage({ getApproximateBytesUsed: async () => 5000 }), { bytes: 1000 });
			const capacity = await account.capacity();

			// Unclamped on purpose: the overshoot is the signal a consumer acts on.
			expect(capacity.usedBytes).to.equal(5000);
			expect(capacity.availableBytes, 'floored, where used is not').to.equal(0);
		});

		it('floors negative reports at zero', async () => {
			const account = makeAccount(makeStorage({ getApproximateBytesUsed: async () => -100 }), { bytes: 1000 });
			const capacity = await account.capacity();

			expect(capacity.usedBytes).to.equal(0);
			expect(capacity.availableBytes).to.equal(1000);
		});
	});

	describe('free space', () => {
		const used = 400;
		const blockStore = (free: () => Promise<number>): IRawStorage => makeStorage({
			getApproximateBytesUsed: async () => used,
			getApproximateBytesFree: free
		});

		it('reads the location figure as the measured use plus the free space', async () => {
			const account = makeAccount(blockStore(async () => 600), { usedBytesCacheTtlMs: 0 });
			const capacity = await account.capacity();

			expect(capacity.locationBytes).to.equal(1000);
			expect(capacity.totalBytes, 'no allotment, so the location is the whole of it').to.equal(1000);
			expect(capacity.availableBytes).to.equal(600);
		});

		it('leaves the total unknown on a failed free-space read, and recovers on the next scan', async () => {
			let calls = 0;
			const account = makeAccount(blockStore(async () => {
				calls++;
				if (calls === 1) throw new Error('statfs boom');
				return 600;
			}), { usedBytesCacheTtlMs: 0 });

			const failed = await account.capacity();
			// Unknown, NOT 0: a transient failure read as "full" would make the node shed
			// responsibility it did not need to shed.
			expect(failed.locationBytes).to.equal(undefined);
			expect(failed.totalBytes).to.equal(undefined);
			expect(failed.availableBytes).to.equal(undefined);
			expect(failed.usedBytes, 'the use was still measured').to.equal(used);

			const recovered = await account.capacity();
			expect(recovered.totalBytes).to.equal(1000);
			expect(recovered.availableBytes).to.equal(600);
		});
	});

	describe('piece bytes', () => {
		const blockBytes = 1000;
		const pieceBytes = 300;
		const blockStore = (): IRawStorage => makeStorage({
			getApproximateBytesUsed: async () => blockBytes,
			getStoreIdentity: () => 'file:/node/blocks'
		});

		/** An `IPieceStore` at `identity` reporting `pieceBytes`; StorageAccount reads only those two. */
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
				const account = makeAccount(blockStore(), { usedBytesCacheTtlMs: 0 }, pieces);
				expect((await account.capacity()).usedBytes).to.equal(blockBytes + pieceBytes);
			}
		});

		it("leaves the piece store's figure out when the block store already measures its location", async () => {
			const account = makeAccount(blockStore(), { usedBytesCacheTtlMs: 0 }, pieceStoreAt('file:/node/blocks'));
			expect((await account.capacity()).usedBytes).to.equal(blockBytes);
		});
	});

	describe('scan cache (TTL)', () => {
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
			const account = makeAccount(storage, { bytes: 1024, usedBytesCacheTtlMs: 60_000, now: () => clock });

			await account.capacity();
			clock += 30_000; // still inside the 60s window
			await account.capacity();

			expect(calls()).to.equal(1);
		});

		it('re-scans once the injected clock passes the TTL', async () => {
			const { storage, calls } = spyStorage();
			let clock = 1000;
			const account = makeAccount(storage, { bytes: 1024, usedBytesCacheTtlMs: 60_000, now: () => clock });

			await account.capacity();
			clock += 60_001; // past expiry
			await account.capacity();

			expect(calls()).to.equal(2);
		});

		// A `NaN` TTL rescans the whole store on every tick and an `Infinity` one keeps the first scan
		// for the life of the node; both read as a working memo, so construction refuses them.
		it('refuses a TTL that is not a lifetime, naming the option', () => {
			const { storage } = spyStorage();
			expect(() => makeAccount(storage, { usedBytesCacheTtlMs: Number.NaN }))
				.to.throw(RangeError, /usedBytesCacheTtlMs/);
			expect(() => makeAccount(storage, { usedBytesCacheTtlMs: Number.POSITIVE_INFINITY }))
				.to.throw(RangeError, /usedBytesCacheTtlMs/);
			expect(() => makeAccount(storage, { usedBytesCacheTtlMs: -1 }))
				.to.throw(RangeError, /usedBytesCacheTtlMs/);
		});

		it('scans on every call when the TTL is 0 (caching disabled)', async () => {
			const { storage, calls } = spyStorage();
			const account = makeAccount(storage, { bytes: 1024, usedBytesCacheTtlMs: 0 });

			await account.capacity();
			await account.capacity();

			expect(calls()).to.equal(2);
		});

		it('single-flights concurrent misses on a cold cache', async () => {
			const { storage, calls } = spyStorage();
			const account = makeAccount(storage, { bytes: 1024, usedBytesCacheTtlMs: 60_000 });

			const [a, b] = await Promise.all([account.capacity(), account.capacity()]);

			expect(calls()).to.equal(1);
			expect(a.usedBytes).to.equal(b.usedBytes);
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
			const account = makeAccount(storage, { bytes: 1024, usedBytesCacheTtlMs: 60_000 });

			let threw = false;
			try {
				await account.capacity();
			} catch {
				threw = true;
			}
			expect(threw).to.equal(true);

			// Slot cleared, nothing cached: the retry scans and succeeds.
			const capacity = await account.capacity();
			expect(calls).to.equal(2);
			expect(capacity.usedBytes).to.equal(256);
		});
	});
});
