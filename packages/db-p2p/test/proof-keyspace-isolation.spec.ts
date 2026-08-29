import { expect } from 'chai';
import type { ActionId, BlockId, IBlock, Transforms } from '@optimystic/db-core';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { withBlockWriteLatch } from '../src/storage/block-latch.js';
import { makeProof } from '../src/testing/raw-storage-conformance.js';

/**
 * Regression guard for `reserved-proof-key-collides-with-client-action-ids`.
 *
 * Commit proofs used to be filed in the TRANSACTIONS store under a made-up action id
 * `~proof:<rev>`, on the assumption that no real action id starts with `~`. Nothing enforced
 * that: an action id is chosen by whoever originates a write and is never re-derived or
 * format-checked by the node that stores it, so a client's `pend` or a peer's restore archive
 * could name that exact id and silently overwrite (or be overwritten by) the proof.
 *
 * Proofs now live in their own `(blockId, rev)`-keyed store, so there is no key both can name.
 * These cases drive the three arrival orders that reproduced the corruption through the real
 * `StorageRepo` / `BlockStorage` surface.
 */

const COLLIDING_ACTION = '~proof:5' as ActionId;

const makeBlock = (id: string, data?: Record<string, unknown>): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId },
	...data
});

const insertTransforms = (blockId: BlockId, block: IBlock): Transforms => ({
	inserts: { [blockId]: block },
	updates: {},
	deletes: []
});

describe('commit proofs do not share the transactions keyspace', () => {
	let storage: MemoryRawStorage;
	let repo: StorageRepo;

	beforeEach(() => {
		storage = new MemoryRawStorage();
		repo = new StorageRepo(id => new BlockStorage(id, storage));
	});

	it('Order A: committing an action named `~proof:5`, then retaining a proof for rev 5, leaves the committed transform intact', async () => {
		const blockId = 'order-a' as BlockId;
		const block = makeBlock('order-a', { items: ['written'] });

		const pend = await repo.pend({ actionId: COLLIDING_ACTION, transforms: insertTransforms(blockId, block), policy: 'c' });
		expect(pend.success, 'a client may pend under any action id').to.equal(true);
		const commit = await repo.commit({ actionId: COLLIDING_ACTION, blockIds: [blockId], tailId: blockId, rev: 1 });
		expect(commit.success, 'and commit it').to.equal(true);

		await storage.saveBlockProof(blockId, 5, makeProof('A'));

		// The committed transform is still the client's insert, not the proof object.
		const stored = await storage.getTransaction(blockId, COLLIDING_ACTION);
		expect(stored, 'the committed transform survives the proof write').to.deep.equal({ insert: block });
		expect((await storage.getBlockProof(blockId, 5))!.messageHash, 'and the proof is stored').to.equal('hash-A');
	});

	it('Order A: the stale-pend catch-up response carries the real transform, not an empty one', async () => {
		const blockId = 'order-a-catchup' as BlockId;
		const block = makeBlock('order-a-catchup', { items: ['written'] });

		await repo.pend({ actionId: COLLIDING_ACTION, transforms: insertTransforms(blockId, block), policy: 'c' });
		await repo.commit({ actionId: COLLIDING_ACTION, blockIds: [blockId], tailId: blockId, rev: 1 });
		await storage.saveBlockProof(blockId, 5, makeProof('A'));

		// A second client pends against the (now stale) rev 0 base. `pend` answers with the
		// revisions it missed; each entry must carry the transform that actually landed. The
		// old bug returned `{ inserts: {}, updates: {}, deletes: [] }` for rev 1 — the client
		// was told the revision changed nothing and replayed a history missing a write.
		const stale = await repo.pend({
			actionId: 'tx:later' as ActionId,
			transforms: { inserts: {}, updates: { [blockId]: [['items', 1, 0, ['appended']]] }, deletes: [] },
			policy: 'f',
			rev: 0
		});

		expect(stale.success, 'the stale pend is rejected with a catch-up payload').to.equal(false);
		const missed = stale.success ? [] : (stale.missing ?? []);
		const rev1 = missed.find(m => m.rev === 1);
		expect(rev1, 'rev 1 appears in the catch-up').to.not.equal(undefined);
		expect(rev1?.actionId).to.equal(COLLIDING_ACTION);
		expect(rev1?.transforms.inserts?.[blockId], 'the missed revision carries the real insert, not an empty transform')
			.to.deep.equal(block);
	});

	it('Order B: retaining a proof for rev 5, then committing an action named `~proof:5`, leaves the proof intact', async () => {
		const blockId = 'order-b' as BlockId;
		const block = makeBlock('order-b', { items: ['written'] });

		await storage.saveBlockProof(blockId, 5, makeProof('B'));

		await repo.pend({ actionId: COLLIDING_ACTION, transforms: insertTransforms(blockId, block), policy: 'c' });
		const commit = await repo.commit({ actionId: COLLIDING_ACTION, blockIds: [blockId], tailId: blockId, rev: 1 });
		expect(commit.success).to.equal(true);

		const proof = await storage.getBlockProof(blockId, 5);
		expect(proof, 'the retained proof is not replaced by the client transform').to.not.equal(undefined);
		expect(proof!.messageHash).to.equal('hash-B');
		expect(await storage.getTransaction(blockId, COLLIDING_ACTION), 'and the transform is stored')
			.to.deep.equal({ insert: block });
	});

	it('Order C: a restore archive whose action is named `~proof:5` leaves the proof intact', async () => {
		const blockId = 'order-c' as BlockId;
		const block = makeBlock('order-c', { items: ['from-peer'] });
		const bs = new BlockStorage(blockId, storage);

		await storage.saveBlockProof(blockId, 5, makeProof('C'));

		// `saveReplica` reaches `saveRestored`, which writes a PEER-supplied action id verbatim
		// into both the revisions and transactions stores.
		await withBlockWriteLatch(blockId, l => bs.saveReplica(block, { rev: 1, actionId: COLLIDING_ACTION }, undefined, l));

		const proof = await storage.getBlockProof(blockId, 5);
		expect(proof, 'a peer cannot overwrite a retained proof by naming its old reserved id').to.not.equal(undefined);
		expect(proof!.messageHash).to.equal('hash-C');
	});

	it('a revision record naming `~proof:5` replays as its own transform, not as the proof', async () => {
		// The fourth route, which needs no transactions write at all: `materializeBlock` feeds a
		// REVISION's action id back to `getTransaction` when replaying a revision whose
		// materialization was pruned. A peer-supplied revision record naming `~proof:5` therefore
		// used to read the stored PROOF back as if it were that revision's transform.
		const blockId = 'order-d' as BlockId;
		const v1 = makeBlock('order-d', { items: ['v1'] });
		const v2 = makeBlock('order-d', { items: ['v1', 'v2'] });
		const bs = new BlockStorage(blockId, storage);

		await withBlockWriteLatch(blockId, async l => {
			await bs.saveReplica(v1, { rev: 1, actionId: 'tx:1' as ActionId }, undefined, l);
			await bs.saveReplica(v2, { rev: 2, actionId: COLLIDING_ACTION }, undefined, l);
		});
		await storage.saveBlockProof(blockId, 5, makeProof('D'));

		// Drop rev 2's materialization so the read must replay rev 2's transform onto rev 1's
		// materialization — the exact step that used to consume the proof.
		await storage.saveMaterializedBlock(blockId, COLLIDING_ACTION, undefined);

		const got = await bs.getBlock(2);
		expect(got?.block, 'the revision replays from its own transform').to.deep.equal(v2);
		expect((await storage.getBlockProof(blockId, 5))!.messageHash, 'and the proof is untouched')
			.to.equal('hash-D');
	});
});
