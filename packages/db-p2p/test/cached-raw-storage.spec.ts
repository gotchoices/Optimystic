import { expect } from 'chai';
import type { BlockId, ActionId, IBlock, Transform, Transforms } from '@optimystic/db-core';
import { runRawStorageConformance } from '../src/testing/raw-storage-conformance.js';
import type { RawStoreDriver } from '../src/storage/raw-store-driver.js';
import type { IRawStorage } from '../src/storage/i-raw-storage.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { MemoryStoreDriver } from '../src/storage/memory-store-driver.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { CachedStoreDriver } from '../src/storage/cached-store-driver.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';

const makeBlock = (id: string, data?: Record<string, unknown>): IBlock => ({
	header: { id: id as BlockId, type: 'test', collectionId: 'collection-1' as BlockId },
	...data
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) out.push(item);
	return out;
}

/** Counts every driver call by method name, then delegates. Placed UNDER the cache to
 * measure what actually reaches the backend, or alone to measure an uncached baseline. */
class CountingStoreDriver implements RawStoreDriver {
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

const READ_METHODS = [
	'getMetadata', 'getRevision', 'rangeRevisions', 'getPending',
	'listPendingActionIds', 'getTransaction', 'getMaterialized'
] as const;
const WRITE_METHODS = [
	'putMetadata', 'putRevision', 'putPending', 'deletePending',
	'putTransaction', 'putMaterialized', 'deleteMaterialized', 'promote'
] as const;

/** Delegates to a memory driver, but when armed, its pending-list enumeration pauses at a
 * gate AFTER draining and BEFORE yielding — so a test can land a write "mid-drain" with the
 * cache's enumeration provably in flight, deterministically (no timing sleeps). */
class GatedStoreDriver implements RawStoreDriver {
	listCalls = 0;
	/** Resolves once an armed enumeration has drained and is parked at the gate. */
	reachedGate: Promise<void> | undefined;
	private gatePromise: Promise<void> | undefined;
	private openGateResolve: (() => void) | undefined;
	private reachedGateResolve: (() => void) | undefined;

	constructor(private readonly inner: MemoryStoreDriver) {}

	armGate(): void {
		this.gatePromise = new Promise<void>(res => { this.openGateResolve = res; });
		this.reachedGate = new Promise<void>(res => { this.reachedGateResolve = res; });
	}

	openGate(): void {
		this.openGateResolve?.();
		this.openGateResolve = undefined;
	}

	getMetadata(blockId: BlockId) { return this.inner.getMetadata(blockId); }
	putMetadata(blockId: BlockId, value: Uint8Array) { return this.inner.putMetadata(blockId, value); }
	getRevision(blockId: BlockId, rev: number) { return this.inner.getRevision(blockId, rev); }
	putRevision(blockId: BlockId, rev: number, value: Uint8Array) { return this.inner.putRevision(blockId, rev, value); }
	rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean) { return this.inner.rangeRevisions(blockId, lo, hi, reverse); }
	getPending(blockId: BlockId, actionId: ActionId) { return this.inner.getPending(blockId, actionId); }
	putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putPending(blockId, actionId, value); }
	deletePending(blockId: BlockId, actionId: ActionId) { return this.inner.deletePending(blockId, actionId); }
	getTransaction(blockId: BlockId, actionId: ActionId) { return this.inner.getTransaction(blockId, actionId); }
	putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putTransaction(blockId, actionId, value); }
	getMaterialized(blockId: BlockId, actionId: ActionId) { return this.inner.getMaterialized(blockId, actionId); }
	putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putMaterialized(blockId, actionId, value); }
	deleteMaterialized(blockId: BlockId, actionId: ActionId) { return this.inner.deleteMaterialized(blockId, actionId); }
	promote(blockId: BlockId, actionId: ActionId) { return this.inner.promote(blockId, actionId); }

	async *listPendingActionIds(blockId: BlockId): AsyncIterable<ActionId> {
		this.listCalls++;
		const drained: ActionId[] = [];
		for await (const id of this.inner.listPendingActionIds(blockId)) {
			drained.push(id);
		}
		if (this.gatePromise) {
			const gate = this.gatePromise;
			this.gatePromise = undefined;
			this.reachedGateResolve?.();
			await gate;
		}
		yield* drained;
	}
}

// --- Full backend-parity conformance over BOTH cached compositions ---

runRawStorageConformance('KvRawStorage over CachedStoreDriver(MemoryStoreDriver)', async () => ({
	storage: new KvRawStorage(new CachedStoreDriver(new MemoryStoreDriver())),
	cleanup: async () => { /* in-memory: nothing to release */ }
}));

runRawStorageConformance('CachedRawStorage over MemoryRawStorage', async () => ({
	storage: new CachedRawStorage(new MemoryRawStorage()),
	cleanup: async () => { /* in-memory: nothing to release */ }
}));

// --- Cache-specific coherence behavior ---

describe('CachedStoreDriver coherence', () => {
	const blockId = 'blk' as BlockId;

	function makeCounted() {
		const counting = new CountingStoreDriver(new MemoryStoreDriver());
		const storage = new KvRawStorage(new CachedStoreDriver(counting));
		return { counting, storage };
	}

	it('write-through metadata: reads after a save never touch the inner driver', async () => {
		const { counting, storage } = makeCounted();
		await storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 1, actionId: 'a1' as ActionId } });

		expect((await storage.getMetadata(blockId))!.latest!.rev).to.equal(1);
		expect((await storage.getMetadata(blockId))!.latest!.rev).to.equal(1);
		expect(counting.count('getMetadata'), 'save populated the cache; no read fell through').to.equal(0);

		// A newer save updates the cache in place — the next read serves the NEW value, still 0 inner reads.
		await storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 2, actionId: 'a2' as ActionId } });
		expect((await storage.getMetadata(blockId))!.latest!.rev).to.equal(2);
		expect(counting.count('getMetadata')).to.equal(0);
	});

	it('negative metadata is cached: repeated probes of an absent block cost one inner read', async () => {
		const { counting, storage } = makeCounted();
		expect(await storage.getMetadata(blockId)).to.equal(undefined);
		expect(await storage.getMetadata(blockId)).to.equal(undefined);
		expect(await storage.getMetadata(blockId)).to.equal(undefined);
		expect(counting.count('getMetadata'), 'one cold miss, then the proven absence is served').to.equal(1);

		// A funnelled create overwrites the negative.
		await storage.saveMetadata(blockId, { ranges: [], latest: undefined });
		expect((await storage.getMetadata(blockId))!.ranges).to.deep.equal([]);
		expect(counting.count('getMetadata')).to.equal(1);
	});

	it('promote with the pending transform cached serves the committed read from cache', async () => {
		const { counting, storage } = makeCounted();
		const transform: Transform = { insert: makeBlock('blk', { items: ['x'] }) };
		await storage.savePendingTransaction(blockId, 'a1' as ActionId, transform);

		await storage.promotePendingTransaction(blockId, 'a1' as ActionId);

		expect(await storage.getTransaction(blockId, 'a1' as ActionId)).to.deep.equal(transform);
		expect(counting.count('getTransaction'), 'committed value moved pending→committed in cache').to.equal(0);
		expect(await storage.getPendingTransaction(blockId, 'a1' as ActionId)).to.equal(undefined);
		expect(counting.count('getPending'), 'funnelled promote proves the pending absence').to.equal(0);
	});

	it('promote with the pending transform NOT cached invalidates a stale committed negative', async () => {
		// Pre-populate a bare storage (a previous process run pended), THEN attach the cache.
		const inner = new MemoryRawStorage();
		const transform: Transform = { insert: makeBlock('blk', { items: ['x'] }) };
		await inner.savePendingTransaction(blockId, 'a1' as ActionId, transform);

		const cached = new CachedRawStorage(inner);
		// Cache a committed negative before the promote.
		expect(await cached.getTransaction(blockId, 'a1' as ActionId)).to.equal(undefined);

		await cached.promotePendingTransaction(blockId, 'a1' as ActionId);

		// The negative must NOT survive the promote; the read falls through to the inner
		// storage and returns the transform (never a synthesized value, never undefined).
		expect(await cached.getTransaction(blockId, 'a1' as ActionId)).to.deep.equal(transform);
		expect(await cached.getPendingTransaction(blockId, 'a1' as ActionId)).to.equal(undefined);
	});

	it('deleteMaterialized caches the proven absence', async () => {
		const { counting, storage } = makeCounted();
		await storage.saveMaterializedBlock(blockId, 'a1' as ActionId, makeBlock('blk'));
		await storage.saveMaterializedBlock(blockId, 'a1' as ActionId, undefined);

		expect(await storage.getMaterializedBlock(blockId, 'a1' as ActionId)).to.equal(undefined);
		expect(await storage.getMaterializedBlock(blockId, 'a1' as ActionId)).to.equal(undefined);
		expect(counting.count('getMaterialized'), 'funnelled delete = proven absence, no fall-through').to.equal(0);
	});

	it('pending list: one enumeration seeds completeness; funnelled writes maintain it', async () => {
		const { counting, storage } = makeCounted();
		await storage.savePendingTransaction(blockId, 'a1' as ActionId, { delete: true });
		await storage.savePendingTransaction(blockId, 'a2' as ActionId, { delete: true });

		expect(new Set(await collect(storage.listPendingTransactions(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(counting.count('listPendingActionIds'), 'first list enumerates the inner driver').to.equal(1);

		expect(new Set(await collect(storage.listPendingTransactions(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(counting.count('listPendingActionIds'), 'second list served from the complete cached set').to.equal(1);

		// A pend after the seed appears WITHOUT re-enumeration; a delete disappears likewise.
		await storage.savePendingTransaction(blockId, 'a3' as ActionId, { delete: true });
		expect(new Set(await collect(storage.listPendingTransactions(blockId)))).to.deep.equal(new Set(['a1', 'a2', 'a3']));
		await storage.deletePendingTransaction(blockId, 'a1' as ActionId);
		expect(new Set(await collect(storage.listPendingTransactions(blockId)))).to.deep.equal(new Set(['a2', 'a3']));
		expect(counting.count('listPendingActionIds')).to.equal(1);
	});

	it('revision coverage: contiguous funnelled writes serve listRevisions with zero inner reads', async () => {
		const { counting, storage } = makeCounted();
		for (let rev = 1; rev <= 5; rev++) {
			await storage.saveRevision(blockId, rev, `a${rev}` as ActionId);
		}
		const revs = await collect(storage.listRevisions(blockId, 1, 5));
		expect(revs.map(r => r.rev)).to.deep.equal([1, 2, 3, 4, 5]);
		expect(counting.count('rangeRevisions'), 'contiguous point coverage merged to [1,5]').to.equal(0);

		// Extending the contiguous run keeps the range served from cache.
		await storage.saveRevision(blockId, 6, 'a6' as ActionId);
		expect((await collect(storage.listRevisions(blockId, 1, 6))).map(r => r.rev)).to.deep.equal([1, 2, 3, 4, 5, 6]);
		// Descending order comes from the same coverage.
		expect((await collect(storage.listRevisions(blockId, 6, 1))).map(r => r.rev)).to.deep.equal([6, 5, 4, 3, 2, 1]);
		expect(counting.count('rangeRevisions')).to.equal(0);
	});

	it('revision coverage: a gap falls through once, then the enumerated range is covered', async () => {
		const { counting, storage } = makeCounted();
		await storage.saveRevision(blockId, 1, 'a1' as ActionId);
		await storage.saveRevision(blockId, 2, 'a2' as ActionId);
		await storage.saveRevision(blockId, 4, 'a4' as ActionId); // rev 3 never written

		// [1,4] spans the uncovered rev 3 → one inner enumeration, which then proves 3 absent.
		expect((await collect(storage.listRevisions(blockId, 1, 4))).map(r => r.rev)).to.deep.equal([1, 2, 4]);
		expect(counting.count('rangeRevisions')).to.equal(1);
		expect((await collect(storage.listRevisions(blockId, 1, 4))).map(r => r.rev)).to.deep.equal([1, 2, 4]);
		expect(counting.count('rangeRevisions'), 'enumerated range now covered').to.equal(1);

		// The proven-absent gap also answers point reads without the inner driver.
		expect(await storage.getRevision(blockId, 3)).to.equal(undefined);
		expect(counting.count('getRevision')).to.equal(0);

		// A wider range than ever proven falls through once more, then is covered.
		expect((await collect(storage.listRevisions(blockId, 0, 6))).map(r => r.rev)).to.deep.equal([1, 2, 4]);
		expect(counting.count('rangeRevisions')).to.equal(2);
		expect((await collect(storage.listRevisions(blockId, 0, 6))).map(r => r.rev)).to.deep.equal([1, 2, 4]);
		expect(counting.count('rangeRevisions')).to.equal(2);
	});

	it('a write landing mid-enumeration vetoes the completeness claim (gen guard)', async () => {
		const gated = new GatedStoreDriver(new MemoryStoreDriver());
		const storage = new KvRawStorage(new CachedStoreDriver(gated));
		await storage.savePendingTransaction(blockId, 'a1' as ActionId, { delete: true });

		gated.armGate();
		const firstListPromise = collect(storage.listPendingTransactions(blockId));
		await gated.reachedGate; // cache's inner drain is provably in flight, parked at the gate
		await storage.savePendingTransaction(blockId, 'a2' as ActionId, { delete: true });
		gated.openGate();

		// The in-flight enumeration drained before the write — snapshot semantics.
		expect(await firstListPromise).to.deep.equal(['a1']);

		// Had completeness been (falsely) claimed for that drain, this list would be served
		// from a cached set that is missing a2, forever. The gen guard forces a re-enumeration.
		expect(new Set(await collect(storage.listPendingTransactions(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(gated.listCalls, 'second list re-enumerated instead of trusting the vetoed drain').to.equal(2);

		// The clean second drain seeds completeness normally.
		expect(new Set(await collect(storage.listPendingTransactions(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(gated.listCalls).to.equal(2);
	});

	it('clearCache at an arbitrary instant is safe: subsequent reads refill from the inner storage', async () => {
		const inner = new MemoryRawStorage();
		const cached = new CachedRawStorage(inner);
		const transform: Transform = { insert: makeBlock('blk', { items: ['x'] }) };

		await cached.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 1, actionId: 'a1' as ActionId } });
		await cached.saveRevision(blockId, 1, 'a1' as ActionId);
		await cached.savePendingTransaction(blockId, 'a1' as ActionId, transform);
		await cached.promotePendingTransaction(blockId, 'a1' as ActionId);
		await cached.saveMaterializedBlock(blockId, 'a1' as ActionId, makeBlock('blk', { items: ['x'] }));

		cached.clearCache();

		expect((await cached.getMetadata(blockId))!.latest!.rev).to.equal(1);
		expect(await cached.getRevision(blockId, 1)).to.equal('a1');
		expect(await cached.getTransaction(blockId, 'a1' as ActionId)).to.deep.equal(transform);
		expect(await cached.getPendingTransaction(blockId, 'a1' as ActionId)).to.equal(undefined);
		expect((await cached.getMaterializedBlock(blockId, 'a1' as ActionId) as IBlock & { items: string[] }).items).to.deep.equal(['x']);
		expect((await collect(cached.listRevisions(blockId, 1, 1))).map(r => r.rev)).to.deep.equal([1]);
		expect(await collect(cached.listPendingTransactions(blockId))).to.deep.equal([]);
	});
});

// --- Cold-start operation-count measurement ---

describe('CachedStoreDriver cold-start op counts', () => {
	/** ≈ the profiled cold start: 6 hot blocks, 22 sequential pend→commit rounds with a
	 * read of every known block after each commit. Insert on a block's first touch,
	 * in-place update after; commit rev is a global counter. */
	async function runWorkload(storage: IRawStorage): Promise<void> {
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

	it('reduces driver reads ≥70% on the cold-start workload and leaves writes untouched', async function () {
		this.timeout(20_000);

		const uncached = new CountingStoreDriver(new MemoryStoreDriver());
		await runWorkload(new KvRawStorage(uncached));

		const cached = new CountingStoreDriver(new MemoryStoreDriver());
		await runWorkload(new KvRawStorage(new CachedStoreDriver(cached)));

		const methods = [...READ_METHODS, ...WRITE_METHODS];
		const pad = (s: string | number, w: number) => String(s).padStart(w);
		console.log('\n      driver op counts (uncached → cached):');
		for (const method of methods) {
			console.log(`        ${method.padEnd(22)} ${pad(uncached.count(method), 5)} → ${pad(cached.count(method), 5)}`);
		}
		const uncachedReads = uncached.total(READ_METHODS);
		const cachedReads = cached.total(READ_METHODS);
		const uncachedWrites = uncached.total(WRITE_METHODS);
		const cachedWrites = cached.total(WRITE_METHODS);
		console.log(`        reads  total          ${pad(uncachedReads, 5)} → ${pad(cachedReads, 5)}  (${(100 * (1 - cachedReads / uncachedReads)).toFixed(1)}% cut)`);
		console.log(`        writes total          ${pad(uncachedWrites, 5)} → ${pad(cachedWrites, 5)}`);

		expect(cachedReads, 'cached reads vs 30% of uncached').to.be.at.most(Math.floor(uncachedReads * 0.3));
		for (const method of WRITE_METHODS) {
			expect(cached.count(method), `write count unchanged: ${method}`).to.equal(uncached.count(method));
		}
	});
});
