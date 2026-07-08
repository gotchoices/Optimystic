import { expect } from 'chai';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockArchive, BlockMetadata, RestoreCallback } from '../src/storage/struct.js';
import { hashString } from '@optimystic/db-core';
import type { BlockId, ActionId, ActionRev, IBlock, BlockHeader, Transforms } from '@optimystic/db-core';

/**
 * Coverage for the `meta.ranges` honesty invariant: `ranges` must state EXACTLY which
 * revisions this node can locally reconstruct — never more, never fewer. A fresh pend
 * seeds `[]` (nothing committed yet).
 *
 * `getBlock(r)` is served by materializeBlock's DESCENDING walk (highest committed rev
 * <= r), so once a node holds the materialization chain from a block's earliest committed
 * rev E, EVERY rev >= E is serveable locally — a read above the latest resolves to the
 * latest's materialization. So coverage is the OPEN-ENDED span [E, +inf), not a set of the
 * sparse points at which the block was modified, and not a span bounded at the latest rev.
 * Each commit merges into that one open-ended span; only revs BELOW E are genuine gaps.
 *
 * Regression guard for two opposite bugs:
 *   - over-claim: `savePendingTransaction` seeded open-ended `[[0]]`, claiming coverage of
 *     every revision and short-circuiting the `ensureRevision` restore path.
 *   - under-claim: each commit claimed only its own point `[rev, rev+1)`, so `inRanges` went
 *     false for any global rev between/above a block's modified revs — a normal read of a
 *     block not touched by the latest commit then hit restore and threw.
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

	it('commit opens coverage from the earliest committed rev', async () => {
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
		// Open-ended from E=1: a descending walk serves any rev >= 1 (reads above latest resolve to it).
		expect(meta!.ranges, 'coverage open-ended from the earliest committed rev').to.deep.equal([[1]]);
	});

	it('sparse commits extend one contiguous span (the intermediate rev IS reconstructible)', async () => {
		const blockId = 'block-gap' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		// Commit rev 1.
		await repo.pend({
			actionId: 'a1' as ActionId,
			transforms: makeInsertTransforms(blockId, makeBlock('block-gap', { items: [] })),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);

		// Commit rev 3 (skipping rev 2). rev 2 is NOT a gap in coverage: getBlock(2)'s descending
		// walk resolves to rev 1's materialization, so the node CAN serve it — coverage spans it.
		await repo.pend({
			actionId: 'a2' as ActionId,
			transforms: makeUpdateTransforms(blockId, [['items', 0, 0, ['more']]]),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a2' as ActionId, blockIds: [blockId], tailId: blockId, rev: 3 })).success).to.equal(true);

		const meta = await raw.getMetadata(blockId);
		expect(meta!.latest?.rev).to.equal(3);
		// Still one open-ended span from E=1: rev 2 (and everything else >= 1) is serveable.
		expect(meta!.ranges, 'coverage stays open-ended from E=1 across the sparse commit').to.deep.equal([[1]]);
	});

	it('getBlock(intermediateRev) between sparse commits serves the prior materialization (no throw)', async () => {
		const blockId = 'block-intermediate' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		// Modify the block at sparse global revs 1 and 3.
		await repo.pend({
			actionId: 'a1' as ActionId,
			transforms: makeInsertTransforms(blockId, makeBlock('block-intermediate', { items: [] })),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);
		await repo.pend({
			actionId: 'a2' as ActionId,
			transforms: makeUpdateTransforms(blockId, [['items', 0, 0, ['more']]]),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a2' as ActionId, blockIds: [blockId], tailId: blockId, rev: 3 })).success).to.equal(true);

		// Read rev 2 (unmodified) — with NO restoreCallback wired. Under the point-range bug this
		// missed inRanges and threw "revision 2 not found during restore attempt".
		const storage = new BlockStorage(blockId, raw);
		const result = await storage.getBlock(2);
		expect(result, 'rev 2 served, not thrown').to.not.equal(undefined);
		expect(result!.actionRev.rev, 'served from the highest committed rev <= 2 (rev 1)').to.equal(1);
	});

	it('StorageRepo.get for a block unchanged at the collection tip serves its prior state', async () => {
		// Public-API regression guard. Two blocks A and B inserted at rev 1; only A modified at
		// rev 2. Reading B at collection tip rev 2 requests a global rev above B's last-modified
		// rev — under the point-range bug this threw instead of serving B's rev-1 state.
		const aId = 'blk-A' as BlockId;
		const bId = 'blk-B' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

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

		// Modify only A at rev 2.
		await repo.pend({
			actionId: 'a2' as ActionId,
			transforms: makeUpdateTransforms(aId, [['items', 0, 0, ['more']]]),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a2' as ActionId, blockIds: [aId], tailId: aId, rev: 2 })).success).to.equal(true);

		// Read B at the collection tip (rev 2). B was not touched by the rev-2 commit.
		const got = await repo.get({ blockIds: [bId], context: { committed: [], rev: 2 } });
		const bResult = got[bId];
		expect(bResult, 'B present in the result').to.not.equal(undefined);
		expect(bResult!.block?.header.id, 'B served at its prior (rev 1) state').to.equal('blk-B');
	});

	it('genuine gap below the earliest reconstructible rev still misses inRanges', async () => {
		// A block whose ONLY committed rev is 5: earliest reconstructible rev E = 5. A read below E
		// is a genuine gap (nothing at/under the target to descend to) — it must miss inRanges so the
		// restore path fires, confirming the span fix does not over-claim below E.
		const blockId = 'block-highstart' as BlockId;
		const restoreCalls: number[] = [];
		const restoredBlock = makeBlock('block-highstart', { items: ['restored'] });
		const restoreCallback: RestoreCallback = async (id, rev) => {
			restoreCalls.push(rev ?? -1);
			return {
				blockId: id,
				revisions: {
					4: {
						action: { actionId: 'r4' as ActionId, rev: 4, transform: { insert: restoredBlock } },
						block: restoredBlock
					}
				},
				range: [4, 5]
			};
		};
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		// First (and only) commit is at rev 5.
		await repo.pend({
			actionId: 'a5' as ActionId,
			transforms: makeInsertTransforms(blockId, makeBlock('block-highstart', { items: [] })),
			policy: 'c'
		});
		expect((await repo.commit({ actionId: 'a5' as ActionId, blockIds: [blockId], tailId: blockId, rev: 5 })).success).to.equal(true);

		const meta = await raw.getMetadata(blockId);
		expect(meta!.ranges, 'span opens at the earliest committed rev (5), not below').to.deep.equal([[5]]);

		// Reading rev 4 (below E=5) must miss inRanges → restore fires.
		const storage = new BlockStorage(blockId, raw, restoreCallback);
		await storage.getBlock(4);
		expect(restoreCalls, 'restore invoked for the genuine sub-E gap').to.deep.equal([4]);
	});

	it('fresh replica seeds open-ended ranges anchored at rev (not [[0]])', async () => {
		const blockId = 'block-replica-fresh' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		const latest = await storage.saveReplica(makeBlock('block-replica-fresh', { items: [] }), { rev: 1, actionId: 'r1' as ActionId });
		expect(latest.rev).to.equal(1);
		expect(latest.actionId).to.equal('r1');

		const meta = await raw.getMetadata(blockId);
		// Open-ended from E=1 — NOT the pre-fix over-claim [[0]] and NOT a bounded point [[1, 2]].
		expect(meta!.ranges, 'coverage open-ended from the anchor rev').to.deep.equal([[1]]);
		expect(meta!.latest?.rev).to.equal(1);
	});

	it('source-less replica derives rev=1 and a deterministic (idempotent) actionId', async () => {
		const blockId = 'block-replica-idem' as BlockId;
		const storage = new BlockStorage(blockId, raw);
		const block = makeBlock('block-replica-idem', { items: ['x'] });

		const first = await storage.saveReplica(block);
		const second = await storage.saveReplica(block);

		// Re-pushing the same block resolves to the same (rev, actionId) — never a fresh id per retry.
		expect(first.rev).to.equal(1);
		expect(second.rev).to.equal(1);
		expect(first.actionId).to.equal(second.actionId);

		// The fallback id is exactly the SHA-256 over `${blockId}:${JSON.stringify(block)}`.
		const expectedId = await hashString(`${blockId}:${JSON.stringify(block)}`);
		expect(first.actionId, 'deterministic hash fallback unchanged').to.equal(expectedId);

		// The idempotent re-push hit the monotonic guard: ranges untouched (still one open-ended span).
		const meta = await raw.getMetadata(blockId);
		expect(meta!.ranges).to.deep.equal([[1]]);
	});

	it('monotonic guard: a lower-rev replica returns the held latest and leaves metadata untouched', async () => {
		const blockId = 'block-guard-replica' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		// Pre-seed latest at rev 5.
		await storage.saveReplica(makeBlock('block-guard-replica', { items: [] }), { rev: 5, actionId: 'r5' as ActionId });
		const before = await raw.getMetadata(blockId);

		// A stale replica at rev 3: equal-or-newer already held ⇒ return held latest, no rewrite.
		const result = await storage.saveReplica(makeBlock('block-guard-replica', { items: ['stale'] }), { rev: 3, actionId: 'r3' as ActionId });
		expect(result.rev, 'held rev-5 latest returned, no downgrade').to.equal(5);
		expect(result.actionId).to.equal('r5');

		const after = await raw.getMetadata(blockId);
		expect(after, 'metadata untouched by the guarded call').to.deep.equal(before);
	});

	it('monotonic guard: a lower-rev deletion returns the held latest and leaves metadata untouched', async () => {
		const blockId = 'block-guard-deletion' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		// Pre-seed latest at rev 5.
		await storage.saveReplica(makeBlock('block-guard-deletion', { items: [] }), { rev: 5, actionId: 'r5' as ActionId });
		const before = await raw.getMetadata(blockId);

		// A stale deletion at rev 3: same guard as replica ⇒ return held latest, no rewrite.
		const result = await storage.saveDeletion({ rev: 3, actionId: 'd3' as ActionId });
		expect(result.rev, 'held rev-5 latest returned, no downgrade').to.equal(5);
		expect(result.actionId).to.equal('r5');

		const after = await raw.getMetadata(blockId);
		expect(after, 'metadata untouched by the guarded call').to.deep.equal(before);
	});

	it('deletion tombstone reads back as undefined (absent, not thrown)', async () => {
		const blockId = 'block-tombstone' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		// A block present at rev 1, then a forward tombstone at rev 2.
		await storage.saveReplica(makeBlock('block-tombstone', { items: ['live'] }), { rev: 1, actionId: 'r1' as ActionId });
		const latest = await storage.saveDeletion({ rev: 2, actionId: 'd2' as ActionId });
		expect(latest.rev).to.equal(2);

		// getBlock() at the tombstone rev reverse-applies { delete: true } → absent block.
		const atLatest = await storage.getBlock();
		expect(atLatest, 'block absent at the tombstone rev').to.equal(undefined);

		// The prior revision still materializes normally.
		const atRev1 = await storage.getBlock(1);
		expect(atRev1?.block.header.id, 'rev 1 still serves the live block').to.equal('block-tombstone');
	});

	it('saveReplica and saveDeletion are mutually exclusive on one block (shared latch)', async () => {
		// A non-shared (per-method) latch would let the two read-modify-write critical sections
		// interleave, risking a `latest` downgrade. Each save reads metadata exactly once while
		// holding the latch, so under a SHARED latch no two getMetadata reads are ever in flight at
		// once. The probe widens the read window and flags any concurrent entry. The counter is
		// self-balanced within getMetadata, so the guard-skip path (which never calls saveMetadata)
		// cannot leak it.
		class LatchProbeStorage extends MemoryRawStorage {
			private inFlight = 0;
			overlaps = 0;
			override async getMetadata(id: BlockId): Promise<BlockMetadata | undefined> {
				this.inFlight++;
				if (this.inFlight > 1) this.overlaps++;
				try {
					// Real async gap: yields the event loop so a non-shared latch's second read overlaps.
					await new Promise<void>(resolve => setTimeout(resolve, 5));
					return await super.getMetadata(id);
				} finally {
					this.inFlight--;
				}
			}
		}

		const probe = new LatchProbeStorage();
		const blockId = 'block-shared-latch' as BlockId;
		const storage = new BlockStorage(blockId, probe);

		// Fire a replica at rev 2 and a deletion at rev 3 concurrently on the SAME block.
		const [a, b] = await Promise.all([
			storage.saveReplica(makeBlock('block-shared-latch', { items: [] }), { rev: 2, actionId: 'r2' as ActionId }),
			storage.saveDeletion({ rev: 3, actionId: 'd3' as ActionId })
		]) as [ActionRev, ActionRev];

		expect(probe.overlaps, 'critical sections never overlapped (latch is shared)').to.equal(0);
		// Regardless of interleave, the monotonic guard converges latest to the higher rev (3).
		expect(Math.max(a.rev, b.rev)).to.equal(3);
		const meta = await probe.getMetadata(blockId);
		expect(meta!.latest?.rev, 'final latest is the higher rev, no downgrade').to.equal(3);
		expect(meta!.latest?.actionId).to.equal('d3');
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
		expect(after!.ranges, 'recovered revision opens coverage from E=1').to.deep.equal([[1]]);
	});
});
