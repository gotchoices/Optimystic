import { expect } from 'chai';
import { MMKVRawStorage, type MMKV } from '../src/mmkv-storage.js';
import { MMKVKVStore } from '../src/mmkv-kv-store.js';
import type { ActionId, BlockId, IBlock, Transform, BlockHeader } from '@optimystic/db-core';

/**
 * Fake MMKV matching react-native-mmkv 4.x nitro spec: per-key removal is
 * `remove(key): boolean`. There is intentionally no `delete` member — any
 * legacy `mmkv.delete(...)` call surfaces as a TypeError, mirroring the
 * production failure on a real v4 instance.
 */
class FakeMMKVv4 implements MMKV {
	private readonly store = new Map<string, string>();
	public removeCalls = 0;

	getString(key: string): string | undefined {
		return this.store.get(key);
	}

	set(key: string, value: string): void {
		this.store.set(key, value);
	}

	remove(key: string): boolean {
		this.removeCalls++;
		return this.store.delete(key);
	}

	getAllKeys(): string[] {
		return Array.from(this.store.keys());
	}

	contains(key: string): boolean {
		return this.store.has(key);
	}
}

const blockId = 'block-1' as BlockId;
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

describe('MMKVRawStorage (react-native-mmkv v4 API)', () => {
	let mmkv: FakeMMKVv4;
	let storage: MMKVRawStorage;

	beforeEach(() => {
		mmkv = new FakeMMKVv4();
		storage = new MMKVRawStorage({ mmkv, prefix: 'test:' });
	});

	it('deletePendingTransaction removes the pending key via remove()', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());
		expect(mmkv.contains('test:block-1:pend:action-1')).to.equal(true);

		await storage.deletePendingTransaction(blockId, actionId);

		expect(mmkv.contains('test:block-1:pend:action-1')).to.equal(false);
		expect(mmkv.removeCalls).to.be.greaterThan(0);

		const pending: ActionId[] = [];
		for await (const id of storage.listPendingTransactions(blockId)) {
			pending.push(id);
		}
		expect(pending).to.deep.equal([]);
	});

	it('saveMaterializedBlock(undefined) removes the materialized key via remove()', async () => {
		const block = makeBlock(blockId);
		await storage.saveMaterializedBlock(blockId, actionId, block);
		expect(mmkv.contains('test:block-1:block:action-1')).to.equal(true);

		const before = mmkv.removeCalls;
		await storage.saveMaterializedBlock(blockId, actionId, undefined);

		expect(mmkv.contains('test:block-1:block:action-1')).to.equal(false);
		expect(mmkv.removeCalls).to.equal(before + 1);
		expect(await storage.getMaterializedBlock(blockId, actionId)).to.equal(undefined);
	});

	it('promotePendingTransaction moves pending → committed via remove()', async () => {
		await storage.savePendingTransaction(blockId, actionId, makeTransform());

		await storage.promotePendingTransaction(blockId, actionId);

		expect(mmkv.contains('test:block-1:pend:action-1')).to.equal(false);
		expect(mmkv.contains('test:block-1:trx:action-1')).to.equal(true);
		expect(await storage.getPendingTransaction(blockId, actionId)).to.equal(undefined);
		expect(await storage.getTransaction(blockId, actionId)).to.deep.equal(makeTransform());
	});

	it('throws when promoting a missing pending action', async () => {
		try {
			await storage.promotePendingTransaction(blockId, actionId);
			expect.fail('expected promotePendingTransaction to throw');
		} catch (err) {
			expect((err as Error).message).to.match(/Pending action .* not found/);
		}
	});
});

describe('MMKVKVStore (react-native-mmkv v4 API)', () => {
	it('delete() forwards to the v4 remove() method', async () => {
		const mmkv = new FakeMMKVv4();
		const kv = new MMKVKVStore(mmkv, 'test:txn:');

		await kv.set('k', 'v');
		expect(await kv.get('k')).to.equal('v');

		await kv.delete('k');

		expect(await kv.get('k')).to.equal(undefined);
		expect(mmkv.removeCalls).to.equal(1);
	});
});
