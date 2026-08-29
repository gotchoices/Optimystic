description: If a program still manages to put two separate caches in front of one storage folder, it should fail loudly at the moment it happens rather than quietly serving each half of the program a different, never-updating view of the data.
prereq: read-cache-dedupe-by-store-identity
files: packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/test/shared-cache-pool.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/docs/storage.md
difficulty: medium
----

# Refuse a second cache over one backing store

## The remaining hole

`withReadCache` now returns one shared cache per backing store, so the composition seams can
no longer produce two. But a cache can be constructed **without** going through that helper —
`new CachedRawStorage(inner)` and `new KvRawStorage(new CachedStoreDriver(driver))` are both
documented, supported constructions. The realistic bad wiring that survives:

> A host builds its own `CachedRawStorage` over `dir` and hands it to one consumer. A second
> consumer's `rawStorageFactory` builds a fresh `FileRawStorage(dir)`. The helper has never
> seen the host's cache, so it constructs a second one — and the two never converge.

Every cache, however constructed, registers a store with a `SharedCachePool`. That
registration is the one choke point all construction paths share, so it is where the conflict
can be caught.

## The guard

`CachedStoreDriver`'s constructor already calls `pool.registerStore(label)`. Pass the inner
driver's identity along:

```ts
this.store = pool.registerStore(label, inner.storeIdentity?.());
```

`SharedCachePool` keeps `Map<StoreIdentity, CacheStoreHandle>` of live registrations. A second
`registerStore` with an identity already present **throws**, naming both labels, the identity,
and the fix:

```
two caches over one backing store never converge: "file:/tmp/xyz" is already cached
(label "quereus:local"); this registration (label "node:test") would be a second, independent
view. Share one CachedRawStorage — withReadCache does this for you — or dispose the first.
```

Throwing rather than logging is the point: the failure it replaces is silent wrong data
returned to a caller who has no way to notice. A registration with no identity is unaffected —
it registers exactly as today.

`unregisterStore` must delete the identity mapping, or sequential reuse (stop a node, start
another over the same directory) would throw on the second start. That is the single most
important line in this change.

## Known escapes, deliberately left open

- **Two different pools.** The map lives on the pool, so two caches over one store registered
  with two different `SharedCachePool` instances still both succeed and still diverge. Closing
  it would mean a process-global identity registry that outlives every pool, which is worse
  machinery than the case deserves: passing a non-default pool is an explicit act, done by
  tests for isolation and by hosts for sizing. Pin the behavior in a test so it reads as a
  decision rather than an oversight, and record it in the pool's class doc.
- **Backends with no identity** (memory drivers, test doubles) are not covered at all. That is
  correct — two memory drivers are two genuinely different stores.
- **Cross-process** sharing of one directory is out of scope entirely; that is Invariant 5's
  unenforced precondition and the proper-lockfile TODO in
  `db-p2p-storage-fs/src/file-storage.ts`.

## Edge cases & interactions

- **A throw must leave the pool untouched.** Validate and throw BEFORE mutating `stores`, the
  counter, or the identity map. Test that after a caught throw, `pool.stats().stores` is
  exactly what it was, and that disposing the first cache then lets a new one register.
- **A half-built `CachedStoreDriver`.** The throw escapes the constructor, so the object is
  never returned; nothing else to clean up — but confirm the caller (`CachedRawStorage`'s
  `super(...)` chain) does not swallow it.
- **Sequential reuse.** dispose → re-register the same identity must succeed. Explicit test.
- **`unregisterStore` is idempotent** today; keep it so with the map delete.
- **The sanctioned paths must never trip it.** One host-built cache handed to N seams is ONE
  registration (the seams pass it through). Two seams over one directory dedupe in
  `withReadCache` to one registration. Both are already covered by specs — confirm they pass
  unchanged rather than adjusting them.
- **Sweep for existing double registrations.** Any spec or harness that builds a
  `CachedRawStorage` over a real backend while another cache over the same location is still
  live will now throw. `read-pull-mechanism.spec.ts` hand-built one over the same `dir` its
  other tests use through `rawStorageFactory`; the prereq ticket should have removed it —
  verify, and check the mesh harness and the fs/ns/rn/web suites for the same shape. Because
  the plugin does not dispose caches on `db.close()`, a cache built in an earlier test in a
  file is generally **still registered** when a later test in that file runs, so "the same
  temp dir reused across tests in one file" is the pattern to look for.
- **`setBudget`, eviction, and stats** are untouched; the identity map is registration
  bookkeeping only and must not appear in the byte or entry budget.

## Tests

`shared-cache-pool.spec.ts`:

- Registering two stores with the same identity throws; the message names the existing label.
- The pool is unchanged after the throw (store list, counters), and a third registration with
  a *different* identity still succeeds.
- `unregisterStore` frees the identity: register → unregister → register the same identity
  succeeds.
- Two registrations with no identity coexist (the memory-driver case).
- Same identity on two different pool instances both succeed — the documented escape.

`cached-raw-storage.spec.ts` (or a sibling):

- Two `CachedRawStorage` over two storages reporting the same identity, on one pool, throw on
  the second construction; after `dispose()` of the first, the second construction succeeds.

## Docs

`packages/db-p2p/docs/storage.md`: in § 6 and under Invariant 5, state that the in-process
"two caches over one store" case is now refused at construction, name the two escapes above,
and leave the cross-process case as the standing unenforced precondition.

## TODO

- Add the optional `identity` parameter to `SharedCachePool.registerStore`, the live-identity
  map, the throw (before any mutation), and the delete in `unregisterStore`.
- Pass `inner.storeIdentity?.()` from `CachedStoreDriver`'s constructor.
- Document the two escapes in the pool's class doc.
- Add the pool and cache specs above.
- Sweep specs/harnesses for a second live cache over one real backing location; fix any found.
- Update `docs/storage.md` § 6 and Invariant 5.
- Run: `yarn workspace @optimystic/db-p2p test`,
  `yarn workspace @optimystic/quereus-plugin-optimystic test`,
  `yarn workspace @optimystic/db-p2p-storage-fs test`, then `yarn build && yarn typecheck`.
