import { expect } from 'chai';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockArchive, RestoreCallback } from '../src/storage/struct.js';
import type { BlockId, ActionId, IBlock, BlockHeader, Transforms } from '@optimystic/db-core';

/**
 * Coverage for the `meta.ranges` honesty invariant: `ranges` must state EXACTLY which
 * revisions this node can locally reconstruct — never more. A fresh pend seeds `[]`
 * (nothing committed yet); each committed revision merges its own closed range.
 *
 * Regression guard for the bug where `savePendingTransaction` seeded an open-ended
 * `[[0]]`, falsely claiming coverage of every revision and short-circuiting the
 * `ensureRevision` restore path so a `getBlock` for an absent revision never fetched it.
 */

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

describe('BlockStorage meta.ranges honesty', () => {
	let raw: MemoryRawStorage;

	beforeEach(() => {
		raw = new MemoryRawStorage();
	});

	it('pend seeds empty ranges (nothing reconstructible yet)', async () => {
		const blockId = 'block-pend' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		await storage.savePendingTransaction('a1' as ActionId, { insert: makeBlock('block-pend') });

		const meta = await raw.getMetadata(blockId);
		expect(meta, 'metadata seeded').to.not.equal(undefined);
		expect(meta!.ranges, 'fresh pend claims no coverage').to.deep.equal([]);
		expect(meta!.latest, 'no committed revision yet').to.equal(undefined);
	});

	it('getBlock for an absent revision fires restoreCallback (restore not short-circuited)', async () => {
		const blockId = 'block-restore' as BlockId;
		const restoreCalls: { blockId: BlockId; rev?: number }[] = [];

		// Minimal archive so the restore + subsequent materialize completes.
		const restoredBlock = makeBlock('block-restore', { items: ['restored'] });
		const restoreCallback: RestoreCallback = async (id, rev) => {
			restoreCalls.push({ blockId: id, rev });
			const archive: BlockArchive = {
				blockId: id,
				revisions: {
					1: {
						action: { actionId: 'restored-action' as ActionId, rev: 1, transform: { insert: restoredBlock } },
						block: restoredBlock
					}
				},
				range: [1, 2]
			};
			return archive;
		};

		const storage = new BlockStorage(blockId, raw, restoreCallback);
		// Seed pending-only metadata (ranges: []), but never commit rev 1 locally.
		await storage.savePendingTransaction('pending' as ActionId, { insert: makeBlock('block-restore') });

		const result = await storage.getBlock(1);

		expect(restoreCalls.length, 'restoreCallback invoked for the absent revision').to.equal(1);
		expect(restoreCalls[0]!.rev).to.equal(1);
		expect(result?.block.header.id).to.equal('block-restore');

		// The restored range is now claimed.
		const meta = await raw.getMetadata(blockId);
		expect(meta!.ranges).to.deep.equal([[1, 2]]);
	});

	it('commit merges the closed range [N, N+1]', async () => {
		const blockId = 'block-commit' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		await repo.pend({
			actionId: 'a1' as ActionId,
			transforms: makeInsertTransforms(blockId, makeBlock('block-commit', { items: [] })),
			policy: 'c'
		});
		const commit = await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 });
		expect(commit.success).to.equal(true);

		const meta = await raw.getMetadata(blockId);
		expect(meta!.latest?.rev).to.equal(1);
		expect(meta!.ranges, 'committed revision merged as a closed range').to.deep.equal([[1, 2]]);
	});

	it('non-contiguous commits stay disjoint (the gap survives)', async () => {
		const blockId = 'block-gap' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		// Commit rev 1.
		await repo.pend({
			actionId: 'a1' as ActionId,
			transforms: makeInsertTransforms(blockId, makeBlock('block-gap', { items: [] })),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);

		// Commit rev 3 (skipping rev 2) — leaves a gap between the two claimed ranges.
		await repo.pend({
			actionId: 'a2' as ActionId,
			transforms: makeUpdateTransforms(blockId, [['items', 0, 0, ['more']]]),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a2' as ActionId, blockIds: [blockId], tailId: blockId, rev: 3 })).success).to.equal(true);

		const meta = await raw.getMetadata(blockId);
		expect(meta!.latest?.rev).to.equal(3);
		expect(meta!.ranges, 'gap at rev 2 survives as two disjoint closed ranges').to.deep.equal([[1, 2], [3, 4]]);
	});

	it('recover merges the recovered span into ranges', async () => {
		const blockId = 'block-recover' as BlockId;
		const actionId = 'a1' as ActionId;
		const storage = new BlockStorage(blockId, raw);

		// Reproduce a Crash-D3 raw state: revision durable + action in committed log,
		// but setLatest (and its range merge) was lost — latest undefined, ranges [].
		const block = makeBlock('block-recover', { items: [] });
		await storage.savePendingTransaction(actionId, { insert: block });
		await storage.saveMaterializedBlock(actionId, block);
		await storage.saveRevision(1, actionId);
		await storage.promotePendingTransaction(actionId);
		// NOTE: setLatest deliberately skipped — the lost write recover() exists to redo.

		const before = await raw.getMetadata(blockId);
		expect(before!.latest, 'latest lost pre-recovery').to.equal(undefined);
		expect(before!.ranges, 'no coverage claimed pre-recovery').to.deep.equal([]);

		const result = await storage.recover();
		expect(result.reconciled).to.equal(true);
		expect(result.latest?.rev).to.equal(1);

		const after = await raw.getMetadata(blockId);
		expect(after!.latest?.rev).to.equal(1);
		expect(after!.ranges, 'recovered revision now claimed').to.deep.equal([[1, 2]]);
	});
});
