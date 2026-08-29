import type { IRawStorage } from "./i-raw-storage.js";
import { MemoryRawStorage } from "./memory-storage.js";
import { CachedRawStorage } from "./cached-raw-storage.js";
import type { SharedCachePool } from "./shared-cache-pool.js";

/**
 * What {@link withReadCache} resolved: the storage to use, and the cache THIS call created —
 * `undefined` when it returned the argument unchanged.
 *
 * The split exists because "the result is a `CachedRawStorage`" and "the result is mine to
 * dispose" are different questions, and answering the second with the first is a bug: the
 * pass-through branch hands back a cache the CALLER built and may still be sharing with other
 * consumers. Dispose `ownedCache`, never `storage`.
 */
export type ResolvedReadCache = {
	/** The storage to build on — wrapped, or the argument unchanged. */
	storage: IRawStorage;
	/** The wrapper this call constructed, and therefore the only thing this caller may dispose. */
	ownedCache: CachedRawStorage | undefined;
};

/**
 * Wrap a raw storage in the write-through read cache ({@link CachedRawStorage}) at a
 * composition seam — the ONE helper every production seam that resolves an `IRawStorage`
 * goes through, so the exclusion rules below are stated once rather than re-derived per site.
 *
 * Returns the storage **unchanged**, with no `ownedCache`, when caching would not pay:
 * - `MemoryRawStorage` is already in memory; the cache would duplicate every map entry's
 *   bookkeeping with nothing to save (see `CachedStoreDriver`'s class doc).
 * - An already-cached storage (a host that wrapped before handing it over) is not wrapped twice.
 *
 * Why this is needed at all: `BlockStorage` re-reads block metadata on essentially every
 * operation and `StorageRepo` builds a fresh `BlockStorage` per block per call, so nothing above
 * this seam memoizes. Over a filesystem backend that is hundreds of reads of the same tiny files
 * per statement. Measured A/B on a create/insert/update/select workload with only the wrap
 * decision changed: 113 → 6 `getMetadata` and 207 → 14 total reads at the `RawStoreDriver` seam;
 * over `FileRawStorage` the same workload went from 184 `readFile` + 29 `readdir` to 9 + 6.
 *
 * **Precondition: exactly one cache fronts a given backing store** (Invariant 5 in
 * `packages/db-p2p/docs/storage.md`). Two forms of violation, both silently non-convergent —
 * no error, just reads that never observe the other writer:
 *
 * - *Across processes.* The filesystem driver takes no cross-process lock (the proper-lockfile
 *   TODO in `db-p2p-storage-fs/src/file-storage.ts`) and is last-writer-wins; a second writing
 *   process bypasses this cache and makes its values stale.
 * - *Within one process.* Two `IRawStorage` instances over the SAME backing location — e.g.
 *   `new FileRawStorage(dir)` twice for the same `dir` — each get their own cache here, because
 *   cache identity is per-object and this function cannot see that they share a directory.
 *   Measured on a create/insert workload: peer A still reads 1 row after peer B commits 3.
 *
 * Wrap once and **share the wrapper**. Note that passing the same *unwrapped* instance twice is
 * NOT enough — each call wraps it again, yielding two caches over one inner. A host that needs
 * several consumers on one store must construct the {@link CachedRawStorage} itself and hand
 * that same object to each; this function returns an already-cached storage unchanged, which is
 * what makes sharing work. (Seams that call a per-consumer factory, such as the plugin's
 * `rawStorageFactory`, get one cache per consumer by construction.)
 *
 * **Lifecycle: dispose {@link ResolvedReadCache.ownedCache} and nothing else.** A seam that
 * disposed `storage` whenever it happened to be a `CachedRawStorage` would clear and unregister
 * the host's shared wrapper the moment its FIRST consumer departed — the pool would keep
 * charging that store's entries while dropping its row from `stats()`, so occupancy becomes
 * unattributable for the rest of the process, and the other consumers keep reading through a
 * cache nobody can account for. That is precisely the recipe recommended above, so the helper
 * reports ownership rather than leaving each site to infer it. A skipped dispose of a cache you
 * DO own leaks only cold entries the pool evicts under pressure — hygiene, not correctness.
 *
 * @param label  Shown in `SharedCachePool.stats()` so this store is recognizable.
 * @param pool   Pool to join; defaults to the process-wide `defaultCachePool()`. Pass one only
 *               for isolation (tests) or host-specific sizing.
 */
export function withReadCache(storage: IRawStorage, label?: string, pool?: SharedCachePool): ResolvedReadCache {
	if (storage instanceof MemoryRawStorage || storage instanceof CachedRawStorage) {
		return { storage, ownedCache: undefined };
	}
	const ownedCache = new CachedRawStorage(storage, pool, label);
	return { storage: ownedCache, ownedCache };
}
