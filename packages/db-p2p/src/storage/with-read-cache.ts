import type { IRawStorage } from "./i-raw-storage.js";
import { MemoryRawStorage } from "./memory-storage.js";
import { CachedRawStorage } from "./cached-raw-storage.js";
import type { SharedCachePool } from "./shared-cache-pool.js";
import type { StoreIdentity } from "./store-identity.js";

/**
 * One consumer's claim on a shared read cache. Release exactly once, when the consumer departs.
 *
 * The cache behind a lease may be serving OTHER consumers — every lease over one store hands
 * back the same {@link CachedRawStorage} — so a lease holder never disposes the cache itself.
 * It releases its claim; the cache is torn down when the last claim goes.
 */
export interface ReadCacheLease {
	/** The cache this lease is a claim on — the same object for every lease over one store. */
	readonly cache: CachedRawStorage;
	/**
	 * Drop this claim. Idempotent. The cache is cleared, unregistered from its pool, and
	 * forgotten only when the LAST lease releases; until then other consumers keep reading
	 * through it. A later {@link withReadCache} over the same store after the last release
	 * builds a fresh, cold cache.
	 */
	release(): Promise<void>;
}

/**
 * What {@link withReadCache} resolved: the storage to use, and this caller's claim on the cache
 * behind it — `undefined` when it returned the argument unchanged.
 *
 * The split exists because "the result is a `CachedRawStorage`" and "the result is mine to
 * release" are different questions, and answering the second with the first is a bug: the
 * pass-through branch hands back a cache the CALLER built and may still be sharing with other
 * consumers. Release `lease`; never dispose `storage`.
 */
export type ResolvedReadCache = {
	/** The storage to build on — the shared cache, or the argument unchanged. */
	storage: IRawStorage;
	/** This caller's claim, or `undefined` when the argument passed through unwrapped. */
	lease: ReadCacheLease | undefined;
};

/**
 * One live shared cache and the number of leases claiming it. `retire` removes it from
 * whichever registry map it lives in — called exactly once, by the last release, BEFORE the
 * async dispose, so a concurrent re-wrap over the same store never finds a dying entry.
 */
type RegistryEntry = {
	readonly cache: CachedRawStorage;
	refs: number;
	readonly retire: () => void;
};

/**
 * The registry of live shared caches, keyed two ways because the two keys close different
 * holes:
 *
 * - `byIdentity` — by {@link IRawStorage.getStoreIdentity}, so two DIFFERENT storage objects
 *   over one backing location (`new FileRawStorage(dir)` twice) resolve to one cache.
 * - `byObject` — by the storage object itself, for backends that report no identity, so one
 *   unwrapped instance handed to two consumers still resolves to one cache. Weak: an entry
 *   never keeps its storage alive.
 *
 * An identity-bearing storage is keyed by identity only (two wraps of one object have one
 * identity, so the object key would be redundant).
 *
 * NOTE: an entry lives until its last lease releases, so a host that never releases (e.g.
 * never calls `plugin.dispose()`) holds one cache per store for the life of the process. This
 * is the same class of retention as before dedupe — an undisposed cache already kept its pool
 * registration forever — and the pool still evicts its entries under pressure, so it is
 * hygiene, not correctness.
 */
const byIdentity = new Map<StoreIdentity, RegistryEntry>();
const byObject = new WeakMap<IRawStorage, RegistryEntry>();

class Lease implements ReadCacheLease {
	private released = false;

	constructor(private readonly entry: RegistryEntry) {}

	get cache(): CachedRawStorage {
		return this.entry.cache;
	}

	async release(): Promise<void> {
		// Latch first, then decrement, all synchronously: a double release on one lease counts
		// once, and two leases releasing concurrently can only land ONE of them on zero.
		if (this.released) return;
		this.released = true;
		this.entry.refs -= 1;
		if (this.entry.refs > 0) return;
		this.entry.retire();
		await this.entry.cache.dispose();
	}
}

/**
 * Wrap a raw storage in the write-through read cache ({@link CachedRawStorage}) at a
 * composition seam — the ONE helper every production seam that resolves an `IRawStorage`
 * goes through, so the exclusion and sharing rules below are stated once rather than
 * re-derived per site.
 *
 * Returns the storage **unchanged**, with no `lease`, when caching would not pay:
 * - `MemoryRawStorage` is already in memory; the cache would duplicate every map entry's
 *   bookkeeping with nothing to save (see `CachedStoreDriver`'s class doc).
 * - An already-cached storage (a host that wrapped before handing it over) is not wrapped twice,
 *   and stays the host's to dispose.
 *
 * Why this is needed at all: `BlockStorage` re-reads block metadata on essentially every
 * operation and `StorageRepo` builds a fresh `BlockStorage` per block per call, so nothing above
 * this seam memoizes. Over a filesystem backend that is hundreds of reads of the same tiny files
 * per statement. Measured A/B on a create/insert/update/select workload with only the wrap
 * decision changed: 113 → 6 `getMetadata` and 207 → 14 total reads at the `RawStoreDriver` seam;
 * over `FileRawStorage` the same workload went from 184 `readFile` + 29 `readdir` to 9 + 6.
 *
 * **One cache per backing store, shared under a lease.** The cache is write-through, so it is
 * coherent only while every in-process writer to a store goes through the SAME cache; two caches
 * over one store each serve their own stale view forever (measured: peer A still reads 1 row
 * after peer B commits 3). So this helper dedupes: the second call over a store that already
 * has a live cache returns that same cache with a fresh {@link ReadCacheLease}, and constructs
 * only on a miss. "Same store" is decided by `storage.getStoreIdentity()` when the backend
 * reports one (two `FileRawStorage` over one directory), else by storage object identity (one
 * unwrapped instance handed to two consumers). Identity is one-directional — equal proves
 * sameness, unequal proves nothing — so backends whose identity under-approximates (path
 * aliases, two handles over one database; each backend's `NOTE:` lists its gaps) can still end
 * up with two caches; and a host that builds its own `CachedRawStorage` never enters the
 * registry, so a second consumer wrapping a fresh instance over that store still gets a second
 * cache. What remains of Invariant 5 (`packages/db-p2p/docs/storage.md`) is the cross-process
 * case: the filesystem driver takes no lock, and a second process's writes bypass this cache.
 *
 * On a dedupe hit the FIRST caller's `label` and `pool` stick: `pool.stats()` shows whoever
 * wrapped first, and a second caller's different pool is ignored. Identity beats sizing — a
 * same-store-different-pool pair would diverge, which is the thing being removed.
 *
 * **Lifecycle: release {@link ResolvedReadCache.lease} and nothing else.** The cache is
 * cleared, unregistered from its pool, and forgotten when the LAST lease over the store
 * releases; a later wrap then starts cold. Disposing `storage` directly would clear and
 * unregister a cache other consumers are still reading through — the pool would keep charging
 * that store's entries while dropping its row from `stats()`. A skipped release leaks only cold
 * entries the pool evicts under pressure — hygiene, not correctness.
 *
 * Deliberately synchronous, with no `await` between lookup and insert: two seams resolving
 * concurrently cannot both construct. Keep it that way.
 *
 * @param label  Shown in `SharedCachePool.stats()` so this store is recognizable. First caller's
 *               label wins on a dedupe hit.
 * @param pool   Pool to join; defaults to the process-wide `defaultCachePool()`. Pass one only
 *               for isolation (tests) or host-specific sizing. First caller's pool wins on a
 *               dedupe hit.
 */
export function withReadCache(storage: IRawStorage, label?: string, pool?: SharedCachePool): ResolvedReadCache {
	if (storage instanceof MemoryRawStorage || storage instanceof CachedRawStorage) {
		return { storage, lease: undefined };
	}

	const identity = storage.getStoreIdentity?.();
	const existing = identity === undefined ? byObject.get(storage) : byIdentity.get(identity);
	if (existing) {
		existing.refs += 1;
		return { storage: existing.cache, lease: new Lease(existing) };
	}

	const cache = new CachedRawStorage(storage, pool, label);
	const entry: RegistryEntry = {
		cache,
		refs: 1,
		retire: identity === undefined
			? () => { byObject.delete(storage); }
			: () => { byIdentity.delete(identity); },
	};
	if (identity === undefined) {
		byObject.set(storage, entry);
	} else {
		byIdentity.set(identity, entry);
	}
	return { storage: cache, lease: new Lease(entry) };
}
