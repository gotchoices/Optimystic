import { expect } from 'chai';
import { Tree, type ITransactor, type BlockId, type ActionId, type IBlock, type BlockHeader, type Transforms, type PendRequest, type CommitRequest, type Transform, type ActionRev } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor, type Mesh, type MeshOptions } from '../src/testing/mesh-harness.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { IRawStorage } from '../src/storage/i-raw-storage.js';
import type { BlockMetadata } from '../src/storage/struct.js';

/**
 * Fault-injection tests for mid-DDL / mid-transaction crash recovery.
 *
 * Wraps `MemoryRawStorage` with a `CrashingRawStorage` proxy that throws at a
 * specified IRawStorage boundary, drives the real production stack
 * (NetworkTransactor → CoordinatorRepo → StorageRepo → BlockStorage → IRawStorage)
 * on a solo node, asserts the on-disk state immediately after the crash, then
 * rebuilds a fresh node stack over the preserved raw storage and asserts the
 * recovery behavior.
 *
 * Solo mesh is intentional — `peerCount <= 1` short-circuits CoordinatorRepo
 * to StorageRepo, keeping these tests focused on the storage-layer contract.
 */

// ============================================================================
// CrashingRawStorage — fault-injection proxy for IRawStorage
// ============================================================================

type RawStorageMethod = keyof IRawStorage;

interface FaultTrigger {
	method: RawStorageMethod;
	blockId?: BlockId;
	actionId?: ActionId;
	/** Fire after N matching calls have already passed (default 0 → fire on first match). */
	skipCount?: number;
	/** `'before'` throws synchronously without delegating; `'after'` delegates then throws. */
	when: 'before' | 'after';
	/** Optional predicate inspecting the method arguments; only matches when true. */
	predicate?: (args: unknown[]) => boolean;
}

class InjectedCrash extends Error {
	constructor(method: string, when: 'before' | 'after') {
		super(`[InjectedCrash] ${when} ${method}`);
		this.name = 'InjectedCrash';
	}
}

class CrashingRawStorage implements IRawStorage {
	private matchCount = 0;
	private hasFired = false;

	constructor(private readonly inner: IRawStorage, private readonly trigger: FaultTrigger) {}

	/** Did the configured fault actually fire? */
	get fired(): boolean { return this.hasFired; }

	private shouldFire(method: RawStorageMethod, args: unknown[], blockId?: BlockId, actionId?: ActionId): boolean {
		if (this.hasFired) return false;
		if (this.trigger.method !== method) return false;
		if (this.trigger.blockId !== undefined && this.trigger.blockId !== blockId) return false;
		if (this.trigger.actionId !== undefined && this.trigger.actionId !== actionId) return false;
		if (this.trigger.predicate && !this.trigger.predicate(args)) return false;

		const skip = this.trigger.skipCount ?? 0;
		if (this.matchCount < skip) {
			this.matchCount++;
			return false;
		}
		this.matchCount++;
		return true;
	}

	private async invoke<T>(
		method: RawStorageMethod,
		args: unknown[],
		blockId: BlockId | undefined,
		actionId: ActionId | undefined,
		call: () => Promise<T>,
	): Promise<T> {
		const fire = this.shouldFire(method, args, blockId, actionId);
		if (fire && this.trigger.when === 'before') {
			this.hasFired = true;
			throw new InjectedCrash(method, 'before');
		}
		const result = await call();
		if (fire && this.trigger.when === 'after') {
			this.hasFired = true;
			throw new InjectedCrash(method, 'after');
		}
		return result;
	}

	getMetadata(blockId: BlockId) {
		return this.invoke('getMetadata', [blockId], blockId, undefined, () => this.inner.getMetadata(blockId));
	}
	saveMetadata(blockId: BlockId, metadata: BlockMetadata) {
		return this.invoke('saveMetadata', [blockId, metadata], blockId, undefined, () => this.inner.saveMetadata(blockId, metadata));
	}
	getRevision(blockId: BlockId, rev: number) {
		return this.invoke('getRevision', [blockId, rev], blockId, undefined, () => this.inner.getRevision(blockId, rev));
	}
	saveRevision(blockId: BlockId, rev: number, actionId: ActionId) {
		return this.invoke('saveRevision', [blockId, rev, actionId], blockId, actionId, () => this.inner.saveRevision(blockId, rev, actionId));
	}
	listRevisions(blockId: BlockId, startRev: number, endRev: number) {
		// No async-iterator fault injection wired in — not needed by the current crash plans.
		return this.inner.listRevisions(blockId, startRev, endRev);
	}
	getPendingTransaction(blockId: BlockId, actionId: ActionId) {
		return this.invoke('getPendingTransaction', [blockId, actionId], blockId, actionId, () => this.inner.getPendingTransaction(blockId, actionId));
	}
	savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform) {
		return this.invoke('savePendingTransaction', [blockId, actionId, transform], blockId, actionId, () => this.inner.savePendingTransaction(blockId, actionId, transform));
	}
	deletePendingTransaction(blockId: BlockId, actionId: ActionId) {
		return this.invoke('deletePendingTransaction', [blockId, actionId], blockId, actionId, () => this.inner.deletePendingTransaction(blockId, actionId));
	}
	listPendingTransactions(blockId: BlockId) {
		return this.inner.listPendingTransactions(blockId);
	}
	getTransaction(blockId: BlockId, actionId: ActionId) {
		return this.invoke('getTransaction', [blockId, actionId], blockId, actionId, () => this.inner.getTransaction(blockId, actionId));
	}
	saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform) {
		return this.invoke('saveTransaction', [blockId, actionId, transform], blockId, actionId, () => this.inner.saveTransaction(blockId, actionId, transform));
	}
	getMaterializedBlock(blockId: BlockId, actionId: ActionId) {
		return this.invoke('getMaterializedBlock', [blockId, actionId], blockId, actionId, () => this.inner.getMaterializedBlock(blockId, actionId));
	}
	saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock) {
		return this.invoke('saveMaterializedBlock', [blockId, actionId, block], blockId, actionId, () => this.inner.saveMaterializedBlock(blockId, actionId, block));
	}
	promotePendingTransaction(blockId: BlockId, actionId: ActionId) {
		return this.invoke('promotePendingTransaction', [blockId, actionId], blockId, actionId, () => this.inner.promotePendingTransaction(blockId, actionId));
	}
}

// ============================================================================
// Test helpers
// ============================================================================

const SOLO_OPTIONS: Omit<MeshOptions, 'rawStorageFactory'> = {
	responsibilityK: 1,
	clusterSize: 1,
	superMajorityThreshold: 0.51
};

const buildCrashingMesh = (raw: IRawStorage, trigger: FaultTrigger): Promise<{ mesh: Mesh; proxy: CrashingRawStorage }> => {
	const proxy = new CrashingRawStorage(raw, trigger);
	return createMesh(1, { ...SOLO_OPTIONS, rawStorageFactory: () => proxy })
		.then(mesh => ({ mesh, proxy }));
};

const rebuildCleanMesh = (raw: IRawStorage): Promise<Mesh> =>
	createMesh(1, { ...SOLO_OPTIONS, rawStorageFactory: () => raw });

const makeHeader = (id: string): BlockHeader => ({
	id: id as BlockId,
	type: 'test-block',
	collectionId: 'coll-mid-ddl' as BlockId
});

const makeBlock = (id: string, extra?: Record<string, unknown>): IBlock => ({
	header: makeHeader(id),
	...extra
});

const makeInsertTransforms = (blocks: Record<string, IBlock>): Transforms => ({
	inserts: blocks,
	updates: {},
	deletes: []
});

const preSeedMetadata = async (raw: IRawStorage, blockIds: BlockId[]): Promise<void> => {
	for (const blockId of blockIds) {
		const existing = await raw.getMetadata(blockId);
		if (!existing) {
			await raw.saveMetadata(blockId, { latest: undefined, ranges: [[0]] });
		}
	}
};

const assertIsCrash = (err: unknown): void => {
	// The crash may be wrapped by outer layers (StorageRepo.commit returns { success: false, reason }).
	// At the throw-site in pend, the rejection surfaces directly — match both.
	if (err instanceof InjectedCrash) return;
	if (err instanceof Error && err.message.includes('[InjectedCrash]')) return;
	throw new Error(`Expected an InjectedCrash, got: ${(err as Error)?.message ?? String(err)}`);
};

// ============================================================================
// Specs
// ============================================================================

describe('Mid-DDL crash recovery (solo node)', function () {
	// Same 5s budget as fresh-node-ddl.spec.ts — tests exercising crash+restart must
	// complete well inside a production-style timeout; if they hang, that's the bug.
	this.timeout(5_000);

	// ------------------------------------------------------------------------
	// Crash-A1: metadata seeded, pending not yet persisted (`when: 'before'`)
	// ------------------------------------------------------------------------
	describe('Crash-A1: savePendingTransaction fails before persist (single block)', () => {
		const blockA = 'block-crash-a1' as BlockId;
		const actionId = 'action-crash-a1' as ActionId;

		const pendRequest = (): PendRequest => ({
			actionId,
			transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['hello'] }) }),
			policy: 'c'
		});

		it('raw state after crash: metadata seeded, no pending', async () => {
			const raw = new MemoryRawStorage();
			const { mesh, proxy } = await buildCrashingMesh(raw, {
				method: 'savePendingTransaction',
				when: 'before',
				blockId: blockA
			});

			let caught: unknown;
			try {
				await mesh.nodes[0]!.storageRepo.pend(pendRequest());
			} catch (err) {
				caught = err;
			}
			assertIsCrash(caught);
			expect(proxy.fired).to.equal(true);

			const meta = await raw.getMetadata(blockA);
			expect(meta, 'metadata seeded by BlockStorage.savePendingTransaction').to.not.equal(undefined);
			expect(meta?.latest, 'no committed revision yet').to.equal(undefined);

			const pending = await raw.getPendingTransaction(blockA, actionId);
			expect(pending, 'pending never persisted').to.equal(undefined);
		});

		it('read after crash returns empty state (depends on pending-only-metadata ticket)', async () => {
			const raw = new MemoryRawStorage();
			const { mesh } = await buildCrashingMesh(raw, {
				method: 'savePendingTransaction',
				when: 'before',
				blockId: blockA
			});
			await mesh.nodes[0]!.storageRepo.pend(pendRequest()).catch(() => {});

			const recovered = await rebuildCleanMesh(raw);
			const result = await recovered.nodes[0]!.storageRepo.get({ blockIds: [blockA] });
			expect(result[blockA]?.state, 'pending-only metadata surfaces as empty state').to.deep.equal({});
		});

		it('retry pend with same actionId reaches commit after crash', async () => {
			const raw = new MemoryRawStorage();
			const { mesh } = await buildCrashingMesh(raw, {
				method: 'savePendingTransaction',
				when: 'before',
				blockId: blockA
			});
			await mesh.nodes[0]!.storageRepo.pend(pendRequest()).catch(() => {});

			const recovered = await rebuildCleanMesh(raw);
			const repo = recovered.nodes[0]!.storageRepo;

			const retry = await repo.pend(pendRequest());
			expect(retry.success, 'retry pend succeeds').to.equal(true);

			const commit = await repo.commit({
				actionId,
				blockIds: [blockA],
				tailId: blockA,
				rev: 1
			} as CommitRequest);
			expect(commit.success, 'subsequent commit succeeds').to.equal(true);

			const final = await repo.get({ blockIds: [blockA] });
			expect(final[blockA]?.state.latest?.rev).to.equal(1);
		});

		it('cancel after crash is a no-op that leaves a retryable clean state', async () => {
			const raw = new MemoryRawStorage();
			const { mesh } = await buildCrashingMesh(raw, {
				method: 'savePendingTransaction',
				when: 'before',
				blockId: blockA
			});
			await mesh.nodes[0]!.storageRepo.pend(pendRequest()).catch(() => {});

			const recovered = await rebuildCleanMesh(raw);
			const repo = recovered.nodes[0]!.storageRepo;
			// Cancel must not throw even though there's nothing to delete.
			await repo.cancel({ actionId, blockIds: [blockA] });

			// Fresh pend (new actionId) must still succeed.
			const freshActionId = 'action-after-cancel' as ActionId;
			const fresh = await repo.pend({
				actionId: freshActionId,
				transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['retry'] }) }),
				policy: 'c'
			});
			expect(fresh.success).to.equal(true);
		});
	});

	// ------------------------------------------------------------------------
	// Crash-B: partial pending across multiple blocks (`when: 'before'`)
	//
	// With `when: 'before'` on block[1], the proxy throws without delegating, so
	// block[1]'s pending is not persisted. Block[0] and block[2] run concurrently
	// under Promise.all and DO complete their writes. Result: genuinely partial.
	// ------------------------------------------------------------------------
	describe('Crash-B: partial pending across 3 blocks', () => {
		const b0 = 'crash-b-block-0' as BlockId;
		const b1 = 'crash-b-block-1' as BlockId;
		const b2 = 'crash-b-block-2' as BlockId;
		const staleActionId = 'stale-multi-action' as ActionId;

		const multiPend = (): PendRequest => ({
			actionId: staleActionId,
			transforms: makeInsertTransforms({
				[b0]: makeBlock(b0, { items: ['v0'] }),
				[b1]: makeBlock(b1, { items: ['v1'] }),
				[b2]: makeBlock(b2, { items: ['v2'] })
			}),
			policy: 'c'
		});

		it('crash leaves partial pending (b1 missing) and does not permanently wedge any block', async () => {
			const raw = new MemoryRawStorage();
			const { mesh, proxy } = await buildCrashingMesh(raw, {
				method: 'savePendingTransaction',
				when: 'before',
				blockId: b1
			});

			let caught: unknown;
			try {
				await mesh.nodes[0]!.storageRepo.pend(multiPend());
			} catch (err) {
				caught = err;
			}
			assertIsCrash(caught);
			expect(proxy.fired).to.equal(true);

			// b0 and b2 wrote pending (Promise.all fans out concurrently), b1 did not.
			const p0 = await raw.getPendingTransaction(b0, staleActionId);
			const p1 = await raw.getPendingTransaction(b1, staleActionId);
			const p2 = await raw.getPendingTransaction(b2, staleActionId);
			expect(p0, 'b0 pending persisted').to.not.equal(undefined);
			expect(p1, 'b1 pending NOT persisted (crash before)').to.equal(undefined);
			expect(p2, 'b2 pending persisted').to.not.equal(undefined);

			// Recovery: cancel the stale action across all blocks; then a fresh action on the
			// same block-set must succeed (no permanent wedge).
			const recovered = await rebuildCleanMesh(raw);
			const repo = recovered.nodes[0]!.storageRepo;
			await repo.cancel({ actionId: staleActionId, blockIds: [b0, b1, b2] });

			// Pending entries across all three must now be gone.
			expect(await raw.getPendingTransaction(b0, staleActionId)).to.equal(undefined);
			expect(await raw.getPendingTransaction(b1, staleActionId)).to.equal(undefined);
			expect(await raw.getPendingTransaction(b2, staleActionId)).to.equal(undefined);

			const freshActionId = 'fresh-after-b-crash' as ActionId;
			const fresh = await repo.pend({
				actionId: freshActionId,
				transforms: makeInsertTransforms({
					[b0]: makeBlock(b0, { items: ['new0'] }),
					[b1]: makeBlock(b1, { items: ['new1'] }),
					[b2]: makeBlock(b2, { items: ['new2'] })
				}),
				policy: 'c'
			});
			expect(fresh.success, 'fresh pend on same blocks after cancel succeeds').to.equal(true);
		});
	});

	// ------------------------------------------------------------------------
	// Crash-C: partial commit across multiple blocks
	//
	// Commit processes blockIds sequentially (not Promise.all), so aborting on
	// block[1] genuinely leaves block[2] unprocessed. Fault: saveMetadata on b1
	// during setLatest (meta.latest !== undefined), `when: 'after'`.
	// ------------------------------------------------------------------------
	describe('Crash-C: partial commit across 3 blocks', () => {
		const b0 = 'crash-c-block-0' as BlockId;
		const b1 = 'crash-c-block-1' as BlockId;
		const b2 = 'crash-c-block-2' as BlockId;
		const actionId = 'action-crash-c' as ActionId;

		it('crash mid-batch commit: b0,b1 fully committed; b2 untouched; retry-commit is rejected per current contract', async () => {
			const raw = new MemoryRawStorage();
			// Pre-seed metadata so pend-path saveMetadata doesn't fire the trigger.
			await preSeedMetadata(raw, [b0, b1, b2]);

			// First pend the multi-block action on the plain raw storage (no crash).
			// We do this by building a non-crashing mesh first, pending, then swapping in
			// a fresh crashing mesh for the commit phase.
			const pendingMesh = await rebuildCleanMesh(raw);
			const pendResult = await pendingMesh.nodes[0]!.storageRepo.pend({
				actionId,
				transforms: makeInsertTransforms({
					[b0]: makeBlock(b0, { items: ['v0'] }),
					[b1]: makeBlock(b1, { items: ['v1'] }),
					[b2]: makeBlock(b2, { items: ['v2'] })
				}),
				policy: 'c'
			});
			expect(pendResult.success).to.equal(true);

			// Attach the crashing wrapper. Trigger: saveMetadata on b1 where meta.latest !== undefined
			// (i.e., setLatest, not the pend-phase seed; seed doesn't exist here anyway).
			const { mesh: crashMesh, proxy } = await buildCrashingMesh(raw, {
				method: 'saveMetadata',
				when: 'after',
				blockId: b1,
				predicate: (args) => {
					const meta = args[1] as BlockMetadata | undefined;
					return meta?.latest !== undefined;
				}
			});

			const commitResult = await crashMesh.nodes[0]!.storageRepo.commit({
				actionId,
				blockIds: [b0, b1, b2],
				tailId: b0,
				rev: 1
			} as CommitRequest);
			expect(proxy.fired, 'crash fired during commit').to.equal(true);
			// StorageRepo.commit catches the internalCommit throw and returns { success: false }.
			expect(commitResult.success, 'commit returns failure').to.equal(false);

			// Verify raw state: b0 + b1 fully committed, b2 untouched.
			const m0 = await raw.getMetadata(b0);
			const m1 = await raw.getMetadata(b1);
			const m2 = await raw.getMetadata(b2);
			expect(m0?.latest?.rev, 'b0 latest updated').to.equal(1);
			expect(m1?.latest?.rev, 'b1 latest updated (setLatest succeeded then proxy threw `after`)').to.equal(1);
			expect(m2?.latest, 'b2 never processed').to.equal(undefined);

			// b2 still has pending and no revision.
			expect(await raw.getPendingTransaction(b2, actionId), 'b2 pending still present').to.not.equal(undefined);
			expect(await raw.getRevision(b2, 1), 'b2 has no revision').to.equal(undefined);

			// Recovery: retry-commit with same actionId+rev.
			const recovered = await rebuildCleanMesh(raw);
			const repo = recovered.nodes[0]!.storageRepo;

			const retry = await repo.commit({
				actionId,
				blockIds: [b0, b1, b2],
				tailId: b0,
				rev: 1
			} as CommitRequest);
			// Current contract: b0,b1 have latest.rev >= 1 → `missing` collected (with empty
			// transforms, since request.rev === latest.rev leaves listRevisions empty), so
			// the whole commit short-circuits with `success: false`. b2 is NOT advanced.
			expect(retry.success, 'retry-commit rejected because b0,b1 are already at rev=1').to.equal(false);

			// b2 remains stranded: pending present, no committed revision. This is the
			// "partial commit split" that the ticket flags as a candidate gap.
			const m2AfterRetry = await raw.getMetadata(b2);
			expect(m2AfterRetry?.latest, 'b2 still not advanced after retry-commit').to.equal(undefined);
			expect(await raw.getPendingTransaction(b2, actionId), 'b2 pending still present after retry-commit').to.not.equal(undefined);
		});
	});

	// ------------------------------------------------------------------------
	// Crash-D2: revision durable, pending not promoted, latest not updated
	// (fault: promotePendingTransaction, `when: 'before'`)
	// ------------------------------------------------------------------------
	describe('Crash-D2: crash before promotePendingTransaction', () => {
		const blockA = 'crash-d2-block' as BlockId;
		const actionId = 'action-crash-d2' as ActionId;

		it('retry-commit reaches full success (saveRevision is idempotent)', async () => {
			const raw = new MemoryRawStorage();
			const pending = await rebuildCleanMesh(raw);
			await pending.nodes[0]!.storageRepo.pend({
				actionId,
				transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['d2'] }) }),
				policy: 'c'
			});

			const { mesh, proxy } = await buildCrashingMesh(raw, {
				method: 'promotePendingTransaction',
				when: 'before',
				blockId: blockA,
				actionId
			});

			const commitResult = await mesh.nodes[0]!.storageRepo.commit({
				actionId,
				blockIds: [blockA],
				tailId: blockA,
				rev: 1
			} as CommitRequest);
			expect(proxy.fired).to.equal(true);
			expect(commitResult.success).to.equal(false);

			// Raw state: revision durable; pending still present; action NOT in committed log;
			// metadata.latest unchanged.
			expect(await raw.getRevision(blockA, 1), 'revision durable').to.equal(actionId);
			expect(await raw.getPendingTransaction(blockA, actionId), 'pending still present').to.not.equal(undefined);
			expect(await raw.getTransaction(blockA, actionId), 'not yet in committed log').to.equal(undefined);
			const metaBefore = await raw.getMetadata(blockA);
			expect(metaBefore?.latest, 'latest not updated').to.equal(undefined);

			// Recovery: retry-commit with same actionId+rev.
			const recovered = await rebuildCleanMesh(raw);
			const repo = recovered.nodes[0]!.storageRepo;
			const retry = await repo.commit({
				actionId,
				blockIds: [blockA],
				tailId: blockA,
				rev: 1
			} as CommitRequest);
			expect(retry.success, 'retry-commit succeeds').to.equal(true);

			const meta = await raw.getMetadata(blockA);
			expect(meta?.latest?.rev).to.equal(1);
			expect(meta?.latest?.actionId).to.equal(actionId);
			expect(await raw.getTransaction(blockA, actionId), 'action now in committed log').to.not.equal(undefined);
			expect(await raw.getPendingTransaction(blockA, actionId), 'pending promoted/removed').to.equal(undefined);

			const final = await repo.get({ blockIds: [blockA] });
			expect(final[blockA]?.block, 'block materialized and readable').to.not.equal(undefined);
			expect(final[blockA]?.state.latest?.rev).to.equal(1);
		});
	});

	// ------------------------------------------------------------------------
	// Crash-D3: pending promoted, saveMetadata(setLatest) throws before delegating
	//
	// Observed current behavior surfaces a REFERENCE-LEAK sharp-edge in
	// MemoryRawStorage: `getMetadata` returns the stored object by reference, and
	// `BlockStorage.setLatest` mutates `meta.latest = latest` BEFORE calling
	// `saveMetadata`. So when the saveMetadata proxy throws `when: 'before'`, the
	// in-memory metadata is already mutated. In RAM the state looks fully
	// committed; in a persistent store (SQLite / file / LevelDB) the picture
	// would differ — the saveMetadata syscall never ran, so `latest` would still
	// be unchanged on-disk.
	//
	// This test documents what actually happens on MemoryRawStorage today, and
	// flags the gap for a persistent-storage recovery path:
	//   → tickets/fix/5-memory-storage-metadata-reference-leak.md
	//   → tickets/fix/5-crash-d3-latest-not-updated-silent-invisible-commit.md
	// ------------------------------------------------------------------------
	describe('Crash-D3: crash before setLatest (documented behavior + gap)', () => {
		const blockA = 'crash-d3-block' as BlockId;
		const actionId = 'action-crash-d3' as ActionId;

		const seedPending = async (raw: IRawStorage): Promise<void> => {
			const pending = await rebuildCleanMesh(raw);
			await pending.nodes[0]!.storageRepo.pend({
				actionId,
				transforms: makeInsertTransforms({ [blockA]: makeBlock(blockA, { items: ['d3'] }) }),
				policy: 'c'
			});
		};

		const crashTrigger: FaultTrigger = {
			method: 'saveMetadata',
			when: 'before',
			blockId: blockA,
			predicate: (args) => {
				const meta = args[1] as BlockMetadata | undefined;
				return meta?.latest !== undefined;
			}
		};

		it('raw revision + committed action are durable; pending is removed', async () => {
			const raw = new MemoryRawStorage();
			await seedPending(raw);

			const { mesh, proxy } = await buildCrashingMesh(raw, crashTrigger);
			const result = await mesh.nodes[0]!.storageRepo.commit({
				actionId,
				blockIds: [blockA],
				tailId: blockA,
				rev: 1
			} as CommitRequest);
			expect(proxy.fired).to.equal(true);
			expect(result.success).to.equal(false);

			// Durable side-effects that DID complete.
			expect(await raw.getRevision(blockA, 1)).to.equal(actionId);
			expect(await raw.getTransaction(blockA, actionId), 'action promoted to committed log').to.not.equal(undefined);
			expect(await raw.getPendingTransaction(blockA, actionId), 'pending removed by promote').to.equal(undefined);
		});

		it('retry-commit is rejected because pending is already gone', async () => {
			const raw = new MemoryRawStorage();
			await seedPending(raw);

			const { mesh } = await buildCrashingMesh(raw, crashTrigger);
			await mesh.nodes[0]!.storageRepo.commit({
				actionId,
				blockIds: [blockA],
				tailId: blockA,
				rev: 1
			} as CommitRequest);

			// Recovery: retry-commit. Per storage-repo.ts:244-253, the pending check
			// fires BEFORE internalCommit; with pending already promoted, it throws
			// "Pending action not found" — surfaced by commit()'s outer catch as
			// `success: false`. No built-in recovery path reconciles the half-state.
			const recovered = await rebuildCleanMesh(raw);
			const repo = recovered.nodes[0]!.storageRepo;
			let retryOk: boolean | undefined;
			try {
				const retry = await repo.commit({
					actionId,
					blockIds: [blockA],
					tailId: blockA,
					rev: 1
				} as CommitRequest);
				retryOk = retry.success;
			} catch {
				retryOk = false;
			}
			expect(retryOk, 'retry-commit cannot complete on a promoted action').to.equal(false);
		});

		it('documents MemoryRawStorage reference-leak: mutation leaks into RAM even when saveMetadata throws', async () => {
			const raw = new MemoryRawStorage();
			await seedPending(raw);

			const { mesh } = await buildCrashingMesh(raw, crashTrigger);
			await mesh.nodes[0]!.storageRepo.commit({
				actionId,
				blockIds: [blockA],
				tailId: blockA,
				rev: 1
			} as CommitRequest);

			// MemoryRawStorage.getMetadata returns the stored object by reference.
			// BlockStorage.setLatest does `meta.latest = latest` BEFORE calling
			// saveMetadata. So even though the proxy threw `before` saveMetadata was
			// delegated, the in-memory map entry was already mutated.
			//
			// This is the observed current behavior on MemoryRawStorage — a persistent
			// store with serialized writes would NOT exhibit this. Tracked by:
			//   tickets/fix/5-memory-storage-metadata-reference-leak.md
			const meta = await raw.getMetadata(blockA);
			expect(meta?.latest?.rev, 'in-memory meta was mutated before the crash').to.equal(1);

			// Consequence: a default read on MemoryRawStorage happens to "succeed"
			// (sees rev=1), but ONLY because of the leak — not because recovery works.
			const recovered = await rebuildCleanMesh(raw);
			const read = await recovered.nodes[0]!.storageRepo.get({ blockIds: [blockA] });
			expect(read[blockA]?.state.latest?.rev).to.equal(1);
		});

		it.skip('DESIRED: after fixing the reference leak, a recovery entry-point reconciles latest with max(revisions)', async () => {
			// TODO: unskip once both follow-up fix tickets land:
			//   tickets/fix/5-memory-storage-metadata-reference-leak.md
			//   tickets/fix/5-crash-d3-latest-not-updated-silent-invisible-commit.md
			// Once the leak is fixed, meta.latest will still be undefined after this crash
			// (matching a persistent store), and the default read must see empty state.
			// A recover entry-point (e.g. repo.recoverTransactions() or equivalent) must
			// then reconcile metadata.latest from max(revisions) so reads see rev=1.
		});
	});

	// ------------------------------------------------------------------------
	// Crash during schema-block commit (Tree.createOrOpen + tree.replace)
	//
	// Drives the real DDL flow via NetworkTransactor. After a crash during the
	// commit phase, a fresh Tree.createOrOpen on the same id must either see a
	// coherent state or surface a clear error — not silently corrupt.
	// ------------------------------------------------------------------------
	describe('Crash during Tree DDL commit (schema-block scenario)', () => {
		interface TestEntry { key: number; value: string; }
		const treeId = 'crash-schema-tree';

		it('crash before any saveRevision: Tree retries succeed post-recovery', async () => {
			const raw = new MemoryRawStorage();
			// Fault on the FIRST saveRevision — aborts commit before any block gets a revision.
			const { mesh } = await buildCrashingMesh(raw, {
				method: 'saveRevision',
				when: 'before'
			});
			const crashingTransactor: ITransactor = buildNetworkTransactor(mesh);

			let ddlErr: unknown;
			try {
				const tree = await Tree.createOrOpen<number, TestEntry>(
					crashingTransactor,
					treeId,
					(entry: TestEntry) => entry.key
				);
				await tree.replace([[1, { key: 1, value: 'first' }]]);
			} catch (err) {
				ddlErr = err;
			}
			expect(ddlErr, 'DDL surfaces an error (not a silent success)').to.not.equal(undefined);

			// Recovery: fresh Tree on the same id must not silently corrupt — it should
			// either succeed (rolled-back or committed state) or surface a clear,
			// actionable error (NOT `non-existent chain`, per the dependency ticket).
			const recovered = await rebuildCleanMesh(raw);
			const recoveredTransactor: ITransactor = buildNetworkTransactor(recovered);

			let recoverErr: unknown;
			let finalValue: TestEntry | undefined;
			try {
				const tree2 = await Tree.createOrOpen<number, TestEntry>(
					recoveredTransactor,
					treeId,
					(entry: TestEntry) => entry.key
				);
				await tree2.replace([[1, { key: 1, value: 'second' }]]);
				finalValue = await tree2.get(1);
			} catch (err) {
				recoverErr = err;
			}

			if (recoverErr) {
				const message = (recoverErr as Error).message ?? '';
				// Silent-corruption sentinels — any of these means the crash wedged the DB.
				expect(message).to.not.include('non-existent chain');
				expect(message).to.not.include('not found during restore attempt');
			} else {
				expect(finalValue).to.deep.equal({ key: 1, value: 'second' });
			}
		});
	});
});
