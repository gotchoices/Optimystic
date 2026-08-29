import { expect } from 'chai';
import type { BlockId, ActionId } from '@optimystic/db-core';
import { withReadCache } from '../src/storage/with-read-cache.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { MemoryStoreDriver } from '../src/storage/memory-store-driver.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import { SharedCachePool } from '../src/storage/shared-cache-pool.js';
import { CountingStoreDriver, READ_METHODS, runColdStartWorkload } from './support/cache-test-helpers.js';

/**
 * `withReadCache` is the ONE helper both production composition seams go through
 * (`CollectionFactory.createLocalTransactor` in the Quereus plugin, `resolveStorage` in
 * `libp2p-node-base`). The cache's semantics are pinned in `cached-raw-storage.spec.ts`; this
 * spec pins the helper's own contract — what it wraps, what it leaves alone, WHICH RESULT THE
 * CALLER MAY DISPOSE, that the wrapped storage really cuts backend reads, and that the lifecycle
 * it hands the caller works.
 *
 * Counts are taken at the `RawStoreDriver` seam, BELOW the cache. Counting `IRawStorage` calls
 * would measure nothing: the callers above the cache issue exactly the same calls cached or not.
 */
describe('withReadCache (composition-seam helper)', () => {
	const blockId = 'blk' as BlockId;

	it('returns a MemoryRawStorage unchanged, owning nothing (already in memory — nothing to save)', () => {
		const memory = new MemoryRawStorage();
		const resolved = withReadCache(memory, 'spec', new SharedCachePool());
		expect(resolved.storage).to.equal(memory);
		expect(resolved.ownedCache, 'nothing was constructed, so nothing is ours to dispose').to.equal(undefined);
	});

	it('returns an already-cached storage unchanged, owning nothing (never double-wraps)', async () => {
		const pool = new SharedCachePool();
		const once = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'spec', pool);
		expect(once.storage).to.be.instanceOf(CachedRawStorage);
		expect(once.ownedCache, 'the wrapper this call built IS the storage it returned').to.equal(once.storage);

		const again = withReadCache(once.storage, 'spec-again', pool);
		expect(again.storage, 'passed straight through').to.equal(once.storage);
		expect(again.ownedCache, 'the second caller owns nothing — disposing here would retire a cache the host still owns')
			.to.equal(undefined);
		expect(pool.stats().stores, 'one registration, not two').to.have.length(1);
		await once.ownedCache!.dispose();
	});

	it('a shared wrapper survives one consumer departing (the documented multi-consumer recipe)', async () => {
		// The recipe this helper's doc prescribes for several in-process consumers over one store:
		// the HOST builds the cache and hands that same object to each seam. Each seam calls
		// withReadCache, gets it back unchanged, and — because ownedCache is undefined — has
		// nothing to dispose. Before ownership was reported, both seams saw `instanceof
		// CachedRawStorage` and the first to depart unregistered the store from the pool while the
		// other kept reading and charging entries against a handle stats() no longer listed.
		const pool = new SharedCachePool();
		const shared = new CachedRawStorage(new KvRawStorage(new MemoryStoreDriver()), pool, 'host-owned');
		await shared.saveMetadata(blockId, { ranges: [], latest: undefined });
		await shared.getMetadata(blockId);

		const consumerA = withReadCache(shared, 'consumer-a', pool);
		const consumerB = withReadCache(shared, 'consumer-b', pool);
		expect(consumerA.storage).to.equal(shared);
		expect(consumerB.storage).to.equal(shared);
		expect(consumerA.ownedCache).to.equal(undefined);
		expect(consumerB.ownedCache).to.equal(undefined);

		// Consumer A departs. It owns nothing, so there is nothing for it to release.
		expect(pool.stats().stores.map(s => s.label), 'the host store is still registered').to.deep.equal(['host-owned']);
		await consumerB.storage.getMetadata(blockId);
		expect(pool.stats().stores, 'and its occupancy is still attributable to it').to.have.length(1);

		// Only the host retires it.
		await shared.dispose();
		expect(pool.stats().stores).to.have.length(0);
		expect(pool.stats().entries).to.equal(0);
	});

	it('two wraps of ONE unwrapped instance are two independent caches that never converge', async () => {
		// The silent-non-convergence footgun the helper's doc warns about, pinned so the warning
		// stays true: sharing the INNER storage is not sharing the cache. This is why the plugin's
		// cross-writer spec hands both peers one pre-built CachedRawStorage instead.
		const pool = new SharedCachePool();
		const inner = new KvRawStorage(new MemoryStoreDriver());
		const first = withReadCache(inner, 'writer', pool);
		const second = withReadCache(inner, 'reader', pool);
		expect(first.storage, 'each call wrapped again').to.not.equal(second.storage);
		expect(pool.stats().stores, 'two registrations over one backing store').to.have.length(2);

		await first.storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 1, actionId: 'a1' as ActionId } });
		expect((await second.storage.getMetadata(blockId))!.latest!.rev, 'reader sees the first write (cold)').to.equal(1);

		await first.storage.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 2, actionId: 'a2' as ActionId } });
		expect((await second.storage.getMetadata(blockId))!.latest!.rev, 'but never the second: its own cache answers')
			.to.equal(1);

		await first.ownedCache!.dispose();
		await second.ownedCache!.dispose();
	});

	it('wraps a non-memory storage and cuts backend reads on the cold-start workload', async () => {
		// Uncached baseline: the kernel straight over the counting driver.
		const baseline = new CountingStoreDriver(new MemoryStoreDriver());
		await runColdStartWorkload(new KvRawStorage(baseline));

		const counting = new CountingStoreDriver(new MemoryStoreDriver());
		const pool = new SharedCachePool();
		const cached = withReadCache(new KvRawStorage(counting), 'spec', pool);
		expect(cached.storage).to.be.instanceOf(CachedRawStorage);
		await runColdStartWorkload(cached.storage);

		const uncachedReads = baseline.total(READ_METHODS);
		const cachedReads = counting.total(READ_METHODS);
		// The write-through cache measured a ~96% cut on this workload (cached-raw-storage.spec);
		// assert a coarse operation-count bound, never wall clock.
		expect(cachedReads, `cached ${cachedReads} vs uncached ${uncachedReads} backend reads`)
			.to.be.below(uncachedReads / 4);
		expect(counting.count('getMetadata'), 'metadata re-reads are the amplification being fixed')
			.to.be.below(baseline.count('getMetadata') / 4);
		await cached.ownedCache!.dispose();
	});

	it('a reopen over the same backing store starts cold and observes the last write', async () => {
		// The property the plugin specs turn on: close a Database, re-open the same directory,
		// read the post-write value. Modelled here as dispose-then-rewrap over one inner driver.
		const inner = new MemoryStoreDriver();
		const pool = new SharedCachePool();

		const first = withReadCache(new KvRawStorage(inner), 'first', pool).ownedCache!;
		await first.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 1, actionId: 'a1' as ActionId } });
		await first.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 2, actionId: 'a2' as ActionId } });
		expect((await first.getMetadata(blockId))!.latest!.rev).to.equal(2);
		await first.dispose();

		const counting = new CountingStoreDriver(inner);
		const second = withReadCache(new KvRawStorage(counting), 'second', pool).ownedCache!;
		expect((await second.getMetadata(blockId))!.latest!.rev, 'post-write value visible after reopen').to.equal(2);
		expect(counting.count('getMetadata'), 'the reopened cache is cold: one real read').to.equal(1);
		expect((await second.getMetadata(blockId))!.latest!.rev).to.equal(2);
		expect(counting.count('getMetadata'), 'then served from cache').to.equal(1);
		await second.dispose();
	});

	it('dispose releases the store registration from the pool', async () => {
		const pool = new SharedCachePool();
		const cached = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'spec-dispose', pool).ownedCache!;
		await cached.saveMetadata(blockId, { ranges: [], latest: undefined });
		await cached.getMetadata(blockId);

		const registered = pool.stats().stores;
		expect(registered.map(s => s.label)).to.deep.equal(['spec-dispose']);
		expect(pool.stats().entries, 'the save populated the cache').to.be.greaterThan(0);

		await cached.dispose();
		expect(pool.stats().stores, 'store handle retired').to.have.length(0);
		expect(pool.stats().entries, 'and its entries released').to.equal(0);

		// Idempotent.
		await cached.dispose();
		expect(pool.stats().stores).to.have.length(0);
	});
});
