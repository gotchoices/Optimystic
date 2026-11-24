/**
 * Ticket: a-node-deletes-what-it-released (`docs/arachnode-ring-handoff.md` § Part 2,
 * `packages/db-p2p/docs/storage.md` § Deleting a block).
 *
 * The sweep's **resumability** contract, which spans the two pieces neither of their own tests
 * covers: the ledger entry outlives the delete it records, and `deleteBlock` finishes a delete a
 * crash caught half-done. Nothing else in the system can take a byte off a node, so a restart that
 * forgot one of these would leave bytes nothing serves and nothing reports, for ever.
 *
 * The companion case — that a sweep deletes only what the confirm step counted — lives in
 * `ring-shift-coordinator.spec.ts`, where the handoff harness that produces a rolled-back Phase B
 * already is.
 */

import { expect } from 'chai';
import type { ActionId, BlockId, IBlock, Transform } from '@optimystic/db-core';
import { createLogger } from '../src/logger.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { ReleasedBlockLedger } from '../src/storage/released-block-ledger.js';
import { ReleasedBlockSweep } from '../src/storage/released-block-sweep.js';
import { StorageRepo } from '../src/storage/storage-repo.js';

const BLOCK_ID = 'half-deleted-block' as BlockId;
const REV = 7;
const ACTION_ID = 'a7' as ActionId;

function blockOf(id: BlockId): IBlock {
	return { header: { id, type: 'test', collectionId: 'c' } } as unknown as IBlock;
}

describe('ReleasedBlockSweep — a delete a restart interrupted', () => {
	it('finishes a block whose metadata is already gone but whose records remain, then drops its entry', async () => {
		const raw = new MemoryRawStorage();
		const repo = new StorageRepo(raw);
		const transform: Transform = { insert: blockOf(BLOCK_ID) };

		// The state a crash between the two halves of a delete leaves: content with no metadata. Written
		// through the raw store, which is the only way to reach it — `deleteBlock` takes metadata first and
		// durably, so this is exactly what an interrupted run leaves behind
		// (`packages/db-p2p/docs/storage.md` § Deleting a block).
		await raw.saveRevision(BLOCK_ID, REV, ACTION_ID);
		await raw.saveTransaction(BLOCK_ID, ACTION_ID, transform);
		await raw.saveMaterializedBlock(BLOCK_ID, ACTION_ID, blockOf(BLOCK_ID));
		expect(await raw.getMetadata(BLOCK_ID), 'the interrupted delete took the metadata').to.equal(undefined);

		// The entry that outlived the delete, carrying no revision — the reading for a release whose
		// confirm handed none over, and the one this post-crash state must produce: the metadata the
		// interrupted delete took is exactly what nobody can report a revision from. It must NOT make the
		// sweep decline the block.
		const kv = new MemoryKVStore();
		const ledger = new ReleasedBlockLedger(kv);
		const entries = await ledger.record([BLOCK_ID], 'ring-shift', new Map());
		expect(entries[0]?.releasedRev, 'no revision was handed over, so the entry carries none').to.equal(undefined);

		const sweep = new ReleasedBlockSweep({ ledger, storage: repo, log: createLogger('storage:released') });
		const run = await sweep.sweep();

		expect(run, 'the interrupted delete is finished by one run').to.deep.include({ found: 1, deleted: 1, kept: 0, failed: 0, remaining: 0 });
		expect(await raw.getRevision(BLOCK_ID, REV), 'revision record').to.equal(undefined);
		expect(await raw.getTransaction(BLOCK_ID, ACTION_ID), 'committed transform').to.equal(undefined);
		expect(await raw.getMaterializedBlock(BLOCK_ID, ACTION_ID), 'materialization').to.equal(undefined);
		expect(await ledger.list(), 'the entry is dropped only after the delete it records').to.deep.equal([]);

		// And again, on the state the first run left: the second run finds nothing, because the entry is
		// gone — which is what keeps a released block from being re-offered to the delete for ever.
		expect(await sweep.sweep(), 'a second run has nothing to do').to.deep.include({ found: 0, deleted: 0 });
	});
});
