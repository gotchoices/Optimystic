description: When two parts of a program open the same storage folder separately, each used to get its own private copy of recently-read data and never saw what the other saved. They now share one copy, released only when the last user is done. Review the sharing, the release accounting, and the test changes that keep "reopen reads disk" honest.
prereq: store-identity-plumbing
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/node-read-cache-wiring.spec.ts, packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts, packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts, packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, packages/quereus-plugin-optimystic/test/deferred-constraint-rollback.spec.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/test/savepoint-rollback.spec.ts, packages/quereus-plugin-optimystic/test/update-pk-move-uniqueness.spec.ts, packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts, packages/db-p2p/docs/storage.md
difficulty: hard
----

# One read cache per backing store, shared under refcounted leases

## What was wrong

`withReadCache` (the one helper every production seam uses to put the write-through read cache
in front of a raw storage) built a fresh `CachedRawStorage` on every call. Two consumers over one
backing store — two `FileRawStorage(dir)` over one directory, or one unwrapped instance handed to
two consumers — each got a private cache and each served its own stale view forever. Measured:
peer A still read 1 row after peer B committed 3.

## What changed

### `packages/db-p2p/src/storage/with-read-cache.ts` (rewritten)

- New exports: `ReadCacheLease { cache; release(): Promise<void> }` and
  `ResolvedReadCache = { storage, lease: ReadCacheLease | undefined }`. `ownedCache` is gone.
- Module-level registry: `byIdentity: Map<StoreIdentity, RegistryEntry>` for storages that report
  `getStoreIdentity()`, plus `byObject: WeakMap<IRawStorage, RegistryEntry>` for those that don't.
  An identity-bearing storage is keyed by identity only.
- `withReadCache` is synchronous with no `await` between lookup and insert. Hit → `refs += 1`,
  same cache, fresh `Lease`. Miss → construct, register with `refs = 1`. First caller's `label`
  and `pool` stick; a second caller's different pool is ignored.
- `Lease.release()`: latches a per-lease `released` flag, decrements synchronously, and only the
  release that lands on 0 retires the registry entry (map delete, BEFORE the async dispose) and
  then `await cache.dispose()`. Double release and concurrent release are safe.
- `MemoryRawStorage` and an already-`CachedRawStorage` still pass through unchanged with
  `lease: undefined` — a host-built cache never enters the registry.

### Consumers

- `libp2p-node-base.ts` — `resolveStorage` returns `lease`; the stop wrapper (installed first, so
  it runs last) calls `lease.release()`. `RawStorageProvider` doc rewritten: two nodes over one
  store now share a cache; the label `NOTE:` explains N nodes over one store share one pool row.
- `collection-factory.ts` — `readCaches: CachedRawStorage[]` → `readCacheLeases: ReadCacheLease[]`;
  `dispose()` releases each. Doc comments on `createLocalTransactor` / `dispose` no longer promise
  a fresh cold cache per transactor: a reopen starts cold only if every earlier lease released.

### Docs — `packages/db-p2p/docs/storage.md`

Invariant 5 "Detecting a violation" now names the cache dedupe as the consumer of
`getStoreIdentity()`; § 6 wiring describes `{ storage, lease }`, "One cache per backing store,
shared under leases", "Lease obligations", "Lifetime now spans consumers", and what remains of
Invariant 5 (cross-process writers only).

## Validation run (all foreground, this session)

| command | result |
| --- | --- |
| `yarn workspace @optimystic/db-p2p test` | 2324 passing, 49 pending |
| `yarn workspace @optimystic/db-p2p-storage-fs test` | 71 passing, 1 pending |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` (+ smoke) | 671 passing, 13 pending |
| the five reopen specs below, re-run after the dispose sweep | 58 passing |
| `yarn typecheck` (after `yarn build`) | clean |
| `npx eslint <every file in files:>` | clean |

**Acceptance criterion met:** `read-pull-mechanism.spec.ts` "count(*) observes a second writer's
committed appends" now runs with two plain `rawStorageFactory: () => new FileRawStorage(dir)`
peers — no hand-built shared `CachedRawStorage` — and logs
`[cross-writer] peerA count after B appends = 3`. That is table row 2 of the original ticket
("two `FileRawStorage(dir)` instances, one cache each → 1, wrong") becoming correct.

## Test coverage (floor, not ceiling)

`packages/db-p2p/test/with-read-cache.spec.ts` pins:
- memory storage and already-cached storage pass through with no lease; host-built wrapper
  survives a consumer departing;
- two wraps of ONE unwrapped instance converge (object key); two distinct storages with one
  identity converge (identity key, modelled with a `Proxy` driver helper `identified(inner, id)`
  that adds `storeIdentity` over a shared `MemoryStoreDriver`);
- distinct identities / identity-less distinct objects stay independent (4 stores → 4 pool rows);
- refcount lifecycle: first departure keeps the cache live and pool-registered, last departure
  clears + unregisters, re-wrap is cold (asserts exactly one real backend `getMetadata`);
- double release on one lease, stale-lease inertness against a later re-wrap, concurrent
  `Promise.all` release → exactly one disposal;
- different pool on the second wrap ignored; first label wins and stays after the first departs;
- reopen-starts-cold after release; releasing the only lease retires the pool row.

`packages/db-p2p/test/node-read-cache-wiring.spec.ts` adds: two nodes over one
`KvRawStorage(MemoryStoreDriver)` → one pool row labelled by the first node; first stop keeps it,
last stop retires it.

`local-transactor-read-cache.spec.ts` (unchanged) still holds: it passes the SAME memory driver to
a fresh `KvRawStorage` per factory call, so the storages are distinct objects with no identity and
do NOT dedupe; its "dispose drops the pool store count by exactly 1" assertion passes.

## Sweep: plugin specs that reopen a directory and expect to read disk

With the shared cache, a second `Database` over a directory joins the first one's cache unless
the first released its lease (`plugin.dispose()`). Every plugin spec that closes a `Database` and
reopens the same directory to check persisted state was swept:

- **`read-pull-mechanism.spec.ts`** — `createDb`'s `shared` parameter and the hand-built
  `CachedRawStorage` removed; each peer `plugin.dispose()`s in its `finally`. Stale comment blocks
  rewritten.
- **`oldkeyvalues-compact-shape.spec.ts`**, **`session-mode-commit.spec.ts`** — every close site
  now `plugin.dispose()`s so the reopen reads disk. (Prior run.)
- **`legacy-commit-atomicity.spec.ts`**, **`committed-read-isolation.spec.ts`** — these write
  behind the plugin's cache via an injected transactor over a bare `FileRawStorage`. The injected
  `Database` never calls `createLocalTransactor` (transactor is pre-registered) so it never takes
  a lease; only the plain reopen does. `reopenCount` in the legacy spec now `plugin.dispose()`s so
  a second reopen in one test can never inherit a warm cache. `committed-read-isolation` was left
  untouched (single reopen per dir) and passes.
- **`deferred-constraint-rollback`, `insert-pk-uniqueness`, `savepoint-rollback`,
  `update-pk-move-uniqueness`** — THIS run closed the gap the prior run flagged: every
  `const { db } = createDb(dir)` now destructures `plugin`, every `db.close()` (44 sites total) is
  followed by `await plugin.dispose()`, the dead `void plugin;` in savepoint-rollback is gone, and
  each reopen helper carries a doc note saying why. Their "reopen: the overwrite never reached
  storage" assertions again read on-disk bytes rather than the previous handle's warm cache.
  All 58 cases pass.
- No spec hand-writes files into a directory a `Database` also uses; the only direct file writer
  (`file-raw-storage-actionid.spec.ts`) drives `FileRawStorage` alone.

## Known gaps / things for the reviewer to push on

- **Registry retention.** An entry lives until its last lease releases; a host that never calls
  `plugin.dispose()` / `node.stop()` holds one cache per store for the process lifetime. Recorded
  as a `NOTE:` at the registry declaration in `with-read-cache.ts` (hygiene, not correctness — the
  pool still evicts under pressure). Not a ticket.
- **Host-built cache hole.** A host that builds `new CachedRawStorage(FileRawStorage(dir))` itself
  and a second consumer whose factory builds a fresh `FileRawStorage(dir)` still end up with two
  caches — the helper never saw the host's. Out of scope by design; the follow-on
  `duplicate-store-identity-guard` (already in `implement/`, prereq on this slug) closes it at the
  pool.
- **Identity under-approximation.** Dedupe is only as good as `getStoreIdentity()`: path aliases
  or two handles over one SQLite file may still produce two caches. Each backend's own `NOTE:`
  lists its gaps (landed in `store-identity-plumbing`).
- **First pool wins.** A second caller passing a different `SharedCachePool` is silently ignored
  on a hit. Tested, documented in the helper's doc; no warning is logged. If a reviewer thinks a
  silent ignore is too quiet, a `wiringLog.warn` at the hit site would be the cheap fix.
- **`identified()` test helper is a `Proxy`** over `MemoryStoreDriver`. It binds functions to the
  target, so private-field access through `this` works; if a future driver reads private fields
  via the receiver, swap it for a hand-written delegating class.
- **Integration tier not run** (`OPTIMYSTIC_INTEGRATION=1` mesh specs). Nothing in this change
  touches the network path, and the mesh harness gives each node its own directory, so no dedupe
  hit is expected there; but it has not been exercised in this session.
- **Working-copy line endings.** The four sweep specs are CRLF in the working copy (git
  `autocrlf`), same as their neighbours; git normalises to LF on commit. `git diff` shows only
  the intended hunks.
