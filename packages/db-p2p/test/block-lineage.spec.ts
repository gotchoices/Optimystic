/**
 * What ONE node's records can say about whether a block's current content was BUILT FROM a given
 * committed write (`IBlockStorage.lineageOf`, surfaced by `StorageRepo.get` when the request carries
 * `lineageOf`).
 *
 * A writer asks this when its write was superseded before it could confirm it: a later revision
 * held by a different action refuses the writer's re-send, but does not say whether that revision
 * was built ON the write (saved) or OVER it (lost). The revision index alone cannot tell either:
 *
 *  - holding the write's revision does not prove the latest content came from it — a node that held
 *    it and then took a later revision as a REPLICA may have taken one descended from a base below
 *    the write (the fork case). It must not vouch for the write;
 *  - NOT holding it does not prove the opposite — a node that was behind and took the later revision
 *    as a replica (restored past the revision) has no record of the write, yet the replica may
 *    contain it. It must not deny the write.
 *
 * Both answer `unknown`, and only a history the node DERIVED ITSELF across the write's revision
 * answers `contains` or `excludes`. The cohort-level rule that turns these per-node answers into one
 * answer is `judgeCohortLineage` in db-core.
 */

import { expect } from 'chai';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { withBlockWriteLatch } from '../src/storage/block-latch.js';
import type { ActionId, ActionRev, BlockId, BlockLineage, IBlock, Transforms } from '@optimystic/db-core';

const blockId = 'leaf' as BlockId;

const makeBlock = (items: string[]): IBlock => ({
	header: { id: blockId, type: 'test', collectionId: 'collection-1' as BlockId },
	items
} as IBlock);

const insertOf = (block: IBlock): Transforms => ({ inserts: { [blockId]: block }, updates: {}, deletes: [] });
const appendOf = (item: string, at: number): Transforms => ({ inserts: {}, updates: { [blockId]: [['items', at, 0, [item]]] }, deletes: [] });

const mine: ActionRev = { actionId: 'mine' as ActionId, rev: 2 };

describe('Block lineage: whether a block was built from a committed write', () => {
	let rawStorage: MemoryRawStorage;
	let repo: StorageRepo;

	beforeEach(() => {
		rawStorage = new MemoryRawStorage();
		repo = new StorageRepo(id => new BlockStorage(id, rawStorage));
	});

	/** Pend and commit one action on the block, through the same path a cohort member applies. */
	const commit = async (actionId: string, rev: number, transforms: Transforms): Promise<void> => {
		const pended = await repo.pend({ actionId: actionId as ActionId, rev, transforms, policy: 'c' });
		expect(pended.success, `pend ${actionId}@${rev}`).to.equal(true);
		const committed = await repo.commit({ actionId: actionId as ActionId, rev, blockIds: [blockId], tailId: blockId });
		expect(committed.success, `commit ${actionId}@${rev}`).to.equal(true);
	};

	const lineage = async (target: ActionRev = mine): Promise<BlockLineage | undefined> =>
		(await repo.get({ blockIds: [blockId], lineageOf: target }))[blockId]?.lineage;

	it('is not reported unless asked for', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		expect((await repo.get({ blockIds: [blockId] }))[blockId]).to.not.have.property('lineage');
	});

	it('contains: the write is the latest revision', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await commit('mine', 2, appendOf('mine', 1));
		expect(await lineage()).to.equal('contains');
	});

	it('contains: a rival committed the next revision ON TOP of the write, here', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await commit('mine', 2, appendOf('mine', 1));
		await commit('rival', 3, appendOf('rival', 2));
		expect(await lineage(), 'every revision since was applied here to the one before it').to.equal('contains');
		const served = (await repo.get({ blockIds: [blockId] }))[blockId]!.block as IBlock & { items: string[] };
		expect(served.items, 'and the content bears it out').to.deep.equal(['seed', 'mine', 'rival']);
	});

	it('behind: the block has not reached the write\'s revision, or does not exist', async () => {
		expect(await lineage(), 'no block at all').to.equal('behind');
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		expect(await lineage(), 'still at the revision before it').to.equal('behind');
	});

	it('excludes: a rival took the very revision the write needed', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await commit('rival', 2, appendOf('rival', 1));
		expect(await lineage()).to.equal('excludes');
	});

	it('excludes: history derived here spans the write\'s revision without it', async () => {
		// The write's block never landed (its pend was cancelled); a rival then built rev 3 on rev 1.
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await commit('rival', 3, appendOf('rival', 1));
		expect(await lineage(), 'rev 3 was applied here to rev 1: the write cannot be in it').to.equal('excludes');
	});

	it('unknown, not contains — the FORK case: held the write, then took a later revision as a replica', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await commit('mine', 2, appendOf('mine', 1));
		// The cohort's rev 3 was built on rev 1 by members that never held the write; this node
		// refused it (its latest was not the declared base) and reconciled the result.
		await repo.saveReplicatedBlock(blockId, makeBlock(['seed', 'rival']), { rev: 3, actionId: 'rival' as ActionId });

		expect(await lineage(), 'the index still names the write at rev 2, and that proves nothing').to.equal('unknown');
		const served = (await repo.get({ blockIds: [blockId] }))[blockId]!.block as IBlock & { items: string[] };
		expect(served.items, 'the write really is gone from the content').to.deep.equal(['seed', 'rival']);
	});

	it('unknown, not excludes — RESTORED PAST the revision: was behind, then took a later revision as a replica', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		// The write and the rival's revision on top of it both landed elsewhere; this node missed the
		// write and reconciled rev 3, which contains it.
		await repo.saveReplicatedBlock(blockId, makeBlock(['seed', 'mine', 'rival']), { rev: 3, actionId: 'rival' as ActionId });

		expect(await lineage(), 'no record of the write here, and that proves nothing either').to.equal('unknown');
	});

	it('a replica of the write\'s OWN revision counts, and so does what is then built on it here', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await repo.saveReplicatedBlock(blockId, makeBlock(['seed', 'mine']), mine);
		expect(await lineage(), 'the replica IS the write\'s revision').to.equal('contains');
		await commit('rival', 3, appendOf('rival', 2));
		expect(await lineage(), 'and rev 3 was applied to it here').to.equal('contains');
	});

	it('unknown: a later commit replaced the block wholesale (an insert is not built on what was there)', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await commit('mine', 2, appendOf('mine', 1));
		// A commit past the latest revision whose transform carries an insert: its content ignores
		// whatever base this node held.
		await commit('replacer', 3, insertOf(makeBlock(['replaced'])));
		expect(await lineage()).to.equal('unknown');
	});

	it('metadata written before the floor existed vouches only for what the next commit was built on', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		await commit('mine', 2, appendOf('mine', 1));
		const meta = (await rawStorage.getMetadata(blockId))!;
		delete meta.lineageFloor;
		await rawStorage.saveMetadata(blockId, meta);

		await commit('rival', 3, appendOf('rival', 2));
		expect(await lineage(), 'rev 3 was built on rev 2 here — that much is known').to.equal('contains');
		expect(await lineage({ actionId: 'seed' as ActionId, rev: 1 }), 'how rev 2 came to be is not').to.equal('unknown');
	});

	it('recover() records for a redone commit what its lost setLatest would have', async () => {
		await commit('seed', 1, insertOf(makeBlock(['seed'])));
		// Crash-D3: rev 2 durably promoted, the setLatest that would have advanced `latest` lost.
		const storage = new BlockStorage(blockId, rawStorage);
		await withBlockWriteLatch(blockId, async latch => {
			await storage.savePendingTransaction('mine' as ActionId, { updates: [['items', 1, 0, ['mine']]] }, 2, latch);
			await storage.saveRevision(2, 'mine' as ActionId, latch);
			await storage.promotePendingTransaction('mine' as ActionId, latch);
		});
		await repo.recoverBlock(blockId);

		expect(await lineage(), 'the recovered revision is the latest').to.equal('contains');
		await commit('rival', 3, appendOf('rival', 1));
		expect(await lineage(), 'and the lineage it extended is still known').to.equal('contains');
	});
});
