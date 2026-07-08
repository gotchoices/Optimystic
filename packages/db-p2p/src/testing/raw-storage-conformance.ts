import { expect } from 'chai';
import type { BlockId, ActionId, IBlock, BlockHeader, Transform, Transforms } from '@optimystic/db-core';
import type { IRawStorage } from '../storage/i-raw-storage.js';
import type { BlockMetadata } from '../storage/struct.js';
import { StorageRepo } from '../storage/storage-repo.js';
import { BlockStorage } from '../storage/block-storage.js';

/**
 * What `makeStorage` hands each conformance case: a fresh `IRawStorage` and a
 * `cleanup` that releases it (close a handle, delete a temp dir, etc.). The
 * memory driver's cleanup is a no-op; disk/db backends do real teardown.
 */
export interface ConformanceHarness {
	storage: IRawStorage;
	cleanup: () => Promise<void>;
}

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

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

/**
 * Registers a `describe(name, ...)` block asserting that a raw-storage backend
 * behaves identically to every other backend. This is the ONE maintained parity
 * target that replaces the four copied `test/*-storage.spec.ts` specs — each
 * driver package calls it from its own `test/` with a factory for its backend.
 *
 * It covers the union of what the existing per-backend specs assert PLUS the
 * behaviors the shared kernel makes parity-critical: clone-on-store/read (now
 * structural via the byte boundary), promote atomicity + the exact missing-pend
 * error, drain-before-yield iteration, and a `BlockStorage`-level slice that
 * guards the `meta.ranges` open-ended seeding invariant and tombstone read-back.
 */
export function runRawStorageConformance(
	name: string,
	makeStorage: () => Promise<ConformanceHarness>
): void {
	describe(name, () => {
		let harness: ConformanceHarness;
		let storage: IRawStorage;

		beforeEach(async () => {
			harness = await makeStorage();
			storage = harness.storage;
		});

		afterEach(async () => {
			await harness.cleanup();
		});

		// --- Metadata ---

		it('getMetadata returns undefined on a miss', async () => {
			expect(await storage.getMetadata('absent' as BlockId)).to.equal(undefined);
		});

		it('metadata round-trips, including a one-element open-ended range', async () => {
			const blockId = 'meta-block' as BlockId;
			// [1, 3] is a bounded range; [5] is OPEN-ENDED (undefined upper bound). The byte
			// codec must preserve the open-ended encoding exactly — no range normalization.
			const meta: BlockMetadata = { ranges: [[1, 3], [5]], latest: { rev: 5, actionId: 'tx:a5' as ActionId } };

			await storage.saveMetadata(blockId, meta);
			const got = await storage.getMetadata(blockId);

			expect(got).to.deep.equal({ ranges: [[1, 3], [5]], latest: { rev: 5, actionId: 'tx:a5' } });
		});

		// --- Revisions ---

		it('getRevision returns undefined on a miss', async () => {
			expect(await storage.getRevision('block' as BlockId, 1)).to.equal(undefined);
		});

		it('revision round-trips', async () => {
			const blockId = 'rev-block' as BlockId;
			await storage.saveRevision(blockId, 7, 'tx:a7' as ActionId);
			expect(await storage.getRevision(blockId, 7)).to.equal('tx:a7');
		});

		it('listRevisions is ascending, inclusive on both bounds, and skips sparse gaps', async () => {
			const blockId = 'list-asc' as BlockId;
			await storage.saveRevision(blockId, 1, 'a1' as ActionId);
			await storage.saveRevision(blockId, 2, 'a2' as ActionId);
			await storage.saveRevision(blockId, 4, 'a4' as ActionId); // rev 3 absent

			const revs = await collect(storage.listRevisions(blockId, 1, 4));
			expect(revs).to.deep.equal([
				{ rev: 1, actionId: 'a1' },
				{ rev: 2, actionId: 'a2' },
				{ rev: 4, actionId: 'a4' }
			]);
		});

		it('listRevisions descends when startRev > endRev (bounds still inclusive)', async () => {
			const blockId = 'list-desc' as BlockId;
			await storage.saveRevision(blockId, 1, 'a1' as ActionId);
			await storage.saveRevision(blockId, 2, 'a2' as ActionId);
			await storage.saveRevision(blockId, 4, 'a4' as ActionId);

			const revs = await collect(storage.listRevisions(blockId, 4, 1));
			expect(revs).to.deep.equal([
				{ rev: 4, actionId: 'a4' },
				{ rev: 2, actionId: 'a2' },
				{ rev: 1, actionId: 'a1' }
			]);
		});

		it('listRevisions with a single inclusive bound yields that one rev', async () => {
			const blockId = 'list-single' as BlockId;
			await storage.saveRevision(blockId, 3, 'a3' as ActionId);
			expect(await collect(storage.listRevisions(blockId, 3, 3))).to.deep.equal([{ rev: 3, actionId: 'a3' }]);
		});

		it('listRevisions is scoped to one blockId (a second block does not leak in)', async () => {
			const a = 'scope-a' as BlockId;
			const b = 'scope-b' as BlockId;
			await storage.saveRevision(a, 1, 'a1' as ActionId);
			await storage.saveRevision(b, 1, 'b1' as ActionId);
			await storage.saveRevision(b, 2, 'b2' as ActionId);

			expect(await collect(storage.listRevisions(a, 1, 5))).to.deep.equal([{ rev: 1, actionId: 'a1' }]);
		});

		it('listRevisions over an empty range yields nothing', async () => {
			expect(await collect(storage.listRevisions('empty' as BlockId, 1, 10))).to.deep.equal([]);
		});

		it('listRevisions tolerates awaits interleaved between yields (drain-before-yield)', async () => {
			const blockId = 'drain-revs' as BlockId;
			await storage.saveRevision(blockId, 1, 'a1' as ActionId);
			await storage.saveRevision(blockId, 2, 'a2' as ActionId);
			await storage.saveRevision(blockId, 3, 'a3' as ActionId);

			const seen: Array<[number, ActionId]> = [];
			for await (const { rev, actionId } of storage.listRevisions(blockId, 1, 3)) {
				// An unrelated storage read between yields would auto-commit / invalidate a
				// native cursor that straddled the await, if the driver failed to drain first.
				await storage.getMetadata('other' as BlockId);
				seen.push([rev, actionId]);
			}
			expect(seen).to.deep.equal([[1, 'a1'], [2, 'a2'], [3, 'a3']]);
		});

		// --- Pending transactions ---

		it('getPendingTransaction returns undefined on a miss', async () => {
			expect(await storage.getPendingTransaction('block' as BlockId, 'a' as ActionId)).to.equal(undefined);
		});

		it('pending transaction round-trips', async () => {
			const blockId = 'pend-block' as BlockId;
			const transform: Transform = { insert: makeBlock('pend-block', { items: ['x'] }) };
			await storage.savePendingTransaction(blockId, 'a1' as ActionId, transform);
			expect(await storage.getPendingTransaction(blockId, 'a1' as ActionId)).to.deep.equal(transform);
		});

		it('listPendingTransactions is scoped to one block', async () => {
			const a = 'pend-a' as BlockId;
			const b = 'pend-b' as BlockId;
			await storage.savePendingTransaction(a, 'a1' as ActionId, { delete: true });
			await storage.savePendingTransaction(a, 'a2' as ActionId, { delete: true });
			await storage.savePendingTransaction(b, 'b1' as ActionId, { delete: true });

			const ids = new Set(await collect(storage.listPendingTransactions(a)));
			expect(ids).to.deep.equal(new Set(['a1', 'a2']));
		});

		it('deletePendingTransaction removes the pending entry', async () => {
			const blockId = 'pend-del' as BlockId;
			await storage.savePendingTransaction(blockId, 'a1' as ActionId, { delete: true });
			await storage.deletePendingTransaction(blockId, 'a1' as ActionId);

			expect(await storage.getPendingTransaction(blockId, 'a1' as ActionId)).to.equal(undefined);
			expect(await collect(storage.listPendingTransactions(blockId))).to.deep.equal([]);
		});

		it('listPendingTransactions tolerates awaits interleaved between yields (drain-before-yield)', async () => {
			const blockId = 'drain-pend' as BlockId;
			await storage.savePendingTransaction(blockId, 'a1' as ActionId, { delete: true });
			await storage.savePendingTransaction(blockId, 'a2' as ActionId, { delete: true });

			const seen: ActionId[] = [];
			for await (const id of storage.listPendingTransactions(blockId)) {
				await storage.getMetadata('other' as BlockId);
				seen.push(id);
			}
			expect(new Set(seen)).to.deep.equal(new Set(['a1', 'a2']));
		});

		// --- Committed transactions ---

		it('getTransaction returns undefined on a miss', async () => {
			expect(await storage.getTransaction('block' as BlockId, 'a' as ActionId)).to.equal(undefined);
		});

		it('committed transaction round-trips', async () => {
			const blockId = 'tx-block' as BlockId;
			const transform: Transform = { updates: [['items', 0, 0, ['y']]] };
			await storage.saveTransaction(blockId, 'a1' as ActionId, transform);
			expect(await storage.getTransaction(blockId, 'a1' as ActionId)).to.deep.equal(transform);
		});

		// --- Materialized blocks ---

		it('getMaterializedBlock returns undefined on a miss', async () => {
			expect(await storage.getMaterializedBlock('block' as BlockId, 'a' as ActionId)).to.equal(undefined);
		});

		it('materialized block round-trips', async () => {
			const blockId = 'mat-block' as BlockId;
			const block = makeBlock('mat-block', { items: ['z'] });
			await storage.saveMaterializedBlock(blockId, 'a1' as ActionId, block);
			expect(await storage.getMaterializedBlock(blockId, 'a1' as ActionId)).to.deep.equal(block);
		});

		it('saveMaterializedBlock(undefined) deletes; a subsequent get returns undefined', async () => {
			const blockId = 'mat-del' as BlockId;
			await storage.saveMaterializedBlock(blockId, 'a1' as ActionId, makeBlock('mat-del'));
			await storage.saveMaterializedBlock(blockId, 'a1' as ActionId, undefined);
			expect(await storage.getMaterializedBlock(blockId, 'a1' as ActionId)).to.equal(undefined);
		});

		// --- Promote (the only cross-key atomic op) ---

		it('promotePendingTransaction moves pending → committed atomically', async () => {
			const blockId = 'promote-block' as BlockId;
			const transform: Transform = { insert: makeBlock('promote-block') };
			await storage.savePendingTransaction(blockId, 'a1' as ActionId, transform);

			await storage.promotePendingTransaction(blockId, 'a1' as ActionId);

			expect(await storage.getTransaction(blockId, 'a1' as ActionId), 'committed after promote').to.deep.equal(transform);
			expect(await storage.getPendingTransaction(blockId, 'a1' as ActionId), 'pending removed after promote').to.equal(undefined);
		});

		it('promotePendingTransaction throws the exact message when no pending entry exists', async () => {
			const blockId = 'promote-missing' as BlockId;
			let error: Error | undefined;
			try {
				await storage.promotePendingTransaction(blockId, 'nope' as ActionId);
			} catch (err) {
				error = err as Error;
			}
			expect(error, 'promote of a missing pending throws').to.not.equal(undefined);
			expect(error!.message).to.equal(`Pending action nope not found for block ${blockId}`);
		});

		// --- Clone-on-store / clone-on-read (now structural via the byte boundary) ---

		it('saveMetadata snapshots — a later caller mutation does not corrupt stored state', async () => {
			const blockId = 'clone-meta' as BlockId;
			const meta: BlockMetadata = { ranges: [[1, 2]], latest: { rev: 1, actionId: 'a1' as ActionId } };
			await storage.saveMetadata(blockId, meta);

			// Mutate the caller's object AFTER saving — must not reach stored state.
			meta.ranges.push([9, 10]);
			meta.latest!.rev = 99;

			const stored = await storage.getMetadata(blockId);
			expect(stored).to.deep.equal({ ranges: [[1, 2]], latest: { rev: 1, actionId: 'a1' } });
		});

		it('savePendingTransaction / saveTransaction snapshot — a later caller mutation does not corrupt stored state', async () => {
			const blockId = 'clone-tx' as BlockId;
			const pend: Transform = { insert: makeBlock('clone-tx', { items: ['p-original'] }) };
			const committed: Transform = { insert: makeBlock('clone-tx', { items: ['c-original'] }) };
			await storage.savePendingTransaction(blockId, 'p1' as ActionId, pend);
			await storage.saveTransaction(blockId, 'c1' as ActionId, committed);

			// Mutate both caller references AFTER saving — neither must reach stored state.
			(pend.insert as IBlock & { items: string[] }).items.push('mutated');
			pend.delete = true;
			(committed.insert as IBlock & { items: string[] }).items.push('mutated');

			const storedPend = await storage.getPendingTransaction(blockId, 'p1' as ActionId);
			expect((storedPend!.insert as IBlock & { items: string[] }).items).to.deep.equal(['p-original']);
			expect(storedPend!.delete).to.equal(undefined);
			const storedCommitted = await storage.getTransaction(blockId, 'c1' as ActionId);
			expect((storedCommitted!.insert as IBlock & { items: string[] }).items).to.deep.equal(['c-original']);
		});

		it('getMetadata returns an independent copy each read (mutating one does not affect another)', async () => {
			const blockId = 'clone-meta-read' as BlockId;
			await storage.saveMetadata(blockId, { ranges: [[1, 2]], latest: { rev: 1, actionId: 'a1' as ActionId } });

			const first = await storage.getMetadata(blockId);
			first!.ranges.push([9, 10]);

			const second = await storage.getMetadata(blockId);
			expect(second!.ranges).to.deep.equal([[1, 2]]);
		});

		it('saveMaterializedBlock snapshots and getMaterializedBlock returns a fresh object', async () => {
			const blockId = 'clone-mat' as BlockId;
			const block = makeBlock('clone-mat', { items: ['original'] });
			await storage.saveMaterializedBlock(blockId, 'a1' as ActionId, block);

			// Mutate the caller's block after saving.
			(block as IBlock & { items: string[] }).items.push('mutated');

			const stored = await storage.getMaterializedBlock(blockId, 'a1' as ActionId) as IBlock & { items: string[] };
			expect(stored.items, 'stored copy unaffected by post-save mutation').to.deep.equal(['original']);

			// Mutate a returned copy; a fresh get is unaffected.
			stored.items.push('mutated-again');
			const reread = await storage.getMaterializedBlock(blockId, 'a1' as ActionId) as IBlock & { items: string[] };
			expect(reread.items, 'fresh read unaffected by mutation of a prior read').to.deep.equal(['original']);
		});

		// --- listBlockIds (optional; only when the driver implements it) ---

		it('listBlockIds yields exactly the blocks with metadata', async function () {
			const listBlockIds = storage.listBlockIds;
			if (typeof listBlockIds !== 'function') {
				this.skip();
			} else {
				await storage.saveMetadata('b1' as BlockId, { ranges: [], latest: undefined });
				await storage.saveMetadata('b2' as BlockId, { ranges: [], latest: undefined });
				// Pended but never committed → no metadata → must not be enumerated.
				await storage.savePendingTransaction('pending-only' as BlockId, 'x' as ActionId, { delete: true });

				const ids = new Set(await collect(listBlockIds.call(storage)));
				expect(ids).to.deep.equal(new Set(['b1', 'b2']));
			}
		});

		it('listBlockIds yields nothing for an empty store', async function () {
			const listBlockIds = storage.listBlockIds;
			if (typeof listBlockIds !== 'function') {
				this.skip();
			} else {
				expect(await collect(listBlockIds.call(storage))).to.deep.equal([]);
			}
		});

		// --- BlockStorage-level parity slice (over the same driver) ---

		it('BlockStorage pend → commit seeds open-ended ranges [[E]] (never [[0]]) and getBlock serves it', async () => {
			const blockId = 'parity-commit' as BlockId;
			const repo = new StorageRepo((id) => new BlockStorage(id, storage));

			await repo.pend({
				actionId: 'a1' as ActionId,
				transforms: makeInsertTransforms(blockId, makeBlock('parity-commit', { items: [] })),
				policy: 'c'
			});
			const commit = await repo.commit({ actionId: 'a1' as ActionId, blockIds: [blockId], tailId: blockId, rev: 1 });
			expect(commit.success, 'commit succeeded').to.equal(true);

			const meta = await storage.getMetadata(blockId);
			expect(meta!.latest?.rev).to.equal(1);
			// Open-ended from the earliest committed rev E=1 — NOT the over-claim [[0]].
			expect(meta!.ranges, 'coverage open-ended from E=1').to.deep.equal([[1]]);

			const got = await new BlockStorage(blockId, storage).getBlock();
			expect(got?.block.header.id, 'committed block served').to.equal('parity-commit');
		});

		it('BlockStorage saveReplica → saveDeletion reads the tombstoned rev back as undefined', async () => {
			const blockId = 'parity-tombstone' as BlockId;
			const bs = new BlockStorage(blockId, storage);

			await bs.saveReplica(makeBlock('parity-tombstone', { items: ['live'] }), { rev: 1, actionId: 'r1' as ActionId });
			const meta = await storage.getMetadata(blockId);
			// saveReplica seeds open-ended coverage anchored at the replica rev, never [[0]].
			expect(meta!.ranges, 'replica seeds open-ended [[1]]').to.deep.equal([[1]]);

			const latest = await bs.saveDeletion({ rev: 2, actionId: 'd2' as ActionId });
			expect(latest.rev).to.equal(2);

			// getBlock at the tombstone rev reverse-applies { delete: true } → absent block.
			expect(await bs.getBlock(), 'tombstoned rev reads back undefined').to.equal(undefined);
			// The prior revision still materializes.
			expect((await bs.getBlock(1))?.block.header.id, 'rev 1 still serves the live block').to.equal('parity-tombstone');
		});
	});
}
