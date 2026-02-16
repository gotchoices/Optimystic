import { expect } from 'aegir/chai';
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

			expect(result.success).to.equal(true);
			if (result.success) {
				expect(result.blockIds).to.deep.equal(['block-1']);
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
			expect(result.success).to.equal(true);
			if (result.success) {
				expect(result.pending?.length).to.equal(1);
				expect(result.pending![0]!.actionId).to.equal('action-1');
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

			expect(result.success).to.equal(false);
			if (!result.success && 'pending' in result) {
				expect(result.pending!.length).to.be.greaterThan(0);
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

			expect(result.success).to.equal(false);
			if (!result.success && 'pending' in result) {
				expect(result.pending!.length).to.be.greaterThan(0);
				// 'r' policy returns transform data
				const pending = result.pending as Array<{ blockId: BlockId; actionId: ActionId; transform?: unknown }>;
				expect('transform' in pending[0]!).to.equal(true);
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

			expect(result.success).to.equal(false);
			if (!result.success && 'missing' in result) {
				expect(result.missing!.length).to.be.greaterThan(0);
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

			expect(result.success).to.equal(true);
			if (result.success) {
				expect(result.blockIds!.includes('block-1')).to.equal(true);
				expect(result.blockIds!.includes('block-2')).to.equal(true);
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

			expect(result.success).to.equal(false);
			if (!result.success && 'reason' in result) {
				expect(result.reason).to.equal('Test rejection');
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
			expect(beforeCancel['block-1']?.state.pendings?.includes('action-1')).to.equal(true);

			// Cancel the pending action
			await repo.cancel({
				actionId: 'action-1' as ActionId,
				blockIds: ['block-1' as BlockId]
			});

			// Verify pending is gone
			const afterCancel = await repo.get({ blockIds: ['block-1' as BlockId] });
			expect(afterCancel['block-1']?.state.pendings?.includes('action-1')).to.not.equal(true);
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

			expect('nonexistent' in result).to.equal(true);
			expect(result['nonexistent']!.state).to.deep.equal({});
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
			expect(Object.keys(result).length).to.equal(1);
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

			expect(result['block-1']!.state.pendings?.includes('pending-1')).to.equal(true);
		});
	});

	describe('concurrent commits (TEST-5.4.1)', () => {
		it('serializes concurrent commits to same block via latches', async () => {
			// Setup: create block and two pending actions
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const testBlock = makeBlock('block-1', { items: [] });
			await blockStorage.savePendingTransaction('setup' as ActionId, { insert: testBlock });
			await blockStorage.saveMaterializedBlock('setup' as ActionId, testBlock);
			await blockStorage.saveRevision(1, 'setup' as ActionId);
			await blockStorage.promotePendingTransaction('setup' as ActionId);
			await blockStorage.setLatest({ actionId: 'setup' as ActionId, rev: 1 });

			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['first']]]),
				policy: 'c'
			});

			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['second']]]),
				policy: 'c'
			});

			// Commit both concurrently
			const [result1, result2] = await Promise.all([
				repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 2 }),
				repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 3 })
			]);

			// One should succeed and the other should either succeed or fail with stale revision
			const successes = [result1, result2].filter(r => r.success);
			expect(successes.length).to.be.greaterThanOrEqual(1);
		});

		it('prevents deadlocks by sorting lock acquisition order', async () => {
			// Setup two blocks
			for (const blockId of ['block-a', 'block-b']) {
				const storage = new BlockStorage(blockId as BlockId, rawStorage);
				const block = makeBlock(blockId, { items: [] });
				await storage.savePendingTransaction('setup' as ActionId, { insert: block });
				await storage.saveMaterializedBlock('setup' as ActionId, block);
				await storage.saveRevision(1, 'setup' as ActionId);
				await storage.promotePendingTransaction('setup' as ActionId);
				await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 });
			}

			const transforms: Transforms = {
				inserts: {},
				updates: {
					'block-a': [['items', 0, 0, ['new-a']]],
					'block-b': [['items', 0, 0, ['new-b']]]
				},
				deletes: []
			};

			await repo.pend({
				actionId: 'multi-a' as ActionId,
				transforms,
				policy: 'c'
			});

			await repo.pend({
				actionId: 'multi-b' as ActionId,
				transforms,
				policy: 'c'
			});

			// Commit operations on both blocks concurrently - should not deadlock
			const [r1, r2] = await Promise.all([
				repo.commit({
					actionId: 'multi-a' as ActionId,
					blockIds: ['block-a' as BlockId, 'block-b' as BlockId],
					tailId: 'block-a' as BlockId,
					rev: 2
				}),
				repo.commit({
					actionId: 'multi-b' as ActionId,
					blockIds: ['block-b' as BlockId, 'block-a' as BlockId], // reversed order
					tailId: 'block-b' as BlockId,
					rev: 3
				})
			]);

			// At least one should succeed; the other may fail with stale revision
			const successes = [r1, r2].filter(r => r.success);
			expect(successes.length).to.be.greaterThanOrEqual(1);
		});
	});

	describe('partial commit recovery (TEST-5.4.2)', () => {
		it('returns failure when commit fails partway through multi-block commit', async () => {
			// Setup block-1 with a committed block
			const storage1 = new BlockStorage('block-1' as BlockId, rawStorage);
			const block1 = makeBlock('block-1', { items: [] });
			await storage1.savePendingTransaction('setup' as ActionId, { insert: block1 });
			await storage1.saveMaterializedBlock('setup' as ActionId, block1);
			await storage1.saveRevision(1, 'setup' as ActionId);
			await storage1.promotePendingTransaction('setup' as ActionId);
			await storage1.setLatest({ actionId: 'setup' as ActionId, rev: 1 });

			// Setup block-2 with a committed block
			const storage2 = new BlockStorage('block-2' as BlockId, rawStorage);
			const block2 = makeBlock('block-2', { items: [] });
			await storage2.savePendingTransaction('setup' as ActionId, { insert: block2 });
			await storage2.saveMaterializedBlock('setup' as ActionId, block2);
			await storage2.saveRevision(1, 'setup' as ActionId);
			await storage2.promotePendingTransaction('setup' as ActionId);
			await storage2.setLatest({ actionId: 'setup' as ActionId, rev: 1 });

			// Pend action on both blocks
			const transforms: Transforms = {
				inserts: {},
				updates: {
					'block-1': [['items', 0, 0, ['new-1']]],
					'block-2': [['items', 0, 0, ['new-2']]]
				},
				deletes: []
			};

			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms,
				policy: 'c'
			});

			// Commit action on block-1 directly to create a stale revision conflict for block-1
			await repo.pend({
				actionId: 'conflict' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['conflict']]]),
				policy: 'c'
			});
			await repo.commit({
				actionId: 'conflict' as ActionId,
				blockIds: ['block-1' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 2
			});

			// Now try to commit a1 with stale revision - should fail
			const result = await repo.commit({
				actionId: 'a1' as ActionId,
				blockIds: ['block-1' as BlockId, 'block-2' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 2
			});

			expect(result.success).to.equal(false);
		});

		it('rejects commit for non-existent pending action', async () => {
			try {
				await repo.commit({
					actionId: 'nonexistent' as ActionId,
					blockIds: ['block-1' as BlockId],
					tailId: 'block-1' as BlockId,
					rev: 1
				});
				expect.fail('Should have thrown');
			} catch (err) {
				expect((err as Error).message).to.include('Pending action');
			}
		});
	});
});
