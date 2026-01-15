import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockId, ActionId, PendRequest, Transforms, IBlock, BlockHeader } from '@optimystic/db-core';

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string, data?: Record<string, unknown>): IBlock => ({
	header: makeHeader(id),
	...data
});

const makeInsertTransforms = (blockId: BlockId, block: IBlock): Transforms => ({
	inserts: { [blockId]: block },
	updates: {},
	deletes: []
});

const makeUpdateTransforms = (blockId: BlockId, operations: [string, number, number, unknown[]][]): Transforms => ({
	inserts: {},
	updates: { [blockId]: operations },
	deletes: []
});

describe('StorageRepo', () => {
	let rawStorage: MemoryRawStorage;
	let repo: StorageRepo;

	beforeEach(() => {
		rawStorage = new MemoryRawStorage();
		repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
	});

	describe('pend', () => {
		it('successfully pends a new action', async () => {
			const request: PendRequest = {
				actionId: 'action-1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			};

			const result = await repo.pend(request);

			assert.strictEqual(result.success, true);
			if (result.success) {
				assert.deepStrictEqual(result.blockIds, ['block-1']);
			}
		});

		it('returns pending actions when policy is "c" (continue)', async () => {
			// First pend
			await repo.pend({
				actionId: 'action-1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});

			// Second pend on same block - continue policy joins
			const result = await repo.pend({
				actionId: 'action-2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['new']]]),
				policy: 'c'
			});

			// Continue behavior allows the pend but reports existing pendings
			assert.strictEqual(result.success, true);
			if (result.success) {
				assert.ok(result.pending?.length === 1);
				assert.strictEqual(result.pending[0]!.actionId, 'action-1');
			}
		});

		it('fails when policy is "f" and pending exists', async () => {
			await repo.pend({
				actionId: 'action-1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});

			const result = await repo.pend({
				actionId: 'action-2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['new']]]),
				policy: 'f'
			});

			assert.strictEqual(result.success, false);
			if (!result.success && 'pending' in result) {
				assert.ok(result.pending!.length > 0);
			}
		});

		it('returns transform data when policy is "r"', async () => {
			await repo.pend({
				actionId: 'action-1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});

			const result = await repo.pend({
				actionId: 'action-2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['new']]]),
				policy: 'r'
			});

			assert.strictEqual(result.success, false);
			if (!result.success && 'pending' in result) {
				assert.ok(result.pending!.length > 0);
				// 'r' policy returns transform data
				const pending = result.pending as Array<{ blockId: BlockId; actionId: ActionId; transform?: unknown }>;
				assert.ok('transform' in pending[0]!);
			}
		});

		it('returns missing transforms when revision conflict exists', async () => {
			// Setup: create a block with committed data
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const initialBlock = makeBlock('block-1');
			await blockStorage.savePendingTransaction('initial-action' as ActionId, { insert: initialBlock });
			await blockStorage.saveMaterializedBlock('initial-action' as ActionId, initialBlock);
			await blockStorage.saveRevision(1, 'initial-action' as ActionId);
			await blockStorage.promotePendingTransaction('initial-action' as ActionId);
			await blockStorage.setLatest({ actionId: 'initial-action' as ActionId, rev: 1 });

			// Now try to pend at revision 0 - should conflict
			const result = await repo.pend({
				actionId: 'new-action' as ActionId,
				rev: 0,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['new']]]),
				policy: 'c'
			});

			assert.strictEqual(result.success, false);
			if (!result.success && 'missing' in result) {
				assert.ok(result.missing!.length > 0);
			}
		});

		it('handles multiple blocks in single pend', async () => {
			const transforms: Transforms = {
				inserts: {
					'block-1': makeBlock('block-1'),
					'block-2': makeBlock('block-2')
				},
				updates: {},
				deletes: []
			};

			const result = await repo.pend({
				actionId: 'multi-action' as ActionId,
				transforms,
				policy: 'c'
			});

			assert.strictEqual(result.success, true);
			if (result.success) {
				assert.ok(result.blockIds!.includes('block-1'));
				assert.ok(result.blockIds!.includes('block-2'));
			}
		});

		it('validates transaction when validator is configured', async () => {
			const validatingRepo = new StorageRepo(
				(blockId) => new BlockStorage(blockId, rawStorage),
				{
					validatePend: async (_txn, _hash) => ({ valid: false, reason: 'Test rejection' })
				}
			);

			const result = await validatingRepo.pend({
				actionId: 'action-1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c',
				transaction: { statements: [], stamp: {} } as any,
				operationsHash: 'mock-hash'
			});

			assert.strictEqual(result.success, false);
			if (!result.success && 'reason' in result) {
				assert.strictEqual(result.reason, 'Test rejection');
			}
		});
	});

	describe('cancel', () => {
		it('removes pending action', async () => {
			// Create block first so it exists
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const existingBlock = makeBlock('block-1');
			await blockStorage.savePendingTransaction('setup' as ActionId, { insert: existingBlock });
			await blockStorage.saveMaterializedBlock('setup' as ActionId, existingBlock);
			await blockStorage.saveRevision(1, 'setup' as ActionId);
			await blockStorage.promotePendingTransaction('setup' as ActionId);
			await blockStorage.setLatest({ actionId: 'setup' as ActionId, rev: 1 });

			// Now pend a new action
			await repo.pend({
				actionId: 'action-1' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['test']]]),
				policy: 'c'
			});

			// Verify pending exists
			const beforeCancel = await repo.get({ blockIds: ['block-1' as BlockId] });
			assert.ok(beforeCancel['block-1']?.state.pendings?.includes('action-1'), 'Pending should exist before cancel');

			// Cancel the pending action
			await repo.cancel({
				actionId: 'action-1' as ActionId,
				blockIds: ['block-1' as BlockId]
			});

			// Verify pending is gone
			const afterCancel = await repo.get({ blockIds: ['block-1' as BlockId] });
			assert.ok(
				!afterCancel['block-1']?.state.pendings?.includes('action-1'),
				'Pending should be removed after cancel'
			);
		});

		it('handles cancel of non-existent action gracefully', async () => {
			// Should not throw
			await repo.cancel({
				actionId: 'nonexistent' as ActionId,
				blockIds: ['block-1' as BlockId]
			});
		});
	});

	describe('get', () => {
		it('returns empty state for nonexistent block', async () => {
			const result = await repo.get({ blockIds: ['nonexistent' as BlockId] });

			assert.ok('nonexistent' in result);
			assert.deepStrictEqual(result['nonexistent']!.state, {});
		});

		it('deduplicates block IDs', async () => {
			// Create a block first
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const testBlock = makeBlock('block-1');
			await blockStorage.savePendingTransaction('create' as ActionId, { insert: testBlock });
			await blockStorage.saveMaterializedBlock('create' as ActionId, testBlock);
			await blockStorage.saveRevision(1, 'create' as ActionId);
			await blockStorage.promotePendingTransaction('create' as ActionId);
			await blockStorage.setLatest({ actionId: 'create' as ActionId, rev: 1 });

			// Request same block multiple times
			const result = await repo.get({
				blockIds: ['block-1' as BlockId, 'block-1' as BlockId, 'block-1' as BlockId]
			});

			// Should only have one entry
			assert.strictEqual(Object.keys(result).length, 1);
		});

		it('lists pending transactions in state', async () => {
			// Create block first
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const testBlock = makeBlock('block-1');
			await blockStorage.savePendingTransaction('create' as ActionId, { insert: testBlock });
			await blockStorage.saveMaterializedBlock('create' as ActionId, testBlock);
			await blockStorage.saveRevision(1, 'create' as ActionId);
			await blockStorage.promotePendingTransaction('create' as ActionId);
			await blockStorage.setLatest({ actionId: 'create' as ActionId, rev: 1 });

			// Add a pending transaction
			await repo.pend({
				actionId: 'pending-1' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['new']]]),
				policy: 'c'
			});

			const result = await repo.get({ blockIds: ['block-1' as BlockId] });

			assert.ok(result['block-1']!.state.pendings?.includes('pending-1'));
		});
	});
});
