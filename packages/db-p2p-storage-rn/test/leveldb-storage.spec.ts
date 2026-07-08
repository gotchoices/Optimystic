import { expect } from 'chai';
import { LevelDBRawStorage } from '../src/leveldb-storage.js';
import { openTestDb, type TestDbHandle } from './classic-level-driver.js';
import { runRawStorageConformance, type ConformanceHarness } from '@optimystic/db-p2p/testing';
import type { ActionId, BlockHeader, BlockId, IBlock, Transform } from '@optimystic/db-core';

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
// LevelDBStoreDriver) behaves identically to every other backend — round-trips,
// listRevisions ordering, promote atomicity + the exact missing-pend error,
// clone-on-store/read (now structural via the byte boundary), drain-before-yield
// iteration, and the BlockStorage parity slice. Runs against `classic-level`;
// production uses `rn-leveldb`, both satisfy `LevelDBLike`. Each case gets a fresh
// file-backed db in an isolated temp dir that cleanup closes and removes.
// ---------------------------------------------------------------------------
runRawStorageConformance('LevelDB', async (): Promise<ConformanceHarness> => {
	const handle = await openTestDb();
	return {
		storage: new LevelDBRawStorage(handle.db),
		cleanup: async () => { await handle.cleanup(); },
	};
});

// ---------------------------------------------------------------------------
// LevelDB-only tests the shared suite does not cover: the tag-range byte-key
// boundary (only TAG_METADATA keys decode as block ids), WriteBatch atomicity on
// a failed promote, and the optional full-scan getApproximateBytesUsed (which the
// shared suite skips entirely as an optional passthrough).
// ---------------------------------------------------------------------------
describe('LevelDB driver specifics', () => {
	let handle: TestDbHandle;
	let storage: LevelDBRawStorage;

	beforeEach(async () => {
		handle = await openTestDb();
		storage = new LevelDBRawStorage(handle.db);
	});

	afterEach(async () => {
		await handle.cleanup();
	});

	it('listBlockIds enumerates only TAG_METADATA keys — higher-tag keys are not decoded as block ids', async () => {
		// Rows in every OTHER store (pending / revision / transaction / materialized) but NO
		// metadata. These keys sort above the metadata range (tags 0x02..0x05 vs 0x01), so the
		// metadataRange upper bound (0x02) must exclude them — none may surface as a block id.
		await storage.savePendingTransaction('only-pending' as BlockId, actionId, makeTransform());
		await storage.saveRevision('only-rev' as BlockId, 1, actionId);
		await storage.saveTransaction('only-tx' as BlockId, actionId, makeTransform());
		await storage.saveMaterializedBlock('only-mat' as BlockId, actionId, makeBlock('only-mat'));
		// One genuinely committed block for contrast.
		await storage.saveMetadata('committed' as BlockId, { ranges: [[1, 1]], latest: { rev: 1, actionId } });

		const out = new Set<string>();
		for await (const id of storage.listBlockIds()) out.add(id);
		expect(out).to.deep.equal(new Set(['committed']));
	});

	it('promotePendingTransaction leaves the database consistent when WriteBatch.write() fails', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());

		// Decorate the underlying batch() so the next write() throws. Any failure
		// in the batched write must leave both rows untouched — no half-written
		// state. (LevelDB's batch is documented atomic, but we exercise the
		// failure mode the package's storage code is responsible for surfacing.)
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
			expect.fail('expected the simulated failure to propagate');
		} catch (err) {
			expect((err as Error).message).to.equal('simulated batch failure');
		} finally {
			realDb.batch = originalBatch;
		}

		// Neither the pending row should have been deleted nor the transaction row created.
		expect(await storage.getPendingTransaction(blockId, actionId)).to.deep.equal(makeTransform());
		expect(await storage.getTransaction(blockId, actionId)).to.equal(undefined);
	});

	it('getApproximateBytesUsed returns a non-negative number', async () => {
		await storage.saveMetadata(blockId, { ranges: [], latest: undefined });
		const used = await storage.getApproximateBytesUsed();
		expect(used).to.be.a('number');
		expect(used).to.be.greaterThan(0);
	});

	it('getApproximateBytesUsed returns 0 for an empty database', async () => {
		expect(await storage.getApproximateBytesUsed()).to.equal(0);
	});
});
