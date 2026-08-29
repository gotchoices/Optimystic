description: Disk-backed storage was re-reading the same small files hundreds of times per query; a caching layer fixed that, and this review pass fixed a bug where a program that shared one cache between two parts had the cache torn down as soon as the first part finished with it.
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p-storage-fs/src/atomic-write.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/node-read-cache-wiring.spec.ts, packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts, packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts, packages/db-p2p/docs/storage.md, docs/repository.md
----

# Write-through read cache in front of file-backed raw storage - complete

## What shipped

`BlockStorage` re-reads block metadata on essentially every operation and `StorageRepo` builds a
fresh `BlockStorage` per block per call, so nothing above the raw-storage boundary memoized. Over
a filesystem backend that was hundreds of reads of the same small files per statement, enough to
push plugin specs past their Mocha timeout on a slow-disk host.

`withReadCache(storage, label?, pool?)` is now the one seam that puts `CachedRawStorage` in front
of a persistent backend. It passes `MemoryRawStorage` and an already-wrapped `CachedRawStorage`
through unchanged. Two call sites: `CollectionFactory.createLocalTransactor` and `resolveStorage`
in `libp2p-node-base.ts`. A win32 skip of the directory fsync in `atomic-write.ts` rode along.

Measured A/B (implement pass, both arms in one process, only the wrap decision changed):
113 -> 6 `getMetadata` and 207 -> 14 total reads at the `RawStoreDriver` seam; over
`FileRawStorage`, 184 -> 9 `readFile` and 29 -> 6 `readdir`. The `open` count did not move because
the fsync skip was active in both arms - that change is orthogonal and its magnitude remains
**inferred, not measured**. Wall clock (789 ms -> 165 ms) is a single sample on a noisy host; the
operation counts are the evidence.

## Review findings

### Fixed in this pass

**1. Both seams disposed a cache the host owned (root cause; repro: verified).**
`withReadCache` returned a bare `IRawStorage`, so each call site decided "is this mine to release?"
by `instanceof CachedRawStorage` - which is also true on the pass-through branch, where the object
came *from the host*. Consequence, reproduced by script against the built `dist/`: a host that
follows the recipe the code and docs recommend for sharing one store across in-process consumers
(build one `CachedRawStorage`, hand the same object to each) loses it the moment the FIRST consumer
departs. `dispose()` clears every entry and calls `pool.unregisterStore`, which deletes the store's
row from `SharedCachePool.stats()`. The surviving consumers keep reading and keep admitting entries
against that retired handle, so from then on live pool occupancy is charged but unattributable:

```
after populate     : [{"id":"s1","label":"host-owned","bytes":289,"entries":1}] entries=1 bytes=289
after A disposes   : []                                                        entries=0 bytes=0
after B keeps using: []                                                        entries=1 bytes=289
```

Not data corruption - the cache is write-through and clean, so clearing it is always safe - but a
library disposing a caller's object, and it silently defeats the only workaround the sibling
backlog ticket offers. Both dispose paths justify themselves in comments as "keeps pool occupancy
honest"; this made it dishonest in exactly the sanctioned configuration.

Fixed at the seam rather than per site: `withReadCache` now returns a pair of `storage` and
`ownedCache`, where `ownedCache` is the wrapper *that call* constructed and undefined on every
pass-through. Both seams dispose `ownedCache` and never `storage`, so the question can no longer
be answered wrong by inspecting the result's type. `resolveStorage` returns the same pair. Guarded
by two new tests in `with-read-cache.spec.ts` and one in the new node spec.

**2. The node seam had no end-to-end test - the handoff's stated reason does not hold.**
The prior pass left `resolveStorage`'s wrapping and the stop-wrapper's dispose verified only by
reading the code, judging a node spin-up too slow. Timed:
`owned-block-seed-node-wiring.spec.ts` spawns two real libp2p nodes in **428 ms and 93 ms**; its
41 s wall clock is mocha/ts-node startup, paid once for the whole suite regardless. New
`packages/db-p2p/test/node-read-cache-wiring.spec.ts` (3 tests, real nodes) asserts through
`defaultCachePool().stats().stores` that a host-supplied persistent storage gets a
`node:<networkName>` cache, that node stop retires exactly that registration, that a
`MemoryRawStorage` registers nothing, and that a host-supplied `CachedRawStorage` survives the node
it was lent to. That closes what the handoff called the largest untested surface in the change.

**3. Stale measurement in `with-read-cache.ts`'s header.** It claimed "measured 314 -> 32 on a
two-statement workload", the figure the implement pass had itself concluded does not reproduce.
Replaced with the numbers the A/B actually produced (and that the regression spec asserts).

**4. `read-pull-mechanism.spec.ts` leaked its shared `CachedRawStorage`** - constructed, never
disposed, so its store registration outlived the test in the process-wide pool for the rest of the
run. Disposed in the cleanup block, which is now the test's own job: with finding 1 fixed, neither
peer's `plugin.dispose()` touches a storage the test owns.

**5. Missing regression guards for the two properties the whole pass turned on.** Both documented
in three places, neither tested. Added to `with-read-cache.spec.ts`: the sharing recipe survives a
consumer departing (finding 1's guard), and two wraps of ONE unwrapped instance really are two
independent caches that never converge (the footgun the docs warn about - the reader observes the
writer's first save and then never again).

### Verified, no change needed

- **Stop-wrapper ordering.** The cache wrapper's comment claims it runs last because it is
  installed first. Checked all seven `node.stop` wrappers: the cache wrapper (line ~747) is the
  earliest and is the only one that calls its captured previous stop *first* and disposes in the
  trailing cleanup; every later one does its own work first and calls the previous stop in cleanup.
  So dispose really does run after the original libp2p stop and after every monitor's own stop
  work. Claim holds.
- **No concurrent sharing of one storage across live nodes.** Re-walked the provider sites rather
  than taking the handoff's word: `distributed-transaction-validation.spec.ts` builds one
  `FileRawStorage` per node index over per-index directories; `mesh-harness.ts` constructs
  `StorageRepo` directly and never reaches `createLibp2pNode`, so it is not wrapped at all;
  `owned-block-seed-node-wiring.spec.ts` shares one `MemoryRawStorage` across two *sequential*
  nodes and memory storage is excluded anyway.
- **`CollectionFactory.dispose()` error handling.** Awaiting each cache's dispose in a loop would
  skip later caches if one threw - but `CachedStoreDriver.close()` is a clear, an unregister, and
  an optional inner close; the first two are in-memory and cannot throw, and
  `RawStorageDriverAdapter` defines no close at all. Not reachable; left alone rather than
  manufacturing a finding.
- **Regression bounds** (20 `getMetadata` / 45 total). The spec's own counters read exactly 6 / 14
  against 113 / 207 uncached, so the ~3x headroom is calibrated, not guessed.

### Recorded as a tripwire, not a ticket

- `resolveStorage` labels the pool store with the network name, so N nodes on one network in one
  process produce N identically-labelled rows in `SharedCachePool.stats()` - real today in
  `distributed-transaction-validation.spec.ts` (3 nodes, one network name). They are still distinct
  stores (the pool keys on a monotonic store id, not the label), so this is only a legibility issue
  for a human reading occupancy. A `NOTE:` at the label site in `libp2p-node-base.ts` says what to
  do if per-node attribution is ever needed.

### Filed / carried forward

- `backlog/debt-two-caches-over-one-store-never-converge` (filed by the implement pass) **stands as
  filed** - the handoff explicitly asked whether it should block instead, and it should not. The
  configuration it describes (two storage objects over one directory) was already unsupported
  before this change: `FileRawStorage` takes no cross-process lock and is last-writer-wins, and
  one-owner-per-store is Invariant 5, predating the cache. The change makes that configuration
  deterministically wrong instead of racy, which is worse to hit and better to diagnose. It is not
  a "should we do this at all" question - the fix shape is settled (store identity, or a loud
  refusal at the pool), only the timing is open - so it is backlog, not blocked. The ticket was
  updated with what landed here, so a future implementer does not re-derive the ownership defect
  and knows `withReadCache`'s return shape changed.

### Known gaps left open, deliberately

- **`plugin.dispose()` is opt-in and almost nothing calls it.** The 18 pre-existing plugin specs
  were not rewritten to call it. A host that never disposes leaks cold pool entries the pool evicts
  under pressure - hygiene, not correctness. Covered by `local-transactor-read-cache.spec.ts` only.
- **The win32 `fsyncDir` skip is not directly tested** and its magnitude is inferred. It also opens
  a power-loss window on win32 that does not exist on POSIX; that tradeoff was made by the implement
  pass and not re-litigated here.

## Validation

All foreground, after the final rebuild, on the reviewed tree:

- `yarn build`, `yarn typecheck`, `yarn lint` - clean.
- `yarn workspace @optimystic/db-p2p test` - **2274 passing**, 44 pending, 0 failing (2269 before;
  +5 from the new guards).
- `yarn workspace @optimystic/db-p2p-storage-fs test` - **60 passing**, 1 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` - **658 passing**, 13 pending,
  0 failing, plus `test:smoke`.

No pre-existing failures surfaced; nothing added to `tickets/.pre-existing-known.md`. No test was
skipped, disabled, or had an assertion loosened.

## Docs

`packages/db-p2p/docs/storage.md` section 6 "Write-through raw-storage cache" carries the new
return shape and a rewritten **Dispose obligations** paragraph explaining why "is a
`CachedRawStorage`" and "is mine to release" are different questions. `docs/repository.md` keeps
its pointer bullet into that section. The root-level `docs/storage.md` the original ticket named
does not exist and never did.
