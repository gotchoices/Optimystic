import { expect } from 'chai';
import { StorageRepo, commitLatchKey } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockId, ActionId, ActionRev, PendRequest, Transforms, IBlock, BlockHeader, CollectionChangeEvent } from '@optimystic/db-core';
import { isBlockChangeNotifier, Latches } from '@optimystic/db-core';

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: 'collection-1' as BlockId
});

const makeBlock = (id: string, data?: Record<string, unknown>): IBlock => ({
	header: makeHeader(id),
	...data
});

const makeBlockInCollection = (id: string, collectionId: string, data?: Record<string, unknown>): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: collectionId as BlockId },
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

const makeDeleteTransforms = (blockId: BlockId): Transforms => ({
	inserts: {},
	updates: {},
	deletes: [blockId]
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

		it('returns empty state when block has only pending transaction (no committed revision)', async () => {
			// Pend without committing — seeds metadata via savePendingTransaction
			// but does NOT commit any revision.
			await repo.pend({
				actionId: 'pending-only' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});

			// Contextless get should return empty state, not throw.
			const result = await repo.get({ blockIds: ['block-1' as BlockId] });

			expect('block-1' in result).to.equal(true);
			expect(result['block-1']!.state).to.deep.equal({});
		});

		it('returns empty state for a committed-then-deleted block (reads back as absent, not a throw)', async () => {
			// Insert block-1 @1, then commit a delete @2. The delete revision is tombstone-shaped
			// (a `{ delete: true }` transform, no materialized block), so materializeBlock's reverse-apply
			// collapses to `undefined`. Reading the deleted block must surface as empty state — the
			// documented "undefined => empty" get() contract — NOT the old `Block ... has been deleted` throw.
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeDeleteTransforms('block-1' as BlockId),
				policy: 'c'
			});
			await repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 2 });

			const result = await repo.get({ blockIds: ['block-1' as BlockId] });
			expect('block-1' in result).to.equal(true);
			expect(result['block-1']!.block).to.equal(undefined);
			expect(result['block-1']!.state).to.deep.equal({});
			// The historical (pre-delete) revision still materializes its content.
			const historical = await new BlockStorage('block-1' as BlockId, rawStorage).getBlock(1);
			expect(historical?.block.header.id).to.equal('block-1');
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

	describe('context-driven pending block serving (TEST-5.4.3)', () => {
		it('serves and promotes a pending block when context proves the action is committed', async () => {
			// Pend an action that inserts a block — simulating the pend phase
			const pendResult = await repo.pend({
				actionId: 'action-1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1', { items: ['data'] })),
				policy: 'c'
			});
			expect(pendResult.success).to.equal(true);

			// Do NOT commit through normal path — simulating non-tail commit failure
			// The action was committed via the tail, so context knows it's committed

			// Get with context proving the action is committed
			const result = await repo.get({
				blockIds: ['block-1' as BlockId],
				context: { committed: [{ actionId: 'action-1' as ActionId, rev: 1 }], rev: 1 }
			});

			// Block should be served (promoted from pending to committed)
			expect(result['block-1']?.block).to.not.equal(undefined);
			expect(result['block-1']?.block?.header.id).to.equal('block-1');
			expect(result['block-1']?.state.latest?.rev).to.equal(1);
		});

		it('after context-driven promotion, contextless get returns the block', async () => {
			// Pend an action
			await repo.pend({
				actionId: 'action-1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1', { items: ['data'] })),
				policy: 'c'
			});

			// Context-driven get triggers promotion
			await repo.get({
				blockIds: ['block-1' as BlockId],
				context: { committed: [{ actionId: 'action-1' as ActionId, rev: 1 }], rev: 1 }
			});

			// Subsequent contextless get should find the block (promotion persisted)
			const result = await repo.get({ blockIds: ['block-1' as BlockId] });
			expect(result['block-1']?.block).to.not.equal(undefined);
			expect(result['block-1']?.block?.header.id).to.equal('block-1');
			expect(result['block-1']?.state.latest?.rev).to.equal(1);
		});

		it('does not mutate the caller context.committed array when the block has no committed latest', async () => {
			// Regression for the in-place sort: when a block has no committed `latest`, the
			// promotion loop's `missing` aliases the caller's `context.committed` array, so an
			// in-place `.sort()` would reorder the shared request context under the caller's feet.
			// No pending actions exist for this block, so the loop is a no-op apart from the sort.
			const committed = [
				{ actionId: 'a3' as ActionId, rev: 3 },
				{ actionId: 'a1' as ActionId, rev: 1 },
				{ actionId: 'a2' as ActionId, rev: 2 }
			];
			const firstRef = committed[0];
			const orderBefore = committed.map(c => c.rev);

			// context.rev is the caller's latest-known GLOBAL rev; the block itself still has no
			// committed `latest`, which is what routes `missing` onto the aliased array.
			await repo.get({
				blockIds: ['no-latest-block' as BlockId],
				context: { committed, rev: 3 }
			});

			expect(committed.map(c => c.rev)).to.deep.equal(orderBefore);
			expect(committed[0]).to.equal(firstRef); // same identity, not reordered
		});

		it('promotes multiple pending blocks from same action via context', async () => {
			// Multi-block action: tail and non-tail
			const transforms: Transforms = {
				inserts: {
					'tail-block': makeBlock('tail-block'),
					'data-block': makeBlock('data-block', { items: ['value'] })
				},
				updates: {},
				deletes: []
			};

			await repo.pend({
				actionId: 'multi-action' as ActionId,
				transforms,
				policy: 'c'
			});

			// Only commit the tail block via normal path
			await repo.commit({
				actionId: 'multi-action' as ActionId,
				blockIds: ['tail-block' as BlockId],
				tailId: 'tail-block' as BlockId,
				rev: 1
			});

			// Get non-tail block with context — should promote from pending
			const result = await repo.get({
				blockIds: ['data-block' as BlockId],
				context: { committed: [{ actionId: 'multi-action' as ActionId, rev: 1 }], rev: 1 }
			});

			expect(result['data-block']?.block).to.not.equal(undefined);
			expect(result['data-block']?.block?.header.id).to.equal('data-block');
			expect(result['data-block']?.state.latest?.rev).to.equal(1);
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

	describe('read-driven promotion under the commit latch (st-storage-repo-promotion-latch-bypass)', () => {
		// Commit block-1 at rev 1 directly, then pend a2 at rev 2 without ever driving it
		// through commit() — so a context-proving get() is what promotes it.
		const seedRev1AndPendA2 = async () => {
			const storage = new BlockStorage('block-1' as BlockId, rawStorage);
			const block = makeBlock('block-1', { items: [] });
			await storage.savePendingTransaction('setup' as ActionId, { insert: block });
			await storage.saveMaterializedBlock('setup' as ActionId, block);
			await storage.saveRevision(1, 'setup' as ActionId);
			await storage.promotePendingTransaction('setup' as ActionId);
			await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 });
			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['a2']]]),
				policy: 'c'
			});
			return storage;
		};

		it('does not promote while another writer holds the block commit latch', async () => {
			// The core of the bug: get()'s read-driven promotion ran internalCommit with NO latch.
			// Hold the block's commit latch (simulating a concurrent commit sitting in its critical
			// section); a correctly-latched promotion must BLOCK on it, a bypassing one promotes anyway.
			const storage = await seedRev1AndPendA2();

			const release = await Latches.acquire(commitLatchKey('block-1' as BlockId));

			let resolved = false;
			const getPromise = repo.get({
				blockIds: ['block-1' as BlockId],
				context: { committed: [{ actionId: 'a2' as ActionId, rev: 2 }], rev: 2 }
			}).then((r) => { resolved = true; return r; });

			// Release even if an assertion throws: the commit latch is a process-global mutex, so a
			// leaked hold would wedge every later test that commits block-1.
			try {
				// Ample event-loop turns: with the fix the get parks on the held latch; pre-fix it has
				// already promoted a2 despite the held latch. A held mutex never releases on its own, so
				// this is not a flaky race — the get simply cannot complete while the latch is out.
				await new Promise((r) => setTimeout(r, 25));

				expect(resolved).to.equal(false);
				// meta.latest must NOT have advanced, and rev 2 must NOT have been written, under the held latch.
				expect((await storage.getLatest())?.rev).to.equal(1);
				expect(await rawStorage.getRevision('block-1' as BlockId, 2)).to.equal(undefined);
			} finally {
				// Release: the promotion now proceeds and lands a2 at rev 2.
				release();
			}
			const result = await getPromise;
			expect(resolved).to.equal(true);
			expect(result['block-1']?.state.latest?.rev).to.equal(2);
			expect((await storage.getLatest())?.rev).to.equal(2);
			expect(await rawStorage.getRevision('block-1' as BlockId, 2)).to.equal('a2');
		});

		it('keeps meta.latest monotonic and revisions single-actionId when a read-driven promotion races a commit', async () => {
			// Force the read-driven promotion of a2@2 to interleave with a concurrent commit of a3@3
			// on the SAME block. Gate the promotion's setLatest so we can pin the interleaving:
			//   - pre-fix: the promotion runs unlatched, so the commit lands rev 3 first, then the
			//     promotion's late setLatest regresses meta.latest back to rev 2 — the bug.
			//   - post-fix: whichever side takes the latch first runs to completion; the promotion
			//     re-reads latest inside the latch and either lands rev 2 before the commit lands
			//     rev 3, or (if the commit won the latch) sees rev 3 and skips a2 as superseded.
			// Either way meta.latest ends at 3 and each revision holds one actionId.
			let gateResolve!: () => void;
			const gate = new Promise<void>((r) => { gateResolve = r; });
			let reachedResolve!: () => void;
			const reached = new Promise<void>((r) => { reachedResolve = r; });

			const gatedRepo = new StorageRepo((blockId) => {
				const storage = new BlockStorage(blockId as BlockId, rawStorage);
				if (blockId === 'block-1') {
					const originalSetLatest = storage.setLatest.bind(storage);
					storage.setLatest = async (latest: ActionRev) => {
						// Gate only the read-driven promotion's write (a2), not the commit's (a3).
						if (latest.actionId === 'a2') {
							reachedResolve();
							await gate;
						}
						return originalSetLatest(latest);
					};
				}
				return storage;
			});

			// block-1 committed at rev 1, with a2 and a3 both pending (neither committed yet).
			const storage = new BlockStorage('block-1' as BlockId, rawStorage);
			const block = makeBlock('block-1', { items: [] });
			await storage.savePendingTransaction('setup' as ActionId, { insert: block });
			await storage.saveMaterializedBlock('setup' as ActionId, block);
			await storage.saveRevision(1, 'setup' as ActionId);
			await storage.promotePendingTransaction('setup' as ActionId);
			await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 });
			await gatedRepo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['a2']]]),
				policy: 'c'
			});
			await gatedRepo.pend({
				actionId: 'a3' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['a3']]]),
				policy: 'c'
			});

			// Read-driven promotion of a2 (context proves it committed) racing a commit of a3.
			const g = gatedRepo.get({
				blockIds: ['block-1' as BlockId],
				context: { committed: [{ actionId: 'a2' as ActionId, rev: 2 }], rev: 2 }
			});
			const c = gatedRepo.commit({
				actionId: 'a3' as ActionId,
				blockIds: ['block-1' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 3
			});

			// Proceed once the promotion reaches its gated setLatest, OR the commit already finished
			// (it won the latch and the promotion will skip a2 as superseded — reached never fires).
			await Promise.race([reached, c]);
			// Let the commit make progress: pre-fix it runs unlatched and completes within the window;
			// post-fix, if the promotion holds the latch, the commit is blocked and this simply elapses.
			await Promise.race([c, new Promise((r) => setTimeout(r, 25))]);
			gateResolve();
			await Promise.all([g, c]);

			// meta.latest is monotonic: it ends at the highest committed rev (3), never regressed to 2.
			expect((await storage.getLatest())?.rev).to.equal(3);
			// Each revision entry holds a single, consistent actionId — no cross-write.
			expect(await rawStorage.getRevision('block-1' as BlockId, 1)).to.equal('setup');
			expect(await rawStorage.getRevision('block-1' as BlockId, 3)).to.equal('a3');
			const rev2 = await rawStorage.getRevision('block-1' as BlockId, 2);
			expect(rev2 === undefined || rev2 === 'a2').to.equal(true);
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

	describe('change notification (IBlockChangeNotifier)', () => {
		// Commit a freshly-pended insert at the given revision and return the result.
		const pendAndCommit = async (actionId: string, block: IBlock, rev: number) => {
			await repo.pend({
				actionId: actionId as ActionId,
				transforms: makeInsertTransforms(block.header.id, block),
				policy: 'c'
			});
			return repo.commit({
				actionId: actionId as ActionId,
				blockIds: [block.header.id],
				tailId: block.header.id,
				rev
			});
		};

		it('StorageRepo is feature-detectable as a change notifier', () => {
			expect(isBlockChangeNotifier(repo)).to.equal(true);
		});

		it('fires exactly one event on commit with committed blockIds, actionId, rev', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			const result = await pendAndCommit('a1', makeBlock('block-1'), 1);

			expect(result.success).to.equal(true);
			expect(events.length).to.equal(1);
			expect(events[0]!.collectionId).to.equal('collection-1');
			expect(events[0]!.blockIds).to.deep.equal(['block-1']);
			expect(events[0]!.actionId).to.equal('a1');
			expect(events[0]!.rev).to.equal(1);
			// Seam: the commit-path event carries the CommitRequest.tailId (anchors the reactivity topic).
			expect(events[0]!.tailId).to.equal('block-1');
		});

		it('does not notify a subscriber for a different collection', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-C' as BlockId, (e) => events.push(e));

			// Commit a block belonging to collection D — the C subscriber must stay silent.
			const result = await pendAndCommit('a1', makeBlockInCollection('block-d', 'collection-D'), 1);

			expect(result.success).to.equal(true);
			expect(events.length).to.equal(0);
		});

		it('routes per collection on one repo (models a remote author)', async () => {
			// Commit directly through the repo — never through a local Database/Collection —
			// to model the cluster-consensus path (consensus → StorageRepo.commit). A writer
			// the local Database never drove must still emit, scoped to the right collection.
			const aEvents: CollectionChangeEvent[] = [];
			const bEvents: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-A' as BlockId, (e) => aEvents.push(e));
			repo.onCollectionChange('collection-B' as BlockId, (e) => bEvents.push(e));

			const result = await pendAndCommit('a1', makeBlockInCollection('block-a', 'collection-A'), 1);

			expect(result.success).to.equal(true);
			expect(aEvents.length).to.equal(1);
			expect(aEvents[0]!.collectionId).to.equal('collection-A');
			expect(aEvents[0]!.blockIds).to.deep.equal(['block-a']);
			expect(bEvents.length).to.equal(0);
		});

		it('does not re-emit on an idempotent re-commit (rollforward path)', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await pendAndCommit('a1', makeBlock('block-1'), 1);
			expect(events.length).to.equal(1);

			// Re-commit the same (actionId, rev): hits the alreadyDone partition, no new commit.
			const second = await repo.commit({
				actionId: 'a1' as ActionId,
				blockIds: ['block-1' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 1
			});

			expect(second.success).to.equal(true);
			expect(events.length).to.equal(1);
		});

		it('stops events after unsubscribe and unsubscribe is idempotent', async () => {
			const events: CollectionChangeEvent[] = [];
			const unsub = repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await pendAndCommit('a1', makeBlock('block-1'), 1);
			expect(events.length).to.equal(1);

			unsub();

			// A later commit to the same block (new rev) must not reach the listener.
			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['more']]]),
				policy: 'c'
			});
			await repo.commit({
				actionId: 'a2' as ActionId,
				blockIds: ['block-1' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 2
			});

			expect(events.length).to.equal(1);

			// Idempotent: a second unsubscribe must not throw.
			expect(() => unsub()).to.not.throw();
		});

		it('isolates a throwing listener so others still fire and the commit succeeds', async () => {
			let secondFired = false;
			repo.onCollectionChange('collection-1' as BlockId, () => { throw new Error('listener boom'); });
			repo.onCollectionChange('collection-1' as BlockId, () => { secondFired = true; });

			const result = await pendAndCommit('a1', makeBlock('block-1'), 1);

			expect(result.success).to.equal(true);
			expect(secondFired).to.equal(true);
		});

		it('emits on a delete using the prior block\'s collectionId (newBlock is undefined)', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			// Insert then delete the same block. The delete's materialized block is
			// undefined, so internalCommit must fall back to priorBlock.header.collectionId.
			await pendAndCommit('a1', makeBlock('block-1'), 1);
			expect(events.length).to.equal(1);

			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeDeleteTransforms('block-1' as BlockId),
				policy: 'c'
			});
			const result = await repo.commit({
				actionId: 'a2' as ActionId,
				blockIds: ['block-1' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 2
			});

			expect(result.success).to.equal(true);
			expect(events.length).to.equal(2);
			expect(events[1]!.collectionId).to.equal('collection-1');
			expect(events[1]!.blockIds).to.deep.equal(['block-1']);
			expect(events[1]!.actionId).to.equal('a2');
			expect(events[1]!.rev).to.equal(2);
		});

		it('emits one event on a get()-driven promotion and does not re-emit later (Path 1)', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			// Pend an insert but never drive it through commit() — the action committed
			// via the tail elsewhere, so a get() whose context proves it is committed
			// promotes it (internalCommit) and that promotion is a durable landing.
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1', { items: ['data'] })),
				policy: 'c'
			});

			const result = await repo.get({
				blockIds: ['block-1' as BlockId],
				context: { committed: [{ actionId: 'a1' as ActionId, rev: 1 }], rev: 1 }
			});

			// The read both serves and promotes the block, and fires exactly one event.
			expect(result['block-1']?.block).to.not.equal(undefined);
			expect(events.length).to.equal(1);
			expect(events[0]!.collectionId).to.equal('collection-1');
			expect(events[0]!.blockIds).to.deep.equal(['block-1']);
			expect(events[0]!.actionId).to.equal('a1');
			expect(events[0]!.rev).to.equal(1);
			// Seam: a read-driven promotion has no commit request, so the event carries no tail id.
			expect(events[0]!.tailId).to.equal(undefined);

			// A later contextless get() finds the block already promoted — no new
			// landing — so it must NOT re-emit.
			await repo.get({ blockIds: ['block-1' as BlockId] });
			expect(events.length).to.equal(1);
		});

		it('aggregates a multi-block same-action get()-promotion into one event (Path 1, emitPromotions grouping)', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			// One action inserts two blocks in the same collection, pended but never
			// driven through commit(). A single get() with context proving the action
			// committed promotes BOTH blocks — exercising emitPromotions' grouping of
			// multiple promotions sharing one (actionId, rev) into a single event.
			const transforms: Transforms = {
				inserts: {
					'block-1': makeBlock('block-1', { items: ['a'] }),
					'block-2': makeBlock('block-2', { items: ['b'] })
				},
				updates: {},
				deletes: []
			};
			await repo.pend({ actionId: 'a1' as ActionId, transforms, policy: 'c' });

			const result = await repo.get({
				blockIds: ['block-1' as BlockId, 'block-2' as BlockId],
				context: { committed: [{ actionId: 'a1' as ActionId, rev: 1 }], rev: 1 }
			});

			expect(result['block-1']?.block).to.not.equal(undefined);
			expect(result['block-2']?.block).to.not.equal(undefined);

			// Exactly ONE event — both blocks grouped under the single (a1, rev:1) key.
			expect(events.length).to.equal(1);
			expect(events[0]!.collectionId).to.equal('collection-1');
			expect(events[0]!.blockIds.slice().sort()).to.deep.equal(['block-1', 'block-2']);
			expect(events[0]!.actionId).to.equal('a1');
			expect(events[0]!.rev).to.equal(1);
		});

		it('emits per durable landing across a failed partial commit and its successful retry (Path 2)', async () => {
			// Wrap block-2's storage so its saveRevision throws exactly once across the
			// whole test, forcing a REAL mid-loop internalCommit throw (the existing
			// TEST-5.4.2 only hits the stale early-return, not this catch branch). The
			// throw-once state lives in the factory closure because commit() builds a
			// fresh BlockStorage per call.
			let block2SaveRevisionThrown = false;
			const failingRepo = new StorageRepo((blockId) => {
				const storage = new BlockStorage(blockId as BlockId, rawStorage);
				if (blockId === 'block-2') {
					const originalSaveRevision = storage.saveRevision.bind(storage);
					storage.saveRevision = async (rev: number, actionId: ActionId) => {
						if (!block2SaveRevisionThrown) {
							block2SaveRevisionThrown = true;
							throw new Error('Simulated saveRevision failure on block-2');
						}
						return originalSaveRevision(rev, actionId);
					};
				}
				return storage;
			});

			// Both blocks committed at rev 1 in collection-1.
			for (const id of ['block-1', 'block-2']) {
				const storage = new BlockStorage(id as BlockId, rawStorage);
				const block = makeBlock(id, { items: [] });
				await storage.savePendingTransaction('setup' as ActionId, { insert: block });
				await storage.saveMaterializedBlock('setup' as ActionId, block);
				await storage.saveRevision(1, 'setup' as ActionId);
				await storage.promotePendingTransaction('setup' as ActionId);
				await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 });
			}

			const events: CollectionChangeEvent[] = [];
			failingRepo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			// Pend an update to both blocks (commit loop processes them in request order).
			const transforms: Transforms = {
				inserts: {},
				updates: {
					'block-1': [['items', 0, 0, ['new-1']]],
					'block-2': [['items', 0, 0, ['new-2']]]
				},
				deletes: []
			};
			await failingRepo.pend({ actionId: 'a1' as ActionId, transforms, policy: 'c' });

			// First commit: block-1 lands durably, block-2's saveRevision throws →
			// success:false, but exactly ONE event for the block that landed (block-1).
			const first = await failingRepo.commit({
				actionId: 'a1' as ActionId,
				blockIds: ['block-1' as BlockId, 'block-2' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 2
			});
			expect(first.success).to.equal(false);
			expect(events.length).to.equal(1);
			expect(events[0]!.blockIds).to.deep.equal(['block-1']);
			expect(events[0]!.actionId).to.equal('a1');
			expect(events[0]!.rev).to.equal(2);

			// Retry: block-1 is alreadyDone (no re-emit), block-2 now lands →
			// success:true and exactly ONE further event, for block-2.
			const second = await failingRepo.commit({
				actionId: 'a1' as ActionId,
				blockIds: ['block-1' as BlockId, 'block-2' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 2
			});
			expect(second.success).to.equal(true);
			expect(events.length).to.equal(2);
			expect(events[1]!.blockIds).to.deep.equal(['block-2']);
			expect(events[1]!.actionId).to.equal('a1');
			expect(events[1]!.rev).to.equal(2);

			// The woken set across both attempts covers both blocks exactly once.
			const woken = events.flatMap(e => e.blockIds).sort();
			expect(woken).to.deep.equal(['block-1', 'block-2']);
		});

		it('wakes the landed collection on a failed partial commit spanning two collections (Path 2 variant)', async () => {
			// block-b's saveRevision throws once; block-a (a different collection) lands
			// first. Pre-fix, collection-A would NEVER be woken — the permanent miss.
			let blockBSaveRevisionThrown = false;
			const failingRepo = new StorageRepo((blockId) => {
				const storage = new BlockStorage(blockId as BlockId, rawStorage);
				if (blockId === 'block-b') {
					const originalSaveRevision = storage.saveRevision.bind(storage);
					storage.saveRevision = async (rev: number, actionId: ActionId) => {
						if (!blockBSaveRevisionThrown) {
							blockBSaveRevisionThrown = true;
							throw new Error('Simulated saveRevision failure on block-b');
						}
						return originalSaveRevision(rev, actionId);
					};
				}
				return storage;
			});

			const setup = async (id: string, collectionId: string) => {
				const storage = new BlockStorage(id as BlockId, rawStorage);
				const block = makeBlockInCollection(id, collectionId, { items: [] });
				await storage.savePendingTransaction('setup' as ActionId, { insert: block });
				await storage.saveMaterializedBlock('setup' as ActionId, block);
				await storage.saveRevision(1, 'setup' as ActionId);
				await storage.promotePendingTransaction('setup' as ActionId);
				await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 });
			};
			await setup('block-a', 'collection-A');
			await setup('block-b', 'collection-B');

			const aEvents: CollectionChangeEvent[] = [];
			const bEvents: CollectionChangeEvent[] = [];
			failingRepo.onCollectionChange('collection-A' as BlockId, (e) => aEvents.push(e));
			failingRepo.onCollectionChange('collection-B' as BlockId, (e) => bEvents.push(e));

			const transforms: Transforms = {
				inserts: {},
				updates: {
					'block-a': [['items', 0, 0, ['new-a']]],
					'block-b': [['items', 0, 0, ['new-b']]]
				},
				deletes: []
			};
			await failingRepo.pend({ actionId: 'a1' as ActionId, transforms, policy: 'c' });

			// Attempt 1: block-a (collection-A) lands and emits even though the overall
			// commit fails on block-b (collection-B), which never landed this attempt.
			const first = await failingRepo.commit({
				actionId: 'a1' as ActionId,
				blockIds: ['block-a' as BlockId, 'block-b' as BlockId],
				tailId: 'block-a' as BlockId,
				rev: 2
			});
			expect(first.success).to.equal(false);
			expect(aEvents.length).to.equal(1);
			expect(aEvents[0]!.collectionId).to.equal('collection-A');
			expect(aEvents[0]!.blockIds).to.deep.equal(['block-a']);
			expect(bEvents.length).to.equal(0);
		});
	});

	describe('change notification on replica-persist', () => {
		it('fresh replica fires exactly one event with correct fields and no tailId', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a1' as ActionId, rev: 5 });

			expect(events.length).to.equal(1);
			expect(events[0]!.collectionId).to.equal('collection-1');
			expect(events[0]!.blockIds).to.deep.equal(['block-1']);
			expect(events[0]!.actionId).to.equal('a1');
			expect(events[0]!.rev).to.equal(5);
			// Seam: no commit tail on the replica path.
			expect(events[0]!.tailId).to.equal(undefined);
		});

		it('idempotent re-push fires no additional event', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a1' as ActionId, rev: 5 });
			expect(events.length).to.equal(1);

			// Same (actionId, rev) again — monotonic no-op.
			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a1' as ActionId, rev: 5 });
			expect(events.length).to.equal(1);
		});

		it('older-rev re-push after a newer replica fires no event', async () => {
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a1' as ActionId, rev: 5 });
			expect(events.length).to.equal(1);

			// Older rev — monotonic guard drops it.
			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a0' as ActionId, rev: 3 });
			expect(events.length).to.equal(1);
		});

		it('distinct collection subscriber stays silent when a different collection block is replicated', async () => {
			const col1Events: CollectionChangeEvent[] = [];
			const col2Events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => col1Events.push(e));
			repo.onCollectionChange('collection-2' as BlockId, (e) => col2Events.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId,
				makeBlockInCollection('block-1', 'collection-1'),
				{ actionId: 'a1' as ActionId, rev: 1 });

			expect(col1Events.length).to.equal(1);
			expect(col2Events.length).to.equal(0);
		});

		it('no event when block already current via commit (equal rev)', async () => {
			// Commit block-1@1 through the normal path, then replica-push at rev 1 — no-op.
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});
			await repo.commit({
				actionId: 'a1' as ActionId,
				blockIds: ['block-1' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 1
			});

			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a1' as ActionId, rev: 1 });

			expect(events.length).to.equal(0);
		});

		it('replica advancing over an older held rev fires a second event', async () => {
			// The churn scenario: a node already holds an older replica when a newer one lands.
			// Exercises the advanced-over-defined-prior branch (priorLatest !== undefined && effective.rev > priorLatest.rev).
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a3' as ActionId, rev: 3 });
			expect(events.length).to.equal(1);
			expect(events[0]!.rev).to.equal(3);

			// Newer rev lands over the held one — advances, so fires again.
			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a5' as ActionId, rev: 5 });
			expect(events.length).to.equal(2);
			expect(events[1]!.actionId).to.equal('a5');
			expect(events[1]!.rev).to.equal(5);
			expect(events[1]!.tailId).to.equal(undefined);
		});

		it('source-less replica uses hash-fallback actionId and stays idempotent', async () => {
			// No ActionRev carried: saveReplica defaults rev=1 and derives a deterministic
			// hash actionId. First push fires once at rev 1; an identical re-push is a no-op.
			const events: CollectionChangeEvent[] = [];
			repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'));
			expect(events.length).to.equal(1);
			expect(events[0]!.rev).to.equal(1);
			expect(events[0]!.tailId).to.equal(undefined);
			// Deterministic fallback id (not nil) so re-push resolves identically.
			expect(events[0]!.actionId).to.be.a('string');
			const fallbackActionId = events[0]!.actionId;

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'));
			expect(events.length).to.equal(1);
			expect(fallbackActionId).to.not.equal(undefined);
		});

		it('catch-all feed also receives the fresh-replica event exactly once', async () => {
			const anyEvents: CollectionChangeEvent[] = [];
			repo.onAnyCollectionChange((e) => anyEvents.push(e));

			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a1' as ActionId, rev: 5 });

			expect(anyEvents.length).to.equal(1);
			expect(anyEvents[0]!.collectionId).to.equal('collection-1');
			expect(anyEvents[0]!.tailId).to.equal(undefined);

			// No second event on idempotent re-push.
			await repo.saveReplicatedBlock('block-1' as BlockId, makeBlock('block-1'),
				{ actionId: 'a1' as ActionId, rev: 5 });
			expect(anyEvents.length).to.equal(1);
		});
	});
});
