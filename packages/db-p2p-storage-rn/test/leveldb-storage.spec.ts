import { expect } from 'chai';
import { LevelDBRawStorage } from '../src/leveldb-storage.js';
import { openTestDb, type TestDbHandle } from './classic-level-driver.js';
import type { ActionId, BlockHeader, BlockId, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata } from '@optimystic/db-p2p';

const blockId = 'block-1' as BlockId;
const otherBlockId = 'block-2' as BlockId;
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

describe('LevelDBRawStorage', () => {
	let handle: TestDbHandle;
	let storage: LevelDBRawStorage;

	beforeEach(async () => {
		handle = await openTestDb();
		storage = new LevelDBRawStorage(handle.db);
	});

	afterEach(async () => {
		await handle.cleanup();
	});

	it('round-trips metadata', async () => {
		const meta: BlockMetadata = { ranges: [[1, 5]], latest: { rev: 4, actionId } };
		await storage.saveMetadata(blockId, meta);
		expect(await storage.getMetadata(blockId)).to.deep.equal(meta);
	});

	it('returns undefined for missing metadata', async () => {
		expect(await storage.getMetadata('missing' as BlockId)).to.equal(undefined);
	});

	it('round-trips a single revision', async () => {
		await storage.saveRevision(blockId, 3, actionId);
		expect(await storage.getRevision(blockId, 3)).to.equal(actionId);
		expect(await storage.getRevision(blockId, 4)).to.equal(undefined);
	});

	it('listRevisions ascending yields revs in order', async () => {
		await storage.saveRevision(blockId, 1, 'a' as ActionId);
		await storage.saveRevision(blockId, 2, 'b' as ActionId);
		await storage.saveRevision(blockId, 3, 'c' as ActionId);
		await storage.saveRevision(otherBlockId, 1, 'x' as ActionId);

		const out: Array<{ rev: number; actionId: ActionId }> = [];
		for await (const r of storage.listRevisions(blockId, 1, 3)) out.push(r);
		expect(out).to.deep.equal([
			{ rev: 1, actionId: 'a' },
			{ rev: 2, actionId: 'b' },
			{ rev: 3, actionId: 'c' },
		]);
	});

	it('listRevisions descending yields revs in reverse', async () => {
		await storage.saveRevision(blockId, 1, 'a' as ActionId);
		await storage.saveRevision(blockId, 2, 'b' as ActionId);
		await storage.saveRevision(blockId, 3, 'c' as ActionId);

		const out: number[] = [];
		for await (const r of storage.listRevisions(blockId, 3, 1)) out.push(r.rev);
		expect(out).to.deep.equal([3, 2, 1]);
	});

	it('listRevisions skips gaps', async () => {
		await storage.saveRevision(blockId, 1, 'a' as ActionId);
		await storage.saveRevision(blockId, 4, 'd' as ActionId);

		const out: number[] = [];
		for await (const r of storage.listRevisions(blockId, 1, 5)) out.push(r.rev);
		expect(out).to.deep.equal([1, 4]);
	});

	it('listRevisions does not cross block boundaries', async () => {
		await storage.saveRevision(blockId, 1, 'a' as ActionId);
		await storage.saveRevision(otherBlockId, 1, 'x' as ActionId);
		await storage.saveRevision(otherBlockId, 2, 'y' as ActionId);

		const out: Array<{ rev: number; actionId: ActionId }> = [];
		for await (const r of storage.listRevisions(blockId, 1, 10)) out.push(r);
		expect(out).to.deep.equal([{ rev: 1, actionId: 'a' }]);
	});

	it('round-trips a pending transaction and lists it', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());
		await storage.savePendingTransaction(blockId, 'action-2' as ActionId, makeTransform());
		await storage.savePendingTransaction(otherBlockId, 'action-3' as ActionId, makeTransform());

		expect(await storage.getPendingTransaction(blockId, actionId)).to.deep.equal(makeTransform());

		const ids: ActionId[] = [];
		for await (const id of storage.listPendingTransactions(blockId)) ids.push(id);
		expect(ids.sort()).to.deep.equal(['action-1', 'action-2']);
	});

	it('deletePendingTransaction removes the row and the listing entry', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());
		await storage.deletePendingTransaction(blockId, actionId);

		expect(await storage.getPendingTransaction(blockId, actionId)).to.equal(undefined);
		const ids: ActionId[] = [];
		for await (const id of storage.listPendingTransactions(blockId)) ids.push(id);
		expect(ids).to.deep.equal([]);
	});

	it('round-trips a committed transaction', async () => {
		await storage.saveTransaction(blockId, actionId, makeTransform());
		expect(await storage.getTransaction(blockId, actionId)).to.deep.equal(makeTransform());
	});

	it('round-trips a materialized block', async () => {
		const block = makeBlock(blockId);
		await storage.saveMaterializedBlock(blockId, actionId, block);
		expect(await storage.getMaterializedBlock(blockId, actionId)).to.deep.equal(block);
	});

	it('saveMaterializedBlock(undefined) deletes the row', async () => {
		const block = makeBlock(blockId);
		await storage.saveMaterializedBlock(blockId, actionId, block);
		await storage.saveMaterializedBlock(blockId, actionId, undefined);
		expect(await storage.getMaterializedBlock(blockId, actionId)).to.equal(undefined);
	});

	it('promotePendingTransaction moves pending → committed atomically', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());
		await storage.promotePendingTransaction(blockId, actionId);

		expect(await storage.getPendingTransaction(blockId, actionId)).to.equal(undefined);
		expect(await storage.getTransaction(blockId, actionId)).to.deep.equal(makeTransform());

		const ids: ActionId[] = [];
		for await (const id of storage.listPendingTransactions(blockId)) ids.push(id);
		expect(ids).to.deep.equal([]);
	});

	it('throws when promoting a missing pending action', async () => {
		try {
			await storage.promotePendingTransaction(blockId, actionId);
			expect.fail('expected promotePendingTransaction to throw');
		} catch (err) {
			expect((err as Error).message).to.match(/Pending action .* not found/);
		}
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
