import { expect } from 'chai';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage, RevisionNotCoveredError } from '../src/storage/block-storage.js';
import { withBlockWriteLatch, type BlockWriteLatch } from '../src/storage/block-latch.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockArchive, BlockMetadata, RestoreCallback, RevisionRange } from '../src/storage/struct.js';
import type { BlockCommitProof } from '../src/cluster/commit-proof.js';
import { makeSignedProof } from './support/commit-proof-fixtures.js';
import { canonicalBlockHash, hashString } from '@optimystic/db-core';
import type {
	BlockId, ActionId, ActionRev, CommitRequest, IBlock, BlockHeader, Transforms
} from '@optimystic/db-core';
import { delay } from '@optimystic/db-core/test';

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
 *     every revision and short-circuiting the `restoreRevision` restore path.
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

		await withBlockWriteLatch(blockId, l =>
			storage.savePendingTransaction('a1' as ActionId, { insert: makeBlock('block-pend') }, l));

		const meta = await raw.getMetadata(blockId);
		expect(meta, 'metadata seeded').to.not.equal(undefined);
		expect(meta!.ranges, 'fresh pend claims no coverage').to.deep.equal([]);
		expect(meta!.latest, 'no committed revision yet').to.equal(undefined);
	});

	it('a healing read for an absent revision fires restoreCallback (restore not short-circuited)', async () => {
		// `getBlock` is LOCAL-ONLY now: it reports the coverage gap and `StorageRepo.get`'s healing
		// helper is what turns that into a latched `restoreRevision` and a re-read. The claim under
		// test is unchanged — a pending-only block claims NO coverage, so the read really does reach
		// the peer instead of being short-circuited by an over-claimed range — but it is asserted
		// where the behaviour now lives, through the public read.
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
		await withBlockWriteLatch(blockId, l =>
			storage.savePendingTransaction('pending' as ActionId, { insert: makeBlock('block-restore') }, l));

		const repo = new StorageRepo((id) => new BlockStorage(id, raw, restoreCallback));
		const result = (await repo.get({ blockIds: [blockId], context: { rev: 1, committed: [] } }))[blockId];

		expect(restoreCalls.length, 'restoreCallback invoked for the absent revision').to.equal(1);
		expect(restoreCalls[0]!.rev).to.equal(1);
		expect(result?.block?.header.id).to.equal('block-restore');
		expect(result?.unavailable, 'a healed read is an authoritative answer').to.equal(undefined);

		// The restored range is now claimed.
		const meta = await raw.getMetadata(blockId);
		expect(meta!.ranges).to.deep.equal([[1, 2]]);
	});

	it('a write latch minted for one block is refused by another block\'s storage, writing nothing', async () => {
		const raw = new MemoryRawStorage();
		const a = 'block-token-a' as BlockId;
		const b = 'block-token-b' as BlockId;
		const storageB = new BlockStorage(b, raw);
		await withBlockWriteLatch(a, async l => {
			expect(l.blockId).to.equal(a);
			let thrown: unknown;
			try {
				await storageB.savePendingTransaction('p' as ActionId, { insert: makeBlock('block-token-b') }, l);
			} catch (err) {
				thrown = err;
			}
			expect(thrown).to.be.instanceOf(Error);
			expect((thrown as Error).message).to.match(/write latch was acquired for block block-token-a/);
		});
		expect(await raw.getMetadata(b), 'nothing was written under the wrong token').to.equal(undefined);
	});

	it('getBlock is local-only: absent, absent, or a coverage gap — never a fetch', async () => {
		// The contract the healing helper is written against. `getBlock` answers only from local
		// records: a block this node never saw is absent, a pending-only block with no rev named is
		// absent, and a named rev outside `meta.ranges` is reported as a gap for the caller to heal.
		// None of the three consults `restoreCallback` — the fetch moved to `restoreRevision`.
		let restores = 0;
		const restoreCallback: RestoreCallback = async () => { restores++; return undefined; };

		const unseen = new BlockStorage('block-unseen' as BlockId, raw, restoreCallback);
		expect(await unseen.getBlock(), 'a never-seen block reads absent').to.equal(undefined);
		expect(await unseen.getBlock(1), 'a never-seen block reads absent at a named rev too').to.equal(undefined);

		const blockId = 'block-local-only' as BlockId;
		const storage = new BlockStorage(blockId, raw, restoreCallback);
		await withBlockWriteLatch(blockId, l =>
			storage.savePendingTransaction('pending' as ActionId, { insert: makeBlock('block-local-only') }, l));
		expect(await storage.getBlock(), 'pending-only with no rev named reads absent').to.equal(undefined);

		let gap: unknown;
		try {
			await storage.getBlock(7);
		} catch (err) {
			gap = err;
		}
		expect(gap, 'an uncovered rev is REPORTED, not healed here').to.be.instanceOf(RevisionNotCoveredError);
		expect((gap as RevisionNotCoveredError).rev, 'the gap names the rev to restore').to.equal(7);
		expect((gap as RevisionNotCoveredError).blockId, 'and the block it is about').to.equal(blockId);

		expect(restores, 'getBlock never consults the restore wire').to.equal(0);
	});

	it('a named rev on a pending-only block with NO restoreCallback reads absent, not a fault', async () => {
		// A brand-new block between pend and commit holds a pending record and no committed
		// revision. Asking for it at a named revision is what a writer reading back its own
		// uncommitted insert does (ActionContext.rev is required). There is no committed base to
		// reconstruct, so the honest answer through the public read is "absent" — it used to be a
		// fault, and StorageRepo.get turned that into `unavailable: 'unmaterializable'`, telling the
		// writer its own pending content was unreadable.
		const blockId = 'block-no-restore' as BlockId;
		const storage = new BlockStorage(blockId, raw);	// no restoreCallback wired
		await withBlockWriteLatch(blockId, l =>
			storage.savePendingTransaction('pending' as ActionId, { insert: makeBlock('block-no-restore') }, l));

		// The local-only contract underneath: the named rev is outside the (empty) ranges, so the
		// direct read reports the gap rather than answering it.
		let direct: unknown;
		try {
			await storage.getBlock(1);
		} catch (err) {
			direct = err;
		}
		expect(direct, 'the direct read reports a coverage gap').to.be.instanceOf(RevisionNotCoveredError);
		expect((direct as RevisionNotCoveredError).rev).to.equal(1);

		// Through the healing read, the restore cannot even be attempted (no callback wired), and a
		// failed restore on a pending-only block reads as ABSENT rather than as a fault.
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));
		const got = (await repo.get({ blockIds: [blockId], context: { rev: 1, committed: [] } }))[blockId];
		expect(got!.block, 'named rev with no committed base ⇒ absent').to.equal(undefined);
		expect(got!.unavailable, 'absent, not unavailable').to.equal(undefined);

		expect(await storage.getBlock(), 'contextless read unchanged').to.equal(undefined);
		expect((await raw.getMetadata(blockId))!.latest, 'still no committed revision').to.equal(undefined);
	});

	it('a named rev on a pending-only block whose restore comes back empty reads absent', async () => {
		// The restore IS attempted (see the 'restore not short-circuited' test above) — it simply
		// cannot supply the revision. That failure means only "no committed base here", so
		// StorageRepo.get's healing helper turns it into an absent answer rather than a fault.
		const blockId = 'block-restore-empty' as BlockId;
		const restoreCalls: number[] = [];
		const restoreCallback: RestoreCallback = async (_id, rev) => {
			restoreCalls.push(rev!);
			return undefined;
		};

		const storage = new BlockStorage(blockId, raw, restoreCallback);
		await withBlockWriteLatch(blockId, l =>
			storage.savePendingTransaction('pending' as ActionId, { insert: makeBlock('block-restore-empty') }, l));

		const repo = new StorageRepo((id) => new BlockStorage(id, raw, restoreCallback));
		const got = (await repo.get({ blockIds: [blockId], context: { rev: 1, committed: [] } }))[blockId];
		expect(got!.block, 'restore supplied nothing ⇒ absent').to.equal(undefined);
		expect(got!.unavailable, 'and authoritatively absent, not a fault').to.equal(undefined);
		expect(restoreCalls, 'the restore was still attempted').to.deep.equal([1]);
	});

	it('a latest pointing at an unmaterializable revision STILL throws (genuine corruption)', async () => {
		// The counterpart the change above must not erode: `latest` is set, so this node holds
		// records claiming a committed revision it cannot reconstruct (truncated history). That is
		// a fault, not an absence, and StorageRepo.get depends on the throw to flag the block
		// `unavailable: 'unmaterializable'` instead of posing as an authoritative "never existed".
		const blockId = 'block-wedged' as BlockId;
		await raw.saveMetadata(blockId, { latest: { rev: 3, actionId: 'ghost' as ActionId }, ranges: [[3]] });
		const storage = new BlockStorage(blockId, raw);

		let contextlessError: unknown;
		try {
			await storage.getBlock();
		} catch (err) {
			contextlessError = err;
		}
		expect((contextlessError as Error)?.message, 'contextless read of a wedged block throws')
			.to.contain('Failed to find materialized block');

		let pinnedError: unknown;
		try {
			await storage.getBlock(3);
		} catch (err) {
			pinnedError = err;
		}
		expect((pinnedError as Error)?.message, 'pinned read of a wedged block throws too')
			.to.contain('Failed to find materialized block');
	});

	it('a pending-only block whose restore supplies revisions but no materialization is a fault', async () => {
		// The narrow seam inside the healing helper's pending-only arm: only a FAILED
		// `restoreRevision` means "no committed base here". Once the restore SUCCEEDS, revision
		// records exist — and if nothing under them is materialized, that is genuine corruption, so
		// the re-read's throw must propagate as `unavailable` rather than being flattened into an
		// absent answer.
		const blockId = 'block-restore-hollow' as BlockId;
		const restoreCallback: RestoreCallback = async (id) => ({
			blockId: id,
			revisions: {
				// Transform + revision entry, but NO `block` — nothing materialized anywhere below.
				1: { action: { actionId: 'hollow-action' as ActionId, rev: 1, transform: { updates: [] } } }
			},
			range: [1, 2]
		});

		const storage = new BlockStorage(blockId, raw, restoreCallback);
		await withBlockWriteLatch(blockId, l =>
			storage.savePendingTransaction('pending' as ActionId, { insert: makeBlock('block-restore-hollow') }, l));

		const repo = new StorageRepo((id) => new BlockStorage(id, raw, restoreCallback));
		const got = (await repo.get({ blockIds: [blockId], context: { rev: 1, committed: [] } }))[blockId];
		expect(got!.block, 'nothing served').to.equal(undefined);
		expect(got!.unavailable, 'restored records with no materialization is a fault, not an absence')
			.to.equal('unmaterializable');

		// The restore itself landed its coverage — the fault is strictly downstream of it, which is
		// what separates this case from the empty-restore one above.
		expect((await raw.getMetadata(blockId))!.ranges, 'the successful restore recorded its span')
			.to.deep.equal([[1, 2]]);
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

		// Reading rev 4 (below E=5) must miss inRanges → the read reports the gap, and the restore
		// a healing caller then runs fetches exactly that rev.
		const storage = new BlockStorage(blockId, raw, restoreCallback);
		let gap: unknown;
		try {
			await storage.getBlock(4);
		} catch (err) {
			gap = err;
		}
		expect(gap, 'the sub-E read is a coverage gap').to.be.instanceOf(RevisionNotCoveredError);
		expect((gap as RevisionNotCoveredError).rev).to.equal(4);
		await withBlockWriteLatch(blockId, l => storage.restoreRevision(4, l));
		expect(restoreCalls, 'restore invoked for the genuine sub-E gap').to.deep.equal([4]);
	});

	it('fresh replica seeds open-ended ranges anchored at rev (not [[0]])', async () => {
		const blockId = 'block-replica-fresh' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		const latest = await withBlockWriteLatch(blockId, l =>
			storage.saveReplica(makeBlock('block-replica-fresh', { items: [] }), { rev: 1, actionId: 'r1' as ActionId }, undefined, l));
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

		const [first, second] = await withBlockWriteLatch(blockId, async (l) => {
			const a = await storage.saveReplica(block, undefined, undefined, l);
			const b = await storage.saveReplica(block, undefined, undefined, l);
			return [a, b] as const;
		});

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
		await withBlockWriteLatch(blockId, l =>
			storage.saveReplica(makeBlock('block-guard-replica', { items: [] }), { rev: 5, actionId: 'r5' as ActionId }, undefined, l));
		const before = await raw.getMetadata(blockId);

		// A stale replica at rev 3: equal-or-newer already held ⇒ return held latest, no rewrite.
		const result = await withBlockWriteLatch(blockId, l =>
			storage.saveReplica(makeBlock('block-guard-replica', { items: ['stale'] }), { rev: 3, actionId: 'r3' as ActionId }, undefined, l));
		expect(result.rev, 'held rev-5 latest returned, no downgrade').to.equal(5);
		expect(result.actionId).to.equal('r5');

		const after = await raw.getMetadata(blockId);
		expect(after, 'metadata untouched by the guarded call').to.deep.equal(before);
	});

	it('monotonic guard: a lower-rev deletion returns the held latest and leaves metadata untouched', async () => {
		const blockId = 'block-guard-deletion' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		// Pre-seed latest at rev 5.
		await withBlockWriteLatch(blockId, l =>
			storage.saveReplica(makeBlock('block-guard-deletion', { items: [] }), { rev: 5, actionId: 'r5' as ActionId }, undefined, l));
		const before = await raw.getMetadata(blockId);

		// A stale deletion at rev 3: same guard as replica ⇒ return held latest, no rewrite.
		const result = await withBlockWriteLatch(blockId, l =>
			storage.saveDeletion({ rev: 3, actionId: 'd3' as ActionId }, l));
		expect(result.rev, 'held rev-5 latest returned, no downgrade').to.equal(5);
		expect(result.actionId).to.equal('r5');

		const after = await raw.getMetadata(blockId);
		expect(after, 'metadata untouched by the guarded call').to.deep.equal(before);
	});

	it('deletion tombstone reads back as undefined (absent, not thrown)', async () => {
		const blockId = 'block-tombstone' as BlockId;
		const storage = new BlockStorage(blockId, raw);

		// A block present at rev 1, then a forward tombstone at rev 2.
		const latest = await withBlockWriteLatch(blockId, async (l) => {
			await storage.saveReplica(makeBlock('block-tombstone', { items: ['live'] }), { rev: 1, actionId: 'r1' as ActionId }, undefined, l);
			return await storage.saveDeletion({ rev: 2, actionId: 'd2' as ActionId }, l);
		});
		expect(latest.rev).to.equal(2);

		// getBlock() at the tombstone rev reverse-applies { delete: true } → absent block.
		const atLatest = await storage.getBlock();
		expect(atLatest, 'block absent at the tombstone rev').to.equal(undefined);

		// The prior revision still materializes normally.
		const atRev1 = await storage.getBlock(1);
		expect(atRev1?.block.header.id, 'rev 1 still serves the live block').to.equal('block-tombstone');
	});

	it('two write-latch scopes on one block never overlap', async () => {
		// "One block, one write lock." Writers no longer take a latch each — they are handed a token
		// by the ONE scope their caller opened, so mutual exclusion is a property of the scope, not
		// of any pair of methods. What must hold is that a second scope on the same block cannot
		// enter while the first still holds it, however long the first takes: that window is exactly
		// where a read-modify-write of the metadata blob would be silently undone.
		//
		// The probe from the per-method-latch era is kept as a second, independent witness: it
		// widens every metadata read and flags any concurrent entry, so a leaked overlap shows up
		// even if the ordering assertions happened to line up. The counter is self-balanced within
		// getMetadata, so the monotonic guard-skip path (which never calls saveMetadata) cannot leak it.
		class LatchProbeStorage extends MemoryRawStorage {
			private inFlight = 0;
			overlaps = 0;
			override async getMetadata(id: BlockId): Promise<BlockMetadata | undefined> {
				this.inFlight++;
				if (this.inFlight > 1) this.overlaps++;
				try {
					// Real async gap: yields the event loop so an unserialized second read would overlap.
					// NOTE: deliberate concurrency-window widener, NOT a settle wait — it manufactures the
					// overlap that exposes a missing latch; there is no observable state to condition-poll on.
					await delay(5);
					return await super.getMetadata(id);
				} finally {
					this.inFlight--;
				}
			}
		}

		const probe = new LatchProbeStorage();
		const blockId = 'block-shared-latch' as BlockId;
		const storage = new BlockStorage(blockId, probe);

		const order: string[] = [];
		let entered2 = false;
		let release!: () => void;
		const held = new Promise<void>(r => { release = r; });
		let signalEntered1!: () => void;
		const entered1 = new Promise<void>(r => { signalEntered1 = r; });

		// Scope 1 enters and then PAUSES while still holding the latch.
		const first = withBlockWriteLatch(blockId, async (l) => {
			order.push('enter-1');
			signalEntered1();
			await held;
			await storage.saveReplica(makeBlock('block-shared-latch', { items: [] }), { rev: 2, actionId: 'r2' as ActionId }, undefined, l);
			order.push('exit-1');
		});
		await entered1;

		// Scope 2 is requested on the SAME block while scope 1 is parked inside.
		const second = withBlockWriteLatch(blockId, async (l) => {
			order.push('enter-2');
			entered2 = true;
			await storage.saveDeletion({ rev: 3, actionId: 'd3' as ActionId }, l);
			order.push('exit-2');
		});
		// NOTE: the only way to observe "did NOT enter" is to give it a real chance to; there is no
		// state that flips on non-entry to condition-poll on.
		await delay(10);
		expect(entered2, 'the second scope must queue behind the first, not enter it').to.equal(false);

		release();
		await Promise.all([first, second]);

		expect(order, 'the scopes ran strictly one after the other')
			.to.deep.equal(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
		expect(probe.overlaps, 'no two metadata read-modify-writes were ever in flight at once').to.equal(0);

		const meta = await probe.getMetadata(blockId);
		expect(meta!.latest?.rev, 'final latest is the higher rev, no downgrade').to.equal(3);
		expect(meta!.latest?.actionId).to.equal('d3');
	});

	/**
	 * Invariant P: a block never holds a pending record and a committed record for the same action id.
	 * `promotePendingTransaction` maintains it on the commit path by MOVING the record; the forward
	 * write paths (`saveReplica` / `saveDeletion`) write the committed transform directly, so they must
	 * delete the pending twin themselves. A record left beside the committed one can never be promoted
	 * (`latest` is already at/past its rev) and `StorageRepo.pend` reports it as a phantom conflicting
	 * action on every later write to the block.
	 */
	describe('Invariant P on the forward write paths', () => {
		it('saveReplica clears the pending record for the same action id', async () => {
			const blockId = 'block-invariant-p-replica' as BlockId;
			const storage = new BlockStorage(blockId, raw);
			const actionId = 'a-diverged' as ActionId;
			const block = makeBlock('block-invariant-p-replica', { items: [] });

			// This node pended the action but diverged before committing it.
			await withBlockWriteLatch(blockId, l => storage.savePendingTransaction(actionId, { insert: block }, l));
			expect(await storage.getPendingTransaction(actionId), 'pended here').to.not.equal(undefined);

			// The reconcile path supplies the committed revision for the SAME action.
			await withBlockWriteLatch(blockId, l => storage.saveReplica(block, { rev: 2, actionId }, undefined, l));

			expect(await storage.getLatest(), 'revision landed').to.deep.equal({ rev: 2, actionId });
			expect(await storage.getPendingTransaction(actionId), 'pending twin removed').to.equal(undefined);
			expect(await storage.getTransaction(actionId), 'committed record present').to.not.equal(undefined);
		});

		it('a later fail-on-pending write is accepted after the replica lands', async () => {
			// The user-visible consequence: without the deletion the node refuses every later
			// `policy: 'f'` write to this block, forever.
			const blockId = 'block-invariant-p-repo' as BlockId;
			const repo = new StorageRepo((id) => new BlockStorage(id, raw));
			const block = makeBlock('block-invariant-p-repo', { items: [] });

			await repo.pend({ actionId: 'a-diverged' as ActionId, transforms: makeInsertTransforms(blockId, block), policy: 'c' });
			await repo.saveReplicatedBlock(blockId, block, { rev: 2, actionId: 'a-diverged' as ActionId });

			const later = await repo.pend({
				actionId: 'a-later' as ActionId,
				transforms: makeUpdateTransforms(blockId, [['items', 0, 0, ['y']]]),
				policy: 'f'
			});
			expect(later.success, 'no phantom conflicting action may remain').to.equal(true);
		});

		it('saveDeletion clears the pending record for the same action id', async () => {
			const blockId = 'block-invariant-p-deletion' as BlockId;
			const storage = new BlockStorage(blockId, raw);
			const actionId = 'a-del' as ActionId;

			await withBlockWriteLatch(blockId, async (l) => {
				await storage.saveReplica(makeBlock('block-invariant-p-deletion', { items: ['live'] }), { rev: 1, actionId: 'r1' as ActionId }, undefined, l);
				await storage.savePendingTransaction(actionId, { delete: true }, l);
			});
			expect(await storage.getPendingTransaction(actionId), 'delete pended here').to.not.equal(undefined);

			await withBlockWriteLatch(blockId, l => storage.saveDeletion({ rev: 2, actionId }, l));

			expect((await storage.getLatest())?.rev, 'tombstone landed').to.equal(2);
			expect(await storage.getPendingTransaction(actionId), 'pending twin removed').to.equal(undefined);
		});

		it('leaves an unrelated action’s pending alone on the write path', async () => {
			// The deletion is scoped to the landing revision's action id, NOT a per-block clear: a
			// genuinely in-flight pend for a different action must survive a replica landing beneath
			// it. Guards the tripwire at the deletion site against being widened into a blind sweep.
			const blockId = 'block-invariant-p-scoped' as BlockId;
			const storage = new BlockStorage(blockId, raw);

			await withBlockWriteLatch(blockId, async (l) => {
				await storage.savePendingTransaction('a-inflight' as ActionId, { updates: [['items', 0, 0, ['x']]] }, l);
				await storage.saveReplica(makeBlock('block-invariant-p-scoped', { items: [] }), { rev: 2, actionId: 'a-land' as ActionId }, undefined, l);
			});

			expect((await storage.getLatest())?.rev, 'the replica landed').to.equal(2);
			expect(await storage.getPendingTransaction('a-inflight' as ActionId),
				'a different action’s pend is still in flight').to.not.equal(undefined);
		});

		it('the monotonic no-op deletes nothing (it wrote nothing)', async () => {
			// The guard returns before any committed record is written, so it owes no deletion — the
			// earlier call that wrote the revision is the one that owed it. A pending at a LOWER rev
			// stays a legitimate in-flight write here.
			const blockId = 'block-invariant-p-noop' as BlockId;
			const storage = new BlockStorage(blockId, raw);
			const actionId = 'a-inflight' as ActionId;

			await withBlockWriteLatch(blockId, async (l) => {
				await storage.saveReplica(makeBlock('block-invariant-p-noop', { items: [] }), { rev: 5, actionId: 'r5' as ActionId }, undefined, l);
				await storage.savePendingTransaction(actionId, { updates: [['items', 0, 0, ['x']]] }, l);
			});
			const before = await raw.getMetadata(blockId);

			// rev 3 <= held rev 5 ⇒ monotonic guard fires, nothing is written.
			const result = await withBlockWriteLatch(blockId, l =>
				storage.saveReplica(makeBlock('block-invariant-p-noop', { items: ['stale'] }), { rev: 3, actionId }, undefined, l));
			expect(result.rev, 'held latest returned').to.equal(5);

			expect(await storage.getPendingTransaction(actionId), 'guarded call must not delete').to.not.equal(undefined);
			expect(await raw.getMetadata(blockId), 'metadata untouched').to.deep.equal(before);
		});
	});

	it('recover merges the recovered span into ranges', async () => {
		const blockId = 'block-recover' as BlockId;
		const actionId = 'a1' as ActionId;
		const storage = new BlockStorage(blockId, raw);

		// Reproduce a Crash-D3 raw state: revision durable + action in committed log,
		// but setLatest (and its range merge) was lost — latest undefined, ranges [].
		const block = makeBlock('block-recover', { items: [] });
		await withBlockWriteLatch(blockId, async (l) => {
			await storage.savePendingTransaction(actionId, { insert: block }, l);
			await storage.saveMaterializedBlock(actionId, block, l);
			await storage.saveRevision(1, actionId, l);
			await storage.promotePendingTransaction(actionId, l);
			// NOTE: setLatest deliberately skipped — the lost write recover() exists to redo.
		});

		const before = await raw.getMetadata(blockId);
		expect(before!.latest, 'latest lost pre-recovery').to.equal(undefined);
		expect(before!.ranges, 'no coverage claimed pre-recovery').to.deep.equal([]);

		const result = await withBlockWriteLatch(blockId, l => storage.recover(l));
		expect(result.reconciled).to.equal(true);
		expect(result.latest?.rev).to.equal(1);

		const after = await raw.getMetadata(blockId);
		expect(after!.latest?.rev).to.equal(1);
		expect(after!.ranges, 'recovered revision opens coverage from E=1').to.deep.equal([[1]]);
	});
});

/**
 * Coverage for the restore TRUST BOUNDARY. `restoreRevision` fills a gap in local revision history
 * by asking a peer, over a wire that verifies nothing — `RestorationCoordinator.queryPeer` returns
 * the response's archive straight through — and `saveRestored` writes keyed by revision number and
 * by action id. So an archive naming a revision or action id this node already holds would
 * otherwise overwrite content that was never in question. Every archive off that wire is vetted
 * before a byte of it is written; a refused archive is indistinguishable from an absent one (same
 * "not found during restore attempt" throw), because both mean this node still cannot serve the rev.
 *
 * The two directions that must BOTH hold:
 *   - reject the wrong answer — an archive entirely above the pin, a range that contradicts the
 *     revisions carried, or content that disagrees with what is already held;
 *   - accept the RIGHT answer, which is routinely a LOWER revision than the pin. `ActionContext.rev`
 *     is a collection-wide revision, so a pin at 9 for a block whose last commit was rev 2 is
 *     correctly answered with rev 2 labelled as rev 2 (see `block-archive-proof.spec.ts`). A guard
 *     that demanded the pin's exact revision would turn working historical reads into hard failures.
 */
describe('BlockStorage restore archive vetting', () => {
	let raw: MemoryRawStorage;

	beforeEach(() => {
		raw = new MemoryRawStorage();
	});

	/**
	 * Commit `block` as this block's FIRST revision, at global rev `rev`. Coverage then opens at
	 * E = rev, so every read BELOW it is a genuine gap — which is what fires the restore path.
	 */
	const seedAtRev = async (blockId: BlockId, actionId: ActionId, rev: number, block: IBlock) => {
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));
		await repo.pend({ actionId, transforms: makeInsertTransforms(blockId, block), policy: 'c' });
		expect((await repo.commit({ actionId, blockIds: [blockId], tailId: blockId, rev })).success).to.equal(true);
	};

	const itemsOf = (block: IBlock) => (block as unknown as { items: unknown[] }).items;

	/**
	 * The refusal now surfaces from `restoreRevision` (called under the block's write latch), not from
	 * `getBlock` — which is local-only and would only report the coverage gap that PROMPTS the
	 * restore. Same throw, same message, one layer down.
	 */
	const expectRestoreRefused = async (blockId: BlockId, storage: BlockStorage, rev: number, why: string) => {
		let error: unknown;
		try {
			await withBlockWriteLatch(blockId, l => storage.restoreRevision(rev, l));
		} catch (err) {
			error = err;
		}
		expect((error as Error)?.message, why).to.contain('not found during restore attempt');
	};

	it('refuses an archive whose revisions all sit ABOVE the pin (the mislabel that overwrote good data)', async () => {
		// The ticket's reproduction, minus the producer `serve-pinned-revision-honestly` removed: a
		// peer asked for rev 1 while holding rev 2 answers with rev 1's bytes filed under rev 2's
		// number and action id. Keyed by action id, `saveRestored` used to write that over the
		// asker's own good rev 2 — and rev 1, the thing actually requested, was still not recorded
		// as held, so every later read repeated the fetch and the overwrite.
		const blockId = 'restore-mislabel' as BlockId;
		await seedAtRev(blockId, 'a2' as ActionId, 2, makeBlock('restore-mislabel', { items: ['TWO'] }));

		const older = makeBlock('restore-mislabel', { items: ['ONE'] });
		let restores = 0;
		const restoreCallback: RestoreCallback = async (id) => {
			restores++;
			return {
				blockId: id,
				revisions: {
					2: { action: { actionId: 'a2' as ActionId, rev: 2, transform: { insert: older } }, block: older }
				},
				range: [2, 3]
			};
		};

		const before = structuredClone((await raw.getMetadata(blockId))!);
		const storage = new BlockStorage(blockId, raw, restoreCallback);

		await expectRestoreRefused(blockId, storage, 1, 'the wrong answer fails loudly, exactly as an absent one does');
		expect(restores, 'the fetch WAS made — the refusal is on the answer, not on asking').to.equal(1);
		expect(await raw.getMetadata(blockId), 'metadata untouched by the refusal').to.deep.equal(before);

		const held = await storage.getBlock(2);
		expect(itemsOf(held!.block), 'the held rev 2 still reads back its OWN content').to.deep.equal(['TWO']);
		expect(held!.actionRev, 'the held rev 2 still names its own action').to.deep.equal({ rev: 2, actionId: 'a2' });
	});

	it('accepts a LOWER revision for a collection-wide pin, and records coverage that stops the re-fetch', async () => {
		// The everyday shape: the collection is at rev 9, this block last changed at rev 2, and the
		// peer correctly serves rev 2 labelled as itself in a range of [2, 3). Two claims here —
		// that the answer is accepted at all, and that the coverage recorded for it includes the PIN,
		// without which `inRanges(9, ...)` stays false and every later read at rev 9 re-runs the
		// whole restore: another round trip and another write, forever.
		const blockId = 'restore-lowpin' as BlockId;
		await seedAtRev(blockId, 'u20' as ActionId, 20, makeBlock('restore-lowpin', { items: ['local'] }));

		const low = makeBlock('restore-lowpin', { items: ['rev2'] });
		const pins: number[] = [];
		const restoreCallback: RestoreCallback = async (id, rev) => {
			pins.push(rev ?? -1);
			return {
				blockId: id,
				revisions: {
					2: { action: { actionId: 'low2' as ActionId, rev: 2, transform: { insert: low } }, block: low }
				},
				range: [2, 3]
			};
		};

		const storage = new BlockStorage(blockId, raw, restoreCallback);
		await withBlockWriteLatch(blockId, l => storage.restoreRevision(9, l));
		const got = await storage.getBlock(9);
		expect(itemsOf(got!.block), "rev 9 served from the block's own rev 2").to.deep.equal(['rev2']);
		expect(got!.actionRev, 'served as the revision it actually is').to.deep.equal({ rev: 2, actionId: 'low2' });

		// [2, 3) extended to the pin — NOT the declared range verbatim, and not open-ended either.
		const meta = await raw.getMetadata(blockId);
		expect(meta!.ranges, 'coverage spans the archive floor up to the pin').to.deep.equal([[2, 10], [20]]);

		// Convergence, stated against the two halves the local-only split created: a later read at the
		// same pin is served locally (no coverage gap to report, so no healing caller is woken), and a
		// restore attempted anyway short-circuits on the recorded coverage without re-asking a peer.
		await storage.getBlock(9);
		await withBlockWriteLatch(blockId, l => storage.restoreRevision(9, l));
		expect(pins, 'the restore converged: it ran once, not once per read').to.deep.equal([9]);
	});

	it('a correct restore at the pin itself still succeeds and still merges its range', async () => {
		const blockId = 'restore-exact' as BlockId;
		await seedAtRev(blockId, 'u10' as ActionId, 10, makeBlock('restore-exact', { items: ['local'] }));

		const low = makeBlock('restore-exact', { items: ['rev4'] });
		const restoreCallback: RestoreCallback = async (id) => ({
			blockId: id,
			revisions: {
				4: { action: { actionId: 'low4' as ActionId, rev: 4, transform: { insert: low } }, block: low }
			},
			range: [4, 5]
		});

		const storage = new BlockStorage(blockId, raw, restoreCallback);
		await withBlockWriteLatch(blockId, l => storage.restoreRevision(4, l));
		expect(itemsOf((await storage.getBlock(4))!.block)).to.deep.equal(['rev4']);
		expect((await raw.getMetadata(blockId))!.ranges, 'restored span merged alongside the local one')
			.to.deep.equal([[4, 5], [10]]);
		expect(await raw.getRevision(blockId, 4), 'the revision record landed').to.equal('low4');
	});

	it('revisions volunteered ABOVE the pin are written but do not widen the recorded coverage', async () => {
		// A peer may honestly serve a contiguous span that overruns the pin, and those entries are
		// kept. What it may NOT do is set the width of its own credibility: if coverage followed the
		// archive's highest revision, padding it with fabricated high revisions would buy a silent
		// no-re-ask window over the whole padded span, and reads inside it would be answered from the
		// peer's floor content without ever consulting anyone else.
		const blockId = 'restore-overshoot' as BlockId;
		await seedAtRev(blockId, 'u20' as ActionId, 20, makeBlock('restore-overshoot', { items: ['local'] }));

		const low = makeBlock('restore-overshoot', { items: ['rev4'] });
		const padding = makeBlock('restore-overshoot', { items: ['fabricated'] });
		const pins: number[] = [];
		const restoreCallback: RestoreCallback = async (id, rev) => {
			pins.push(rev ?? -1);
			return {
				blockId: id,
				revisions: {
					4: { action: { actionId: 'low4' as ActionId, rev: 4, transform: { insert: low } }, block: low },
					30: { action: { actionId: 'pad30' as ActionId, rev: 30, transform: { insert: padding } }, block: padding }
				},
				range: [4, 31]
			};
		};

		const storage = new BlockStorage(blockId, raw, restoreCallback);
		await withBlockWriteLatch(blockId, l => storage.restoreRevision(4, l));
		expect(itemsOf((await storage.getBlock(4))!.block), 'the pinned rev is served').to.deep.equal(['rev4']);
		expect((await raw.getMetadata(blockId))!.ranges, 'coverage stops at the pin, not at the archive tip')
			.to.deep.equal([[4, 5], [20]]);
		expect(await raw.getRevision(blockId, 30), 'the overshooting entry is still WRITTEN, just not claimed')
			.to.equal('pad30');

		// The un-claimed span still costs a fetch rather than being answered locally on the peer's word:
		// a read at rev 10 reports a coverage gap (not served from the padding), and the restore that
		// heals it goes back to the peer instead of short-circuiting.
		let padded: unknown;
		try {
			await storage.getBlock(10);
		} catch (err) {
			padded = err;
		}
		expect(padded, 'the padded span is NOT claimed as coverage').to.be.instanceOf(RevisionNotCoveredError);
		await withBlockWriteLatch(blockId, l => storage.restoreRevision(10, l));
		expect(itemsOf((await storage.getBlock(10))!.block)).to.deep.equal(['rev4']);
		expect(pins, 'a read inside the padded span re-asks instead of trusting the padding').to.deep.equal([4, 10]);
		expect((await raw.getMetadata(blockId))!.ranges, 'and converges on the span actually asked about')
			.to.deep.equal([[4, 11], [20]]);
	});

	it('refuses an archive that files two entries under one revision via a second spelling of the key', async () => {
		// `saveRestored` re-derives each revision number with its own `Number(key)`, so "4" and "04"
		// collapse to the same revision on the way in. Whichever entry `Object.entries` yields last
		// wins the write — a choice no check ever made — so the archive is refused outright.
		const blockId = 'restore-alias' as BlockId;
		await seedAtRev(blockId, 'u10' as ActionId, 10, makeBlock('restore-alias', { items: ['local'] }));

		const low = makeBlock('restore-alias', { items: ['low'] });
		const shadow = makeBlock('restore-alias', { items: ['shadow'] });
		const storage = new BlockStorage(blockId, raw, async (id) => ({
			blockId: id,
			revisions: {
				4: { action: { actionId: 'low4' as ActionId, rev: 4, transform: { insert: low } }, block: low },
				['04' as unknown as number]: { action: { actionId: 'shadow4' as ActionId, transform: { insert: shadow } }, block: shadow }
			},
			range: [4, 5]
		}));

		await expectRestoreRefused(blockId, storage, 4, 'a revision key with two spellings is not a revision key');
		expect(await raw.getRevision(blockId, 4), 'neither entry landed').to.equal(undefined);
	});

	it('refuses an archive whose declared range disagrees with the revisions it carries', async () => {
		const blockId = 'restore-badrange' as BlockId;
		await seedAtRev(blockId, 'u10' as ActionId, 10, makeBlock('restore-badrange', { items: ['local'] }));

		const low = makeBlock('restore-badrange', { items: ['low'] });
		const servingRange = (range: RevisionRange): RestoreCallback => async (id) => ({
			blockId: id,
			revisions: {
				4: { action: { actionId: 'low4' as ActionId, rev: 4, transform: { insert: low } }, block: low }
			},
			range
		});

		const before = structuredClone((await raw.getMetadata(blockId))!);
		const cases: [RevisionRange, string][] = [
			[[3, 5], 'a floor below the revisions carried — nothing to descend to at rev 3'],
			[[4, 4], 'a range that ends at or below its own highest revision'],
			[[4], 'an open-ended range, which would claim infinite coverage on one unverified say-so']
		];
		for (const [range, why] of cases) {
			await expectRestoreRefused(blockId, new BlockStorage(blockId, raw, servingRange(range)), 4, why);
		}

		expect(await raw.getMetadata(blockId), 'nothing written by any of the refusals').to.deep.equal(before);
		expect(await raw.getRevision(blockId, 4), 'no revision record landed').to.equal(undefined);
		expect(await raw.getTransaction(blockId, 'low4' as ActionId), 'no transform landed').to.equal(undefined);
	});

	it('refuses a malformed archive: a non-revision key, a missing action, a self-contradicting entry, or another block', async () => {
		const blockId = 'restore-malformed' as BlockId;
		await seedAtRev(blockId, 'u10' as ActionId, 10, makeBlock('restore-malformed', { items: ['local'] }));

		const low = makeBlock('restore-malformed', { items: ['low'] });
		const goodEntry = { action: { actionId: 'low4' as ActionId, rev: 4, transform: { insert: low } }, block: low };
		const before = structuredClone((await raw.getMetadata(blockId))!);

		const cases: [BlockArchive, string][] = [
			[{
				blockId: 'some-other-block' as BlockId,
				revisions: { 4: goodEntry },
				range: [4, 5]
			}, "an answer about a different block, which would land as THIS block's history"],
			[{
				blockId,
				// A JSON key that is not a number coerces to NaN and would be stored as a garbage rev.
				revisions: { ['not-a-rev' as unknown as number]: goodEntry },
				range: [4, 5]
			}, 'a revision key that is not a revision'],
			[{
				blockId,
				revisions: { 4: {} as unknown as BlockArchive['revisions'][number] },
				range: [4, 5]
			}, 'an entry carrying no action'],
			[{
				blockId,
				// The entry's own rev contradicts the key it is filed under — the mislabel, in miniature.
				revisions: { 4: { ...goodEntry, action: { ...goodEntry.action, rev: 7 } } },
				range: [4, 5]
			}, 'an entry whose declared rev disagrees with its key'],
			[{ blockId, revisions: {}, range: [4, 5] }, 'an archive carrying no revisions at all']
		];

		for (const [archive, why] of cases) {
			const storage = new BlockStorage(blockId, raw, async () => archive);
			await expectRestoreRefused(blockId, storage, 4, why);
		}

		expect(await raw.getMetadata(blockId), 'nothing written by any of the refusals').to.deep.equal(before);
		expect(await raw.getRevision(blockId, 4), 'no revision record landed').to.equal(undefined);
	});

	describe('never overwrites content this node already holds', () => {
		const blockId = 'restore-collide' as BlockId;
		const low5 = makeBlock('restore-collide', { items: ['rev5'] });
		const low3 = makeBlock('restore-collide', { items: ['rev3'] });

		/** Seed an upper range at E=10 and restore rev 5 into a lower range, so rev 5 IS held. */
		const seedHoldingRev5 = async () => {
			await seedAtRev(blockId, 'u10' as ActionId, 10, makeBlock('restore-collide', { items: ['local'] }));
			const first: RestoreCallback = async (id) => ({
				blockId: id,
				revisions: {
					5: { action: { actionId: 'low5' as ActionId, rev: 5, transform: { insert: low5 } }, block: low5 }
				},
				range: [5, 6]
			});
			const seeder = new BlockStorage(blockId, raw, first);
			await withBlockWriteLatch(blockId, l => seeder.restoreRevision(5, l));
			expect(itemsOf((await seeder.getBlock(5))!.block)).to.deep.equal(['rev5']);
		};

		/** An archive answering a rev-3 pin that ALSO re-states rev 5, with `rev5Entry`'s content. */
		const alsoRestating5 = (rev5Entry: BlockArchive['revisions'][number]): RestoreCallback => async (id) => ({
			blockId: id,
			revisions: {
				3: { action: { actionId: 'low3' as ActionId, rev: 3, transform: { insert: low3 } }, block: low3 },
				5: rev5Entry
			},
			range: [3, 6]
		});

		it('refuses the WHOLE archive when it renames a held revision to another action id', async () => {
			await seedHoldingRev5();
			const before = structuredClone((await raw.getMetadata(blockId))!);

			const storage = new BlockStorage(blockId, raw, alsoRestating5({
				action: { actionId: 'imposter' as ActionId, rev: 5, transform: { insert: low3 } }, block: low3
			}));
			await expectRestoreRefused(blockId, storage, 3, 'rev 5 is already held under a different action id');

			// All-or-nothing: the entry this node LACKED (rev 3) is not landed either.
			expect(await raw.getMetadata(blockId), 'metadata untouched').to.deep.equal(before);
			expect(await raw.getRevision(blockId, 3), 'the innocent-looking entry is refused with the rest').to.equal(undefined);
			expect(await raw.getRevision(blockId, 5), 'the held revision keeps its own action').to.equal('low5');
		});

		it('refuses the WHOLE archive when it re-materializes a held action with different content', async () => {
			await seedHoldingRev5();
			const before = structuredClone((await raw.getMetadata(blockId))!);

			// Same (rev, actionId) as what is held — only the bytes differ. This is the pairing that
			// `saveMaterializedBlock`, keyed by action id, would silently write over.
			const rewritten = makeBlock('restore-collide', { items: ['REWRITTEN'] });
			const storage = new BlockStorage(blockId, raw, alsoRestating5({
				action: { actionId: 'low5' as ActionId, rev: 5, transform: { insert: rewritten } }, block: rewritten
			}));
			await expectRestoreRefused(blockId, storage, 3, 'action low5 is already held with different content');

			expect(await raw.getMetadata(blockId), 'metadata untouched').to.deep.equal(before);
			expect(await raw.getRevision(blockId, 3), 'nothing from the archive landed').to.equal(undefined);
			const reader = new BlockStorage(blockId, raw);
			expect(itemsOf((await reader.getBlock(5))!.block), 'the held rev 5 still reads its own content')
				.to.deep.equal(['rev5']);
		});

		it('accepts an archive that RE-STATES a held revision identically (a re-restore stays idempotent)', async () => {
			await seedHoldingRev5();

			// Byte-identical restatement of rev 5 — not a conflict, or the pin-extended coverage
			// above could never converge across overlapping restores.
			const storage = new BlockStorage(blockId, raw, alsoRestating5({
				action: { actionId: 'low5' as ActionId, rev: 5, transform: { insert: makeBlock('restore-collide', { items: ['rev5'] }) } },
				block: makeBlock('restore-collide', { items: ['rev5'] })
			}));
			await withBlockWriteLatch(blockId, l => storage.restoreRevision(3, l));
			expect(itemsOf((await storage.getBlock(3))!.block), 'rev 3 restored').to.deep.equal(['rev3']);

			// [3, 4) — the floor up to the PIN, not the archive's declared [3, 6). Rev 5's entry was
			// accepted and is still held under its own earlier span, but the archive does not get to
			// widen the claim past the revision that was asked for.
			expect((await raw.getMetadata(blockId))!.ranges, 'the accepted restatement claims only up to the pin')
				.to.deep.equal([[3, 4], [5, 6], [10]]);
			expect(await raw.getRevision(blockId, 5), 'the held revision is unchanged').to.equal('low5');
		});
	});
});

/**
 * Coverage for the checkpoint-materialization sweep: every committed revision keeps its forward
 * transform forever, but a full materialized copy is retained only at checkpoint revs (every
 * `checkpointInterval`th rev), the block's tip, and the floor of each contiguous held range. Redundant
 * intermediate materializations are pruned incrementally on commit (in `StorageRepo.internalCommit`,
 * after `setLatest`). Because all transforms are kept and a materialization survives at each floor +
 * checkpoint, EVERY held rev stays locally reconstructible by replay, so `meta.ranges` is unchanged by
 * sweeping — a swept rev is still honestly claimed present.
 */
describe('BlockStorage checkpoint materialization sweep', () => {
	let raw: MemoryRawStorage;

	beforeEach(() => {
		raw = new MemoryRawStorage();
	});

	// Small injected cadence so tests exercise sweeping without committing 32+ revs.
	const CK = 4;

	const makeDeleteTransforms = (blockId: BlockId): Transforms => ({
		inserts: {},
		updates: {},
		deletes: [blockId]
	});

	const repoWithInterval = (interval: number) =>
		new StorageRepo((id) => new BlockStorage(id, raw, undefined, interval));

	// Enumerate which revs in [1, upTo] currently hold a materialized copy vs a forward transform.
	const scanStores = async (blockId: BlockId, upTo: number) => {
		const materialized: number[] = [];
		const transforms: number[] = [];
		for (let r = 1; r <= upTo; r++) {
			const actionId = await raw.getRevision(blockId, r);
			if (!actionId) continue;
			if (await raw.getMaterializedBlock(blockId, actionId)) materialized.push(r);
			if (await raw.getTransaction(blockId, actionId)) transforms.push(r);
		}
		return { materialized, transforms };
	};

	// rev 1 inserts { items: [] }; each later rev prepends 'more' (so items.length === rev - 1). Global
	// rev === commit count, one block per commit.
	const insertRev1 = async (repo: StorageRepo, blockId: BlockId) => {
		await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms(blockId, makeBlock(blockId, { items: [] })), policy: 'c' });
		expect((await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 })).success).to.equal(true);
	};
	const updateRev = async (repo: StorageRepo, blockId: BlockId, r: number) => {
		const actionId = `a${r}` as ActionId;
		await repo.pend({ actionId, transforms: makeUpdateTransforms(blockId, [['items', 0, 0, ['more']]]), policy: 'c' });
		expect((await repo.commit({ actionId, blockIds: [blockId], tailId: blockId, rev: r })).success).to.equal(true);
	};
	const commitLinear = async (repo: StorageRepo, blockId: BlockId, upTo: number) => {
		await insertRev1(repo, blockId);
		for (let r = 2; r <= upTo; r++) await updateRev(repo, blockId, r);
	};

	it('retains materializations only at {floor, checkpoints, tip}; keeps every transform; every rev reads correctly', async () => {
		const blockId = 'ck-sweep' as BlockId;
		const repo = repoWithInterval(CK);
		const upTo = CK + 5; // 9 — crosses K (4) and 2K (8)
		await commitLinear(repo, blockId, upTo);

		const { materialized, transforms } = await scanStores(blockId, upTo);
		// Floor E=1, checkpoints 4 & 8, tip 9. Nothing else.
		expect(materialized, 'materializations only at floor + checkpoints + tip').to.deep.equal([1, 4, 8, 9]);
		// Every rev keeps its forward transform (the replay log is never pruned).
		expect(transforms, 'all transforms retained').to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9]);

		// Every held rev — swept or not — reconstructs correctly and never throws.
		const storage = new BlockStorage(blockId, raw, undefined, CK);
		for (let r = 1; r <= upTo; r++) {
			const got = await storage.getBlock(r);
			expect(got, `rev ${r} served (never "Failed to find materialized block")`).to.not.equal(undefined);
			expect((got!.block as unknown as { items: unknown[] }).items.length, `rev ${r} content`).to.equal(r - 1);
		}
	});

	it('meta.ranges is byte-identical before vs after sweeping a long chain (open-ended [E,+inf) preserved)', async () => {
		const blockId = 'ck-ranges' as BlockId;
		const repo = repoWithInterval(CK);

		await insertRev1(repo, blockId);
		await updateRev(repo, blockId, 2); // first sweep-triggering commit has landed
		const early = structuredClone((await raw.getMetadata(blockId))!.ranges);

		for (let r = 3; r <= CK * 3; r++) await updateRev(repo, blockId, r); // sweep a long chain

		const late = (await raw.getMetadata(blockId))!.ranges;
		expect(late, 'ranges unchanged by sweeping').to.deep.equal(early);
		expect(late, 'still one open-ended span from E=1').to.deep.equal([[1]]);
	});

	it('mid-history delete: tombstone rev reads back absent, the rev before it still present, sweep continues', async () => {
		const blockId = 'ck-del' as BlockId;
		const repo = repoWithInterval(CK);

		await insertRev1(repo, blockId);          // rev 1: items []
		await updateRev(repo, blockId, 2);         // rev 2: items ['more']
		// rev 3: forward tombstone via a delete transform through the commit funnel.
		await repo.pend({ actionId: 'a3' as ActionId, transforms: makeDeleteTransforms(blockId), policy: 'c' });
		expect((await repo.commit({ actionId: 'a3' as ActionId, blockIds: [blockId], tailId: blockId, rev: 3 })).success).to.equal(true);
		await insertRev1AfterDelete(repo, blockId, 4);  // rev 4: re-create, items []
		await updateRev(repo, blockId, 5);              // rev 5: items ['more']

		const storage = new BlockStorage(blockId, raw, undefined, CK);
		expect(await storage.getBlock(3), 'tombstone rev reads back absent').to.equal(undefined);
		const atRev2 = await storage.getBlock(2);
		expect(atRev2, 'rev before the tombstone still present').to.not.equal(undefined);
		expect((atRev2!.block as unknown as { items: unknown[] }).items.length).to.equal(1);
		// Re-created content after the tombstone reads correctly too.
		expect((await storage.getBlock(4))!.block as unknown as { items: unknown[] }, 'rev 4 re-created items').to.have.property('items').that.deep.equals([]);
		expect((await storage.getBlock(5))!.block as unknown as { items: unknown[] }, 'rev 5 items').to.have.property('items').that.deep.equals(['more']);

		// The tombstone rev carries no materialization (prune on it is a no-op delete).
		const action3 = await raw.getRevision(blockId, 3);
		expect(await raw.getMaterializedBlock(blockId, action3!), 'tombstone carries no materialization').to.equal(undefined);
	});

	it('multi-range (restore-seeded) block: lower range floor materialization survives commits to the upper range', async () => {
		const blockId = 'ck-multirange' as BlockId;
		const lowBlock = makeBlock('ck-multirange', { items: ['low'] });
		const restoreCallback: RestoreCallback = async (id) => ({
			blockId: id,
			revisions: {
				2: { action: { actionId: 'low2' as ActionId, rev: 2, transform: { insert: lowBlock } }, block: lowBlock }
			},
			range: [2, 3]
		});
		const repo = new StorageRepo((id) => new BlockStorage(id, raw, restoreCallback, CK));

		// Upper range starts at E=10 (a non-checkpoint floor — exercises the mandatory floor clause).
		await repo.pend({ actionId: 'u10' as ActionId, transforms: makeInsertTransforms(blockId, makeBlock('ck-multirange', { items: [] })), policy: 'c' });
		expect((await repo.commit({ actionId: 'u10' as ActionId, blockIds: [blockId], tailId: blockId, rev: 10 })).success).to.equal(true);
		for (let r = 11; r <= 10 + CK; r++) await updateRev(repo, blockId, r); // through 14

		// Restore the lower range: rev 2 is below E=10, so it is a genuine gap ⇒ restoreRevision
		// brings in [2,3] and the read then serves it locally.
		const storage = new BlockStorage(blockId, raw, restoreCallback, CK);
		await withBlockWriteLatch(blockId, l => storage.restoreRevision(2, l));
		expect((await storage.getBlock(2))!.block.header.id).to.equal('ck-multirange');
		const meta = await raw.getMetadata(blockId);
		expect(meta!.ranges, 'two disjoint ranges after restore').to.deep.equal([[2, 3], [10]]);

		// More commits to the UPPER range: prune only ever targets the prior upper-range latest.
		for (let r = 15; r <= 10 + CK * 2; r++) await updateRev(repo, blockId, r); // through 18

		const low2 = await raw.getRevision(blockId, 2);
		expect(await raw.getMaterializedBlock(blockId, low2!), 'lower range floor materialization survives').to.not.equal(undefined);
		// Upper range floor (10) retained despite not being a checkpoint (10 % 4 !== 0).
		const upper10 = await raw.getRevision(blockId, 10);
		expect(await raw.getMaterializedBlock(blockId, upper10!), 'upper range floor (non-checkpoint) retained').to.not.equal(undefined);
	});

	it('repeated cold historical read of a swept rev does not repopulate the materialized store', async () => {
		const blockId = 'ck-coldread' as BlockId;
		const repo = repoWithInterval(CK);
		await commitLinear(repo, blockId, CK * 2); // revs 1..8 ⇒ materialized {1,4,8}

		const before = (await scanStores(blockId, CK * 2)).materialized;
		expect(before, 'swept before reads').to.deep.equal([1, 4, 8]);

		const storage = new BlockStorage(blockId, raw, undefined, CK);
		for (let i = 0; i < 5; i++) {
			const got = await storage.getBlock(3); // rev 3 is swept (not floor/checkpoint/tip)
			expect((got!.block as unknown as { items: unknown[] }).items.length).to.equal(2);
		}

		const after = (await scanStores(blockId, CK * 2)).materialized;
		expect(after, 'materialized store did not grow via reads').to.deep.equal(before);
		expect(after, 'the swept rev was not re-cached').to.not.include(3);
	});

	it('crash before prune: block stays fully reconstructible and prune resumes on the next commit', async () => {
		// A crash between setLatest and pruneSupersededMaterialization leaves a redundant (but harmless)
		// materialization. Simulate by suppressing the prune, then verify the crucial safety property —
		// full reconstructibility — and that a later commit's prune still functions.
		let suppressPrune = true;
		class SkipPruneStorage extends BlockStorage {
			override async pruneSupersededMaterialization(prior: ActionRev, latch: BlockWriteLatch): Promise<void> {
				if (suppressPrune) return; // simulate crash before the prune ran
				return super.pruneSupersededMaterialization(prior, latch);
			}
		}
		const blockId = 'ck-crash' as BlockId;
		const repo = new StorageRepo((id) => new SkipPruneStorage(id, raw, undefined, CK));

		// Commit revs 1..5 with the prune suppressed: every materialization lingers.
		await insertRev1(repo, blockId);
		for (let r = 2; r <= 5; r++) await updateRev(repo, blockId, r);
		expect((await scanStores(blockId, 5)).materialized, 'all materializations linger after crash-before-prune').to.deep.equal([1, 2, 3, 4, 5]);

		// Safety invariant: fully reconstructible despite the lingering copies.
		const reader = new BlockStorage(blockId, raw, undefined, CK);
		for (let r = 1; r <= 5; r++) {
			const got = await reader.getBlock(r);
			expect((got!.block as unknown as { items: unknown[] }).items.length, `rev ${r} reconstructs`).to.equal(r - 1);
		}

		// Re-enable prune; the next commit (rev 6) reclaims its immediate prior (rev 5).
		suppressPrune = false;
		await updateRev(repo, blockId, 6);
		const rev5Action = await raw.getRevision(blockId, 5);
		expect(await raw.getMaterializedBlock(blockId, rev5Action!), 'prune resumed: superseded rev 5 reclaimed').to.equal(undefined);
		// NOTE: the incrementally-pruned design only ever targets the immediate prior, so the earlier
		// leaked copies (revs 2 & 3) are NOT auto-reclaimed by later commits — a bounded (≤1 block per
		// crash), harmless leak. Reconstructibility and consistency are unaffected. See the review handoff.
		expect((await scanStores(blockId, 6)).materialized).to.deep.equal([1, 2, 3, 4, 6]);
	});

	it('restore-then-replay read does NOT re-cache a swept rev (retention sees the just-restored range)', async () => {
		// Regression: a read that healed its own gap used to materialize against `meta` captured
		// BEFORE the restore, so the re-cache gate saw stale `ranges`; rangeFloorOf then fell back to
		// treating the target as its own floor and wrongly RETAINED it — re-caching a materialization
		// the sweep means to prune, regrowing storage via reads of restored ranges (the exact
		// floor+transforms shape a swept peer serves).
		//
		// The heal is now a separate step (`StorageRepo.get` → `restoreRevision` → re-read), so the
		// second `getBlock` reads metadata fresh by construction and the gate's own fresh read is
		// belt-and-braces. The claim is unchanged and is asserted through the public healing read,
		// which is the only way to reach this shape in one call.
		const blockId = 'ck-staleread' as BlockId;
		const prependOp: [string, number, number, unknown[]][] = [['items', 0, 0, ['more']]];
		const lowFloor = makeBlock('ck-staleread', { items: ['a'] });
		// Lower archive [2,5): rev 2 carries a materialization (floor); revs 3 & 4 carry ONLY forward
		// transforms (no block ⇒ saveRestored stores no materialization), so reading rev 3 replays.
		const restoreCallback: RestoreCallback = async (id) => ({
			blockId: id,
			revisions: {
				2: { action: { actionId: 'low2' as ActionId, rev: 2, transform: { insert: lowFloor } }, block: lowFloor },
				3: { action: { actionId: 'low3' as ActionId, rev: 3, transform: { updates: prependOp } } },
				4: { action: { actionId: 'low4' as ActionId, rev: 4, transform: { updates: prependOp } } }
			},
			range: [2, 5]
		});
		const repo = new StorageRepo((id) => new BlockStorage(id, raw, restoreCallback, CK));

		// Local upper range from E=10 (disjoint from the lower archive), so a read at rev 3 must restore.
		await repo.pend({ actionId: 'u10' as ActionId, transforms: makeInsertTransforms(blockId, makeBlock('ck-staleread', { items: [] })), policy: 'c' });
		expect((await repo.commit({ actionId: 'u10' as ActionId, blockIds: [blockId], tailId: blockId, rev: 10 })).success).to.equal(true);
		for (let r = 11; r <= 10 + CK; r++) await updateRev(repo, blockId, r); // through 14

		// rev 3: below E=10 ⇒ the read reports the gap, the healing helper restores [2,4), and the
		// re-read replays from the floor (rev 2). Not floor/checkpoint/tip, so it must not be cached.
		const got = (await repo.get({ blockIds: [blockId], context: { rev: 3, committed: [] } }))[blockId];
		expect(got!.block, 'restored & replayed rev served').to.not.equal(undefined);
		expect(got!.unavailable, 'and served authoritatively').to.equal(undefined);
		expect((got!.block as unknown as { items: unknown[] }).items.length, 'rev 3 content = floor + 1 prepend').to.equal(2);

		const low3 = await raw.getRevision(blockId, 3);
		expect(await raw.getMaterializedBlock(blockId, low3!), 'swept restored rev NOT re-cached').to.equal(undefined);
		const low2 = await raw.getRevision(blockId, 2);
		expect(await raw.getMaterializedBlock(blockId, low2!), 'restored floor retained').to.not.equal(undefined);
	});
});

/**
 * Ticket: certified-claims-reconcile-and-persist. The persistence contract for commit proofs on
 * the replica path: `StorageRepo.saveReplicatedBlock` retains a proof its caller VERIFIED against
 * the exact bytes (the reconcile path is that caller), a proof-less save retains none, a re-heal
 * of an already-held revision back-fills only under the digest-match retention rule, and the
 * unverified restore wire (`RestorationCoordinator` → `restoreCallback`) strips any proof a
 * remote archive attached. This layer never verifies — verification happened upstream — so a
 * minimal cast literal stands in for a real proof and keeps the tests fast. That literal declares
 * no digest, so the tests using it can only show the back-fill WITHHOLDING; the nested
 * `back-fill (real signed proofs)` block below pays for real fixtures where a digest is needed.
 * The back-fill driven end to end through a certified push lives in
 * `block-transfer-push-persist.spec.ts`.
 */
describe('commit-proof persistence on the replica path', () => {
	let raw: MemoryRawStorage;

	beforeEach(() => {
		raw = new MemoryRawStorage();
	});

	const proof = { v: 1 } as unknown as BlockCommitProof;

	it('saveReplicatedBlock persists a supplied proof, retrievable by (blockId, rev)', async () => {
		const blockId = 'block-proof-kept' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		await repo.saveReplicatedBlock(
			blockId, makeBlock('block-proof-kept', { items: [] }),
			{ rev: 2, actionId: 'r2' as ActionId }, proof);

		// JSON round-trips through the raw store, so compare structurally, not by reference.
		expect(await repo.getBlockProof(blockId, 2), 'the verified proof reads back for its revision')
			.to.deep.equal(proof);
	});

	it('saveReplicatedBlock without a proof persists none', async () => {
		const blockId = 'block-proof-none' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		await repo.saveReplicatedBlock(
			blockId, makeBlock('block-proof-none', { items: [] }),
			{ rev: 2, actionId: 'r2' as ActionId });

		expect(await repo.getBlockProof(blockId, 2), 'a corroboration-only heal stays proof-less')
			.to.equal(undefined);
	});

	it('monotonic-skip: a re-heal whose proof declares no digest back-fills nothing', async () => {
		// `saveReplicatedBlock` DOES back-fill a proof onto an already-held revision (ticket:
		// backfill-proof-on-held-revision) — but only through the digest-match retention rule, which
		// stores nothing when the proof declares no digest for this `(blockId, rev, actionId)`. The
		// stand-in `{ v: 1 }` proof used throughout this suite declares none, so it is withheld
		// (`commit:proof-undeclared`). That is the claim pinned here.
		//
		// The back-fill's POSITIVE path needs real signed proofs and lives in
		// `block-transfer-push-persist.spec.ts`, alongside the diverged-holder and stale-revision
		// cases that make the retention rule matter.
		const blockId = 'block-proof-skip' as BlockId;
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));
		const block = makeBlock('block-proof-skip', { items: [] });

		await repo.saveReplicatedBlock(blockId, block, { rev: 2, actionId: 'r2' as ActionId });
		await repo.saveReplicatedBlock(blockId, block, { rev: 2, actionId: 'r2' as ActionId }, proof);

		expect(await repo.getBlockProof(blockId, 2), 'a proof declaring no digest is withheld')
			.to.equal(undefined);
	});

	it('restore strips a proof the remote archive attached (unverified wire)', async () => {
		// The RestorationCoordinator wire verifies nothing, so a proof arriving on it must never be
		// persisted — persisting it would re-serve a hostile peer's artifact as evidence this node
		// retained itself. Verified proofs enter storage only through saveReplica.
		const blockId = 'block-proof-strip' as BlockId;
		const restoredBlock = makeBlock('block-proof-strip', { items: ['restored'] });
		const restoreCallback: RestoreCallback = async (id) => ({
			blockId: id,
			revisions: {
				1: {
					action: { actionId: 'restored-action' as ActionId, rev: 1, transform: { insert: restoredBlock } },
					block: restoredBlock,
					proof
				}
			},
			range: [1, 2]
		});

		const storage = new BlockStorage(blockId, raw, restoreCallback);
		// Seed pending-only metadata (ranges: []) so rev 1 is a genuine gap and the restore fires.
		await withBlockWriteLatch(blockId, l =>
			storage.savePendingTransaction('pending' as ActionId, { insert: makeBlock('block-proof-strip') }, l));

		await withBlockWriteLatch(blockId, l => storage.restoreRevision(1, l));
		const result = await storage.getBlock(1);

		expect(result?.block.header.id, 'the restore itself succeeded').to.equal('block-proof-strip');
		expect(await storage.getBlockProof(1), 'the unverified proof was stripped, not persisted')
			.to.equal(undefined);
	});

	/**
	 * Ticket: backfill-proof-on-held-revision. `saveReplicatedBlock` is reached by two callers —
	 * `BlockTransferService.handlePush` and `cluster/reconcile-block.ts` — with the same
	 * `(block, source, verifiedProof)` shape. The push caller is driven end to end in
	 * `block-transfer-push-persist.spec.ts`; these call the seam directly, which is the reconcile
	 * caller's shape, and cover the two branches no push can reach: a save with no declared
	 * `source`, and a proof-persist fault.
	 *
	 * Real signed proofs here because the retention rule compares a DECLARED digest against local
	 * content, and the suite's stand-in literal declares none.
	 */
	describe('back-fill (real signed proofs)', () => {
		/** The proof a genuine cohort retained for `(blockId, rev, actionId)` over exactly `block`. */
		const certify = async (
			blockId: BlockId, block: IBlock, rev: number, actionId: string
		): Promise<BlockCommitProof> => {
			const commit: CommitRequest = {
				actionId: actionId as ActionId,
				blockIds: [blockId],
				tailId: blockId,
				rev,
				blockDigests: { [blockId]: { digest: await canonicalBlockHash(block) } }
			};
			return (await makeSignedProof(4, commit)).proof;
		};

		it('back-fills onto a revision already held proof-lessly (the reconcile-path caller)', async () => {
			// The assertion that would have failed before this ticket: the second call is a monotonic
			// no-op, so nothing is written by `saveReplica` — the proof lands via the back-fill.
			const blockId = 'block-backfill-reconcile' as BlockId;
			const repo = new StorageRepo((id) => new BlockStorage(id, raw));
			const block = makeBlock('block-backfill-reconcile', { items: [] });
			const source = { rev: 3, actionId: 'a3' as ActionId };

			await repo.saveReplicatedBlock(blockId, block, source);
			expect(await repo.getBlockProof(blockId, 3), 'precondition: corroboration-only')
				.to.equal(undefined);

			const real = await certify(blockId, block, 3, 'a3');
			await repo.saveReplicatedBlock(blockId, block, source, real);

			expect(await repo.getBlockProof(blockId, 3), 'the verified proof is back-filled')
				.to.deep.equal(real);
			expect(await repo.get({ blockIds: [blockId] }).then(r => r[blockId]?.state?.latest),
				'latest is untouched — this was a no-op save').to.deep.equal(source);
		});

		it('never back-fills a save that declares no source revision', async () => {
			// With no `source`, `saveReplica` FABRICATES `rev = 1` and a content-derived actionId, so
			// there is no declared revision the proof could be compared against — back-filling would
			// key evidence to an identity this node invented. Unreachable from `handlePush` (it
			// refuses `proof-without-meta`) and from reconcile (its `source` is required), so this
			// pins the guard rather than a live path.
			const blockId = 'block-backfill-no-source' as BlockId;
			const repo = new StorageRepo((id) => new BlockStorage(id, raw));
			const block = makeBlock('block-backfill-no-source', { items: [] });

			await repo.saveReplicatedBlock(blockId, block);
			const held = (await repo.get({ blockIds: [blockId] }))[blockId]?.state?.latest;
			expect(held?.rev, 'precondition: landed at the fabricated rev 1').to.equal(1);

			await repo.saveReplicatedBlock(
				blockId, block, undefined, await certify(blockId, block, 1, held!.actionId));

			expect(await repo.getBlockProof(blockId, 1), 'no declared source ⇒ no back-fill')
				.to.equal(undefined);
		});

		it('a proof-persist fault leaves the no-op successful and the revision durable', async () => {
			// `persistProofIfContentMatches` swallows and logs: the revision this proof describes is
			// ALREADY durable, so a proof-write fault must not turn a no-op save into a rejection the
			// pusher reads as "not replicated".
			const blockId = 'block-backfill-fault' as BlockId;
			const faulty = new MemoryRawStorage();
			faulty.saveBlockProof = async () => { throw new Error('disk write failed'); };
			const repo = new StorageRepo((id) => new BlockStorage(id, faulty));
			const block = makeBlock('block-backfill-fault', { items: [] });
			const source = { rev: 3, actionId: 'a3' as ActionId };

			await repo.saveReplicatedBlock(blockId, block, source);
			await repo.saveReplicatedBlock(
				blockId, block, source, await certify(blockId, block, 3, 'a3'));

			expect(await repo.getBlockProof(blockId, 3), 'the proof simply is not retained')
				.to.equal(undefined);
			expect((await repo.get({ blockIds: [blockId] }))[blockId]?.state?.latest,
				'the revision is untouched and still held').to.deep.equal(source);
		});
	});
});

/** Re-create a block AFTER a tombstone via the commit funnel: an insert at `rev`. Distinct from
 * `insertRev1` because the action id / rev differ; the prior tombstone read as undefined so the insert
 * materializes from scratch. */
async function insertRev1AfterDelete(repo: StorageRepo, blockId: BlockId, rev: number): Promise<void> {
	const actionId = `a${rev}` as ActionId;
	// Declare the expected rev so pend's insert-conflict guard (which fires when a prior latest exists —
	// here the tombstone) is satisfied instead of reporting the block as stale.
	await repo.pend({
		actionId,
		rev,
		transforms: makeInsertTransforms(blockId, makeBlock(blockId, { items: [] })),
		policy: 'c'
	});
	const result = await repo.commit({ actionId, blockIds: [blockId], tailId: blockId, rev });
	if (!result.success) throw new Error(`re-create commit failed at rev ${rev}`);
}

/**
 * Regression coverage for "one block, one write lock": every writer of a block's metadata blob
 * (`{ latest, ranges }`) serializes on the SAME per-block latch. Before the fix, the restore path,
 * the replica path, and the pend path each took a different lock (or none), so two of them could
 * interleave inside one read-modify-write window and silently undo each other.
 *
 * Both tests force the interleaving by subclassing `MemoryRawStorage` and pausing AFTER an
 * underlying read returns — the racing writer then lands in the window the first writer's check has
 * already looked past. Only `StorageRepo.get` / `pend` / `saveReplicatedBlock` are used, whose
 * signatures do not change with the fix, so the tests run (and fail) on the unfixed tree.
 */
describe('one block, one write lock', () => {
	/** A one-shot gate: `parked` resolves when the gated read pauses; `release()` lets it continue. */
	function makeGate() {
		let release!: () => void;
		let signalParked!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		const parked = new Promise<void>(r => { signalParked = r; });
		return { gate, parked, release, signalParked };
	}

	it('a peer restore and a replica push on the same block never cross-write a revision (A)', async () => {
		const B = 'block-race-a' as BlockId;
		const g = makeGate();
		let tripped = false;
		class GatedRaw extends MemoryRawStorage {
			override async getRevision(id: BlockId, rev: number): Promise<ActionId | undefined> {
				const r = await super.getRevision(id, rev);
				// Pause inside the restore's `noDivergentRewrite` scan, right after it has observed
				// that rev 6 is NOT held — the check it is about to act on is now stale.
				if (id === B && rev === 6 && !tripped) {
					tripped = true;
					g.signalParked();
					await g.gate;
				}
				return r;
			}
		}
		const raw = new GatedRaw();

		const two = makeBlock(B, { items: ['two'] });
		const six = makeBlock(B, { items: ['six'] });
		// The peer answers the pin at rev 2 with rev 2 AND volunteers rev 6 (action x6).
		const restoreCallback: RestoreCallback = async (id) => ({
			blockId: id,
			revisions: {
				2: { action: { actionId: 'a2' as ActionId, rev: 2, transform: { insert: two } }, block: two },
				6: { action: { actionId: 'x6' as ActionId, rev: 6, transform: { insert: six } }, block: six }
			},
			range: [2, 7]
		});
		const repo = new StorageRepo((id) => new BlockStorage(id, raw, restoreCallback));

		// Seed the block at rev 5 (coverage [[5]]), so rev 2 is a genuine gap that triggers a restore.
		await repo.pend({
			actionId: 'a5' as ActionId,
			transforms: makeInsertTransforms(B, makeBlock(B, { items: ['five'] })),
			policy: 'c'
		});
		const seeded = await repo.commit({ actionId: 'a5' as ActionId, blockIds: [B], tailId: B, rev: 5 });
		expect(seeded.success).to.equal(true);
		expect((await raw.getMetadata(B))!.ranges).to.deep.equal([[5]]);

		// Read at rev 2 → restore → parks inside the divergence scan.
		const readP = repo.get({ blockIds: [B], context: { rev: 2, committed: [] } });
		await g.parked;

		// A replica of rev 6 arrives while the restore is mid-flight.
		const replicaP = repo.saveReplicatedBlock(B, six, { rev: 6, actionId: 'r6' as ActionId });
		await delay(10);
		expect(await raw.getRevision(B, 6), 'the replica must QUEUE behind the in-flight restore, not land inside it')
			.to.equal(undefined);

		g.release();
		await Promise.all([readP, replicaP]);

		// Either serialization order converges here: restore-then-replica overwrites the volunteered
		// x6 with r6 above its own latest; replica-then-restore refuses the archive on divergence.
		expect(await raw.getRevision(B, 6), 'rev 6 is the replica, never the peer-volunteered x6')
			.to.equal('r6');
		expect((await raw.getMetadata(B))!.latest, 'latest never regresses below the replica')
			.to.deep.equal({ rev: 6, actionId: 'r6' });
	});

	it('a pend seeding metadata and a replica push on a fresh block never erase latest (B)', async () => {
		const B = 'block-race-b' as BlockId;
		const g = makeGate();
		let tripped = false;
		class GatedRaw extends MemoryRawStorage {
			override async getMetadata(id: BlockId): Promise<BlockMetadata | undefined> {
				const m = await super.getMetadata(id);
				// Pause inside `savePendingTransaction`, right after it has read "no metadata" and
				// decided to seed an empty blob.
				if (id === B && !tripped) {
					tripped = true;
					g.signalParked();
					await g.gate;
				}
				return m;
			}
		}
		const raw = new GatedRaw();
		const repo = new StorageRepo((id) => new BlockStorage(id, raw));

		// An updates-only pend with no `rev` makes no getLatest() call of its own, so the FIRST
		// metadata read for this block is the one inside savePendingTransaction.
		const pendP = repo.pend({
			actionId: 'p1' as ActionId,
			transforms: makeUpdateTransforms(B, [['items', 0, 0, ['x']]]),
			policy: 'c'
		});
		await g.parked;

		const one = makeBlock(B, { items: ['one'] });
		const replicaP = repo.saveReplicatedBlock(B, one, { rev: 1, actionId: 'r1' as ActionId });
		await delay(10);

		g.release();
		const [pended] = await Promise.all([pendP, replicaP]);
		expect(pended.success).to.equal(true);

		expect((await raw.getMetadata(B))!.latest, 'the committed replica latest survives the pend')
			.to.deep.equal({ rev: 1, actionId: 'r1' });
		expect(await raw.getPendingTransaction(B, 'p1' as ActionId), 'the pending record is present')
			.to.not.equal(undefined);
	});
});
