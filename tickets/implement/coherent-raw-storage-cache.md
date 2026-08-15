----
description: Storing a small amount of data re-reads the same handful of records dozens of times, which makes startup slow on a phone or a busy disk. Keep those records in memory and update them as they are written, instead of reading them back from the device each time.
prereq: storage-invariants-undocumented-and-doc-rot
files: packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/index.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/docs/storage.md
difficulty: hard
----

<!-- resume-note -->
**Prior run interrupted by BUDGET_WARNING after design + first file. Resume here; do not redo the analysis.**

**Done (unverified — not yet compiled or tested):**
- `packages/db-p2p/src/storage/cached-store-driver.ts` — complete `CachedStoreDriver implements RawStoreDriver`, the kernel-level hook. Wraps any inner driver; wire as `new KvRawStorage(new CachedStoreDriver(innerDriver))`.

**Design decisions already made (hold to these unless they fail verification):**
- **Hook level = driver, not IRawStorage.** Cache stores the *encoded bytes* the kernel writes/reads. Kernel's codec (`raw-store-codec.ts`) then decodes fresh objects per read, so clone-on-read/write stays structural (conformance clone tests should pass with zero cache-side cloning) and entry byte-size is free for the follow-up pool ticket.
- Cached value type: `Uint8Array | null` where `null` = **proven** absence (confirmed inner miss or funnelled delete); map-miss = unknown. Preserves the absence-verdict distinction the ticket requires.
- Read-miss fills are guarded "fill only if still unknown" after the await, so a stale read never clobbers a newer funnelled write. Write-error paths drop affected entries to unknown and rethrow.
- Revisions: per-block `{byRev, covered: [lo,hi][] (inclusive, adjacency-merged), gen}`. Coverage from full enumerations + written points only. `listRevisions`/`listPendingTransactions` completeness claims are guarded by a `gen` counter + state-object identity check so a write or `clear()` landing mid-drain vetoes the claim.
- **No metadata-birth completeness shortcut** (ticket allowed it; declined): pending-sans-metadata and revisions-sans-metadata are reachable at the raw layer (conformance writes the former directly; crash inside `saveForwardRevision` after `saveRestored`, before `saveMetadata`, produces the latter). Cost of declining: ≤2 extra driver enumerations per block per process life — negligible vs target. Document this tradeoff in the handoff.
- `promote`: inner atomic move first; then one synchronous cache mutation — pending→null, pendList id dropped, committed set from cached pending bytes if present else **invalidated** (also kills any cached negative). On throw: invalidate all three.
- `clear()` safe at any instant (cache always clean); in-flight enumerations detect state-object swap.
- Memory backend: do NOT wrap `MemoryStoreDriver` (bookkeeping-only overhead; bytes would be shared refs, so no byte copy, still pointless) — document, don't code-guard.

**Remaining TODO (in order):**
- `packages/db-p2p/src/storage/cached-raw-storage.ts`: `RawStorageDriverAdapter implements RawStoreDriver` over a plain `IRawStorage` (uses `encodeJson`/`decodeJson`/`encodeActionId`/`decodeActionId`; `rangeRevisions` maps `(lo,hi,reverse)` back to `listRevisions(start,end)` and drains before yielding; `promote`→`promotePendingTransaction`; feature-detected optional passthroughs assigned in constructor like `KvRawStorage` does) + `class CachedRawStorage extends KvRawStorage` constructed as `super(new CachedStoreDriver(new RawStorageDriverAdapter(inner)))`, keeping a ref to the cache driver to expose `clearCache()`.
- Export both new modules from `src/index.ts` AND `src/rn.ts` (rn.ts mirrors the storage exports).
- Tests in `packages/db-p2p/test/cached-raw-storage.spec.ts` (mocha+chai, see `test/kv-raw-storage.spec.ts` for the conformance harness call):
  - `runRawStorageConformance` over BOTH forms: `KvRawStorage(CachedStoreDriver(MemoryStoreDriver))` and `CachedRawStorage(new MemoryRawStorage())`.
  - Coherence-specific: promote when pending was cached (committed served from cache); promote when pending NOT cached — pre-populate a bare `MemoryRawStorage`, then wrap, `getTransaction`→undefined cached negative, promote, `getTransaction` must return the transform (negative invalidated, read falls to inner); `clear()` mid-sequence then reads still correct; negative metadata cached (repeat probe = 0 inner ops, use a counting driver); `deleteMaterialized`→negative; pending-list completeness (second list = 0 inner enumerations; add id via wrapper appears without re-enumeration); revision coverage ([1,5] enumerated then re-served from cache; saveRevision 6 extends; [0,6] falls to inner once then covered); mid-drain-write gen guard (inner driver with a controllable gate: start list drain, putPending through wrapper mid-drain, finish — next list must include the concurrent id, i.e. completeness not falsely claimed).
  - Op-count measurement: `CountingStoreDriver` wrapping `MemoryStoreDriver` counting per-method calls; workload ≈ cold start: `StorageRepo(id => new BlockStorage(id, storage))`, 6 blocks, 22 sequential pend→commit rounds (insert first touch, `{updates:[['items',0,0,['v'+rev]]]}` after — see conformance `makeInsertTransforms` and parity-slice for request shapes; commit rev = global counter), `repo.get({blockIds})` each round. Run uncached vs cached, log per-method table, assert cached driver-reads reduced ≥70% and writes unchanged. Report measured numbers in handoff.
- `docs/storage.md`: add a cache section under/near "Shared KV Kernel" — write-through coherence, the five invariants it relies on (already documented in that file), single-process precondition, wiring guidance (wrap driver for kernel backends; `CachedRawStorage` otherwise; never memory), unbounded-until-pool note.
- Advisory-lock decision (fs backend single-owner enforcement): DECLINE in this ticket — fs package out of `files:` scope, cross-platform (RN/Expo) advisory locking unreliable, Invariant 5 documented in docs/storage.md. Say so in handoff for the reviewer.
- `yarn build` (tsc) + `yarn test` in `packages/db-p2p` — full suite must pass unchanged. tsconfig has no `exactOptionalPropertyTypes`, so the `s.revs = undefined` / `s.pendList = undefined` assignments in the new driver are fine.
- Handoff to `tickets/review/coherent-raw-storage-cache.md` (distilled summary, measured op counts, known gaps: unlatched same-actionId pend-during-promote race is tolerated same as pre-cache; JSON.parse per cache hit tripwire NOTE already in class doc), then delete this ticket file.
<!-- /resume-note -->

# A write-through coherent cache at the raw-storage seam

## The problem

One cold start of a downstream control database — 8 tables, 1 index — issues **1987 raw-storage
operations over at most 21 distinct blocks**. `getMetadata` is read ~34 times per distinct block;
`getMaterializedBlock` ~65 times. Only ~130 of the 1987 are writes.

Start duration is operation count × per-operation storage latency, so the count is the whole story:
at ~1 ms/op a start takes 1.5 s, and at the 50-90 ms/op a phone sees under launch contention it
takes 15-60 s. A React Native consumer is blocked on this today.

The repetition is structural, not accidental. `StorageRepo` constructs a fresh `BlockStorage` per
block per operation (`storage-repo.ts:189`, `:427`, `:570`, `:801`, `:824`), and `BlockStorage`
re-reads `getMetadata` at the top of nearly every method — `getLatest` (`block-storage.ts:32`),
`getBlock` (`:37`, then again inside `materializeBlock` at `:433`), `setLatest` (`:164-186`),
`pruneSupersededMaterialization` (`:136`), `savePendingTransaction` (`:109`), `ensureRevision`
(`:357`). One logical read of one block costs ~4 metadata reads plus a revision walk, a materialized
read and a pending list. Twenty-two commits over six hot blocks produce the measured profile.

The layers are deliberately stateless per call, and that design is not the problem — re-deriving
state from storage is correct and simple. What is wrong is that "storage" costs a device round trip
every time.

## Why the obvious fix was already rejected, and what is different here

A read cache at this seam **has been tried and measured**: memoizing `getMetadata` /
`getMaterializedBlock` per block, invalidated on any write to that block, cut 1541 → 1189 — only
**23%**. Do not re-propose that.

It fails because the reads exist to observe the writes. A commit runs read-meta → write-materialized
→ write-revision → promote → read-meta + write-meta → read-meta, and the next operation's pre-scan
reads metadata again. With 28 metadata writes over 6 blocks, invalidation lands between nearly every
read pair on exactly the hot blocks.

**The fix is coherence, not eviction policy.** `saveMetadata(id, meta)` stores `meta` into the cache
*as* it writes it, rather than dropping the entry. After one cold read per block, every subsequent
read is a hit for the life of the process, because the cache always holds the last durable value.

This is the same discipline the collection layer already uses one level up —
`CacheSource.transformCache` folds committed transforms into the cache in place rather than clearing
them (`packages/db-core/src/collection/collection.ts:458`, `:573`; class at
`packages/db-core/src/transform/cache-source.ts:19`). That cache is in use and cannot be extended to
cover this: roughly 400 of the 1987 are server-side authoritative reads below the transactor —
`pend`'s conflict checks (`storage-repo.ts:431-458`), `commit`'s staleness partitioning (`:586-609`),
`internalCommit` (`:854-922`) — which are consensus inputs and must read the authority. The two
caches compose: the collection cache saves network round trips, this one saves backend I/O.

## Why it is sound

Three properties, all enforced today. The prereq ticket writes them down; this ticket depends on
them holding.

1. **Single write funnel.** Every backend mutation goes through `IRawStorage` in-process —
   commits, replica saves, restores, read-driven promotions, invalidation applies. Cache and backend
   therefore agree at all times (`kv-raw-storage.ts:47-56` calls this "the single choke point").
2. **Latched read-modify-write.** Every writer of `meta.latest` serializes on the per-block commit
   latch (`storage-repo.ts:21-46`). The cache update happens inside the wrapped `save*` call, so it
   is inside whatever latch the caller holds; a latch-protected read-after-write sees the new value
   exactly as a disk read would. Unlatched readers can race a write — they can today too.
3. **Revision immutability.** Committed revisions and materialized blocks at a given
   `(blockId, actionId)` are append-only, guarded monotonically (`block-storage.ts:287`,
   `storage-repo.ts:589`). Only metadata and pending sets mutate, and both go through the funnel.

**Precondition:** a store is owned by exactly one process. This is the design's one correctness
cliff — a second writer makes cached values stale in ways that feed consensus decisions. The prereq
ticket documents it. Consider whether an advisory lock in the filesystem backend should enforce it;
if you decide against, say why in the handoff.

## What to build

A `CachedRawStorage` wrapping any backend. Prefer hooking at the `KvRawStorage` kernel
(`kv-raw-storage.ts:21`) rather than as an opaque `IRawStorage` wrapper: both shipped persistent
paths are kernel-backed now (`FileRawStorage extends KvRawStorage`,
`packages/db-p2p-storage-fs/src/file-storage.ts:411`), and the kernel sees encoded bytes and decoded
value at the same instant, which makes an entry's byte size free — the next ticket
(`shared-bounded-cache-pool`) needs that. Keep the plain-wrapper form working for a backend that is
not kernel-backed.

Semantics that must be exact:

- **Write-through, never write-behind.** `internalCommit`'s write ordering (materialize →
  `saveRevision` → `promote` → `setLatest`, `storage-repo.ts:888-899`) is crash-recovery
  load-bearing (recovery at `:638-660`). Never reorder, coalesce, or defer a write.
- **`promotePendingTransaction` is a cross-store atomic move** (`kv-raw-storage.ts:132`; Invariant P
  at `docs/repository.md:89-114`). Model it as one synchronous cache mutation after the driver's
  atomic promote resolves: drop the pending id, move the value from pending to committed — and if
  the pending transform was not cached, **invalidate** the committed entry rather than synthesize
  it. Getting this wrong recreates the phantom-pending bug class Invariant P exists to prevent. This
  is the single hardest part of the ticket; review it hardest.
- **`saveMaterializedBlock(id, actionId, undefined)` is a delete** — drop the entry.
- **Cache negatives.** `getMetadata → undefined` is cacheable, because everything that creates
  metadata passes through the wrapper (the seed at `block-storage.ts:110-118`, `saveRestored`,
  `saveForwardRevision`). Repeated probes of not-yet-created collections are a real cold-start
  pattern.
- **Clone on read and on write.** Callers mutate what they read — `setLatest` mutates `meta` in
  place before saving (`block-storage.ts:169-185`). Never hand out a cached reference. The clone
  discipline is already documented (`docs/internals.md:328-351`, `:903-923`) and asserted by
  `packages/db-p2p/src/testing/raw-storage-conformance.ts` — **run the wrapper under that
  conformance suite**; it is the right harness and it already tests this.
- **List completeness.** `listPendingTransactions` and `listRevisions` may only be served from cache
  when the set is known complete. Keep the completeness flag *inside the same cache entry* as the
  set it describes, so eviction can never strand a half-true claim. A block whose metadata the
  wrapper itself saw come into existence is complete without enumerating; otherwise one full
  enumeration sets it.

## Expected result

~1987 → roughly 165-200 operations, dominated by the ~130 writes, which are untouched. A
conservative first cut that leaves the revision map uncached lands near 430. Both crush the 23%
ceiling, because writes now feed the cache instead of killing it. Report the measured number.

## Edge cases & interactions

- **Bounding is deliberately out of scope.** This ticket may hold entries for the process lifetime.
  `shared-bounded-cache-pool-with-2q-admission` adds the bound and the cross-store pool, and lists
  this ticket as its prereq. Do not build a half-bound here — but do keep the entry classes and
  their keys clean enough for a pool to key on `(storeId, class, key)` later, and do not assume the
  cache is process-global.
- **Eviction is always safe** — the cache is clean, never dirty, so nothing needs pinning and
  `clear()` is correct at any instant. Preserve that property; it is what keeps eviction a pure
  performance question. If any design pressure pushes toward a dirty or pinned entry, stop and
  reconsider.
- **Concurrency.** Multiple in-flight operations touch the same block through the same wrapper.
  Cache mutation must be synchronous with respect to the write it accompanies, with no `await`
  between the driver write resolving and the cache update.
- **Header block ids are name-derived**, not content hashes (`docs/architecture.md:67`) — two stores
  running the same schema produce identical header block ids. Harmless while one wrapper serves one
  store, fatal once a pool is shared. Key defensively now so the next ticket is not a rewrite.
- **Restore and replica paths** (`saveRestored`, `saveForwardRevision`,
  `saveReplicatedBlock`) write revisions and materializations outside the commit path. They go
  through the funnel, so they must feed the cache identically. Cover them.
- **Absence verdicts.** The absence/unavailability logic distinguishes "provably absent" from
  "could not confirm". A cached negative must mean the former; make sure a cached `undefined` never
  becomes evidence for the latter.
- **Memory backend.** Already in-memory. The wrapper must not double-store there, or must be
  documented as pointless for it.

## How to confirm

Wrap the storage a cold start is given in a counting proxy and report operations by method and by
distinct block, before and after — the same shape as the table in this ticket. Then run the full
`db-p2p` suite plus the raw-storage conformance suite. A correctness bar worth stating explicitly:
every existing consensus, restore, and crash-recovery test must pass **unchanged**; if one needs
adjusting, that is a signal the cache changed semantics, not that the test was wrong.
