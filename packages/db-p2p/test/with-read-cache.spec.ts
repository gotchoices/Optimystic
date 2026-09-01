import { expect } from 'chai';
import type { BlockId, ActionId } from '@optimystic/db-core';
import { withReadCache } from '../src/storage/with-read-cache.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { MemoryStoreDriver } from '../src/storage/memory-store-driver.js';
import type { RawStoreDriver } from '../src/storage/raw-store-driver.js';
import type { StoreIdentity } from '../src/storage/store-identity.js';
import type { IRawStorage } from '../src/storage/i-raw-storage.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import { CachedStoreDriver } from '../src/storage/cached-store-driver.js';
import { SharedCachePool } from '../src/storage/shared-cache-pool.js';
import { CountingStoreDriver, READ_METHODS, runColdStartWorkload } from './support/cache-test-helpers.js';

/**
 * `withReadCache` is the ONE helper both production composition seams go through
 * (`CollectionFactory.createLocalTransactor` in the Quereus plugin, `resolveStorage` in
 * `libp2p-node-base`). The cache's semantics are pinned in `cached-raw-storage.spec.ts`; this
 * spec pins the helper's own contract — what it wraps, what it leaves alone, that two callers
 * over ONE backing store get ONE cache (by store identity, or by object when the backend reports
 * none), that the lease lifecycle it hands the caller tears the cache down exactly when the last
 * consumer departs, and that the wrapped storage really cuts backend reads.
 *
 * Counts are taken at the `RawStoreDriver` seam, BELOW the cache. Counting `IRawStorage` calls
 * would measure nothing: the callers above the cache issue exactly the same calls cached or not.
 */
describe('withReadCache (composition-seam helper)', () => {
	const blockId = 'blk' as BlockId;
	const meta = (rev: number): Parameters<IRawStorage['saveMetadata']>[1] =>
		({ ranges: [[1]], latest: { rev, actionId: `a${rev}` as ActionId } });

	/**
	 * A driver that reports a fixed store identity — the shape `FileRawStorage` presents (two
	 * instances over one directory report one identity) without touching a disk. Every other
	 * call forwards to `inner`, so several identified drivers over one memory driver ARE one
	 * backing store.
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

	it('returns a MemoryRawStorage unchanged, with no lease (already in memory — nothing to save)', () => {
		const memory = new MemoryRawStorage();
		const resolved = withReadCache(memory, 'spec', new SharedCachePool());
		expect(resolved.storage).to.equal(memory);
		expect(resolved.lease, 'nothing was constructed, so there is nothing to claim').to.equal(undefined);
	});

	it('returns an already-cached storage unchanged, with no lease (never double-wraps)', async () => {
		const pool = new SharedCachePool();
		const once = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'spec', pool);
		expect(once.storage).to.be.instanceOf(CachedRawStorage);
		expect(once.lease!.cache, 'the lease is a claim on the cache this call returned').to.equal(once.storage);

		const again = withReadCache(once.storage, 'spec-again', pool);
		expect(again.storage, 'passed straight through').to.equal(once.storage);
		expect(again.lease, 'the second caller holds no claim — the host that built the cache still owns it')
			.to.equal(undefined);
		expect(pool.stats().stores, 'one registration, not two').to.have.length(1);
		await once.lease!.release();
	});

	it('a host-built wrapper survives one consumer departing (host-owned caches never enter the registry)', async () => {
		// A host that builds the cache itself and hands that same object to each seam: each seam
		// gets it back unchanged with no lease, so nothing a seam does can retire it. Before
		// ownership was reported, both seams saw `instanceof CachedRawStorage` and the first to
		// depart unregistered the store from the pool while the other kept reading and charging
		// entries against a handle stats() no longer listed.
		const pool = new SharedCachePool();
		const shared = new CachedRawStorage(new KvRawStorage(new MemoryStoreDriver()), pool, 'host-owned');
		await shared.saveMetadata(blockId, { ranges: [], latest: undefined });
		await shared.getMetadata(blockId);

		const consumerA = withReadCache(shared, 'consumer-a', pool);
		const consumerB = withReadCache(shared, 'consumer-b', pool);
		expect(consumerA.storage).to.equal(shared);
		expect(consumerB.storage).to.equal(shared);
		expect(consumerA.lease).to.equal(undefined);
		expect(consumerB.lease).to.equal(undefined);

		// Consumer A departs. It holds nothing, so there is nothing for it to release.
		expect(pool.stats().stores.map(s => s.label), 'the host store is still registered').to.deep.equal(['host-owned']);
		await consumerB.storage.getMetadata(blockId);
		expect(pool.stats().stores, 'and its occupancy is still attributable to it').to.have.length(1);

		// Only the host retires it.
		await shared.dispose();
		expect(pool.stats().stores).to.have.length(0);
		expect(pool.stats().entries).to.equal(0);
	});

	it('two wraps of ONE unwrapped instance converge on one cache (keyed by object when there is no identity)', async () => {
		// The footgun this helper used to pin as a warning: sharing the INNER storage was not
		// sharing the cache, so each call wrapped it again and the reader's own cache answered
		// forever. Now the second call finds the first call's cache.
		const pool = new SharedCachePool();
		const inner = new KvRawStorage(new MemoryStoreDriver());
		expect(inner.getStoreIdentity, 'the memory driver reports no identity — this is the object-key path').to.equal(undefined);
		const writer = withReadCache(inner, 'writer', pool);
		const reader = withReadCache(inner, 'reader', pool);
		expect(reader.storage, 'the same wrapper came back').to.equal(writer.storage);
		expect(reader.lease, 'under a distinct lease').to.not.equal(writer.lease);
		expect(pool.stats().stores, 'one registration over one backing store').to.have.length(1);

		await writer.storage.saveMetadata(blockId, meta(1));
		expect((await reader.storage.getMetadata(blockId))!.latest!.rev, 'reader sees the first write').to.equal(1);
		await writer.storage.saveMetadata(blockId, meta(2));
		expect((await reader.storage.getMetadata(blockId))!.latest!.rev, 'AND the second — one cache, write-through')
			.to.equal(2);

		await writer.lease!.release();
		await reader.lease!.release();
	});

	it('two storages reporting the same store identity dedupe to one cache and one pool registration', async () => {
		// Two `FileRawStorage(dir)` over one `dir`, modelled: two DISTINCT storage objects whose
		// drivers report one identity over one backing driver.
		const pool = new SharedCachePool();
		const backing = new MemoryStoreDriver();
		const storageA = new KvRawStorage(identified(backing, 'spec:same-store'));
		const storageB = new KvRawStorage(identified(backing, 'spec:same-store'));
		expect(storageA, 'distinct objects').to.not.equal(storageB);
		expect(storageA.getStoreIdentity!()).to.equal(storageB.getStoreIdentity!());

		const a = withReadCache(storageA, 'a', pool);
		const b = withReadCache(storageB, 'b', pool);
		expect(b.storage, 'one wrapper for both').to.equal(a.storage);
		expect(pool.stats().stores, 'one registration').to.have.length(1);

		await a.storage.saveMetadata(blockId, meta(1));
		await a.storage.saveMetadata(blockId, meta(2));
		expect((await b.storage.getMetadata(blockId))!.latest!.rev, 'a write through one is visible through the other')
			.to.equal(2);

		await a.lease!.release();
		await b.lease!.release();
		expect(pool.stats().stores).to.have.length(0);
	});

	it('the identity key is retired on the last release: a re-wrap is cold and the stale lease is inert', async () => {
		// The refcount test below walks this lifecycle on the OBJECT key; production walks it on
		// the IDENTITY key (two `FileRawStorage` over one dir), where retirement is a `Map.delete`
		// rather than a `WeakMap.delete` and the key outlives every storage object that used it. A
		// leftover entry here would hand a re-opened store a dead cache; a successor entry retired
		// by the departed lease would blind the store that just re-opened it.
		const pool = new SharedCachePool();
		const backing = new MemoryStoreDriver();
		const identity = 'spec:retired-identity';
		const counting = new CountingStoreDriver(backing);

		const first = withReadCache(new KvRawStorage(identified(counting, identity)), 'first', pool);
		await first.storage.saveMetadata(blockId, meta(1));
		await first.lease!.release();
		expect(pool.stats().stores, 'the identity entry was retired, not just emptied').to.have.length(0);

		// A DIFFERENT storage object under the same identity: a stale byIdentity entry would hand
		// back the dead cache instead of building one.
		const reopened = withReadCache(new KvRawStorage(identified(counting, identity)), 'reopened', pool);
		expect(reopened.storage, 'a fresh cache, not the retired one').to.not.equal(first.storage);
		expect(pool.stats().stores.map(s => s.label)).to.deep.equal(['reopened']);
		const readsBefore = counting.count('getMetadata');
		expect((await reopened.storage.getMetadata(blockId))!.latest!.rev, 'reads the store, not a stale cache').to.equal(1);
		expect(counting.count('getMetadata'), 'cold: one real backend read').to.equal(readsBefore + 1);

		// The departed lease must not retire the successor registered under the same identity.
		await first.lease!.release();
		expect(pool.stats().stores, 'the stale lease is inert against its successor').to.have.length(1);
		await reopened.lease!.release();
		expect(pool.stats().stores).to.have.length(0);
	});

	it('distinct identities, and identity-less distinct objects, keep independent caches', async () => {
		// The dedupe must not over-merge: several db-p2p specs build two caches over two memory
		// drivers and compare them, and two stores that merely LOOK alike must stay apart.
		const pool = new SharedCachePool();
		const byIdentityA = withReadCache(new KvRawStorage(identified(new MemoryStoreDriver(), 'spec:x')), 'x', pool);
		const byIdentityB = withReadCache(new KvRawStorage(identified(new MemoryStoreDriver(), 'spec:y')), 'y', pool);
		expect(byIdentityA.storage).to.not.equal(byIdentityB.storage);

		const objectA = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'obj-a', pool);
		const objectB = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'obj-b', pool);
		expect(objectA.storage).to.not.equal(objectB.storage);
		expect(pool.stats().stores, 'four stores, four registrations').to.have.length(4);

		for (const resolved of [byIdentityA, byIdentityB, objectA, objectB]) await resolved.lease!.release();
		expect(pool.stats().stores).to.have.length(0);
	});

	it('refcount lifecycle: the cache outlives the first departure and dies with the last; a re-wrap starts cold', async () => {
		const pool = new SharedCachePool();
		const counting = new CountingStoreDriver(new MemoryStoreDriver());
		const inner = new KvRawStorage(counting);

		const a = withReadCache(inner, 'a', pool);
		const b = withReadCache(inner, 'b', pool);
		await a.storage.saveMetadata(blockId, meta(1));
		await b.storage.getMetadata(blockId);
		const readsAfterWarm = counting.count('getMetadata');

		// A departs: B still reads through a live, pool-registered cache.
		await a.lease!.release();
		expect(pool.stats().stores, 'still registered').to.have.length(1);
		expect(pool.stats().entries, 'entries intact').to.be.greaterThan(0);
		expect((await b.storage.getMetadata(blockId))!.latest!.rev).to.equal(1);
		expect(counting.count('getMetadata'), 'served from the surviving cache, no backend read').to.equal(readsAfterWarm);

		// B departs: cleared, unregistered, forgotten.
		await b.lease!.release();
		expect(pool.stats().stores, 'registration retired').to.have.length(0);
		expect(pool.stats().entries, 'entries released').to.equal(0);

		// A later wrap over the same store builds a fresh cold cache.
		const c = withReadCache(inner, 'c', pool);
		expect(c.storage, 'a new wrapper, not the dead one').to.not.equal(a.storage);
		expect((await c.storage.getMetadata(blockId))!.latest!.rev).to.equal(1);
		expect(counting.count('getMetadata'), 'cold: one real backend read').to.equal(readsAfterWarm + 1);
		await c.lease!.release();
	});

	it('release() twice on one lease retires the store exactly once, and concurrent releases land one disposal', async () => {
		const pool = new SharedCachePool();
		const inner = new KvRawStorage(new MemoryStoreDriver());

		const solo = withReadCache(inner, 'solo', pool);
		await solo.storage.saveMetadata(blockId, meta(1));
		await solo.lease!.release();
		expect(pool.stats().stores).to.have.length(0);
		await solo.lease!.release();
		expect(pool.stats().stores, 'a double release does not decrement twice or throw').to.have.length(0);

		// A second lease over the same (now re-wrapped) store must not be retired by the stale one.
		const a = withReadCache(inner, 'a', pool);
		const b = withReadCache(inner, 'b', pool);
		expect(pool.stats().stores).to.have.length(1);
		await solo.lease!.release();
		expect(pool.stats().stores, 'the already-released lease is inert').to.have.length(1);
		await Promise.all([a.lease!.release(), b.lease!.release()]);
		expect(pool.stats().stores, 'both released concurrently: exactly one disposal, nothing left').to.have.length(0);
	});

	it('a different pool on the second wrap is ignored — identity beats sizing', async () => {
		// A same-store-different-pool pair would be two caches over one store, which is the thing
		// dedupe removes. So the first wrap fixes the pool; the second caller joins that cache.
		const firstPool = new SharedCachePool();
		const secondPool = new SharedCachePool();
		const inner = new KvRawStorage(new MemoryStoreDriver());
		const first = withReadCache(inner, 'first', firstPool);
		const second = withReadCache(inner, 'second', secondPool);
		expect(second.storage).to.equal(first.storage);
		await second.storage.saveMetadata(blockId, meta(1));
		expect(firstPool.stats().stores, 'the first pool keeps the registration').to.have.length(1);
		expect(secondPool.stats().stores, 'the second pool never saw it').to.have.length(0);
		await first.lease!.release();
		await second.lease!.release();
		expect(firstPool.stats().stores).to.have.length(0);
	});

	it('the first caller\'s label is the one pool.stats() shows for a shared cache', async () => {
		const pool = new SharedCachePool();
		const inner = new KvRawStorage(new MemoryStoreDriver());
		const first = withReadCache(inner, 'node:alpha', pool);
		const second = withReadCache(inner, 'quereus:local', pool);
		expect(pool.stats().stores.map(s => s.label), 'first label wins; the second caller\'s is not recorded anywhere')
			.to.deep.equal(['node:alpha']);
		await first.lease!.release();
		expect(pool.stats().stores.map(s => s.label), 'and it stays after the first caller departs').to.deep.equal(['node:alpha']);
		await second.lease!.release();
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
		await cached.lease!.release();
	});

	it('a reopen over the same backing store starts cold and observes the last write', async () => {
		// The property the plugin specs turn on: close a Database (releasing its lease), re-open
		// the same directory, read the post-write value. Modelled here as release-then-rewrap
		// over one inner driver.
		const inner = new MemoryStoreDriver();
		const pool = new SharedCachePool();

		const first = withReadCache(new KvRawStorage(inner), 'first', pool);
		await first.storage.saveMetadata(blockId, meta(1));
		await first.storage.saveMetadata(blockId, meta(2));
		expect((await first.storage.getMetadata(blockId))!.latest!.rev).to.equal(2);
		await first.lease!.release();

		const counting = new CountingStoreDriver(inner);
		const second = withReadCache(new KvRawStorage(counting), 'second', pool);
		expect((await second.storage.getMetadata(blockId))!.latest!.rev, 'post-write value visible after reopen').to.equal(2);
		expect(counting.count('getMetadata'), 'the reopened cache is cold: one real read').to.equal(1);
		expect((await second.storage.getMetadata(blockId))!.latest!.rev).to.equal(2);
		expect(counting.count('getMetadata'), 'then served from cache').to.equal(1);
		await second.lease!.release();
	});

	it('releasing the only lease retires the store registration from the pool', async () => {
		const pool = new SharedCachePool();
		const cached = withReadCache(new KvRawStorage(new MemoryStoreDriver()), 'spec-dispose', pool);
		await cached.storage.saveMetadata(blockId, { ranges: [], latest: undefined });
		await cached.storage.getMetadata(blockId);

		const registered = pool.stats().stores;
		expect(registered.map(s => s.label)).to.deep.equal(['spec-dispose']);
		expect(pool.stats().entries, 'the save populated the cache').to.be.greaterThan(0);

		await cached.lease!.release();
		expect(pool.stats().stores, 'store handle retired').to.have.length(0);
		expect(pool.stats().entries, 'and its entries released').to.equal(0);

		// Idempotent.
		await cached.lease!.release();
		expect(pool.stats().stores).to.have.length(0);
	});

	// --- "already read-cached" is a reported capability, not a class ---
	//
	// `docs/storage.md` documents TWO cache constructions and recommends the driver-level one
	// when the backend's `RawStoreDriver` is reachable. Only the storage-level one produces a
	// `CachedRawStorage`, so a class check here misread the recommended shape as uncached and
	// tried to attach a SECOND cache. These pin the marker (`IRawStorage.readCached`) instead.

	it('returns a driver-level cache unchanged, with no lease (the recommended construction)', () => {
		// The reproduction. Before the marker this THREW out of `SharedCachePool.registerStore`
		// — the host's identity was already claimed by its own cache — with a message about two
		// views never converging and a suggestion to call the very helper that was throwing.
		const pool = new SharedCachePool();
		const hostBuilt = new KvRawStorage(
			new CachedStoreDriver(identified(new MemoryStoreDriver(), 'spec:drv-level'), pool, 'host-built'));

		const resolved = withReadCache(hostBuilt, 'seam', pool);
		expect(resolved.storage, 'passed straight through').to.equal(hostBuilt);
		expect(resolved.lease, 'a pass-through mints no lease — the cache is the host\'s to dispose')
			.to.equal(undefined);
		expect(pool.stats().stores.map(s => s.label), 'one registration, the host\'s')
			.to.deep.equal(['host-built']);
	});

	it('returns an identity-less driver-level cache unchanged too (no identity, so nothing threw before — it stacked)', () => {
		// The quieter half: with no store identity the pool's guard never fires, so before the
		// marker this silently returned a DOUBLY cached storage under a lease. Pure overhead,
		// and only a pass-through assertion catches it.
		const pool = new SharedCachePool();
		const hostBuilt = new KvRawStorage(new CachedStoreDriver(new MemoryStoreDriver(), pool, 'host-built'));

		const resolved = withReadCache(hostBuilt, 'seam', pool);
		expect(resolved.storage, 'passed straight through').to.equal(hostBuilt);
		expect(resolved.lease, 'and unleased — no second cache was built').to.equal(undefined);
		expect(pool.stats().stores.map(s => s.label)).to.deep.equal(['host-built']);
	});

	it('the readCached marker is present for both cache constructions and absent otherwise', async () => {
		const pool = new SharedCachePool();
		const driverLevel = new KvRawStorage(new CachedStoreDriver(new MemoryStoreDriver(), pool));
		const storageLevel = new CachedRawStorage(new MemoryRawStorage(), pool);

		expect(driverLevel.readCached, 'driver-level: KvRawStorage over a CachedStoreDriver').to.equal(true);
		expect(storageLevel.readCached, 'storage-level: CachedRawStorage').to.equal(true);
		expect(new KvRawStorage(new MemoryStoreDriver()).readCached, 'uncached kernel: absent, never false')
			.to.equal(undefined);
		expect(new MemoryRawStorage().readCached, 'memory backend: absent').to.equal(undefined);

		await storageLevel.dispose();
	});
});
