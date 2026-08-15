----
description: Storing a small amount of data used to re-read the same handful of records dozens of times, making startup slow on a phone or busy disk. Those records are now kept in memory and updated as they are written; this needs a code-review pass.
prereq: storage-invariants-undocumented-and-doc-rot
files: packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts
difficulty: hard
----

# Review: write-through coherent cache at the raw-storage seam

## What was built

A write-through coherent cache at the byte layer of the storage stack, plus a wrapper form
for backends that only expose the higher-level interface:

- `packages/db-p2p/src/storage/cached-store-driver.ts` — `CachedStoreDriver implements
  RawStoreDriver`. Wraps any inner driver; wire as
  `new KvRawStorage(new CachedStoreDriver(innerDriver))`. All cache semantics live here.
- `packages/db-p2p/src/storage/cached-raw-storage.ts` — `RawStorageDriverAdapter` (presents
  a plain `IRawStorage` as a `RawStoreDriver`) and `CachedRawStorage extends KvRawStorage`
  (kernel → cache → adapter → inner storage), exposing `clearCache()`.
- Both modules exported from `src/index.ts` and `src/rn.ts`.
- `docs/storage.md` — new section "6. Write-through raw-storage cache" under Core
  Components: coherence model, the five invariants it relies on, single-process
  precondition, wiring guidance, unbounded-until-pool note.
- `packages/db-p2p/test/cached-raw-storage.spec.ts` — full conformance over both
  compositions, ten cache-specific coherence tests, and a measured cold-start workload.

**No production call site was changed.** Nothing wires the cache yet; adoption is the
consumer's choice per the docs wiring guidance. All existing behavior is untouched unless
someone opts in.

## Core semantics (what to review hardest)

- **Write-through, never invalidate, never write-behind.** Every save stores the encoded
  bytes into the cache synchronously after the inner write resolves — no `await` between.
  No write is deferred, reordered, or coalesced; commit-path crash-recovery ordering is
  untouched.
- **Cached value type is `Uint8Array | null`**, where `null` = *proven* absence (confirmed
  inner miss or funnelled delete) and a map miss = unknown. A cached negative can never
  mean "could not confirm" — the absence-verdict distinction the ticket required.
- **Read-miss fills are guarded**: after the inner await, fill only if the entry is still
  unknown (and for revisions, only if still uncovered and the state object identity is
  unchanged), so a stale read never clobbers a newer funnelled write.
- **Promote** (the single hardest part — Invariant P): inner atomic move first, then one
  synchronous cache mutation — pending → proven-absent, pending-list id dropped, committed
  entry set from the cached pending bytes if present, otherwise **invalidated** (which also
  kills any stale cached negative), never synthesized. On throw, all three entries drop to
  unknown (the throw may be the contract's missing-pend error or a mid-operation fault).
- **List completeness**: `listPendingTransactions` is served from cache only after one full
  enumeration seeds a `complete` flag stored inside the same entry as the set; funnelled
  writes maintain it. `listRevisions` tracks covered inclusive rev intervals
  (adjacency-merged) fed by enumerations and written points. Both enumerations snapshot a
  generation counter before draining the inner driver and decline the completeness claim if
  a write (gen bump) or `clear()` (state-object swap) landed mid-drain.
- **Errors**: a failed inner write drops the affected entries to unknown and rethrows.
- **`clear()` is safe at any instant** — the cache is always clean, nothing is pinned.

## Measured result

Workload ≈ the profiled cold start (memory-backed, synthetic): `StorageRepo` over
`BlockStorage`, 6 blocks, 22 sequential pend→commit rounds (insert on first touch, update
after; commit rev = global counter), `repo.get` of every known block each round. Counting
driver under vs without the cache:

| driver method | uncached | cached |
|---|---|---|
| getMetadata | 360 | 6 |
| rangeRevisions | 133 | 21 |
| getPending | 44 | 0 |
| listPendingActionIds | 139 | 6 |
| getMaterialized | 133 | 0 |
| **reads total** | **809** | **33 (95.9% cut)** |
| **writes total (per-method identical)** | **126** | **126** |

The test asserts reads cut ≥70% and every write-method count unchanged. This crushes the
23% ceiling the ticket measured for invalidate-on-write. (The ticket's 1987-op number came
from a downstream control DB we cannot reproduce here; this workload approximates its
shape, and the per-block read amplification it demonstrates is the same structural
repetition.)

## Validation run

- `runRawStorageConformance` (the full backend-parity suite, including clone-on-read/write
  and the BlockStorage parity slice) passes over BOTH compositions:
  `KvRawStorage(CachedStoreDriver(MemoryStoreDriver))` and
  `CachedRawStorage(MemoryRawStorage)` — zero cache-side cloning needed, because the cache
  stores encoded bytes and the kernel decodes fresh objects per read.
- Coherence-specific tests: write-through metadata (0 inner reads after save), negative
  metadata caching, promote with cached pending (committed served from cache), promote with
  UNcached pending (pre-populated bare storage; stale committed negative invalidated, read
  falls through to the transform), deleteMaterialized negative, pending-list completeness
  (1 enumeration ever), revision coverage (contiguous writes → 0 enumerations; gap → 1;
  wider range → 1 more), deterministic mid-drain-write gen-guard veto (gated driver, no
  timing sleeps), clearCache mid-sequence.
- `yarn build` (tsc) clean; full `db-p2p` suite: **1674 passing, 44 pending
  (pre-existing skips), 0 failing** — every existing consensus/restore/crash-recovery test
  unchanged.

## Decisions a reviewer should weigh

- **Hook level = driver bytes, not `IRawStorage` values.** Clone discipline stays
  structural, entry byte-size is free for the follow-up bounded-pool ticket
  (`shared-bounded-cache-pool-with-2q-admission`, which lists this as prereq), and both
  shipped persistent backends are kernel-backed so the driver seam is reachable.
- **Declined: metadata-birth completeness shortcut** (ticket explicitly allowed inferring
  list completeness for blocks whose metadata the wrapper saw created). Declined because
  pending-sans-metadata is reachable at the raw layer (the conformance suite writes it
  directly) and revisions-sans-metadata is reachable via a crash inside
  `saveForwardRevision` after `saveRestored` but before `saveMetadata`. Cost: ≤2 extra
  driver enumerations per block per process life — negligible. Documented in
  `cached-store-driver.ts` at the enumeration site.
- **Declined: advisory lock for the filesystem backend** (single-owner enforcement the
  ticket asked us to consider). The fs package is outside this ticket's `files:` scope, and
  cross-platform advisory locking (React Native/Expo targets included) is unreliable.
  Invariant 5 (one process owns a store) is documented with an embedder note in
  `docs/storage.md`; enforcement would be its own ticket if ever wanted.
- **Memory backend is documented-not-guarded**: wrapping `MemoryStoreDriver` is pointless
  (bookkeeping overhead, bytes already shared refs) but harmless; docs and both class docs
  say don't, no code guard. Tests deliberately wrap it to prove semantics.
- **Pool-readiness**: entry classes are distinct and keyed by natural key; docs and the
  class doc call out that header block ids are name-derived (not globally unique), so a
  future shared pool must key `(storeId, class, key)`.

## Known gaps / tripwires (honest list)

- **Unlatched same-actionId pend-during-promote race is tolerated**, exactly as it is
  without the cache: a `putPending` racing a `promote` of the same action id can interleave
  arbitrarily at the driver, and the cache mirrors whichever inner order occurred. Nothing
  latches this today at any layer; the cache does not widen the window (its promote
  mutation is synchronous) but does not close it either.
- **JSON.parse per cache hit**: every hit still pays one decode in the kernel. Tripwire
  NOTE in the `CachedStoreDriver` class doc — if decode ever shows hot on large
  materialized blocks, cache decoded objects plus an explicit clone instead.
- **`clear()` racing an in-flight enumeration is guarded by state-object identity but not
  explicitly unit-tested** (the write-mid-drain gen guard is; the clear-mid-drain veto
  shares the same check via object identity). A test would need a gated driver plus a
  mid-drain `clear()` — straightforward extension of the existing gated test if the
  reviewer wants it.
- **Racy unlatched point reads return possibly-stale values without caching them** (the
  fill guard declines the fill). Same observable behavior as the raw driver under the same
  race; noted so a reviewer doesn't mistake the guard for a linearizability claim.
- **No persistent-backend run**: the cache is exercised over the memory driver only.
  Conformance over `FileRawStorage`/LevelDB/SQLite/IndexedDB with the cache interposed
  would be a per-backend one-liner in each backend package's existing conformance spec,
  but those packages are outside this ticket's file scope.
- **The op-count workload is synthetic** (see Measured result); the ticket's real
  downstream consumer (React Native control DB) has not been re-profiled with the cache.
