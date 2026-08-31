import { expect } from 'chai';
import { StorageRepo, MISSING_BASE_REVISION_REASON } from '../src/storage/storage-repo.js';
import { blockWriteLatchKey, withBlockWriteLatch, type BlockWriteLatch } from '../src/storage/block-latch.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockArchive, RestoreCallback, RevisionRange } from '../src/storage/struct.js';
import type { BlockId, ActionId, ActionRev, ActionTransforms, CommitResult, PendRequest, PendSuccess, StaleFailure, Transforms, IBlock, BlockHeader, CollectionChangeEvent } from '@optimystic/db-core';
import { isBlockChangeNotifier, Latches, canonicalBlockHash } from '@optimystic/db-core';
import { delay } from '@optimystic/db-core/test';

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

/** Asserts the result is a stale failure carrying a `missing` list, and returns that list. */
const expectStaleMissing = (result: CommitResult): ActionTransforms[] => {
	expect(result.success, 'expected commit to fail as stale').to.equal(false);
	const missing = (result as { missing?: ActionTransforms[] }).missing;
	expect(missing, 'expected StaleFailure.missing to be present').to.not.equal(undefined);
	return missing!;
};

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
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await blockStorage.savePendingTransaction('initial-action' as ActionId, { insert: initialBlock }, l);
				await blockStorage.saveMaterializedBlock('initial-action' as ActionId, initialBlock, l);
				await blockStorage.saveRevision(1, 'initial-action' as ActionId, l);
				await blockStorage.promotePendingTransaction('initial-action' as ActionId, l);
				await blockStorage.setLatest({ actionId: 'initial-action' as ActionId, rev: 1 }, l);
			});

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

		// `StaleFailure.staleAt` reports the revision this node actually holds, so a losing writer
		// gets the number as data instead of having to parse it out of the reason prose.
		it('reports staleAt with the revision this node holds when the requested rev is taken', async () => {
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const initialBlock = makeBlock('block-1');
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await blockStorage.savePendingTransaction('initial-action' as ActionId, { insert: initialBlock }, l);
				await blockStorage.saveMaterializedBlock('initial-action' as ActionId, initialBlock, l);
				await blockStorage.saveRevision(1, 'initial-action' as ActionId, l);
				await blockStorage.promotePendingTransaction('initial-action' as ActionId, l);
				await blockStorage.setLatest({ actionId: 'initial-action' as ActionId, rev: 1 }, l);
			});

			const result = await repo.pend({
				actionId: 'new-action' as ActionId,
				rev: 0,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['new']]]),
				policy: 'c'
			});

			expect(result.success).to.equal(false);
			// The held revision (1), not the requested one (0).
			expect((result as StaleFailure).staleAt).to.deep.equal({ blockId: 'block-1', rev: 1 });
		});

		it('reports NO staleAt for an insert collision on a request that carries no rev', async () => {
			// Same code branch, different meaning: with `rev` undefined the comparison degrades to
			// `latest.rev >= 0`, which matches any existing block. That is an insert collision, not a
			// revision race, so the held revision would be a number answering no question.
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const initialBlock = makeBlock('block-1');
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await blockStorage.savePendingTransaction('initial-action' as ActionId, { insert: initialBlock }, l);
				await blockStorage.saveMaterializedBlock('initial-action' as ActionId, initialBlock, l);
				await blockStorage.saveRevision(1, 'initial-action' as ActionId, l);
				await blockStorage.promotePendingTransaction('initial-action' as ActionId, l);
				await blockStorage.setLatest({ actionId: 'initial-action' as ActionId, rev: 1 }, l);
			});

			const result = await repo.pend({
				actionId: 'colliding-insert' as ActionId,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});

			expect(result.success, 'the insert still collides and is still rejected').to.equal(false);
			expect((result as StaleFailure).missing?.length ?? 0).to.be.greaterThan(0);
			expect((result as StaleFailure).staleAt, 'an insert collision is not a revision race').to.equal(undefined);
			expect(Object.prototype.hasOwnProperty.call(result, 'staleAt')).to.equal(false);
		});

		it('reports the HIGHEST held revision when several blocks are past the requested one', async () => {
			// Two blocks of the same collection can sit at different revisions (an action that touched
			// only one advances only that one). The loser has to clear every holder, so the largest is
			// the binding number — and it must win even though the smaller block is scanned first.
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: { inserts: { 'block-1': makeBlock('block-1', { items: [] }), 'block-2': makeBlock('block-2', { items: [] }) }, updates: {}, deletes: [] },
				policy: 'c'
			});
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			// Advance block-2 alone twice, leaving block-1 at rev 1 and block-2 at rev 3.
			for (const [actionId, rev] of [['a2', 2], ['a3', 3]] as [string, number][]) {
				await repo.pend({ actionId: actionId as ActionId, transforms: makeUpdateTransforms('block-2' as BlockId, [['items', 0, 0, ['x']]]), policy: 'c' });
				const advanced = await repo.commit({ actionId: actionId as ActionId, blockIds: ['block-2' as BlockId], tailId: 'block-2' as BlockId, rev });
				expect(advanced.success, `setup: block-2 must reach rev ${rev}`).to.equal(true);
			}

			// block-1 is listed first and is stale at rev 1; block-2 is stale at rev 3.
			const result = await repo.pend({
				actionId: 'a4' as ActionId,
				rev: 1,
				transforms: { inserts: {}, updates: { 'block-1': [['items', 0, 0, ['y']]], 'block-2': [['items', 0, 0, ['y']]] }, deletes: [] },
				policy: 'c'
			});

			expect(result.success).to.equal(false);
			expect((result as StaleFailure).staleAt, 'the highest holder, not the first scanned').to.deep.equal({ blockId: 'block-2', rev: 3 });
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

	// A write transaction touching several blocks is committed one group at a time, so it can end
	// up with SOME blocks durably committed and the rest refused (a "torn action"). The retry reuses
	// the SAME actionId, so its pend meets its own already-committed half. Comparing revision
	// numbers alone refuses the writer with its own durable work, forever.
	describe('pend — own already-committed block (torn-action retry)', () => {
		const listPendings = async (blockId: BlockId): Promise<ActionId[]> => {
			const found: ActionId[] = [];
			for await (const actionId of new BlockStorage(blockId, rawStorage).listPendingTransactions()) found.push(actionId);
			return found;
		};

		const commitBlockOne = async () => {
			const pended = await repo.pend({
				actionId: 'a1' as ActionId,
				rev: 1,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});
			expect(pended.success, 'setup: first pend must succeed').to.equal(true);
			const committed = await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });
			expect(committed.success, 'setup: commit must land at rev 1').to.equal(true);
		};

		it('accepts a re-pend of the SAME action at the revision it already committed, recording no pending', async () => {
			await commitBlockOne();

			const result = await repo.pend({
				actionId: 'a1' as ActionId,
				rev: 1,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});

			expect(result.success, 'our own durable work must not refuse us').to.equal(true);
			// Still reported, so `cancel` covers the block (deleting an absent pending is a no-op).
			expect((result as PendSuccess).blockIds).to.deep.equal(['block-1']);
			// And NO pending record: commit's alreadyDone arm skips internalCommit, the only thing that
			// promotes (and removes) a pending — one saved here would be a permanent durable
			// reservation that the rival-pending checks refuse every future writer against.
			expect(await listPendings('block-1' as BlockId), 'no permanent reservation').to.deep.equal([]);
		});

		// The shape the fix actually exists for: the retry pends BOTH halves at once. The committed
		// half must be waved through without a pending record while the refused half still gets one,
		// and the follow-on commit must then carry the whole action to success.
		it('re-pends a partially-committed action: committed half satisfied, refused half still pended', async () => {
			await commitBlockOne();

			const transforms: Transforms = {
				inserts: { 'block-1': makeBlock('block-1'), 'block-2': makeBlock('block-2') },
				updates: {},
				deletes: []
			};
			const result = await repo.pend({ actionId: 'a1' as ActionId, rev: 1, transforms, policy: 'c' });

			expect(result.success).to.equal(true);
			expect((result as PendSuccess).blockIds).to.have.members(['block-1', 'block-2']);
			expect(await listPendings('block-1' as BlockId), 'committed half: no reservation').to.deep.equal([]);
			expect(await listPendings('block-2' as BlockId), 'refused half: pended as usual').to.deep.equal(['a1']);

			const committed = await repo.commit({
				actionId: 'a1' as ActionId,
				blockIds: ['block-1' as BlockId, 'block-2' as BlockId],
				tailId: 'block-1' as BlockId,
				rev: 1
			});
			expect(committed.success, 'the torn action converges').to.equal(true);
			expect((await new BlockStorage('block-2' as BlockId, rawStorage).getLatest())?.rev).to.equal(1);
			expect(await listPendings('block-2' as BlockId), 'promoted, so cleared').to.deep.equal([]);
		});

		it('still refuses a RIVAL action at a revision this node already holds', async () => {
			await commitBlockOne();

			const result = await repo.pend({
				actionId: 'rival' as ActionId,
				rev: 1,
				transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')),
				policy: 'c'
			});

			expect(result.success).to.equal(false);
			expect((result as StaleFailure).missing?.length ?? 0, 'rival behavior unchanged').to.be.greaterThan(0);
		});
	});

	describe('cancel', () => {
		it('removes pending action', async () => {
			// Create block first so it exists
			const blockStorage = new BlockStorage('block-1' as BlockId, rawStorage);
			const existingBlock = makeBlock('block-1');
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await blockStorage.savePendingTransaction('setup' as ActionId, { insert: existingBlock }, l);
				await blockStorage.saveMaterializedBlock('setup' as ActionId, existingBlock, l);
				await blockStorage.saveRevision(1, 'setup' as ActionId, l);
				await blockStorage.promotePendingTransaction('setup' as ActionId, l);
				await blockStorage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
			});

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
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await blockStorage.savePendingTransaction('create' as ActionId, { insert: testBlock }, l);
				await blockStorage.saveMaterializedBlock('create' as ActionId, testBlock, l);
				await blockStorage.saveRevision(1, 'create' as ActionId, l);
				await blockStorage.promotePendingTransaction('create' as ActionId, l);
				await blockStorage.setLatest({ actionId: 'create' as ActionId, rev: 1 }, l);
			});

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
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await blockStorage.savePendingTransaction('create' as ActionId, { insert: testBlock }, l);
				await blockStorage.saveMaterializedBlock('create' as ActionId, testBlock, l);
				await blockStorage.saveRevision(1, 'create' as ActionId, l);
				await blockStorage.promotePendingTransaction('create' as ActionId, l);
				await blockStorage.setLatest({ actionId: 'create' as ActionId, rev: 1 }, l);
			});

			// Add a pending transaction
			await repo.pend({
				actionId: 'pending-1' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['new']]]),
				policy: 'c'
			});

			const result = await repo.get({ blockIds: ['block-1' as BlockId] });

			expect(result['block-1']!.state.pendings?.includes('pending-1')).to.equal(true);
		});

		it('a revision-pinned get reports the revision its content was materialized at, not the latest', async () => {
			// Ticket 2-bug-pinned-get-reports-latest-revision. `getBlock(context.rev)` already
			// materialized the content at the pin and reported that revision as `actionRev`; the
			// result used to throw it away and stamp the block with the node's NEWEST revision.
			// TransactorSource records that number as the read dependency, so pinned content was
			// being labelled with a revision it never was — the validator's stale-read check
			// (exact equality) then passed for a read that observed older content.
			const blockId = 'block-1' as BlockId;
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(blockId, makeBlock('block-1', { items: ['v1'] })),
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);

			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms(blockId, [['items', 1, 0, ['v2']]]),
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a2' as ActionId, blockIds: [blockId], tailId: blockId, rev: 2 })).success).to.equal(true);

			// Unpinned read: content and both revision fields all describe rev 2.
			const latest = (await repo.get({ blockIds: [blockId] }))[blockId]!;
			expect((latest.block as unknown as { items: string[] }).items).to.deep.equal(['v1', 'v2']);
			expect(latest.state.latest?.rev).to.equal(2);
			expect(latest.materialized?.rev, 'unpinned: materialized rev agrees with latest').to.equal(2);

			// Pinned read at rev 1: rev-1 content, reported as rev 1 — while `state.latest` keeps
			// its own meaning (the newest revision this node holds), which callers rely on.
			const pinned = (await repo.get({ blockIds: [blockId], context: { rev: 1, committed: [] } }))[blockId]!;
			expect((pinned.block as unknown as { items: string[] }).items, 'pinned content is rev 1\'s').to.deep.equal(['v1']);
			expect(pinned.materialized?.rev, 'and is reported as rev 1').to.equal(1);
			expect(pinned.state.latest?.rev, 'state.latest still the newest revision held').to.equal(2);
		});

		it('a pinned get of a block unchanged since the pin reports that block\'s own revision', async () => {
			// The pin is a COLLECTION-wide revision, so it routinely sits above a given block's last
			// change. `materialized` must be the block's own revision (what the descending walk
			// actually served), not the pin — otherwise every unchanged block would record a
			// dependency at a revision it was never committed at and stale-reject spuriously.
			const aId = 'blk-A' as BlockId;
			const bId = 'blk-B' as BlockId;
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: {
					inserts: { [aId]: makeBlock('blk-A', { items: [] }), [bId]: makeBlock('blk-B', { items: ['b'] }) },
					updates: {},
					deletes: []
				},
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [aId, bId], tailId: aId, rev: 1 })).success).to.equal(true);

			// Only A moves to rev 2; B stays at rev 1.
			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms(aId, [['items', 0, 0, ['more']]]),
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a2' as ActionId, blockIds: [aId], tailId: aId, rev: 2 })).success).to.equal(true);

			const result = await repo.get({ blockIds: [bId], context: { rev: 2, committed: [] } });
			expect(result[bId]!.materialized?.rev, 'B is served from its own rev 1, not the rev-2 pin').to.equal(1);
			expect(result[bId]!.state.latest?.rev, 'and its latest is rev 1 too — the two agree here').to.equal(1);
		});

		it('a pending-overlay get reports the committed base it was applied over', async () => {
			// A pending carries no revision of its own, so the honest label for pending-overlaid
			// content is the revision of the committed base underneath it. Pinning the read below
			// `latest` proves the field tracks the base actually used, not the newest revision held.
			const blockId = 'block-1' as BlockId;
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(blockId, makeBlock('block-1', { items: ['v1'] })),
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);

			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms(blockId, [['items', 1, 0, ['v2']]]),
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a2' as ActionId, blockIds: [blockId], tailId: blockId, rev: 2 })).success).to.equal(true);

			// Uncommitted pending, read back over a base pinned at rev 1.
			await repo.pend({
				actionId: 'a3' as ActionId,
				transforms: makeUpdateTransforms(blockId, [['items', 1, 0, ['v3']]]),
				policy: 'c'
			});
			const entry = (await repo.get({
				blockIds: [blockId],
				context: { actionId: 'a3' as ActionId, rev: 1, committed: [] }
			}))[blockId]!;

			expect((entry.block as unknown as { items: string[] }).items, 'rev-1 base with the pending applied')
				.to.deep.equal(['v1', 'v3']);
			expect(entry.materialized?.rev, 'reports the base revision, not the newest held').to.equal(1);
			expect(entry.state.latest?.rev, 'state.latest still the newest revision held').to.equal(2);
		});

		it('a pending-only insert read WITH a context is served over an absent committed base', async () => {
			// The writer reading back its own not-yet-committed insert. There is no committed
			// revision under the pending, so `getBlock` reports an ABSENT base (not a fault) and the
			// overlay applies the insert on top of it. Every named `rev` answers identically — the
			// rev names a base that does not exist, so there is nothing to pin.
			const blockId = 'brand-new' as BlockId;
			await repo.pend({
				actionId: 'p1' as ActionId,
				transforms: makeInsertTransforms(blockId, makeBlock('brand-new', { items: ['fresh'] })),
				policy: 'c'
			});

			for (const rev of [0, 1, 2]) {
				const entry = (await repo.get({
					blockIds: [blockId],
					context: { actionId: 'p1' as ActionId, rev, committed: [] }
				}))[blockId]!;
				expect(entry.block?.header.id, `rev ${rev}: the pending insert is served`).to.equal(blockId);
				expect((entry.block as unknown as { items: string[] }).items, `rev ${rev}: with its content`)
					.to.deep.equal(['fresh']);
				expect(entry.materialized?.rev, `rev ${rev}: no committed base ⇒ no materialized revision`)
					.to.equal(undefined);
				expect('unavailable' in entry, `rev ${rev}: a real answer is never flagged`).to.equal(false);
				expect(entry.state.latest, `rev ${rev}: nothing committed yet`).to.equal(undefined);
				expect(entry.state.pendings, `rev ${rev}: the overlaid pending is reported`).to.deep.equal(['p1']);
			}

			// The contextLESS read is unchanged: it applies no pendings, so it stays the
			// authoritative absent the createOrOpen insert probe depends on.
			const contextless = (await repo.get({ blockIds: [blockId] }))[blockId]!;
			expect(contextless.block, 'contextless read does not apply pendings').to.equal(undefined);
			expect(contextless.state).to.deep.equal({});
		});

		it('a pending-only block read at a named rev with NO actionId is a plain unflagged absent', async () => {
			// The shape production actually issues: `CoordinatorRepo.promoteCorroborated` reads with
			// `{ committed: [corroborated], rev }` and never sets `actionId`. Before the getBlock
			// change this threw and came back `unavailable: 'unmaterializable'`, which the read-repair
			// pass had to log and step over. It is an ABSENCE — no committed revision exists here — so
			// it must stay unflagged, and `state` must stay the empty object the coordinator reads as
			// "consult the cohort".
			const blockId = 'pending-only-no-actionid' as BlockId;
			await repo.pend({
				actionId: 'p1' as ActionId,
				transforms: makeInsertTransforms(blockId, makeBlock('pending-only-no-actionid', { items: ['fresh'] })),
				policy: 'c'
			});

			const entry = (await repo.get({
				blockIds: [blockId],
				context: { rev: 3, committed: [] }
			}))[blockId]!;

			expect(entry.block, 'no committed revision to serve').to.equal(undefined);
			expect('unavailable' in entry, 'an absent base is not a reconstruction failure').to.equal(false);
			expect(entry.state).to.deep.equal({});
			// The pending record survives the read — nothing above consumed or refused it.
			expect(await rawStorage.getPendingTransaction(blockId, 'p1' as ActionId)).to.not.equal(undefined);
		});

		it('a pending UPDATE over an absent committed base materializes nothing and is flagged', async () => {
			// The overlay runs (getBlock no longer throws), but `applyTransform` drops updates when
			// there is no block to apply them to. This node holds a pending record PROVING the block
			// exists and produced nothing — that is a guess, not an authoritative absent, even though
			// no promotion refusal fired here (`committed: []`).
			const blockId = 'update-no-base' as BlockId;
			await repo.pend({
				actionId: 'p1' as ActionId,
				transforms: makeUpdateTransforms(blockId, [['items', 0, 0, ['x']]]),
				policy: 'c'
			});

			const entry = (await repo.get({
				blockIds: [blockId],
				context: { actionId: 'p1' as ActionId, rev: 2, committed: [] }
			}))[blockId]!;

			expect(entry.block, 'nothing to apply the update to').to.equal(undefined);
			expect(entry.unavailable, 'an empty overlay over no base is a guess').to.equal('unmaterializable');
			expect(entry.materialized?.rev, 'no base ⇒ no materialized revision').to.equal(undefined);
		});

		it('a promotion refusal on the context\'s OWN actionId returns a flagged entry, never a throw', async () => {
			// The context proves rev 2 for `p1` AND names `p1` as its pending overlay. Read-driven
			// promotion refuses (no base to apply the update to) and `refuseMissingBase` DELETES that
			// pending record. The overlay branch then finds no pending — but this repo did hold it and
			// dropped it, so the honest answer is the availability flag. Throwing `Pending action …
			// not found` here would escape the per-block catch and fail the whole batch.
			const blockId = 'refused-own-pending' as BlockId;
			await repo.pend({
				actionId: 'p1' as ActionId,
				transforms: makeUpdateTransforms(blockId, [['items', 0, 0, ['x']]]),
				policy: 'c'
			});

			const result = await repo.get({
				blockIds: [blockId],
				context: { actionId: 'p1' as ActionId, rev: 2, committed: [{ actionId: 'p1' as ActionId, rev: 2 }] }
			});

			expect(result[blockId]!.block).to.equal(undefined);
			expect(result[blockId]!.unavailable).to.equal('unmaterializable');
			expect(result[blockId]!.state).to.deep.equal({});
			// The refusal really did drop the record — otherwise this test proves nothing.
			expect(await rawStorage.getPendingTransaction(blockId, 'p1' as ActionId)).to.equal(undefined);
		});

		it('a pending DELETE over a real committed base reads absent and stays UNFLAGGED', async () => {
			// The counterweight to the two cases above: `block === undefined` here too, but there IS
			// a committed base underneath and the pending deliberately removes it. That is an
			// authoritative tombstone, not a reconstruction failure.
			const blockId = 'pending-tombstone' as BlockId;
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(blockId, makeBlock('pending-tombstone', { items: ['v1'] })),
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);

			await repo.pend({ actionId: 'p2' as ActionId, transforms: makeDeleteTransforms(blockId), policy: 'c' });

			const entry = (await repo.get({
				blockIds: [blockId],
				context: { actionId: 'p2' as ActionId, rev: 1, committed: [] }
			}))[blockId]!;

			expect(entry.block, 'the pending delete removes the base').to.equal(undefined);
			expect('unavailable' in entry, 'an intended tombstone is an authoritative absent').to.equal(false);
			expect(entry.materialized?.rev, 'the base it was applied over is still reported').to.equal(1);
		});

		it('a context naming a pending this repo NEVER had still throws', async () => {
			// The genuine caller-contract violation the flagged answers above must not swallow: a
			// healthy committed block, no refusal, and an actionId this repo has no record of.
			const blockId = 'healthy-block' as BlockId;
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(blockId, makeBlock('healthy-block', { items: ['v1'] })),
				policy: 'c'
			});
			expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);

			let error: unknown;
			try {
				await repo.get({
					blockIds: [blockId],
					context: { actionId: 'never-pended' as ActionId, rev: 1, committed: [] }
				});
			} catch (err) {
				error = err;
			}
			expect((error as Error)?.message).to.contain('Pending action never-pended not found');
		});

		it('a mixed batch serves a pending-only insert alongside a wedged block', async () => {
			// Each block gets its own answer and `Promise.all` stays unbroken: the pending-only
			// insert is served from its overlay while the wedged sibling (latest pointing at a
			// revision with no materialization) is flagged.
			const fresh = 'fresh-insert' as BlockId;
			const wedged = 'wedged-block' as BlockId;
			await repo.pend({
				actionId: 'p1' as ActionId,
				transforms: makeInsertTransforms(fresh, makeBlock('fresh-insert', { items: ['new'] })),
				policy: 'c'
			});
			await rawStorage.saveMetadata(wedged, { latest: { rev: 3, actionId: 'ghost' as ActionId }, ranges: [[3]] });

			const result = await repo.get({
				blockIds: [fresh, wedged],
				context: { actionId: 'p1' as ActionId, rev: 3, committed: [] }
			});

			expect(result[fresh]!.block?.header.id, 'pending-only insert served').to.equal(fresh);
			expect('unavailable' in result[fresh]!, 'and unflagged').to.equal(false);
			expect(result[wedged]!.block, 'wedged sibling has no content').to.equal(undefined);
			expect(result[wedged]!.unavailable, 'and is flagged').to.equal('unmaterializable');
		});
	});

	describe('get — unavailable vs absent (ticket repo-reports-unavailable-vs-absent)', () => {
		const BLOCK = 'no-base-block' as BlockId;

		/** Pend an update for a block this repo holds no revision of — the shape a node is left
		 *  in when it received revision N's pend but never the revision it applies to. */
		const pendUpdateWithoutBase = async (actionId: string): Promise<void> => {
			await repo.pend({
				actionId: actionId as ActionId,
				transforms: makeUpdateTransforms(BLOCK, [['items', 0, 0, ['x']]]),
				policy: 'c'
			});
		};

		it('flags a context-driven read as unmaterializable when the pending has no base', async () => {
			// The reported trace: this node holds the pending record for rev 2 with no rev 1 to
			// apply it to, so it cannot reconstruct the block — but its records PROVE the block
			// exists, so answering { state: {} } would be a guess presented as authoritative.
			await pendUpdateWithoutBase('a-ctx');

			const result = await repo.get({
				blockIds: [BLOCK],
				context: { committed: [{ actionId: 'a-ctx' as ActionId, rev: 2 }], rev: 2 }
			});

			expect(result[BLOCK]?.block).to.equal(undefined);
			expect(result[BLOCK]?.state?.latest).to.equal(undefined);
			expect(result[BLOCK]?.unavailable).to.equal('unmaterializable');
		});

		it('a block never written returns { state: {} } with NO unavailable field', async () => {
			// The common createOrOpen "does this block exist?" probe: this answer must stay
			// authoritative, or creating any collection becomes impossible (the flag would
			// send it into retries and then a throw).
			const result = await repo.get({ blockIds: ['never-written' as BlockId] });

			expect(result['never-written']!.state).to.deep.equal({});
			expect('unavailable' in result['never-written']!).to.equal(false);
		});

		it('a tombstoned block reads back absent with NO unavailable field', async () => {
			// A deleted block reverse-applies to nothing by design — an authoritative absent.
			// It never enters the missing-base catch, so the flag must not appear.
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK)),
				policy: 'c'
			});
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });
			await repo.pend({ actionId: 'a2' as ActionId, transforms: makeDeleteTransforms(BLOCK), policy: 'c' });
			await repo.commit({ actionId: 'a2' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 2 });

			const result = await repo.get({ blockIds: [BLOCK] });

			expect(result[BLOCK]!.block).to.equal(undefined);
			expect('unavailable' in result[BLOCK]!).to.equal(false);
		});

		it('flags a contextless read when latest itself is unmaterializable, instead of failing the batch', async () => {
			// A wedged block: latest points at a revision with no materialization anywhere below
			// it, so getBlock() throws ("Failed to find materialized block"). Before this ticket
			// the throw escaped Promise.all and failed the whole get.
			await rawStorage.saveMetadata(BLOCK, { latest: { rev: 3, actionId: 'ghost' as ActionId }, ranges: [[3]] });

			const result = await repo.get({ blockIds: [BLOCK] });

			expect(result[BLOCK]?.block).to.equal(undefined);
			expect(result[BLOCK]?.unavailable).to.equal('unmaterializable');
		});

		it('a mixed batch returns healthy siblings alongside the flagged block', async () => {
			// One broken block must fail for the one block that is actually broken — not take
			// nine healthy siblings down with it.
			const OK = 'healthy-sibling' as BlockId;
			await repo.pend({
				actionId: 'a-ok' as ActionId,
				transforms: makeInsertTransforms(OK, makeBlock(OK, { items: ['v'] })),
				policy: 'c'
			});
			await repo.commit({ actionId: 'a-ok' as ActionId, blockIds: [OK], tailId: OK, rev: 1 });
			// Wedge the sibling with an unmaterializable latest.
			await rawStorage.saveMetadata(BLOCK, { latest: { rev: 3, actionId: 'ghost' as ActionId }, ranges: [[3]] });

			const result = await repo.get({ blockIds: [OK, BLOCK] });

			expect(result[OK]?.block?.header.id, 'healthy sibling served').to.equal(OK);
			expect(result[OK]?.state?.latest?.rev).to.equal(1);
			expect('unavailable' in result[OK]!).to.equal(false);
			expect(result[BLOCK]?.unavailable).to.equal('unmaterializable');
		});

		it('a block with committed content stays authoritative when a context names a revision this node lacks', async () => {
			// The stale-but-real-answer case: the block materializes at rev 1, and the caller's
			// context proves a rev 2 this node holds no pending for. Promotion is a no-op (no
			// pending, no refusal) and the read serves rev 1 unflagged — a stale answer is a
			// real answer, never `unavailable`.
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK, { items: [] })),
				policy: 'c'
			});
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });

			const result = await repo.get({
				blockIds: [BLOCK],
				context: { committed: [{ actionId: 'a-future' as ActionId, rev: 2 }], rev: 2 }
			});

			expect(result[BLOCK]?.block?.header.id).to.equal(BLOCK);
			expect(result[BLOCK]?.state?.latest?.rev).to.equal(1);
			expect('unavailable' in result[BLOCK]!).to.equal(false);
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
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await blockStorage.savePendingTransaction('setup' as ActionId, { insert: testBlock }, l);
				await blockStorage.saveMaterializedBlock('setup' as ActionId, testBlock, l);
				await blockStorage.saveRevision(1, 'setup' as ActionId, l);
				await blockStorage.promotePendingTransaction('setup' as ActionId, l);
				await blockStorage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
			});

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
				await withBlockWriteLatch(blockId as BlockId, async l => {
					await storage.savePendingTransaction('setup' as ActionId, { insert: block }, l);
					await storage.saveMaterializedBlock('setup' as ActionId, block, l);
					await storage.saveRevision(1, 'setup' as ActionId, l);
					await storage.promotePendingTransaction('setup' as ActionId, l);
					await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
				});
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

	describe('read-driven promotion under the write latch (st-storage-repo-promotion-latch-bypass)', () => {
		// Commit block-1 at rev 1 directly, then pend a2 at rev 2 without ever driving it
		// through commit() — so a context-proving get() is what promotes it.
		const seedRev1AndPendA2 = async () => {
			const storage = new BlockStorage('block-1' as BlockId, rawStorage);
			const block = makeBlock('block-1', { items: [] });
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await storage.savePendingTransaction('setup' as ActionId, { insert: block }, l);
				await storage.saveMaterializedBlock('setup' as ActionId, block, l);
				await storage.saveRevision(1, 'setup' as ActionId, l);
				await storage.promotePendingTransaction('setup' as ActionId, l);
				await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
			});
			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['a2']]]),
				policy: 'c'
			});
			return storage;
		};

		it('does not promote while another writer holds the block write latch', async () => {
			// The core of the bug: get()'s read-driven promotion ran internalCommit with NO latch.
			// Hold the block's write latch (simulating a concurrent commit sitting in its critical
			// section); a correctly-latched promotion must BLOCK on it, a bypassing one promotes anyway.
			const storage = await seedRev1AndPendA2();

			const release = await Latches.acquire(blockWriteLatchKey('block-1' as BlockId));

			let resolved = false;
			const getPromise = repo.get({
				blockIds: ['block-1' as BlockId],
				context: { committed: [{ actionId: 'a2' as ActionId, rev: 2 }], rev: 2 }
			}).then((r) => { resolved = true; return r; });

			// Release even if an assertion throws: the write latch is a process-global mutex, so a
			// leaked hold would wedge every later test that commits block-1.
			try {
				// Ample event-loop turns: with the fix the get parks on the held latch; pre-fix it has
				// already promoted a2 despite the held latch. A held mutex never releases on its own, so
				// this is not a flaky race — the get simply cannot complete while the latch is out.
				// Residual bounded sleep: proving the get does NOT resolve is a negative assertion.
				await delay(25);

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
					storage.setLatest = async (latest: ActionRev, l: BlockWriteLatch) => {
						// Gate only the read-driven promotion's write (a2), not the commit's (a3).
						if (latest.actionId === 'a2') {
							reachedResolve();
							await gate;
						}
						return originalSetLatest(latest, l);
					};
				}
				return storage;
			});

			// block-1 committed at rev 1, with a2 and a3 both pending (neither committed yet).
			const storage = new BlockStorage('block-1' as BlockId, rawStorage);
			const block = makeBlock('block-1', { items: [] });
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await storage.savePendingTransaction('setup' as ActionId, { insert: block }, l);
				await storage.saveMaterializedBlock('setup' as ActionId, block, l);
				await storage.saveRevision(1, 'setup' as ActionId, l);
				await storage.promotePendingTransaction('setup' as ActionId, l);
				await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
			});
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
			// Residual bounded window: both outcomes are valid, so there is no single state to poll on.
			await Promise.race([c, delay(25)]);
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

		it('recoverBlock does not reconcile meta.latest while another writer holds the block write latch', async () => {
			// recoverBlock() is a read-modify-write of meta.latest (redoes a lost setLatest), same class
			// as get()'s read-driven promotion — it must hold the write latch too, or a concurrent commit
			// advancing latest in between gets clobbered. Build a Crash-D3 state: rev 1 is latest, but rev 2
			// is durable (revision + promoted action) with meta.latest never advanced. recover() should lift
			// latest to 2 — but not while the latch is held.
			const storage = new BlockStorage('block-1' as BlockId, rawStorage);
			const block = makeBlock('block-1', { items: [] });
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await storage.savePendingTransaction('setup' as ActionId, { insert: block }, l);
				await storage.saveMaterializedBlock('setup' as ActionId, block, l);
				await storage.saveRevision(1, 'setup' as ActionId, l);
				await storage.promotePendingTransaction('setup' as ActionId, l);
				await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
				// rev 2 durable but latest deliberately NOT advanced (the lost-setLatest / Crash-D3 signature).
				await storage.savePendingTransaction('a2' as ActionId, { insert: makeBlock('block-1', { items: ['a2'] }) }, l);
				await storage.saveMaterializedBlock('a2' as ActionId, makeBlock('block-1', { items: ['a2'] }), l);
				await storage.saveRevision(2, 'a2' as ActionId, l);
				await storage.promotePendingTransaction('a2' as ActionId, l);
			});

			const release = await Latches.acquire(blockWriteLatchKey('block-1' as BlockId));

			let resolved = false;
			const recoverPromise = repo.recoverBlock('block-1' as BlockId).then(() => { resolved = true; });

			// Release in finally: the write latch is a process-global mutex; a leaked hold would wedge
			// every later test that commits block-1.
			try {
				// A held mutex never self-releases, so a correctly-latched recover cannot complete in this
				// window; a bypassing one has already advanced latest to rev 2 despite the held latch.
				// Residual bounded sleep: proving recover does NOT resolve is a negative assertion.
				await delay(25);
				expect(resolved).to.equal(false);
				expect((await storage.getLatest())?.rev, 'latest not advanced under held latch').to.equal(1);
			} finally {
				release();
			}
			await recoverPromise;
			expect(resolved).to.equal(true);
			// Once the latch is free, recovery reconciles latest to the highest contiguous durable rev.
			expect((await storage.getLatest())?.rev).to.equal(2);
		});
	});

	describe('partial commit recovery (TEST-5.4.2)', () => {
		it('returns failure when commit fails partway through multi-block commit', async () => {
			// Setup block-1 with a committed block
			const storage1 = new BlockStorage('block-1' as BlockId, rawStorage);
			const block1 = makeBlock('block-1', { items: [] });
			await withBlockWriteLatch('block-1' as BlockId, async l => {
				await storage1.savePendingTransaction('setup' as ActionId, { insert: block1 }, l);
				await storage1.saveMaterializedBlock('setup' as ActionId, block1, l);
				await storage1.saveRevision(1, 'setup' as ActionId, l);
				await storage1.promotePendingTransaction('setup' as ActionId, l);
				await storage1.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
			});

			// Setup block-2 with a committed block
			const storage2 = new BlockStorage('block-2' as BlockId, rawStorage);
			const block2 = makeBlock('block-2', { items: [] });
			await withBlockWriteLatch('block-2' as BlockId, async l => {
				await storage2.savePendingTransaction('setup' as ActionId, { insert: block2 }, l);
				await storage2.saveMaterializedBlock('setup' as ActionId, block2, l);
				await storage2.saveRevision(1, 'setup' as ActionId, l);
				await storage2.promotePendingTransaction('setup' as ActionId, l);
				await storage2.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
			});

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
					storage.saveRevision = async (rev: number, actionId: ActionId, l: BlockWriteLatch) => {
						if (!block2SaveRevisionThrown) {
							block2SaveRevisionThrown = true;
							throw new Error('Simulated saveRevision failure on block-2');
						}
						return originalSaveRevision(rev, actionId, l);
					};
				}
				return storage;
			});

			// Both blocks committed at rev 1 in collection-1.
			for (const id of ['block-1', 'block-2']) {
				const storage = new BlockStorage(id as BlockId, rawStorage);
				const block = makeBlock(id, { items: [] });
				await withBlockWriteLatch(id as BlockId, async l => {
					await storage.savePendingTransaction('setup' as ActionId, { insert: block }, l);
					await storage.saveMaterializedBlock('setup' as ActionId, block, l);
					await storage.saveRevision(1, 'setup' as ActionId, l);
					await storage.promotePendingTransaction('setup' as ActionId, l);
					await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
				});
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
					storage.saveRevision = async (rev: number, actionId: ActionId, l: BlockWriteLatch) => {
						if (!blockBSaveRevisionThrown) {
							blockBSaveRevisionThrown = true;
							throw new Error('Simulated saveRevision failure on block-b');
						}
						return originalSaveRevision(rev, actionId, l);
					};
				}
				return storage;
			});

			const setup = async (id: string, collectionId: string) => {
				const storage = new BlockStorage(id as BlockId, rawStorage);
				const block = makeBlockInCollection(id, collectionId, { items: [] });
				await withBlockWriteLatch(id as BlockId, async l => {
					await storage.savePendingTransaction('setup' as ActionId, { insert: block }, l);
					await storage.saveMaterializedBlock('setup' as ActionId, block, l);
					await storage.saveRevision(1, 'setup' as ActionId, l);
					await storage.promotePendingTransaction('setup' as ActionId, l);
					await storage.setLatest({ actionId: 'setup' as ActionId, rev: 1 }, l);
				});
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

	describe('commit — stale-conflict missing transforms', () => {
		// Regression for perBlockActionTransformsToPerAction discarding the return value of
		// concatTransform (a pure helper that never mutates its first argument).  Before the fix,
		// every StaleFailure.missing[*].transforms was an empty Transforms regardless of how many
		// blocks the missed action had touched.

		it('single-block stale conflict returns non-empty transforms', async () => {
			const block = makeBlock('block-1');
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms('block-1' as BlockId, block), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			await repo.pend({ actionId: 'a2' as ActionId, transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['x']]]), policy: 'c' });
			const result = await repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			const missing = expectStaleMissing(result);
			expect(missing.length).to.equal(1);
			expect(missing[0]!.actionId).to.equal('a1');
			expect(missing[0]!.rev).to.equal(1);
			// inserts must contain block-1 — pre-fix this was empty.
			expect(Object.keys(missing[0]!.transforms.inserts ?? {})).to.deep.equal(['block-1']);
		});

		it('reports staleAt for a commit that lost to a newer revision', async () => {
			// CommitResult is a StaleFailure too, and TransactorSource.transact hands it straight back
			// to Collection — so the commit-side loss deserves the same number as the pend-side one.
			const block = makeBlock('block-1');
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms('block-1' as BlockId, block), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			await repo.pend({ actionId: 'a2' as ActionId, transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['x']]]), policy: 'c' });
			const result = await repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			expect(result.success).to.equal(false);
			expect((result as StaleFailure).staleAt).to.deep.equal({ blockId: 'block-1', rev: 1 });
		});

		it('does not report staleAt on an idempotent commit retry', async () => {
			// Same (actionId, rev) already landed here: a rollforward no-op, not a lost race. It must
			// neither fail nor seed a staleAt that a later block's real rejection would then carry.
			const block = makeBlock('block-1');
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms('block-1' as BlockId, block), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			const retry = await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			expect(retry.success, 'an idempotent retry succeeds').to.equal(true);
			expect((retry as { staleAt?: unknown }).staleAt).to.equal(undefined);
		});

		it('an idempotent block does not lend its revision to a sibling block\'s real loss', async () => {
			// Mixed batch: block-1 is the idempotent no-op (skipped), block-2 genuinely lost to a
			// newer revision. The reported staleAt must name block-2 — the `continue` above must not
			// have seeded it from block-1.
			await repo.pend({
				actionId: 'a1' as ActionId,
				// block-2 carries an `items` array so the update below actually applies (the operation
				// splices into it); without it the rev-2 commit fails and block-2 never advances.
				transforms: { inserts: { 'block-1': makeBlock('block-1'), 'block-2': makeBlock('block-2', { items: [] }) }, updates: {}, deletes: [] },
				policy: 'c'
			});
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			// Advance block-2 alone to rev 2, so it is strictly ahead of the rev-1 retry below.
			await repo.pend({ actionId: 'a2' as ActionId, transforms: makeUpdateTransforms('block-2' as BlockId, [['items', 0, 0, ['x']]]), policy: 'c' });
			const advanced = await repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-2' as BlockId], tailId: 'block-2' as BlockId, rev: 2 });
			expect(advanced.success, 'setup: block-2 must actually reach rev 2').to.equal(true);

			// Re-commit a1 at rev 1: block-1 is idempotent (same actionId + rev), block-2 is at rev 2.
			const result = await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			expect(result.success).to.equal(false);
			expect((result as StaleFailure).staleAt).to.deep.equal({ blockId: 'block-2', rev: 2 });
		});

		it('reports the HIGHEST held revision when several blocks lost at different revisions', async () => {
			// Same rule as the pend side: block-1 is stale at rev 1 and scanned first, block-2 at rev 3.
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: { inserts: { 'block-1': makeBlock('block-1', { items: [] }), 'block-2': makeBlock('block-2', { items: [] }) }, updates: {}, deletes: [] },
				policy: 'c'
			});
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			for (const [actionId, rev] of [['a2', 2], ['a3', 3]] as [string, number][]) {
				await repo.pend({ actionId: actionId as ActionId, transforms: makeUpdateTransforms('block-2' as BlockId, [['items', 0, 0, ['x']]]), policy: 'c' });
				const advanced = await repo.commit({ actionId: actionId as ActionId, blockIds: ['block-2' as BlockId], tailId: 'block-2' as BlockId, rev });
				expect(advanced.success, `setup: block-2 must reach rev ${rev}`).to.equal(true);
			}

			// A rev-less pend skips the revision check, so a4 can reach commit and lose there.
			await repo.pend({
				actionId: 'a4' as ActionId,
				transforms: { inserts: {}, updates: { 'block-1': [['items', 0, 0, ['y']]], 'block-2': [['items', 0, 0, ['y']]] }, deletes: [] },
				policy: 'c'
			});
			const result = await repo.commit({ actionId: 'a4' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			expect(result.success).to.equal(false);
			expect((result as StaleFailure).staleAt, 'the highest holder, not the first scanned').to.deep.equal({ blockId: 'block-2', rev: 3 });
		});

		it('multi-block stale conflict returns transforms for all missed blocks', async () => {
			const inserts = (): Transforms => ({
				inserts: { 'block-1': makeBlock('block-1'), 'block-2': makeBlock('block-2') },
				updates: {},
				deletes: []
			});
			await repo.pend({ actionId: 'a1' as ActionId, transforms: inserts(), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			await repo.pend({ actionId: 'a2' as ActionId, transforms: inserts(), policy: 'c' });
			const result = await repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			const missing = expectStaleMissing(result);
			expect(missing.length).to.equal(1);
			expect(missing[0]!.actionId).to.equal('a1');
			const insertedIds = Object.keys(missing[0]!.transforms.inserts ?? {}).sort();
			// Both block-1 and block-2 must appear — pre-fix this was empty.
			expect(insertedIds).to.deep.equal(['block-1', 'block-2']);
		});

		it('carries update and delete transforms of the missed action', async () => {
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: { inserts: { 'block-1': makeBlock('block-1', { items: [] }), 'block-2': makeBlock('block-2') }, updates: {}, deletes: [] },
				policy: 'c'
			});
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			// a2 updates block-1 and deletes block-2, landing at rev 2.
			await repo.pend({
				actionId: 'a2' as ActionId,
				transforms: { inserts: {}, updates: { 'block-1': [['items', 0, 0, ['x']]] }, deletes: ['block-2' as BlockId] },
				policy: 'c'
			});
			const commit2 = await repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 2 });
			expect(commit2.success, 'a2 must land at rev 2 for a3 to miss it').to.equal(true);

			// a3 arrives believing rev 2 is free — stale against a2 on both blocks.
			await repo.pend({ actionId: 'a3' as ActionId, transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['y']]]), policy: 'c' });
			const result = await repo.commit({ actionId: 'a3' as ActionId, blockIds: ['block-1' as BlockId, 'block-2' as BlockId], tailId: 'block-1' as BlockId, rev: 2 });

			const missing = expectStaleMissing(result);
			expect(missing.length).to.equal(1);
			const missed = missing[0]!;
			expect(missed.actionId).to.equal('a2');
			expect(missed.transforms.updates?.['block-1' as BlockId]).to.deep.equal([['items', 0, 0, ['x']]]);
			expect(missed.transforms.deletes).to.deep.equal(['block-2']);
			expect(Object.keys(missed.transforms.inserts ?? {})).to.deep.equal([]);
		});

		it('groups several missed actions on the same block, one entry each', async () => {
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1', { items: [] })), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			await repo.pend({ actionId: 'a2' as ActionId, transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['x']]]), policy: 'c' });
			const commit2 = await repo.commit({ actionId: 'a2' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 2 });
			expect(commit2.success, 'a2 must land at rev 2 for a3 to miss it').to.equal(true);

			// a3 believes it is at rev 1 — it has missed both a1 (rev 1) and a2 (rev 2).
			await repo.pend({ actionId: 'a3' as ActionId, transforms: makeUpdateTransforms('block-1' as BlockId, [['items', 0, 0, ['y']]]), policy: 'c' });
			const result = await repo.commit({ actionId: 'a3' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

			const missing = expectStaleMissing(result);
			expect(missing.map(m => m.actionId).sort()).to.deep.equal(['a1', 'a2']);
			const byId = new Map(missing.map(m => [m.actionId as string, m]));
			expect(byId.get('a1')!.rev).to.equal(1);
			expect(Object.keys(byId.get('a1')!.transforms.inserts ?? {})).to.deep.equal(['block-1']);
			expect(byId.get('a2')!.rev).to.equal(2);
			expect(byId.get('a2')!.transforms.updates?.['block-1' as BlockId]).to.deep.equal([['items', 0, 0, ['x']]]);
		});
	});

	/**
	 * Ticket: bug-member-commits-unmaterializable-revision.
	 *
	 * A cohort member could accept revision N of a block while holding no revision at all:
	 * `applyTransform(undefined, <updates>)` silently returns undefined, so nothing was
	 * materialized, yet `setLatest({rev: N})` ran anyway. The block was then unreadable
	 * locally (`materializeBlock` throws), unservable to peers, and every later pend for it
	 * was rejected. The invariant these specs pin: **`latest` never advances past a revision
	 * this node can actually materialize.**
	 */
	describe('commit — missing base revision (latest never outruns materialization)', () => {
		const BLOCK = 'orphan-block' as BlockId;

		/** Pend an update-only transform for a block this repo holds no revision of, then commit it. */
		const commitUpdateWithoutBase = async (actionId: string, rev: number): Promise<CommitResult> => {
			await repo.pend({
				actionId: actionId as ActionId,
				transforms: makeUpdateTransforms(BLOCK, [['items', 0, 0, ['x']]]),
				policy: 'c'
			});
			return await repo.commit({ actionId: actionId as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev });
		};

		/** Asserts the result is the distinct missing-base refusal (not a generic fault). */
		const expectMissingBase = (result: CommitResult): void => {
			expect(result.success, 'commit must be refused').to.equal(false);
			const reason = (result as { reason?: string }).reason;
			expect(reason, 'refusal must carry a reason').to.be.a('string');
			expect(reason!.startsWith(MISSING_BASE_REVISION_REASON),
				`reason must be greppable as ${MISSING_BASE_REVISION_REASON}, got: ${reason}`).to.equal(true);
		};

		it('refuses a forward transform when the block has no committed revision', async () => {
			expectMissingBase(await commitUpdateWithoutBase('a-orphan', 2));
		});

		it('leaves latest unset and the block readable-as-absent after the refusal', async () => {
			await commitUpdateWithoutBase('a-orphan', 2);

			// The whole point: no wedged pointer. get() must answer (not throw) and report no revision.
			const got = await repo.get({ blockIds: [BLOCK] });
			expect(got[BLOCK]?.state?.latest, 'latest must not advance to an unmaterializable rev').to.equal(undefined);
			expect(got[BLOCK]?.block).to.equal(undefined);
		});

		it('refuses a delete with no base (it would leave nothing to reverse-apply from)', async () => {
			await repo.pend({ actionId: 'a-del' as ActionId, transforms: makeDeleteTransforms(BLOCK), policy: 'c' });
			const result = await repo.commit({ actionId: 'a-del' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 4 });

			expectMissingBase(result);
			const got = await repo.get({ blockIds: [BLOCK] });
			expect(got[BLOCK]?.state?.latest).to.equal(undefined);
		});

		it('drops the unusable pending so it cannot block later writes to the block', async () => {
			await commitUpdateWithoutBase('a-orphan', 2);

			// policy 'f' fails if ANY pending action is outstanding on the block — the refused
			// pending must be gone, or every later write to this block is rejected as conflicting.
			const later = await repo.pend({
				actionId: 'a-later' as ActionId,
				transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK)),
				policy: 'f'
			});
			expect(later.success, 'no orphaned pending may remain').to.equal(true);
		});

		it('does NOT refuse an insert with no prior revision (the normal create path)', async () => {
			await repo.pend({ actionId: 'a-new' as ActionId, transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK)), policy: 'c' });
			const result = await repo.commit({ actionId: 'a-new' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });

			expect(result.success).to.equal(true);
			const got = await repo.get({ blockIds: [BLOCK] });
			expect(got[BLOCK]?.state?.latest?.rev).to.equal(1);
		});

		it('commits across an arbitrary revision gap when a base IS held', async () => {
			// Revisions are allocated per COLLECTION, so a block only gets one when an action
			// touches it: local rev 1 → committing rev 7 is routine, not a gap to heal.
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK, { items: [] })), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });

			await repo.pend({ actionId: 'a7' as ActionId, transforms: makeUpdateTransforms(BLOCK, [['items', 0, 0, ['x']]]), policy: 'c' });
			const result = await repo.commit({ actionId: 'a7' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 7 });

			expect(result.success, 'a held base makes any forward rev committable').to.equal(true);
			const got = await repo.get({ blockIds: [BLOCK] });
			expect(got[BLOCK]?.state?.latest?.rev).to.equal(7);
			expect((got[BLOCK]?.block as unknown as { items: unknown[] }).items).to.deep.equal(['x']);
		});

		it('refuses rather than throwing opaquely when latest itself is unmaterializable', async () => {
			// A block wedged by the pre-fix defect (or by truncated history): latest points at a
			// revision with no materialization anywhere below it, so getBlock throws. The next
			// commit must report the same greppable divergence — which routes to healing — rather
			// than surfacing a raw storage fault that resets the cluster stream.
			await rawStorage.saveMetadata(BLOCK, { latest: { rev: 3, actionId: 'ghost' as ActionId }, ranges: [[3]] });

			expectMissingBase(await commitUpdateWithoutBase('a-after-wedge', 4));
		});

		it('read-driven promotion does not advance latest without a base', async () => {
			await repo.pend({
				actionId: 'a-ctx' as ActionId,
				transforms: makeUpdateTransforms(BLOCK, [['items', 0, 0, ['x']]]),
				policy: 'c'
			});

			// The read-repair shape: a context asserting the cluster committed rev 2, on a node
			// holding the pending but no base. get() promotes context revisions through the same
			// internalCommit, so it must observe the same refusal instead of wedging `latest`.
			let readError: Error | undefined;
			try {
				await repo.get({
					blockIds: [BLOCK],
					context: { committed: [{ actionId: 'a-ctx' as ActionId, rev: 2 }], rev: 2 }
				});
			} catch (err) {
				readError = err as Error;
			}

			expect(await new BlockStorage(BLOCK, rawStorage).getLatest(),
				'a read must never advance latest to an unmaterializable rev').to.equal(undefined);
			// The refusal itself is absorbed by get(). Anything that still escapes is a storage-layer
			// read fault, not this refusal leaking out — acquiring the block this node never held is
			// the coordinator's job (`CoordinatorRepo.restoreCorroborated`), one layer up.
			expect(readError?.message ?? '', 'the missing-base refusal must not escape a read')
				.to.not.include(MISSING_BASE_REVISION_REASON);
		});

		it('converges once the block arrives out-of-band, and then accepts later writes', async () => {
			// Refuse (this node missed the creating revision) …
			expectMissingBase(await commitUpdateWithoutBase('a-orphan', 2));

			// … the healing path (ClusterMember reconcile → saveReplicatedBlock) supplies rev 2 …
			await repo.saveReplicatedBlock(BLOCK, makeBlock(BLOCK, { items: ['x'] }), { actionId: 'a-orphan' as ActionId, rev: 2 });

			const healed = await repo.get({ blockIds: [BLOCK] });
			expect(healed[BLOCK]?.state?.latest?.rev, 'block converged at the committed rev').to.equal(2);
			expect((healed[BLOCK]?.block as unknown as { items: unknown[] }).items).to.deep.equal(['x']);

			// … and the node participates in the block's next write instead of rejecting it.
			const pended = await repo.pend({
				actionId: 'a-next' as ActionId,
				transforms: makeUpdateTransforms(BLOCK, [['items', 1, 0, ['y']]]),
				policy: 'c'
			});
			expect(pended.success).to.equal(true);
			const committed = await repo.commit({ actionId: 'a-next' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 3 });
			expect(committed.success, 'a healed member must not reject later writes').to.equal(true);
			const after = await repo.get({ blockIds: [BLOCK] });
			expect((after[BLOCK]?.block as unknown as { items: unknown[] }).items).to.deep.equal(['x', 'y']);
		});

		/**
		 * A batch mixing a committable block with one that has no base. `commit()` breaks out of its
		 * per-block loop on the first failure, so which block refuses decides how much of the batch
		 * lands. Both orders must still surface the refusal (that is what routes the action to the
		 * healing path) and must never leave a block at a revision it cannot materialize.
		 */
		describe('mixed batch (one block committable, one with no base)', () => {
			const OK = 'sibling-block' as BlockId;

			/** Pend an insert on `OK` and an update on `BLOCK` under one action, then commit both. */
			const commitMixedBatch = async (blockIds: BlockId[]): Promise<CommitResult> => {
				await repo.pend({
					actionId: 'a-mixed' as ActionId,
					transforms: {
						inserts: { [OK]: makeBlock(OK, { items: [] }) },
						updates: { [BLOCK]: [['items', 0, 0, ['x']]] },
						deletes: []
					},
					policy: 'c'
				});
				return await repo.commit({ actionId: 'a-mixed' as ActionId, blockIds, tailId: OK, rev: 2 });
			};

			it('surfaces the refusal even when a sibling block committed first', async () => {
				const events: CollectionChangeEvent[] = [];
				repo.onCollectionChange('collection-1' as BlockId, (e) => events.push(e));

				const result = await commitMixedBatch([OK, BLOCK]);

				expectMissingBase(result);
				// The sibling landed durably before the break — a retry treats it as an idempotent
				// no-op, so it must NOT be rolled back.
				expect((await repo.get({ blockIds: [OK] }))[OK]?.state?.latest?.rev, 'sibling landed').to.equal(2);
				expect((await repo.get({ blockIds: [BLOCK] }))[BLOCK]?.state?.latest, 'refusing block untouched').to.equal(undefined);
				// … and its change event still fires despite the batch failing afterwards. The
				// pending-record cleanup runs before the emit and must not suppress or disturb it.
				expect(events.length, 'the landed sibling still emits').to.equal(1);
				expect(events[0]!.blockIds, 'only the block that landed').to.deep.equal([OK]);
				expect(events[0]!.actionId).to.equal('a-mixed');
				expect(events[0]!.rev).to.equal(2);
			});

			it('leaves a not-yet-reached sibling uncommitted rather than half-applied', async () => {
				// Refusing block first: the break happens before the sibling is reached, so the whole
				// batch is unapplied here. The action still reached consensus cluster-wide; this member
				// converges by replication, which is what the refusal routes to.
				expectMissingBase(await commitMixedBatch([BLOCK, OK]));

				expect((await repo.get({ blockIds: [OK] }))[OK]?.state?.latest, 'sibling not reached').to.equal(undefined);
				expect((await repo.get({ blockIds: [BLOCK] }))[BLOCK]?.state?.latest).to.equal(undefined);
			});

			/** Pend a later exclusive write to `OK` and report whether it was accepted. */
			const laterExclusiveWriteAccepted = async (): Promise<boolean> => {
				const later = await repo.pend({
					actionId: 'a-later' as ActionId,
					transforms: makeUpdateTransforms(OK, [['items', 0, 0, ['y']]]),
					policy: 'f'
				});
				return later.success;
			};

			it('drops a not-yet-reached sibling’s pending, which could never be promoted', async () => {
				// The break leaves the sibling unreached; reconcile then advances that block past the
				// action, so a pending left behind would be unpromotable forever and would be reported
				// as a conflicting action by every later write to the block. commit() drops the whole
				// batch's pendings for this (divergence) failure kind, so the node keeps participating.
				await commitMixedBatch([BLOCK, OK]);
				await repo.saveReplicatedBlock(OK, makeBlock(OK, { items: [] }), { actionId: 'a-mixed' as ActionId, rev: 2 });

				expect(await laterExclusiveWriteAccepted(), 'no orphaned pending may block later writes').to.equal(true);
			});

			it('drops them for the missing-pend divergence too (no refusal involved)', async () => {
				// Same orphan route without any missing-base refusal: commit() throws for the block
				// whose pend never arrived, BEFORE the per-block loop runs, so every block in the batch
				// would keep its pending. ClusterMember reconciles the whole batch after this throw, so
				// commit drops them here as well.
				await repo.pend({
					actionId: 'a-mixed' as ActionId,
					transforms: makeInsertTransforms(OK, makeBlock(OK, { items: [] })),
					policy: 'c'
				});

				// BLOCK was never pended here, so commit throws rather than returning a refusal.
				let thrown: Error | undefined;
				try {
					await repo.commit({ actionId: 'a-mixed' as ActionId, blockIds: [OK, BLOCK], tailId: OK, rev: 2 });
				} catch (err) {
					thrown = err as Error;
				}
				// The message shape is load-bearing: ClusterMember.isMissingPendingActionError matches
				// on it to route this to reconcile. Cleanup must not change or replace it.
				expect(thrown?.message ?? '', 'this path throws, it does not refuse').to.include('Pending action');
				expect(thrown?.message ?? '').to.not.include(MISSING_BASE_REVISION_REASON);

				await repo.saveReplicatedBlock(OK, makeBlock(OK, { items: [] }), { actionId: 'a-mixed' as ActionId, rev: 2 });

				expect(await laterExclusiveWriteAccepted(), 'same route, same cleanup').to.equal(true);
			});

			it('KEEPS the pendings when the failure is a genuine fault, and a retry replays them', async () => {
				// The discriminator's other arm. A raw-storage fault is NOT divergence: ClusterMember
				// propagates it for retry rather than reconciling, so the batch's pendings must survive
				// or the retry has nothing to commit. Without this guard, Arm 1 would silently degrade
				// every transient fault into a reconcile.
				const FAULT = 'fault-block' as BlockId;
				let faulted = false;
				const faulting = new (class extends MemoryRawStorage {
					override async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
						// One-shot, and only for FAULT: the retry below must be able to succeed.
						if (blockId === FAULT && !faulted) {
							faulted = true;
							throw new Error('injected raw-storage fault');
						}
						await super.saveMaterializedBlock(blockId, actionId, block);
					}
				})();
				const faultingRepo = new StorageRepo((blockId) => new BlockStorage(blockId, faulting));

				await faultingRepo.pend({
					actionId: 'a-fault' as ActionId,
					transforms: {
						inserts: { [FAULT]: makeBlock(FAULT, { items: [] }), [OK]: makeBlock(OK, { items: [] }) },
						updates: {},
						deletes: []
					},
					policy: 'c'
				});

				// FAULT first, so the break happens before OK is reached.
				const result = await faultingRepo.commit({ actionId: 'a-fault' as ActionId, blockIds: [FAULT, OK], tailId: OK, rev: 1 });
				expect(result.success, 'the injected fault fails the commit').to.equal(false);
				expect((result as { reason?: string }).reason ?? '', 'a fault, not a divergence refusal')
					.to.not.include(MISSING_BASE_REVISION_REASON);

				// The not-yet-reached sibling still holds its pending record …
				const okPending = await new BlockStorage(OK, faulting).getPendingTransaction('a-fault' as ActionId);
				expect(okPending, 'a retryable fault must not drop the batch’s pendings').to.not.equal(undefined);
				// … and so does the faulting block itself (its own commit never reached promotion).
				const faultPending = await new BlockStorage(FAULT, faulting).getPendingTransaction('a-fault' as ActionId);
				expect(faultPending, 'the faulting block keeps its pending too').to.not.equal(undefined);

				// The retry (same actionId + rev) replays both from those records.
				const retried = await faultingRepo.commit({ actionId: 'a-fault' as ActionId, blockIds: [FAULT, OK], tailId: OK, rev: 1 });
				expect(retried.success, 'retry replays the retained pendings').to.equal(true);
				const got = await faultingRepo.get({ blockIds: [FAULT, OK] });
				expect(got[FAULT]?.state?.latest?.rev).to.equal(1);
				expect(got[OK]?.state?.latest?.rev).to.equal(1);
			});

			it('a cleanup that itself fails must not replace the error the caller reports', async () => {
				// `ClusterMember.isMissingPendingActionError` pattern-matches this throw's message to
				// route the action to reconcile. If the cleanup's own failure escaped, consensus would
				// see an opaque fault instead and propagate it — turning a healable divergence into a
				// stream reset. So per-block cleanup failures are logged and swallowed.
				const breaking = new (class extends MemoryRawStorage {
					override async deletePendingTransaction(): Promise<void> {
						throw new Error('injected cleanup fault');
					}
				})();
				const breakingRepo = new StorageRepo((blockId) => new BlockStorage(blockId, breaking));

				// Pend on OK only, then commit a batch naming BLOCK too — BLOCK has no pend, so the
				// pre-loop divergence throw fires and cleanup runs over the batch.
				await breakingRepo.pend({
					actionId: 'a-mixed' as ActionId,
					transforms: makeInsertTransforms(OK, makeBlock(OK, { items: [] })),
					policy: 'c'
				});

				let thrown: Error | undefined;
				try {
					await breakingRepo.commit({ actionId: 'a-mixed' as ActionId, blockIds: [OK, BLOCK], tailId: OK, rev: 2 });
				} catch (err) {
					thrown = err as Error;
				}
				expect(thrown?.message ?? '', 'the divergence signal survives a failed cleanup').to.include('Pending action');
				expect(thrown?.message ?? '').to.not.include('injected cleanup fault');
			});

			it('an idempotent-retry block is not in the batch, so cleanup cannot touch it', async () => {
				// OK is committed on its own first, so the mixed commit partitions it as alreadyDone —
				// never in `toCommit`, hence never a cleanup target. It must keep its committed state
				// and stay writable.
				await repo.pend({
					actionId: 'a-mixed' as ActionId,
					transforms: {
						inserts: { [OK]: makeBlock(OK, { items: [] }) },
						updates: { [BLOCK]: [['items', 0, 0, ['x']]] },
						deletes: []
					},
					policy: 'c'
				});
				expect((await repo.commit({ actionId: 'a-mixed' as ActionId, blockIds: [OK], tailId: OK, rev: 2 })).success).to.equal(true);

				// Now the full batch: OK is alreadyDone, BLOCK refuses for a missing base.
				expectMissingBase(await repo.commit({ actionId: 'a-mixed' as ActionId, blockIds: [OK, BLOCK], tailId: OK, rev: 2 }));

				expect((await repo.get({ blockIds: [OK] }))[OK]?.state?.latest?.rev, 'already-done block untouched').to.equal(2);
				expect(await laterExclusiveWriteAccepted(), 'and still writable').to.equal(true);
			});
		});
	});

	/**
	 * `StorageRepo.commit` holds the write latch of EVERY block in its batch at once, which makes that
	 * critical section the wrong place for network I/O — one slow peer would stall every writer of
	 * every block in the batch. So the commit path reads its base LOCALLY (`BlockStorage.getBlock`
	 * never consults `restoreCallback`), and a base this node cannot materialize locally is refused
	 * with `MISSING_BASE_REVISION_REASON` rather than fetched in line. Healing is out-of-band: cohort
	 * reconcile supplies the revision (`saveReplicatedBlock`) and the action is retried.
	 *
	 * This is a deliberate behaviour CHANGE. Previously `readCommitBase` -> `getBlock` ->
	 * `ensureRevision` fetched the missing base from a peer with all of those latches held. These
	 * tests pin the new behaviour: a restore callback that WOULD have answered is never invoked from
	 * the commit path.
	 */
	describe('commit reads its base locally (no peer fetch inside the latched critical section)', () => {
		const BLOCK = 'gap-block' as BlockId;
		const GHOST = 'ghost' as ActionId;

		let restoreCalls: { blockId: BlockId; rev?: number }[];
		let restoringRepo: StorageRepo;

		beforeEach(() => {
			restoreCalls = [];
			// A peer that can answer for rev 3, and records every time it is asked.
			const restoreCallback: RestoreCallback = async (blockId, rev) => {
				restoreCalls.push({ blockId, rev });
				const block = makeBlock(BLOCK, { items: ['from-peer'] });
				const archive: BlockArchive = {
					blockId,
					revisions: { 3: { action: { actionId: GHOST, rev: 3, transform: { insert: block } }, block } },
					range: [3, 4]
				};
				return archive;
			};
			restoringRepo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage, restoreCallback));
		});

		/**
		 * `latest` at rev 3 that this node cannot serve — the shape the old code healed in line.
		 *
		 * Written straight to raw storage on purpose: no code path produces this state today (every
		 * writer of `latest` merges coverage for it in the same `saveMetadata` — see the NOTE in
		 * `readCommitBase`), so it stands in for the states that DO reach it — a block wedged by an
		 * older build, or truncated history — which are exactly the ones the old code answered by
		 * fetching from a peer mid-commit.
		 */
		const seedUnservableLatest = async (ranges: RevisionRange[]): Promise<void> => {
			await rawStorage.saveMetadata(BLOCK, { latest: { rev: 3, actionId: GHOST }, ranges });
		};

		const pendUpdate = async (actionId: string): Promise<void> => {
			const pended = await restoringRepo.pend({
				actionId: actionId as ActionId,
				transforms: makeUpdateTransforms(BLOCK, [['items', 0, 0, ['x']]]),
				policy: 'c'
			});
			expect(pended.success, 'the pend itself must succeed — the refusal under test is the commit').to.equal(true);
		};

		const expectMissingBase = (result: CommitResult): void => {
			expect(result.success, 'commit must be refused').to.equal(false);
			const reason = (result as { reason?: string }).reason;
			expect(reason, 'refusal must carry a reason').to.be.a('string');
			expect(reason!.startsWith(MISSING_BASE_REVISION_REASON),
				`reason must be greppable as ${MISSING_BASE_REVISION_REASON}, got: ${reason}`).to.equal(true);
		};

		it('control: the READ path DOES fetch this same base from the peer', async () => {
			// Without this, "the commit path made 0 restore calls" would pass just as well against a
			// callback that could never have answered in the first place. Same metadata, same wiring,
			// different entry point — the read heals (StorageRepo.get -> restoreRevision -> re-read).
			await seedUnservableLatest([]);

			const got = await restoringRepo.get({ blockIds: [BLOCK] });

			expect(restoreCalls.length, 'the read path heals through restoreRevision').to.equal(1);
			expect(restoreCalls[0]!.rev, 'pinned at the uncovered revision').to.equal(3);
			expect((got[BLOCK]?.block as unknown as { items: unknown[] } | undefined)?.items,
				'the content a peer would have supplied really is servable').to.deep.equal(['from-peer']);
		});

		it('refuses a commit whose base is not locally covered, without calling the restore callback', async () => {
			// `ranges: []` under `latest.rev = 3`: getBlock reports the coverage gap
			// (RevisionNotCoveredError). Pre-change, that gap was healed in line by ensureRevision — from
			// a peer, while this commit held the block's write latch.
			await seedUnservableLatest([]);
			await pendUpdate('a-gap');

			expectMissingBase(await restoringRepo.commit({
				actionId: 'a-gap' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 4
			}));

			expect(restoreCalls, 'the commit path must not reach the network while holding block latches')
				.to.deep.equal([]);
			expect(await new BlockStorage(BLOCK, rawStorage).getPendingTransaction('a-gap' as ActionId),
				'refuseMissingBase drops the pending it can never promote here').to.equal(undefined);
			expect((await new BlockStorage(BLOCK, rawStorage).getLatest())?.rev,
				'the refusal writes nothing else — latest is exactly as it was').to.equal(3);
		});

		it('the refusal really is gated on the block write latch', async () => {
			// The tests above prove no fetch happens; on their own they would also pass if `commit` took
			// no latch at all, which would make the whole "no network I/O in the critical section"
			// argument vacuous. Hold the block's write latch and the commit must PARK — it cannot reach
			// readCommitBase, let alone refuse, until the latch is free.
			await seedUnservableLatest([]);
			await pendUpdate('a-latched');	// pend needs the latch too, so it must run before we take it

			const release = await Latches.acquire(blockWriteLatchKey(BLOCK));

			let result: CommitResult | undefined;
			const commitPromise = restoringRepo.commit({
				actionId: 'a-latched' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 4
			}).then((r) => { result = r; return r; });

			// Release even if an assertion throws: the write latch is a process-global mutex, so a leaked
			// hold would wedge every later test that writes this block.
			try {
				// A held mutex never self-releases, so this is a stable negative assertion, not a race:
				// an unlatched commit would already have run the refusal within these turns.
				await delay(25);
				expect(result, 'commit must not reach its refusal while the latch is held').to.equal(undefined);
				expect((await new BlockStorage(BLOCK, rawStorage).getPendingTransaction('a-latched' as ActionId)),
					'and must not have dropped the pending yet either').to.not.equal(undefined);
			} finally {
				release();
			}

			expectMissingBase(await commitPromise);
			expect(restoreCalls, 'still no fetch once it does run').to.deep.equal([]);
		});

		it('refuses the same way, and still without a fetch, when history under a claimed range is truncated', async () => {
			// `ranges: [[3]]` with no revision records: getBlock passes the coverage check and then finds
			// nothing materializable. Different throw, same refusal path, same no-network rule.
			await seedUnservableLatest([[3]]);
			await pendUpdate('a-truncated');

			expectMissingBase(await restoringRepo.commit({
				actionId: 'a-truncated' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 4
			}));

			expect(restoreCalls, 'no peer fetch on this arm either').to.deep.equal([]);
			expect(await new BlockStorage(BLOCK, rawStorage).getPendingTransaction('a-truncated' as ActionId),
				'the unpromotable pending is dropped').to.equal(undefined);
		});

		it('a multi-block batch refuses without a fetch, with every block in the batch latched', async () => {
			// The concrete cost the change removes: the old in-line restore happened with the latches of
			// EVERY block in `blockIds` held, so one unreachable base stalled writers of every sibling for
			// the length of a round trip. (Which block the loop reaches first is `commit`'s sorted-id
			// business and is covered by the 'mixed batch' tests above; all this one claims is that no
			// fetch happens on any ordering.)
			const SIBLING = 'gap-sibling' as BlockId;
			await seedUnservableLatest([]);
			const pended = await restoringRepo.pend({
				actionId: 'a-batch' as ActionId,
				transforms: {
					inserts: { [SIBLING]: makeBlock(SIBLING, { items: [] }) },
					updates: { [BLOCK]: [['items', 0, 0, ['x']]] },
					deletes: []
				},
				policy: 'c'
			});
			expect(pended.success).to.equal(true);

			expectMissingBase(await restoringRepo.commit({
				actionId: 'a-batch' as ActionId, blockIds: [SIBLING, BLOCK], tailId: SIBLING, rev: 4
			}));

			expect(restoreCalls, 'no network I/O with N block latches held').to.deep.equal([]);
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

	/**
	 * Ticket: commit-cert-digest-member-check. `previewCommitDigest` predicts, read-only and
	 * latch-free, what internalCommit would materialize for a pended action — the member side of the
	 * commit content-digest check compares it against the digest the transaction author declared.
	 * The invariant these specs pin: the preview's digest matches what a commit of the same pending
	 * action ACTUALLY stores, and the preview never disturbs durable state.
	 */
	describe('previewCommitDigest', () => {
		const BLOCK = 'digest-block' as BlockId;

		/** Digest of the block the repo actually stored at `rev` — the ground truth a preview must match. */
		const storedDigest = async (rev: number): Promise<string> => {
			const stored = await new BlockStorage(BLOCK, rawStorage).getBlock(rev);
			expect(stored?.block, `a materialized block must exist at rev ${rev}`).to.not.equal(undefined);
			return await canonicalBlockHash(stored!.block);
		};

		it('returns undefined when this node holds no pending transform for the action', async () => {
			expect(await repo.previewCommitDigest(BLOCK, 'never-pended' as ActionId, 1)).to.equal(undefined);
		});

		it('previews an insert as base-independent and matches what internalCommit stores', async () => {
			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK, { items: ['x'] })),
				policy: 'c'
			});

			const preview = await repo.previewCommitDigest(BLOCK, 'a1' as ActionId, 1);
			expect(preview).to.not.equal(undefined);
			expect(preview!.baseIndependent, 'an insert is base-independent').to.equal(true);
			expect(preview!.baseRev, 'no base is read for an insert').to.equal(undefined);
			expect(preview!.digest).to.be.a('string');

			// Read-only: the pending record survives the preview and the commit still lands from it.
			const commit = await repo.commit({ actionId: 'a1' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });
			expect(commit.success).to.equal(true);
			expect(await storedDigest(1), 'preview predicted the committed content').to.equal(preview!.digest);
		});

		it('previews an update against the local base and matches what internalCommit stores', async () => {
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK, { items: ['x'] })), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });
			await repo.pend({ actionId: 'a2' as ActionId, transforms: makeUpdateTransforms(BLOCK, [['items', 1, 0, ['y']]]), policy: 'c' });

			const preview = await repo.previewCommitDigest(BLOCK, 'a2' as ActionId, 2);
			expect(preview!.baseIndependent).to.equal(false);
			expect(preview!.baseRev, 'computed against the local committed base').to.equal(1);
			expect(preview!.digest).to.be.a('string');

			const commit = await repo.commit({ actionId: 'a2' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 2 });
			expect(commit.success).to.equal(true);
			expect(await storedDigest(2)).to.equal(preview!.digest);
			// Preview cloned before materializing: the base rev 1 must still hold the pre-update content.
			expect(await storedDigest(1), 'the base materialization was not mutated by the preview')
				.to.not.equal(preview!.digest);
		});

		it('previews a delete as digest-undefined, and the tombstone commit still lands', async () => {
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK, { items: ['x'] })), policy: 'c' });
			await repo.commit({ actionId: 'a1' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 1 });
			await repo.pend({ actionId: 'a2' as ActionId, transforms: makeDeleteTransforms(BLOCK), policy: 'c' });

			const preview = await repo.previewCommitDigest(BLOCK, 'a2' as ActionId, 2);
			expect(preview, 'a pended delete still yields a preview').to.not.equal(undefined);
			expect(preview!.digest, 'a delete materializes nothing to digest').to.equal(undefined);
			expect(preview!.baseIndependent).to.equal(false);
			expect(preview!.baseRev).to.equal(1);

			// internalCommit's absent-newBlock-with-prior-latest tombstone branch still commits.
			const commit = await repo.commit({ actionId: 'a2' as ActionId, blockIds: [BLOCK], tailId: BLOCK, rev: 2 });
			expect(commit.success).to.equal(true);
			// `latest` advanced, read from storage: repo.get returns an EMPTY state for a tombstone
			// (the `!blockRev` branch) — an authoritative absent, deliberately without `latest`.
			expect((await new BlockStorage(BLOCK, rawStorage).getLatest())?.rev).to.equal(2);
			const got = await repo.get({ blockIds: [BLOCK] });
			expect(got[BLOCK]?.block, 'tombstoned').to.equal(undefined);
			expect('unavailable' in got[BLOCK]!, 'an authoritative absent, not a failed read').to.equal(false);
		});

		it('previews updates-with-no-base as digest-undefined with no baseRev', async () => {
			// applyTransform drops updates when there is no block to apply them to; a preview of that
			// pending must say "nothing to compare", not fabricate content.
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeUpdateTransforms(BLOCK, [['items', 0, 0, ['x']]]), policy: 'c' });

			const preview = await repo.previewCommitDigest(BLOCK, 'a1' as ActionId, 2);
			expect(preview).to.not.equal(undefined);
			expect(preview!.digest).to.equal(undefined);
			expect(preview!.baseRev).to.equal(undefined);
			expect(preview!.baseIndependent).to.equal(false);
		});

		it('reports digest-undefined plus the baseRev when the base is unmaterializable, without disturbing the pending', async () => {
			// A wedged block: latest points at a revision with no materialization below it, so
			// getBlock throws. The commit path refuses AND deletes the pending (refuseMissingBase);
			// preview must do neither — an unmaterializable base is "cannot check", not a mismatch.
			await rawStorage.saveMetadata(BLOCK, { latest: { rev: 3, actionId: 'ghost' as ActionId }, ranges: [[3]] });
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeUpdateTransforms(BLOCK, [['items', 0, 0, ['x']]]), policy: 'c' });

			const preview = await repo.previewCommitDigest(BLOCK, 'a1' as ActionId, 4);
			expect(preview).to.not.equal(undefined);
			expect(preview!.digest).to.equal(undefined);
			expect(preview!.baseRev, 'the unreachable base rev is still reported').to.equal(3);
			expect(preview!.baseIndependent).to.equal(false);

			const pending = await new BlockStorage(BLOCK, rawStorage).getPendingTransaction('a1' as ActionId);
			expect(pending, 'preview must not drop the pending record').to.not.equal(undefined);
		});

		it('an insert-carrying transform previews cleanly even on a wedged block (no base read at all)', async () => {
			// Base-independence must not just ignore the base's CONTENT — it must not read the base,
			// or a locally wedged block would degrade a check every member could otherwise make.
			await rawStorage.saveMetadata(BLOCK, { latest: { rev: 3, actionId: 'ghost' as ActionId }, ranges: [[3]] });
			await withBlockWriteLatch(BLOCK, async l => {
				await new BlockStorage(BLOCK, rawStorage).savePendingTransaction('a1' as ActionId,
					{ insert: makeBlock(BLOCK, { items: ['fresh'] }) }, l);
			});

			const preview = await repo.previewCommitDigest(BLOCK, 'a1' as ActionId, 4);
			expect(preview!.baseIndependent).to.equal(true);
			expect(preview!.digest).to.be.a('string');
			expect(preview!.digest, 'digest is of the insert content')
				.to.equal(await canonicalBlockHash(makeBlock(BLOCK, { items: ['fresh'] })));
		});

		it('single-peer fast path: StorageRepo.commit accepts a request carrying blockDigests', async () => {
			// CoordinatorRepo.commit short-circuits straight to storageRepo.commit when peerCount <= 1
			// — no consensus, no member check. The extra field must ride through harmlessly.
			await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms(BLOCK, makeBlock(BLOCK, { items: ['x'] })), policy: 'c' });
			const commit = await repo.commit({
				actionId: 'a1' as ActionId,
				blockIds: [BLOCK],
				tailId: BLOCK,
				rev: 1,
				blockDigests: { [BLOCK]: { digest: 'not-even-checked-here' } }
			});
			expect(commit.success).to.equal(true);
			const got = await repo.get({ blockIds: [BLOCK] });
			expect(got[BLOCK]?.state?.latest?.rev).to.equal(1);
		});
	});
});
