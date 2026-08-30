description: When two parts of a program open the same storage folder separately, each used to get its own private copy of recently-read data and never saw what the other saved. They now share one copy, released only when the last user is done.
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/README.md, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/node-read-cache-wiring.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique-migration.spec.ts, packages/db-p2p/docs/storage.md
----

# One read cache per backing store, shared under refcounted leases

## What shipped

`withReadCache` — the single helper every production seam uses to put the write-through read
cache in front of a raw storage — used to build a fresh `CachedRawStorage` on every call. Two
consumers over one backing store each got a private cache and each served its own stale view
forever (measured: peer A still read 1 row after peer B committed 3).

It now keeps a module-level registry of live caches and hands the second caller over a store the
SAME cache under a fresh `ReadCacheLease`. The registry is keyed by `getStoreIdentity()` when the
backend reports one (two `FileRawStorage` over one directory) and by the storage object otherwise.
`ResolvedReadCache` became `{ storage, lease }`; a lease is released, never disposed, and only the
release that lands the refcount on zero retires the registry entry (synchronously, before the
async dispose) and tears the cache down. `MemoryRawStorage` and an already-`CachedRawStorage` still
pass through with no lease, so a host-built cache never enters the registry.

Consumers: `libp2p-node-base`'s stop wrapper releases the node's lease (installed first so it runs
last); `CollectionFactory` tracks leases instead of caches and releases them in `dispose()`.
`packages/db-p2p/docs/storage.md` Invariant 5 and section 6 were rewritten around the new contract.

**Acceptance criterion met.** `read-pull-mechanism.spec.ts`'s cross-writer test now runs two peers
with plain `rawStorageFactory: () => new FileRawStorage(dir)` — no hand-built shared cache — and
logs `[cross-writer] peerA count after B appends = 3`.

## Review findings

**Checked:** the implement diff read fresh before the handoff summary; the helper's registry keying,
refcount arithmetic, retire-before-dispose ordering, double and concurrent release, both
pass-through branches, and the "no `await` between lookup and insert" invariant; both consumer
seams and their teardown paths; what a disposed-but-still-referenced cache actually does; every
`docs/` and README file the change touches or should have touched; the completeness of the
plugin-spec sweep, by scripted scan of every spec that opens two or more `Database`s over a
`FileRawStorage`; lint, build, typecheck, and the db-p2p, quereus-plugin, and fs suites.

**Fixed in this pass (minor):**

- **The sweep missed a site.** `secondary-unique-migration.spec.ts` closes a `Database` over a temp
  dir and reopens the same dir in the same test to prove a later build backfills from what the
  earlier build left on disk — exactly the shape the sweep targeted. Its `createDb` did not return
  the plugin handle, so neither close released, and build 2 was reading build 1's warm cache rather
  than disk. `createDb` now returns `plugin`, both close sites `await plugin.dispose()`, and the
  helper carries a doc note saying why. The assertions passed either way (the warm cache holds the
  same values), so this was a silently weakened premise, not a false green.
- **`memory-store-driver.ts`'s identity NOTE stated something untrue.** It justified having no
  `storeIdentity()` with "the case that DOES matter — one driver object shared by two wrappers — is
  already covered by object identity". It is not: `withReadCache`'s fallback key is the *storage*
  object, so two `KvRawStorage` over one `MemoryStoreDriver` are two keys and get two caches over
  one Map — the divergence this ticket exists to remove. Rewritten to state the real gap (see the
  tripwire below).
- **Host-facing dispose docs were stale and, in the README, absent.** `plugin.dispose()` was never
  mentioned in `packages/quereus-plugin-optimystic/README.md`, and `plugin.ts`'s doc still said
  skipping it "leaks only cold cache bookkeeping". Skipping it now also keeps the store's cache warm
  for the process, so a later `Database` over the same store reads the cache instead of the backend.
  Both updated; the README gained a "Closing down" section with the mutate-behind-our-back caveat.
- **`file-storage.ts`'s win32 case-fold NOTE** warned that "a consumer that merges on equality would
  then merge two distinct stores". That consumer now exists. The NOTE names it. This is an accepted
  tradeoff whose stated revisit condition (Optimystic targeting a case-sensitive-enabled Windows
  directory) has NOT tripped, so it was not re-filed — only made accurate.

**Test added (one real gap):** every lifecycle test walked the OBJECT key. Production walks the
IDENTITY key, where retirement is a `Map.delete` and the key outlives every storage object that used
it — a leftover entry would hand a reopened store a dead cache, and a successor retired by a
departed lease would blind the store that just reopened it. `with-read-cache.spec.ts` now pins that
release-then-re-wrap under the same identity yields a new cold cache with a new pool row, and that
the stale lease is inert against its successor. The rest of the implementer's coverage held up:
pass-through branches, both convergence keys, non-over-merging, refcount lifecycle,
double/concurrent release, first-pool-and-label-wins, reopen-starts-cold.

**Tripwires recorded, not filed:**

- One driver object behind two `KvRawStorage` wrappers still gets two caches — `NOTE:` in
  `memory-store-driver.ts` with the condition (a host wiring
  `rawStorageFactory: () => new KvRawStorage(oneSharedDriver)` for two consumers) and the remedy
  (`identityForHandle('memory', this)`, and re-premising `local-transactor-read-cache.spec.ts`,
  which currently asserts the non-dedupe). Dormant today: this driver is a test fixture and every
  shipping backend's driver reports an identity.
- On a dedupe hit the `storage` argument is dropped unused, so the FIRST caller's instance is the
  only one the last release closes — `NOTE:` at the hit site in `with-read-cache.ts`. Free today
  (`IRawStorage` has no close, and only the filesystem backend can make two distinct objects
  collide on identity, and it holds nothing open); it would leak a handle for any future backend
  pairing a location-derived identity with an open handle.

**Examined and deliberately left alone:**

- *A no-lease pass-through consumer can outlive the last lease and keep using a disposed cache.*
  Traced through `CachedStoreDriver.close()`: it clears, unregisters, and closes the inner driver,
  after which reads simply re-consult the backend and re-admit into an unregistered store handle.
  The pool still evicts those entries normally, so the consequence is a missing row in
  `stats().stores`, not wrong data. Already the documented behaviour for host-built caches, and
  unchanged in reachability by this ticket.
- *`CollectionFactory.dispose()` aborts its remaining releases if one `release()` rejects.* Identical
  shape to the pre-change loop over `cache.dispose()`, and the consequence is unretired pool rows.
  Not worth changing the error semantics for.
- *The registry is module-global,* so two copies of `@optimystic/db-p2p` in one process would split
  it and silently stop deduping. `defaultCachePool()` already rests on the same single-instance
  assumption; this adds no new exposure.
- *`byObject`'s entries hold a `retire` closure over their own WeakMap key.* Correct under ephemeron
  collection, which V8 implements; no retention.
- `committed-read-isolation`, `composite-pk-point-lookup` and `nullable-pk-point-lookup` were
  confirmed correctly untouched — the first drives a shared in-memory transactor that never takes a
  lease, the other two give every test a fresh directory and never reopen one.

**No tickets filed.** Nothing found rose above a tripwire or an inline fix; the one structural gap
that remains (backends reporting no identity) already has a stated position on the board in
`duplicate-store-identity-guard`.

## Validation

| command | result |
| --- | --- |
| `yarn lint` (repo-wide) | clean |
| `yarn build` then `yarn typecheck` | clean |
| `yarn workspace @optimystic/db-p2p test` | 2325 passing, 49 pending |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` (+ smoke) | 671 passing, 13 pending |
| `yarn workspace @optimystic/db-p2p-storage-fs test` | 71 passing, 1 pending |

No pre-existing failures surfaced. The integration tier (`OPTIMYSTIC_INTEGRATION=1` mesh specs) was
not run, as in the implement stage: the mesh harness gives every node its own directory, so no
dedupe hit arises there.
