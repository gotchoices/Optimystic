import { expect } from 'chai';
import type { BlockId, ActionId, Transform } from '@optimystic/db-core';
import { runRawStorageConformance } from '../src/testing/raw-storage-conformance.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { MemoryStoreDriver } from '../src/storage/memory-store-driver.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { CachedStoreDriver } from '../src/storage/cached-store-driver.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import {
	SharedCachePool,
	type CacheStoreHandle,
	type PoolEntry,
	type PoolEntryOwner,
} from '../src/storage/shared-cache-pool.js';
import {
	CountingStoreDriver, READ_METHODS, WRITE_METHODS,
	makeBlock, collect, runColdStartWorkload,
} from './support/cache-test-helpers.js';

/** Records evicted keys, in order — the whole owner contract for direct pool driving. */
class RecordingOwner implements PoolEntryOwner {
	readonly evicted: string[] = [];
	onPoolEvict(entry: PoolEntry): void {
		this.evicted.push(entry.key);
	}
}

/** Build a bare pool entry the way owners do: literal, `where: 'none'`, `base` folded into `charge`. */
function entryFor(
	pool: SharedCachePool, store: CacheStoreHandle, owner: RecordingOwner,
	blockId: string, charge: number
): PoolEntry {
	const key = pool.keyFor(store, 'meta', blockId as BlockId);
	return {
		key, store, owner, cls: 'meta', blockId: blockId as BlockId, actionId: undefined,
		value: undefined, base: 0, charge, where: 'none',
	};
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

// --- Pool mechanics, driven directly through the owner contract ---

describe('SharedCachePool mechanics', () => {
	it('rejects non-finite or non-positive budgets, at construction and live', () => {
		expect(() => new SharedCachePool({ maxBytes: 0 })).to.throw(TypeError);
		expect(() => new SharedCachePool({ maxBytes: -1 })).to.throw(TypeError);
		expect(() => new SharedCachePool({ maxBytes: Number.NaN })).to.throw(TypeError);
		expect(() => new SharedCachePool({ maxBytes: Number.POSITIVE_INFINITY })).to.throw(TypeError);
		expect(() => new SharedCachePool({ maxBytes: 1024, maxEntries: 0 })).to.throw(TypeError);
		const pool = new SharedCachePool({ maxBytes: 1024 });
		expect(() => pool.setBudget({ maxBytes: -5 })).to.throw(TypeError);
		expect(() => pool.setBudget({ maxEntries: Number.NaN })).to.throw(TypeError);
	});

	it('first admission enters A1in probation; a re-touch does not move it', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		const e = entryFor(pool, store, owner, 'b1', 100);
		pool.admit(e);
		expect(e.where).to.equal('a1in');
		pool.touch(e);
		expect(e.where, 'no intra-A1in promotion').to.equal('a1in');
		const stats = pool.stats();
		expect(stats.a1in.entries).to.equal(1);
		expect(stats.am.entries).to.equal(0);
		expect(stats.hits).to.equal(1);
	});

	it('admitting an already-resident entry throws', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		const e = entryFor(pool, store, owner, 'b1', 100);
		pool.admit(e);
		expect(() => pool.admit(e)).to.throw(/already-resident/);
	});

	it('A1in evicts in FIFO order regardless of touches, and eviction ghosts the key', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		const e1 = entryFor(pool, store, owner, 'b1', 300);
		const e2 = entryFor(pool, store, owner, 'b2', 300);
		const e3 = entryFor(pool, store, owner, 'b3', 300);
		pool.admit(e1); pool.admit(e2); pool.admit(e3);
		pool.touch(e1); pool.touch(e1); // heavily re-touched — must NOT save it from FIFO order

		pool.admit(entryFor(pool, store, owner, 'b4', 300)); // 1200 > 1000 → evict
		expect(owner.evicted, 'oldest A1in entry evicted despite touches').to.deep.equal([e1.key]);
		expect(e1.where).to.equal('none');
		expect(pool.stats().ghostKeys, 'A1in eviction demotes the key to the ghost set').to.equal(1);
	});

	it('re-admitting a ghosted key goes straight to Am (ghost hit)', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		pool.admit(entryFor(pool, store, owner, 'b1', 300));
		pool.admit(entryFor(pool, store, owner, 'b2', 300));
		pool.admit(entryFor(pool, store, owner, 'b3', 300));
		pool.admit(entryFor(pool, store, owner, 'b4', 300)); // evicts b1 → ghost

		const again = entryFor(pool, store, owner, 'b1', 300); // evicts b2, then admits b1
		pool.admit(again);
		expect(again.where, 'ghosted key re-admitted into the protected queue').to.equal('am');
		const stats = pool.stats();
		expect(stats.ghostHits).to.equal(1);
		expect(stats.am.entries).to.equal(1);
	});

	it('Am is an LRU that a touch refreshes; Am evictions do not ghost', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		// Route k1, k2 into Am: admit → evict-all (ghosts them) → re-admit.
		pool.admit(entryFor(pool, store, owner, 'k1', 100));
		pool.admit(entryFor(pool, store, owner, 'k2', 100));
		pool.setBudget({ maxBytes: 1 });    // evict everything out of A1in → both ghosted
		pool.setBudget({ maxBytes: 1000 });
		const k1 = entryFor(pool, store, owner, 'k1', 100);
		const k2 = entryFor(pool, store, owner, 'k2', 100);
		pool.admit(k1); pool.admit(k2);
		expect(k1.where).to.equal('am');
		expect(k2.where).to.equal('am');

		pool.touch(k1); // k1 becomes MRU; the LRU victim is now k2
		owner.evicted.length = 0;
		const ghostsBefore = pool.stats().ghostKeys;
		pool.setBudget({ maxBytes: 150 }); // room for exactly one 100-byte entry
		expect(owner.evicted, 'Am LRU head evicted; the touched entry survives').to.deep.equal([k2.key]);
		expect(k1.where).to.equal('am');
		expect(pool.stats().ghostKeys, 'Am evictions never ghost').to.equal(ghostsBefore);
	});

	it('enforces the byte rail and the entry rail; setBudget shrink evicts immediately', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 8 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		for (let i = 0; i < 50; i++) {
			pool.admit(entryFor(pool, store, owner, `b${i}`, 100));
			expect(pool.bytes).to.be.at.most(1000);
			expect(pool.entries, 'entry rail binds before the byte rail here').to.be.at.most(8);
		}
		expect(pool.entries).to.equal(8);
		pool.setBudget({ maxBytes: 350 });
		expect(pool.bytes, 'shrink evicted down synchronously').to.be.at.most(350);
		expect(pool.stats().evictions).to.be.greaterThan(0);
	});

	it('admits() refuses charges above 1/16 of the byte budget and counts the bypass', () => {
		const pool = new SharedCachePool({ maxBytes: 1600, maxEntries: 100 });
		expect(pool.admits(100)).to.equal(true);
		expect(pool.admits(101)).to.equal(false);
		expect(pool.stats().bypasses).to.equal(1);
	});

	it('updated() re-accounts growth and may evict the updated entry itself', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		const e1 = entryFor(pool, store, owner, 'b1', 400);
		const e2 = entryFor(pool, store, owner, 'b2', 400);
		pool.admit(e1); pool.admit(e2);
		pool.updated(e1, 700); // 700 + 400 = 1100 > 1000; e1 is the A1in FIFO head
		expect(owner.evicted).to.deep.equal([e1.key]);
		expect(e1.where).to.equal('none');
		expect(pool.bytes).to.equal(400);
	});

	it('drop() removes without ghosting — an invalidation says nothing about reuse', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		const e = entryFor(pool, store, owner, 'b1', 100);
		pool.admit(e);
		pool.drop(e);
		expect(pool.stats().ghostKeys).to.equal(0);
		expect(owner.evicted, 'drop is not an eviction; no owner callback').to.deep.equal([]);
		const again = entryFor(pool, store, owner, 'b1', 100);
		pool.admit(again);
		expect(again.where, 'no ghost, so the fresh admission is probation again').to.equal('a1in');
	});

	it('the ghost set is capped at half the entry budget', () => {
		const pool = new SharedCachePool({ maxBytes: 100_000, maxEntries: 8 }); // ghost cap 4
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		for (let i = 0; i < 30; i++) {
			pool.admit(entryFor(pool, store, owner, `b${i}`, 100));
		}
		expect(pool.stats().ghostKeys).to.be.at.most(4);
	});

	it('store ids are never reused; unregisterStore sweeps entries and ghosts', () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100 });
		const owner = new RecordingOwner();
		const s1 = pool.registerStore('one');
		const s2 = pool.registerStore('two');
		expect(s1.id).to.not.equal(s2.id);

		const e1 = entryFor(pool, s1, owner, 'b1', 300);
		pool.admit(e1);
		pool.admit(entryFor(pool, s1, owner, 'b2', 300));
		pool.admit(entryFor(pool, s1, owner, 'b3', 300));
		pool.admit(entryFor(pool, s1, owner, 'b4', 300)); // evicts s1's b1 → ghost
		pool.admit(entryFor(pool, s2, owner, 'b1', 100));
		expect(pool.stats().ghostKeys).to.equal(1);

		pool.unregisterStore(s1);
		const stats = pool.stats();
		expect(s1.bytes).to.equal(0);
		expect(s1.entries).to.equal(0);
		expect(stats.ghostKeys, "the departed store's ghost keys are purged").to.equal(0);
		expect(stats.stores.map(s => s.label), 'registry keeps only the live store').to.deep.equal(['two']);
		expect(stats.bytes, "the other store's entry is untouched").to.equal(100);

		const s3 = pool.registerStore('three');
		expect(s3.id, 'ids are monotonic, never recycled').to.not.equal(s1.id);
	});

	it("in 'lru' mode everything goes to Am, evictions never ghost, and touches drive the order", () => {
		const pool = new SharedCachePool({ maxBytes: 1000, maxEntries: 100, admission: 'lru' });
		const owner = new RecordingOwner();
		const store = pool.registerStore();
		const k1 = entryFor(pool, store, owner, 'k1', 300);
		const k2 = entryFor(pool, store, owner, 'k2', 300);
		const k3 = entryFor(pool, store, owner, 'k3', 300);
		pool.admit(k1); pool.admit(k2); pool.admit(k3);
		expect(k1.where).to.equal('am');
		pool.touch(k1); // LRU order now k2, k3, k1

		pool.admit(entryFor(pool, store, owner, 'k4', 300));
		expect(owner.evicted, 'plain LRU victim — touches DO protect here').to.deep.equal([k2.key]);
		const stats = pool.stats();
		expect(stats.ghostKeys).to.equal(0);
		expect(stats.ghostHits).to.equal(0);
	});
});

// --- Thrash conformance: the full storage contract must hold at ANY residency ---

// At 2 KB the pool's bypass limit (128 bytes) is below every entry's base charge, so nothing
// is ever cached — the pure read-through degenerate case.
runRawStorageConformance('KvRawStorage over CachedStoreDriver on a read-through-tiny pool (2 KB)', async () => ({
	storage: new KvRawStorage(new CachedStoreDriver(
		new MemoryStoreDriver(), new SharedCachePool({ maxBytes: 2048 }))),
	cleanup: async () => { /* in-memory: nothing to release */ }
}));

// At 16 KB entries admit but churn constantly — eviction lands at arbitrary instants,
// including between promote's coupled mutations. The contract must be indistinguishable.
runRawStorageConformance('KvRawStorage over CachedStoreDriver on a thrashing pool (16 KB)', async () => ({
	storage: new KvRawStorage(new CachedStoreDriver(
		new MemoryStoreDriver(), new SharedCachePool({ maxBytes: 16 * 1024 }))),
	cleanup: async () => { /* in-memory: nothing to release */ }
}));

// --- Bounded-cache behavior through the driver ---

describe('CachedStoreDriver under a bounded pool', () => {
	const blockId = 'blk' as BlockId;

	it('a probe stream of nonexistent blocks stays inside both budget rails', async () => {
		const pool = new SharedCachePool({ maxBytes: 16 * 1024 }); // maxEntries defaults to 32
		const counting = new CountingStoreDriver(new MemoryStoreDriver());
		const driver = new CachedStoreDriver(counting, pool);
		for (let i = 0; i < 2000; i++) {
			expect(await driver.getMetadata(`missing-${i}` as BlockId)).to.equal(undefined);
		}
		const stats = pool.stats();
		expect(stats.entries).to.be.at.most(stats.maxEntries);
		expect(stats.bytes).to.be.at.most(stats.maxBytes);
		expect(stats.ghostKeys).to.be.at.most(Math.floor(stats.maxEntries / 2));
		expect(stats.evictions, 'the stream churned instead of accumulating').to.be.greaterThan(0);
		expect(counting.count('getMetadata'), 'every probe of a new id fell through').to.equal(2000);
	});

	it('pending-list completeness survives eviction: the next list re-enumerates and is correct', async () => {
		const pool = new SharedCachePool({ maxBytes: 8192, maxEntries: 100 });
		const counting = new CountingStoreDriver(new MemoryStoreDriver());
		const driver = new CachedStoreDriver(counting, pool);
		await driver.putPending(blockId, 'a1' as ActionId, bytesOf('one'));
		await driver.putPending(blockId, 'a2' as ActionId, bytesOf('two'));

		expect(new Set(await collect(driver.listPendingActionIds(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(counting.count('listPendingActionIds'), 'first list seeds completeness').to.equal(1);
		expect(new Set(await collect(driver.listPendingActionIds(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(counting.count('listPendingActionIds'), 'second list served from the complete set').to.equal(1);

		// Flood the pool with foreign metadata until the pending-list entry is evicted.
		for (let i = 0; i < 100; i++) {
			await driver.getMetadata(`flood-${i}` as BlockId);
		}

		// The evicted list took its completeness flag with it: the next enumeration MUST
		// consult the inner driver again, and MUST still be correct.
		expect(new Set(await collect(driver.listPendingActionIds(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(counting.count('listPendingActionIds'), 'post-eviction list re-enumerated').to.equal(2);
		expect(new Set(await collect(driver.listPendingActionIds(blockId)))).to.deep.equal(new Set(['a1', 'a2']));
		expect(counting.count('listPendingActionIds'), 're-seeded completeness serves again').to.equal(2);
	});

	it('promote with the pending entry EVICTED falls through to the real transform', async () => {
		const inner = new MemoryRawStorage();
		const pool = new SharedCachePool({ maxBytes: 1 << 20 });
		const cached = new CachedRawStorage(inner, pool);
		const transform: Transform = { insert: makeBlock('blk', { items: ['x'] }) };
		await cached.savePendingTransaction(blockId, 'a1' as ActionId, transform);

		// Evict everything (including the cached pending transform), then restore the budget.
		pool.setBudget({ maxBytes: 1 });
		pool.setBudget({ maxBytes: 1 << 20 });

		// Cache a committed negative — the exact entry the promote must not leave stale.
		expect(await cached.getTransaction(blockId, 'a1' as ActionId)).to.equal(undefined);

		await cached.promotePendingTransaction(blockId, 'a1' as ActionId);

		// The pending bytes were evicted, so the committed entry must be INVALIDATED (never
		// synthesized, never the stale negative): the read falls through to the inner storage.
		expect(await cached.getTransaction(blockId, 'a1' as ActionId)).to.deep.equal(transform);
		expect(await cached.getPendingTransaction(blockId, 'a1' as ActionId)).to.equal(undefined);
	});

	it('two stores sharing one pool never alias, even on identical block ids', async () => {
		const pool = new SharedCachePool({ maxBytes: 1 << 20 });
		const innerA = new CountingStoreDriver(new MemoryStoreDriver());
		const innerB = new CountingStoreDriver(new MemoryStoreDriver());
		const a = new CachedStoreDriver(innerA, pool, 'A');
		const b = new CachedStoreDriver(innerB, pool, 'B');
		// The SAME name-derived header block id in both stores — the aliasing hazard the
		// store-id key segment exists for.
		const shared = 'header-tree-of-trade' as BlockId;
		await a.putMetadata(shared, bytesOf('value-of-A'));
		await b.putMetadata(shared, bytesOf('value-of-B'));

		expect(new TextDecoder().decode(await a.getMetadata(shared))).to.equal('value-of-A');
		expect(new TextDecoder().decode(await b.getMetadata(shared))).to.equal('value-of-B');
		expect(innerA.count('getMetadata'), 'served from cache, not aliased').to.equal(0);
		expect(innerB.count('getMetadata'), 'served from cache, not aliased').to.equal(0);

		await a.close();
		const stats = pool.stats();
		expect(stats.stores.map(st => st.label), 'closed store left the registry').to.deep.equal(['B']);
		expect(new TextDecoder().decode(await b.getMetadata(shared)), "B's entry outlived A's close").to.equal('value-of-B');
		expect(innerB.count('getMetadata')).to.equal(0);

		b.clear();
		expect(b.storeStats().bytes, 'clear released all pool occupancy').to.equal(0);
		expect(b.storeStats().entries).to.equal(0);
	});

	it('values above 1/16 of the budget bypass the cache entirely', async () => {
		const pool = new SharedCachePool({ maxBytes: 64 * 1024, maxEntries: 1000 }); // bypass limit 4 KB
		const counting = new CountingStoreDriver(new MemoryStoreDriver());
		const driver = new CachedStoreDriver(counting, pool);

		const big = new Uint8Array(8 * 1024);
		await driver.putMetadata(blockId, big);
		expect(driver.storeStats().entries, 'oversized write not cached').to.equal(0);

		expect((await driver.getMetadata(blockId))!.length).to.equal(big.length);
		expect((await driver.getMetadata(blockId))!.length).to.equal(big.length);
		expect(counting.count('getMetadata'), 'both reads fell through — no negative, no value cached').to.equal(2);
		expect(driver.storeStats().entries).to.equal(0);

		// A small value on the same store still caches normally.
		await driver.putMetadata('small' as BlockId, bytesOf('tiny'));
		expect(driver.storeStats().entries).to.equal(1);
		await driver.getMetadata('small' as BlockId);
		expect(counting.count('getMetadata')).to.equal(2);
	});
});

// --- The headline measurement: 2Q admission protects a hot set from a bulk scan ---

describe('2Q pollution resistance vs plain LRU', () => {
	const HOT_COUNT = 20;

	/**
	 * The ticket's pollution scenario: store "hot" holds a small working set; store "bulk"
	 * scans thousands of one-off blocks through the same pool. Phases:
	 * warm hot set → flood so it falls out of probation (2Q: → ghost) → re-touch it
	 * (2Q: ghost hits promote to Am) → bulk-scan 3000 blocks → re-read the hot set.
	 * Returns how many hot reads had to consult the inner driver after the scan.
	 */
	async function runScenario(admission: '2q' | 'lru') {
		const pool = new SharedCachePool({ maxBytes: 32 * 1024, maxEntries: 200, admission });
		const innerHot = new CountingStoreDriver(new MemoryStoreDriver());
		const bulk = new CachedStoreDriver(new CountingStoreDriver(new MemoryStoreDriver()), pool, 'bulk');
		const hot = new CachedStoreDriver(innerHot, pool, 'hot');
		const hotIds = Array.from({ length: HOT_COUNT }, (_, i) => `hot-${i}` as BlockId);
		const value = new Uint8Array(64);

		for (const id of hotIds) await hot.putMetadata(id, value);
		for (let i = 0; i < 150; i++) await bulk.getMetadata(`flood-${i}` as BlockId);

		for (const id of hotIds) await hot.getMetadata(id);
		const reloadReads = innerHot.count('getMetadata');

		for (let i = 0; i < 3000; i++) await bulk.getMetadata(`scan-${i}` as BlockId);

		for (const id of hotIds) {
			expect(await hot.getMetadata(id), `hot value of ${id} intact`).to.deep.equal(value);
		}
		const afterScanReads = innerHot.count('getMetadata') - reloadReads;
		return { reloadReads, afterScanReads, stats: pool.stats() };
	}

	it('a bulk scan cannot displace a re-used hot set under 2Q, and does under LRU', async function () {
		this.timeout(20_000);
		const twoQ = await runScenario('2q');
		const lru = await runScenario('lru');

		console.log('\n      hot-set inner reads after the 3000-block bulk scan:');
		console.log(`        2q:  ${twoQ.afterScanReads}/${HOT_COUNT}  (ghost hits: ${twoQ.stats.ghostHits}, evictions: ${twoQ.stats.evictions})`);
		console.log(`        lru: ${lru.afterScanReads}/${HOT_COUNT}  (evictions: ${lru.stats.evictions})`);

		// Both variants lost the hot set to the initial flood — the reuse signal comes later.
		expect(twoQ.reloadReads, 'flood evicted the once-written hot set (2q)').to.equal(HOT_COUNT);
		expect(lru.reloadReads, 'flood evicted the once-written hot set (lru)').to.equal(HOT_COUNT);

		// The contrast the admission layer exists for: after the re-touch proved reuse,
		// 2Q's protected queue rides out the scan; plain LRU loses everything to it.
		expect(twoQ.stats.ghostHits, 'the re-touch was recognized as reuse').to.be.at.least(HOT_COUNT);
		expect(twoQ.afterScanReads, 'ZERO further inner reads under 2Q').to.equal(0);
		expect(lru.afterScanReads, 'the whole hot set was lost under LRU').to.equal(HOT_COUNT);
	});
});

// --- The easy case must not regress: a real budget that never binds is invisible ---

describe('bounded pool on the cold-start workload', () => {
	it('an 8 MB budget leaves per-method driver counts identical to an effectively-unbounded pool', async function () {
		this.timeout(20_000);

		const bounded = new CountingStoreDriver(new MemoryStoreDriver());
		await runColdStartWorkload(new KvRawStorage(new CachedStoreDriver(
			bounded, new SharedCachePool({ maxBytes: 8 * 1024 * 1024 }))));

		const unbounded = new CountingStoreDriver(new MemoryStoreDriver());
		await runColdStartWorkload(new KvRawStorage(new CachedStoreDriver(
			unbounded, new SharedCachePool({ maxBytes: 1024 * 1024 * 1024 }))));

		for (const method of [...READ_METHODS, ...WRITE_METHODS]) {
			expect(bounded.count(method), `count unchanged under the 8 MB budget: ${method}`)
				.to.equal(unbounded.count(method));
		}

		// And the prereq's headline still holds against an uncached baseline.
		const uncached = new CountingStoreDriver(new MemoryStoreDriver());
		await runColdStartWorkload(new KvRawStorage(uncached));
		expect(bounded.total(READ_METHODS), 'the ≥70% read cut survives the bound')
			.to.be.at.most(Math.floor(uncached.total(READ_METHODS) * 0.3));
	});
});
