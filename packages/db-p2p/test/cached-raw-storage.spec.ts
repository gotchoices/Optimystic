import { expect } from 'chai';
import type { BlockId, ActionId, IBlock, Transform } from '@optimystic/db-core';
import { makeProof, runRawStorageConformance } from '../src/testing/raw-storage-conformance.js';
import type { RawStoreDriver } from '../src/storage/raw-store-driver.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { MemoryStoreDriver } from '../src/storage/memory-store-driver.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { CachedStoreDriver } from '../src/storage/cached-store-driver.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import { SharedCachePool } from '../src/storage/shared-cache-pool.js';
import type { StoreIdentity } from '../src/storage/store-identity.js';
import {
	CountingStoreDriver, READ_METHODS, WRITE_METHODS,
	makeBlock, collect, runColdStartWorkload,
} from './support/cache-test-helpers.js';

/** A one-shot rendezvous: arm it, `await reached` once the code under test parks, do
 * whatever must land "mid-operation", then `open()`. Deterministic — no timing sleeps. */
class Gate {
	/** Resolves once an armed operation has parked at the gate. */
	reached: Promise<void> | undefined;
	private held: Promise<void> | undefined;
	private openResolve: (() => void) | undefined;
	private reachedResolve: (() => void) | undefined;

	arm(): void {
		this.held = new Promise<void>(res => { this.openResolve = res; });
		this.reached = new Promise<void>(res => { this.reachedResolve = res; });
	}

	open(): void {
		this.openResolve?.();
		this.openResolve = undefined;
	}

	/** Park here if armed; consumes the arming so only the next operation waits. */
	async pass(): Promise<void> {
		if (!this.held) return;
		const held = this.held;
		this.held = undefined;
		this.reachedResolve?.();
		await held;
	}
}

/** Delegates to a memory driver, but when armed, an inner read pauses at a gate after
 * reading and before returning — so a test can land writes (and a `clear()`) with the
 * cache's inner call provably in flight. `listGate` parks the pending-list enumeration
 * after its drain; `metadataGate` parks a point metadata read after its inner fetch. */
class GatedStoreDriver implements RawStoreDriver {
	listCalls = 0;
	readonly listGate = new Gate();
	readonly metadataGate = new Gate();

	constructor(private readonly inner: MemoryStoreDriver) {}

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		const bytes = await this.inner.getMetadata(blockId);
		await this.metadataGate.pass();
		return bytes;
	}
	putMetadata(blockId: BlockId, value: Uint8Array) { return this.inner.putMetadata(blockId, value); }
	getRevision(blockId: BlockId, rev: number) { return this.inner.getRevision(blockId, rev); }
	putRevision(blockId: BlockId, rev: number, value: Uint8Array) { return this.inner.putRevision(blockId, rev, value); }
	rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean) { return this.inner.rangeRevisions(blockId, lo, hi, reverse); }
	getPending(blockId: BlockId, actionId: ActionId) { return this.inner.getPending(blockId, actionId); }
	putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putPending(blockId, actionId, value); }
	deletePending(blockId: BlockId, actionId: ActionId) { return this.inner.deletePending(blockId, actionId); }
	getTransaction(blockId: BlockId, actionId: ActionId) { return this.inner.getTransaction(blockId, actionId); }
	putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putTransaction(blockId, actionId, value); }
	getProof(blockId: BlockId, rev: number) { return this.inner.getProof(blockId, rev); }
	putProof(blockId: BlockId, rev: number, value: Uint8Array) { return this.inner.putProof(blockId, rev, value); }
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
		await this.listGate.pass();
		yield* drained;
	}
}

/** Delegates to a memory driver, failing the next `putMetadata` once — so a test can
 * observe what the cache does when an inner write leaves the backend in an unknown state. */
class FaultyStoreDriver implements RawStoreDriver {
	failNextPutMetadata = false;
	metadataReads = 0;

	constructor(private readonly inner: MemoryStoreDriver) {}

	async getMetadata(blockId: BlockId): Promise<Uint8Array | undefined> {
		this.metadataReads++;
		return this.inner.getMetadata(blockId);
	}
	async putMetadata(blockId: BlockId, value: Uint8Array): Promise<void> {
		if (this.failNextPutMetadata) {
			this.failNextPutMetadata = false;
			throw new Error('inner putMetadata failed');
		}
		return this.inner.putMetadata(blockId, value);
	}
	getRevision(blockId: BlockId, rev: number) { return this.inner.getRevision(blockId, rev); }
	putRevision(blockId: BlockId, rev: number, value: Uint8Array) { return this.inner.putRevision(blockId, rev, value); }
	rangeRevisions(blockId: BlockId, lo: number, hi: number, reverse: boolean) { return this.inner.rangeRevisions(blockId, lo, hi, reverse); }
	getPending(blockId: BlockId, actionId: ActionId) { return this.inner.getPending(blockId, actionId); }
	putPending(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putPending(blockId, actionId, value); }
	deletePending(blockId: BlockId, actionId: ActionId) { return this.inner.deletePending(blockId, actionId); }
	listPendingActionIds(blockId: BlockId) { return this.inner.listPendingActionIds(blockId); }
	getTransaction(blockId: BlockId, actionId: ActionId) { return this.inner.getTransaction(blockId, actionId); }
	putTransaction(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putTransaction(blockId, actionId, value); }
	getProof(blockId: BlockId, rev: number) { return this.inner.getProof(blockId, rev); }
	putProof(blockId: BlockId, rev: number, value: Uint8Array) { return this.inner.putProof(blockId, rev, value); }
	getMaterialized(blockId: BlockId, actionId: ActionId) { return this.inner.getMaterialized(blockId, actionId); }
	putMaterialized(blockId: BlockId, actionId: ActionId, value: Uint8Array) { return this.inner.putMaterialized(blockId, actionId, value); }
	deleteMaterialized(blockId: BlockId, actionId: ActionId) { return this.inner.deleteMaterialized(blockId, actionId); }
	promote(blockId: BlockId, actionId: ActionId) { return this.inner.promote(blockId, actionId); }
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

	// Proofs are a deliberate PASSTHROUGH (see the NOTE at CachedStoreDriver.getProof): they get no
	// cache namespace, so every read must reach the inner driver. Pinned so that adding a proofs
	// namespace without coherence rules — the way the transactions store incidentally cached proofs
	// before they got their own keyspace — fails here rather than going unnoticed.
	it('proofs are never cached: every read reaches the inner driver', async () => {
		const { counting, storage } = makeCounted();
		await storage.saveBlockProof(blockId, 1, makeProof('pass'));
		expect(counting.count('putProof'), 'the write goes straight through').to.equal(1);

		expect((await storage.getBlockProof(blockId, 1))!.messageHash).to.equal('hash-pass');
		expect((await storage.getBlockProof(blockId, 1))!.messageHash).to.equal('hash-pass');
		expect(counting.count('getProof'), 'a write-through cache would have served these').to.equal(2);

		// Absence is not cached either — a repeated miss still costs an inner read each time.
		expect(await storage.getBlockProof(blockId, 2)).to.equal(undefined);
		expect(await storage.getBlockProof(blockId, 2)).to.equal(undefined);
		expect(counting.count('getProof')).to.equal(4);
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

		gated.listGate.arm();
		const firstListPromise = collect(storage.listPendingTransactions(blockId));
		await gated.listGate.reached; // cache's inner drain is provably in flight, parked at the gate
		await storage.savePendingTransaction(blockId, 'a2' as ActionId, { delete: true });
		gated.listGate.open();

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

	it('a clear() landing during an in-flight read never reinstalls the pre-clear value', async () => {
		const gated = new GatedStoreDriver(new MemoryStoreDriver());
		const cache = new CachedStoreDriver(gated);
		const storage = new KvRawStorage(cache);

		await storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 1, actionId: 'a1' as ActionId } });
		cache.clear(); // durable rev 1, cache empty — the read below is a genuine cold miss

		gated.metadataGate.arm();
		const inFlight = storage.getMetadata(blockId);
		await gated.metadataGate.reached; // the inner read has returned rev 1 and is parked

		// A newer write lands (cached on the CURRENT state object), then clear() discards it.
		await storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 2, actionId: 'a2' as ActionId } });
		cache.clear();
		gated.metadataGate.open();

		// The in-flight read still returns its own snapshot — that value is simply older,
		// exactly as an uncached driver read overlapping the same write would be.
		expect((await inFlight)!.latest!.rev).to.equal(1);

		// What must NOT happen: that snapshot being filled into the post-clear state, where
		// it would outlive the rev-2 write that the clear took with it and be served forever.
		expect((await storage.getMetadata(blockId))!.latest!.rev, 'post-clear read reflects the newest durable value').to.equal(2);
	});

	it('a failed inner write drops the entry to unknown rather than caching a guess', async () => {
		const faulty = new FaultyStoreDriver(new MemoryStoreDriver());
		const storage = new KvRawStorage(new CachedStoreDriver(faulty));

		await storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 1, actionId: 'a1' as ActionId } });
		expect((await storage.getMetadata(blockId))!.latest!.rev).to.equal(1);
		expect(faulty.metadataReads, 'the successful save populated the cache').to.equal(0);

		faulty.failNextPutMetadata = true;
		let error: Error | undefined;
		try {
			await storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 2, actionId: 'a2' as ActionId } });
		} catch (err) {
			error = err as Error;
		}
		expect(error?.message, 'the inner failure propagates').to.equal('inner putMetadata failed');

		// The backend state is unknown after the failure, so the cache must hold NEITHER the
		// attempted rev 2 nor the stale rev 1 — the next read has to consult the driver.
		expect((await storage.getMetadata(blockId))!.latest!.rev).to.equal(1);
		expect(faulty.metadataReads, 'the failed write invalidated, forcing a fall-through').to.equal(1);
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

// --- The one-cache-per-backing-store guard, through the real construction path ---

describe('CachedRawStorage over an already-cached backing store', () => {
	/**
	 * A driver reporting a fixed store identity — the shape `FileRawStorage` presents (two
	 * instances over one directory report ONE identity) without touching a disk. Each call
	 * forwards to its own memory driver, so the two storages below are genuinely two objects
	 * that merely CLAIM to be one store, which is exactly the bad wiring under test.
	 */
	function identified(inner: RawStoreDriver, identity: StoreIdentity): RawStoreDriver {
		return new Proxy(inner, {
			get(target, prop, _receiver) {
				if (prop === 'storeIdentity') return () => identity;
				const value = Reflect.get(target, prop, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	}

	const storageOver = (identity: StoreIdentity) =>
		new KvRawStorage(identified(new MemoryStoreDriver(), identity));

	it('refuses the second construction, and accepts it once the first is disposed', async () => {
		// The hole `withReadCache`'s dedupe cannot close: a host hand-builds a cache over a store,
		// and something else hand-builds a second one over the same store. Both are supported
		// constructions, so registration — the choke point they share — is where it is caught.
		const pool = new SharedCachePool();
		const first = new CachedRawStorage(storageOver('test:one-store'), pool, 'host-built');

		expect(() => new CachedRawStorage(storageOver('test:one-store'), pool, 'second-consumer'))
			.to.throw(/never converge/);
		expect(pool.stats().stores.map(s => s.label), 'the refused construction registered nothing')
			.to.deep.equal(['host-built']);

		// Sequential reuse: the store is free again once its cache departs.
		await first.dispose();
		const second = new CachedRawStorage(storageOver('test:one-store'), pool, 'second-consumer');
		expect(pool.stats().stores.map(s => s.label)).to.deep.equal(['second-consumer']);
		await second.dispose();
	});

	it('leaves identity-less backings alone: two caches over two memory storages coexist', async () => {
		const pool = new SharedCachePool();
		const a = new CachedRawStorage(new MemoryRawStorage(), pool, 'mem-a');
		const b = new CachedRawStorage(new MemoryRawStorage(), pool, 'mem-b');
		expect(pool.stats().stores.map(s => s.label)).to.deep.equal(['mem-a', 'mem-b']);
		await a.dispose();
		await b.dispose();
	});
});

// --- Cold-start operation-count measurement ---

describe('CachedStoreDriver cold-start op counts', () => {
	it('reduces driver reads ≥70% on the cold-start workload and leaves writes untouched', async function () {
		this.timeout(20_000);

		const uncached = new CountingStoreDriver(new MemoryStoreDriver());
		await runColdStartWorkload(new KvRawStorage(uncached));

		const cached = new CountingStoreDriver(new MemoryStoreDriver());
		await runColdStartWorkload(new KvRawStorage(new CachedStoreDriver(cached)));

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
