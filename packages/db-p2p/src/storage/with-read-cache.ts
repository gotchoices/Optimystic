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
 * **Precondition: one process owns this storage's backing store** (Invariant 5 in
 * `packages/db-p2p/docs/storage.md`). The filesystem driver takes no cross-process lock (the
 * proper-lockfile TODO in `db-p2p-storage-fs/src/file-storage.ts`) and is last-writer-wins; a
 * second writing process bypasses this cache and makes its values stale. Likewise two
 * *in-process* consumers must not each wrap the SAME inner instance: they would hold two caches
 * that never see each other's writes. Wrap once, at the seam that owns the instance.
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
