import type { IRawStorage } from "./i-raw-storage.js";
import { MemoryRawStorage } from "./memory-storage.js";
import { CachedRawStorage } from "./cached-raw-storage.js";
import type { SharedCachePool } from "./shared-cache-pool.js";

/**
 * Wrap a raw storage in the write-through read cache ({@link CachedRawStorage}) at a
 * composition seam — the ONE helper every production seam that resolves an `IRawStorage`
 * goes through, so the exclusion rules below are stated once rather than re-derived per site.
 *
 * Returns the storage **unchanged** when caching would not pay:
 * - `MemoryRawStorage` is already in memory; the cache would duplicate every map entry's
 *   bookkeeping with nothing to save (see `CachedStoreDriver`'s class doc).
 * - An already-cached storage (a host that wrapped before handing it over) is not wrapped twice.
 *
 * Why this is needed at all: `BlockStorage` re-reads block metadata on essentially every
 * operation and `StorageRepo` builds a fresh `BlockStorage` per block per call, so nothing above
 * this seam memoizes. Over a filesystem backend that is hundreds of `readFile`s of the same tiny
 * files per statement (measured 314 → 32 on a two-statement workload once cached).
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
 * The caller owns the returned wrapper's lifecycle: when the result is a {@link CachedRawStorage},
 * call `dispose()` on departure so the shared pool's occupancy stays honest (a skipped dispose
 * leaks only cold entries the pool evicts under pressure — hygiene, not correctness).
 *
 * @param label  Shown in `SharedCachePool.stats()` so this store is recognizable.
 * @param pool   Pool to join; defaults to the process-wide `defaultCachePool()`. Pass one only
 *               for isolation (tests) or host-specific sizing.
 */
export function withReadCache(storage: IRawStorage, label?: string, pool?: SharedCachePool): IRawStorage {
	if (storage instanceof MemoryRawStorage || storage instanceof CachedRawStorage) {
		return storage;
	}
	return new CachedRawStorage(storage, pool, label);
}
