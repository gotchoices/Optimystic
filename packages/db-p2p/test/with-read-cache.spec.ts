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
 * spec pins the helper's own contract — what it wraps, what it leaves alone, that the wrapped
 * storage really cuts backend reads, and that the lifecycle it hands the caller works.
 *
 * Counts are taken at the `RawStoreDriver` seam, BELOW the cache. Counting `IRawStorage` calls
 * would measure nothing: the callers above the cache issue exactly the same calls cached or not.
 */
describe('withReadCache (composition-seam helper)', () => {
	const blockId = 'blk' as BlockId;

	it('returns a MemoryRawStorage unchanged (already in memory — nothing to save)', () => {
		const memory = new MemoryRawStorage();
		expect(withReadCache(memory, 'spec', new SharedCachePool())).to.equal(memory);
	});

	it('returns an already-cached storage unchanged (never double-wraps)', async () => {
		const pool = new SharedCachePool();
		const once = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'spec', pool);
		expect(once).to.be.instanceOf(CachedRawStorage);
		expect(withReadCache(once, 'spec-again', pool)).to.equal(once);
		expect(pool.stats().stores, 'one registration, not two').to.have.length(1);
		await (once as CachedRawStorage).dispose();
	});

	it('wraps a non-memory storage and cuts backend reads on the cold-start workload', async () => {
		// Uncached baseline: the kernel straight over the counting driver.
		const baseline = new CountingStoreDriver(new MemoryStoreDriver());
		await runColdStartWorkload(new KvRawStorage(baseline));

		const counting = new CountingStoreDriver(new MemoryStoreDriver());
		const pool = new SharedCachePool();
		const cached = withReadCache(new KvRawStorage(counting), 'spec', pool);
		expect(cached).to.be.instanceOf(CachedRawStorage);
		await runColdStartWorkload(cached);

		const uncachedReads = baseline.total(READ_METHODS);
		const cachedReads = counting.total(READ_METHODS);
		// The write-through cache measured a ~96% cut on this workload (cached-raw-storage.spec);
		// assert a coarse operation-count bound, never wall clock.
		expect(cachedReads, `cached ${cachedReads} vs uncached ${uncachedReads} backend reads`)
			.to.be.below(uncachedReads / 4);
		expect(counting.count('getMetadata'), 'metadata re-reads are the amplification being fixed')
			.to.be.below(baseline.count('getMetadata') / 4);
		await (cached as CachedRawStorage).dispose();
	});

	it('a reopen over the same backing store starts cold and observes the last write', async () => {
		// The property the plugin specs turn on: close a Database, re-open the same directory,
		// read the post-write value. Modelled here as dispose-then-rewrap over one inner driver.
		const inner = new MemoryStoreDriver();
		const pool = new SharedCachePool();

		const first = withReadCache(new KvRawStorage(inner), 'first', pool) as CachedRawStorage;
		await first.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 1, actionId: 'a1' as ActionId } });
		await first.saveMetadata(blockId, { ranges: [[1]], latest: { rev: 2, actionId: 'a2' as ActionId } });
		expect((await first.getMetadata(blockId))!.latest!.rev).to.equal(2);
		await first.dispose();

		const counting = new CountingStoreDriver(inner);
		const second = withReadCache(new KvRawStorage(counting), 'second', pool) as CachedRawStorage;
		expect((await second.getMetadata(blockId))!.latest!.rev, 'post-write value visible after reopen').to.equal(2);
		expect(counting.count('getMetadata'), 'the reopened cache is cold: one real read').to.equal(1);
		expect((await second.getMetadata(blockId))!.latest!.rev).to.equal(2);
		expect(counting.count('getMetadata'), 'then served from cache').to.equal(1);
		await second.dispose();
	});

	it('dispose releases the store registration from the pool', async () => {
		const pool = new SharedCachePool();
		const cached = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'spec-dispose', pool) as CachedRawStorage;
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
