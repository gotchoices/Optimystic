description: A host can attach the storage read cache in either of two ways the documentation offers, but only one of them is recognized later; pick the other and the program refuses to start, blaming a problem that is not the one it actually has.
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/docs/storage.md
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The broken shape is not built anywhere in this repository — only an outside host following the docs would hit it — so a maintainer could reasonably delete the second documented construction instead of teaching the seam to recognize it, or decide the loud failure is acceptable until someone actually reports it.
----

# The seam can only recognize one of the two documented ways to attach a read cache

## What a reader needs to know first

A "read cache" sits between the database and its storage backend so repeated reads of the same
small records do not go back to disk every time. It must be the **only** cache over a given
backing store in the process, because it is kept correct by every writer passing through it; two
caches sitting side by side over one directory each end up serving a stale picture forever.

There are two documented ways to attach one:

- `new CachedRawStorage(inner)` — wrap the storage object.
- `new KvRawStorage(new CachedStoreDriver(driver))` — wrap the backend's lower-level driver.
  `packages/db-p2p/src/storage/cached-raw-storage.ts` explicitly says to **prefer** this one when
  the driver is reachable, because it skips a redundant encode/decode pass, and
  `packages/db-p2p/docs/storage.md` lists it as a supported construction.

Separately, every place inside this repository that resolves a storage calls the helper
`withReadCache(storage, ...)`, whose job is to attach the cache if one is not already attached.

## The defect

`withReadCache` decides "this storage is already cached" with a single check —
`storage instanceof CachedRawStorage` (`with-read-cache.ts`, top of the function). The second
documented construction does not produce a `CachedRawStorage`; it produces a plain
`KvRawStorage`. So the helper does not recognize it, and tries to attach a second cache.

Since the recently added one-cache-per-backing-store guard, that second attach no longer happens
silently — `SharedCachePool.registerStore` refuses it and **throws**. The host's node fails to
start. Two things make this worse than a clean rejection:

- **The message names the wrong cause.** It says the two caches "never converge" and would be "a
  second, independent view". That is true of two *side-by-side* caches, which is what the guard
  was built for. Here the caches would be *stacked* — the outer one reading through the inner one
  — which is merely redundant, not incoherent. A reader chasing a data-divergence bug that does
  not exist will waste time.
- **The message's suggested fix is the thing that just failed.** It says to use `withReadCache`,
  and `withReadCache` is what threw.

## Verified reproduction

Confirmed by running this against the current tree (a throwaway spec under
`packages/db-p2p/test/`, since no permanent home for it exists yet):

- build a driver that reports a fixed store identity,
- `const hostBuilt = new KvRawStorage(new CachedStoreDriver(driver, pool, 'host-built'))`,
- `withReadCache(hostBuilt, 'seam', pool)`.

Result: throws `two caches over one backing store never converge: "probe:one" is already cached
(label "host-built"); this registration (label "seam") would be a second, independent view. Share
one CachedRawStorage — withReadCache does this for you — or dispose the first.`

No production wiring in this repository builds the driver-level shape, so nothing here breaks
today. The reachable path is an embedding host that supplies its own storage — the
`rawStorageFactory` seam — and follows the documentation's own recommendation.

## What should be true instead

"Is this storage already read-cached?" should be a property a storage can **report**, not
something a caller guesses from its concrete class. The two constructions differ only in where
the cache sits in the composition; both end up with a `CachedStoreDriver` somewhere below, and
that fact is already propagated upward for two sibling questions — `KvRawStorage`'s constructor
wires `getStoreIdentity`, `listBlockIds`, and `getApproximateBytesUsed` through from its driver
in exactly this pattern. A cached-marker capability would travel the same wire, and then no
construction shape can be misread: the bad state stops being representable rather than being
detected case by case.

With that in place `withReadCache` returns the storage unchanged for **either** shape, the guard
never sees a stacked wrap at all, and its message stays true to the only case it can still be
raised for — genuinely side-by-side caches.

Whoever picks this up should also decide the smaller question it exposes: if the driver-level
construction is not meant to be handed across a seam, the documentation should say so, rather
than recommending it.
