import { expect } from 'chai';
import type { BlockId, ActionId, IBlock, Transforms } from '@optimystic/db-core';
import type { RawStoreDriver } from '../../src/storage/raw-store-driver.js';
import type { IRawStorage } from '../../src/storage/i-raw-storage.js';
import { StorageRepo } from '../../src/storage/storage-repo.js';
import { BlockStorage } from '../../src/storage/block-storage.js';

export const makeBlock = (id: string, data?: Record<string, unknown>): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId },
	...data
});

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

/** Counts every driver call by method name, then delegates. Placed UNDER the cache to
 * measure what actually reaches the backend, or alone to measure an uncached baseline.
 *
 * Deliberately does NOT pass `storeIdentity` through, and must not start: tests build several
 * of these over one shared inner driver precisely so each wrapper stays INDEPENDENT. Passing
 * identity through would let identity-keyed consumers collapse them into one, silently voiding
 * the isolation the counts depend on. Same reason it passes no `close`. */
export class CountingStoreDriver implements RawStoreDriver {
	readonly counts: Record<string, number> = {};

	constructor(private readonly inner: RawStoreDriver) {}

	private bump(method: string): void {
		this.counts[method] = (this.counts[method] ?? 0) + 1;
	}

	count(method: string): number {
		return this.counts[method] ?? 0;
	}

	total(methods: readonly string[]): number {
		return methods.reduce((sum, m) => sum + this.count(m), 0);
	}

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		this.bump('getMetadata');
		return this.inner.getMetadata(blockId);
	}
	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		this.bump('putMetadata');
		return this.inner.putMetadata(blockId, value);
	}
	async getRevision(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		this.bump('getRevision');
		return this.inner.getRevision(blockId, rev);
	}
	async putRevision(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		this.bump('putRevision');
		return this.inner.putRevision(blockId, rev, value);
	}
	async *rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean): AsyncIterable<[number, Uint8Array]> {
		this.bump('rangeRevisions');
		yield* this.inner.rangeRevisions(blockId, lo, hi, reverse);
	}
	async getPending(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		this.bump('getPending');
		return this.inner.getPending(blockId, actionId);
	}
	async putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		this.bump('putPending');
		return this.inner.putPending(blockId, actionId, value);
	}
	async deletePending(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.bump('deletePending');
		return this.inner.deletePending(blockId, actionId);
	}
	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		this.bump('listPendingActionIds');
		yield* this.inner.listPendingActionIds(blockId);
	}
	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		this.bump('getTransaction');
		return this.inner.getTransaction(blockId, actionId);
	}
	async putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		this.bump('putTransaction');
		return this.inner.putTransaction(blockId, actionId, value);
	}
	async getProof(blockId: BlockId, rev: number): Promise<Uint8Array | undefined> {
		this.bump('getProof');
		return this.inner.getProof(blockId, rev);
	}
	async putProof(blockId: BlockId, rev: number, value: Uint8Array): Promise<void> {
		this.bump('putProof');
		return this.inner.putProof(blockId, rev, value);
	}
	async getMaterialized(blockId: BlockId, actionId: ActionId): Promise<Uint8Array | undefined> {
		this.bump('getMaterialized');
		return this.inner.getMaterialized(blockId, actionId);
	}
	async putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array): Promise<void> {
		this.bump('putMaterialized');
		return this.inner.putMaterialized(blockId, actionId, value);
	}
	async deleteMaterialized(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.bump('deleteMaterialized');
		return this.inner.deleteMaterialized(blockId, actionId);
	}
	async promote(blockId: BlockId, actionId: ActionId): Promise<void> {
		this.bump('promote');
		return this.inner.promote(blockId, actionId);
	}
}

// `getProof`/`putProof` are deliberately absent from both lists: the proofs store is a
// PASSTHROUGH in CachedStoreDriver (never cached), so counting it would make the cache-hit
// ratio assertions measure a store the cache does not claim to serve.
export const READ_METHODS = [
	'getMetadata', 'getRevision', 'rangeRevisions', 'getPending',
	'listPendingActionIds', 'getTransaction', 'getMaterialized'
] as const;
export const WRITE_METHODS = [
	'putMetadata', 'putRevision', 'putPending', 'deletePending',
	'putTransaction', 'putMaterialized', 'deleteMaterialized', 'promote'
] as const;

/** ≈ the profiled cold start: 6 hot blocks, 22 sequential pend→commit rounds with a
 * read of every known block after each commit. Insert on a block's first touch,
 * in-place update after; commit rev is a global counter. */
export async function runColdStartWorkload(storage: IRawStorage): Promise<void> {
	const repo = new StorageRepo(id => new BlockStorage(id, storage));
	const blockIds = Array.from({ length: 6 }, (_, i) => `blk-${i}` as BlockId);
	const inserted = new Set<BlockId>();

	for (let round = 1; round <= 22; round++) {
		const blockId = blockIds[(round - 1) % blockIds.length]!;
		const actionId = `tx:${round}` as ActionId;
		const transforms: Transforms = inserted.has(blockId)
			? { inserts: {}, updates: { [blockId]: [['items', 0, 0, [`v${round}`]]] }, deletes: [] }
			: { inserts: { [blockId]: makeBlock(blockId, { items: [] }) }, updates: {}, deletes: [] };
		inserted.add(blockId);

		const pend = await repo.pend({ actionId, transforms, policy: 'c' });
		expect(pend.success, `pend round ${round}`).to.equal(true);
		const commit = await repo.commit({ actionId, blockIds: [blockId], tailId: blockId, rev: round });
		expect(commit.success, `commit round ${round}`).to.equal(true);

		const got = await repo.get({ blockIds: Array.from(inserted) });
		for (const id of inserted) {
			expect(got[id]?.block?.header.id, `read of ${id} after round ${round}`).to.equal(id);
		}
	}
}
