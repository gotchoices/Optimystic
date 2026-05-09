// Polyfill IndexedDB into the Node test environment before importing `idb`.
import 'fake-indexeddb/auto';
import { expect } from 'chai';
import { IndexedDBRawStorage } from '../src/indexeddb-storage.js';
import { openOptimysticWebDb, type OptimysticWebDBHandle } from '../src/db.js';
import type { ActionId, BlockId, BlockHeader, IBlock, Transform } from '@optimystic/db-core';
import type { BlockMetadata } from '@optimystic/db-p2p';

const blockId = 'block-1' as BlockId;
const otherBlockId = 'block-2' as BlockId;
const actionId = 'action-1' as ActionId;

const makeBlock = (id: string): IBlock => {
	const header: BlockHeader = {
		id: id as BlockId,
		type: 'test',
		collectionId: 'collection-1' as BlockId
	};
	return { header };
};

const makeTransform = (): Transform => ({ insert: makeBlock(blockId) });

let dbCounter = 0;

async function freshDb(): Promise<OptimysticWebDBHandle> {
	return openOptimysticWebDb(`optimystic-test-${++dbCounter}-${Math.random().toString(36).slice(2)}`);
}

describe('IndexedDBRawStorage', () => {
	let db: OptimysticWebDBHandle;
	let storage: IndexedDBRawStorage;

	beforeEach(async () => {
		db = await freshDb();
		storage = new IndexedDBRawStorage(db);
	});

	afterEach(() => {
		db.close();
	});

	it('round-trips metadata', async () => {
		const meta: BlockMetadata = { ranges: [[1, 5]], latest: { rev: 4, actionId } };
		await storage.saveMetadata(blockId, meta);
		const got = await storage.getMetadata(blockId);
		expect(got).to.deep.equal(meta);
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
		await storage.saveRevision(otherBlockId, 1, 'x' as ActionId); // should not leak

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

	it('round-trips a pending transaction and lists it', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());
		await storage.savePendingTransaction(blockId, 'action-2' as ActionId, makeTransform());
		await storage.savePendingTransaction(otherBlockId, 'action-3' as ActionId, makeTransform());

		expect(await storage.getPendingTransaction(blockId, actionId)).to.deep.equal(makeTransform());

		const ids: ActionId[] = [];
		for await (const id of storage.listPendingTransactions(blockId)) ids.push(id);
		expect(ids.sort()).to.deep.equal(['action-1', 'action-2']);
	});

	it('deletePendingTransaction removes it from the store and from listing', async () => {
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

	it('getApproximateBytesUsed returns a number', async () => {
		// navigator.storage is generally absent in Node + fake-indexeddb, in which
		// case we expect 0. In a real browser the value will be > 0; the contract
		// here is just "doesn't throw, returns a number."
		const used = await storage.getApproximateBytesUsed();
		expect(used).to.be.a('number');
		expect(used).to.be.at.least(0);
	});
});
