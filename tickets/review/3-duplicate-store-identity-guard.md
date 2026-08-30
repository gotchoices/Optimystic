description: Two caches placed in front of one storage folder used to quietly serve each half of the program a different, never-updating view of the data; now the second one refuses to be built and says why.
files: packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/test/shared-cache-pool.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p-storage-fs/test/file-store-identity.spec.ts, packages/db-p2p/docs/storage.md
----

# Refuse a second cache over one backing store — review handoff

## What shipped

A prior ticket made `withReadCache` return one shared cache per backing store, closing the
composition seams. The hole left open: a cache can also be built directly —
`new CachedRawStorage(inner)` and `new KvRawStorage(new CachedStoreDriver(driver))` are both
supported, documented constructions — so a host that hand-builds a cache over a directory,
while a second consumer's storage factory returns a fresh storage over that same directory,
still got two caches that never converge. The helper never saw the first one.

Every cache, however constructed, registers a store with a `SharedCachePool`. That
registration is the choke point all paths share, so the guard lives there.

**`SharedCachePool`** (`shared-cache-pool.ts`)

- `registerStore(label?, identity?)` — new optional second parameter.
- A private `claims: Map<StoreIdentity, CacheStoreHandle>` of live registrations.
- A second `registerStore` for an identity already claimed **throws**, naming the identity,
  the incumbent label, the arriving label, and the fix.
- The check runs **before any mutation** — no store row, no consumed store id, no claim.
- `CacheStoreHandle` gained a `readonly identity` field so `unregisterStore` can free the
  claim. It frees it only when the map still points at *that* handle, so a late second
  unregister of a departed handle cannot strip the claim from a successor that legitimately
  took the identity in between.

**`CachedStoreDriver`** (`cached-store-driver.ts`)

- Constructor now calls `pool.registerStore(label, inner.storeIdentity?.())`.
- The throw escapes the constructor; the half-built driver is never returned and holds
  nothing to clean up. Confirmed to propagate out through `CachedRawStorage`'s `super(...)`
  chain (asserted in the fs spec).

**Docs** (`packages/db-p2p/docs/storage.md`) — section 6 gained a "construction guard behind
the dedupe" paragraph and the "what remains of Invariant 5" bullet became a four-item list;
the cache's Invariant-5 entry in the soundness list notes that the in-process twin is now
enforced.

## Escapes left open, deliberately

Each is stated in the pool's class doc and in `docs/storage.md` section 6:

- **Two different pools.** The claim map lives on the pool, so one identity registered on two
  `SharedCachePool` instances succeeds twice and still diverges. Closing it needs a
  process-global registry outliving every pool. Pinned by a test so it reads as a decision.
- **Backends reporting no identity** (memory drivers, test doubles) are uncovered, correctly:
  two memory drivers are two genuinely different stores.
- **Cross-process** sharing of one directory is untouched — Invariant 5's standing unenforced
  precondition and the proper-lockfile TODO in `db-p2p-storage-fs/src/file-storage.ts`.

## Validation performed

All green, all foreground:

- `yarn workspace @optimystic/db-p2p test` — 2332 passing, 49 pending
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 671 passing, 13 pending
- `yarn workspace @optimystic/db-p2p-storage-fs test` — 72 passing, 1 pending
- `yarn workspace @optimystic/db-p2p-storage-ns test` — 58 passing
- `yarn workspace @optimystic/db-p2p-storage-rn test` — 53 passing
- `yarn workspace @optimystic/db-p2p-storage-web test` — 52 passing
- `yarn build` and `yarn typecheck` — clean

No pre-existing failures surfaced; nothing was skipped or loosened.

**Note for anyone re-running the fs/ns/rn/web suites:** they resolve `@optimystic/db-p2p` from
its `dist/`, not `src/`. A source change to db-p2p is invisible to them until `yarn build`
runs. This cost one confusing red run during implementation — worth knowing before concluding
a guard "doesn't fire".

## Tests added

`packages/db-p2p/test/shared-cache-pool.spec.ts` (5 new, in `SharedCachePool mechanics`):

- the second registration for one identity throws, and the message names the identity, the
  incumbent label, the arriving label, and `withReadCache`
- a refused registration leaves stores/bytes/entries exactly as they were, and a different
  identity still registers afterward
- `unregisterStore` frees the identity so sequential reuse registers cleanly; a repeat
  unregister of the departed handle does not strip the successor's claim
- registrations with no identity coexist freely
- one identity on two pools both succeed — the documented escape

`packages/db-p2p/test/cached-raw-storage.spec.ts` (new describe, real construction path):

- two `CachedRawStorage` over storages claiming one identity, one pool → second throws, and
  the pool shows only the first store; after `dispose()` of the first, the second succeeds
- two caches over two `MemoryRawStorage` coexist

`packages/db-p2p-storage-fs/test/file-store-identity.spec.ts`:

- new: a second cache over one directory on one pool is refused — the end-to-end join across
  packages, with a real filesystem identity through the real construction path

## Sweep for existing double registrations

Swept every `new CachedRawStorage` / `new CachedStoreDriver` site in the repo, plus every
`withReadCache` call site. **One** existing spec tripped the guard, and it was the only one:

`packages/db-p2p-storage-fs/test/file-store-identity.spec.ts` — "two independent caches over
ONE directory report equal identities" built both over one `SharedCachePool`. Its point is the
identity-equality fact, not coexistence, so it now builds each on its own pool (the documented
escape) with a comment saying why. Its assertion is unchanged.

`read-pull-mechanism.spec.ts`, which the ticket flagged, no longer hand-builds a cache — the
prereq removed it. Confirmed by grep. The sanctioned paths (`with-read-cache.spec.ts`,
`node-read-cache-wiring.spec.ts`, the whole quereus plugin suite) pass **unchanged**.

## What a reviewer should push on

Honest gaps, roughly in order of how much they would repay a second pass:

- **The sequential-reuse window is argued, not tested.** `withReadCache`'s last release does
  `retire()` then `dispose()`; the claim is freed inside `dispose()`'s synchronous prefix, so
  retire and unregister land in one synchronous block and a re-wrap can never find the registry
  empty while the claim is still held. That reasoning is recorded as a `NOTE:` tripwire at
  `CachedStoreDriver.close()` (an `await` inserted ahead of `unregisterStore` would open the
  window). No test pins it — a test would have to interleave at exactly that point. Worth
  deciding whether the NOTE is enough.
- **Production wiring is only covered transitively.** The guard is exercised directly by unit
  specs and by the fs identity spec; the quereus and libp2p seams are covered only by "the
  existing suites still pass". No test asserts that a host-built cache plus a seam-built one
  over the same real directory throws end-to-end through `CollectionFactory`. That is the exact
  scenario the ticket described, and it is the one shape not directly pinned.
- **Message quality is asserted by substring.** The test checks four substrings plus
  `withReadCache`. If the message is reworded, the test fails for the right reason but says
  little about whether the new wording is actually actionable.
- **Cross-suite ordering.** The db-p2p suite shares one `defaultCachePool()` across the whole
  process. Nothing in it registers an identity-bearing store on the default pool today (every
  identity-bearing spec passes an explicit pool), so ordering cannot matter yet — but a future
  spec that hand-builds a cache over a real directory on the default pool could collide with
  another file's, and the failure would look like a flake dependent on file order. Nothing
  guards against that; consider whether it should.
- **`stats()` does not expose identity.** The ticket did not ask for it and the shape stayed
  stable, but a `stats()` row saying which store an identity claims would make a guard failure
  easier to debug from a running process. Deliberately left out; a reviewer may disagree.

## Tripwires recorded

- `NOTE:` at `CachedStoreDriver.close()` — `unregisterStore` must stay in the synchronous
  prefix, ahead of any `await`, or `withReadCache`'s retire/dispose block opens a window where
  a re-wrap trips the guard on a claim that is merely late to be released.
