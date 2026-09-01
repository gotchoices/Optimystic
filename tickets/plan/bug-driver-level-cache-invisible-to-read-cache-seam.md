description: A host can attach the storage read cache in either of two ways the documentation offers, but only one of them is recognized later; pick the other and the program refuses to start, blaming a problem that is not the one it actually has.
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/with-read-cache.spec.ts
repro: verified
difficulty: medium
----

# The seam can only recognize one of the two documented ways to attach a read cache

## What a reader needs to know first

A "read cache" sits between the database and its storage backend so repeated reads of the same
small records do not go back to disk every time. It must be the **only** cache over a given
backing store in the process, because it is kept correct by every writer passing through it; two
caches sitting side by side over one directory each end up serving a stale picture forever.

The documentation (`packages/db-p2p/docs/storage.md` § "Write-through raw-storage cache",
"Wiring" bullets) offers two ways to attach one:

- `new CachedRawStorage(inner)` — wrap the storage object. Used when only the storage surface
  (`IRawStorage`) is reachable.
- `new KvRawStorage(new CachedStoreDriver(driver))` — wrap the backend's lower-level driver
  (`RawStoreDriver`). `cached-raw-storage.ts` explicitly says to **prefer** this one when the
  driver is reachable, because it skips a redundant encode/decode pass on cold misses.

Separately, every place inside this repository that resolves a storage for real use calls the
helper `withReadCache(storage, label?, pool?)`, whose job is to attach the cache if one is not
already attached, and to return the storage unchanged if one is.

## The defect

`withReadCache` decides "this storage is already cached" with a single check —
`storage instanceof CachedRawStorage` (`with-read-cache.ts`, first line of the function). The
second documented construction does not produce a `CachedRawStorage`; it produces a plain
`KvRawStorage`. So the helper does not recognize it, and tries to attach a second cache.

Since the one-cache-per-backing-store guard landed, that second attach no longer happens
silently — `SharedCachePool.registerStore` (`shared-cache-pool.ts:235`) refuses it and **throws**,
so the host's node fails to start. Two things make this worse than a clean rejection:

- **The message names the wrong cause.** It says the two caches "never converge" and would be "a
  second, independent view". That is true of two *side-by-side* caches, which is what the guard
  was built for. Here the caches would be *stacked* — the outer one reading through the inner one
  — which is merely redundant, not incoherent. A reader chasing a data-divergence bug that does
  not exist will waste time.
- **The message's suggested fix is the thing that just failed.** It says to use `withReadCache`,
  and `withReadCache` is what threw.

## Verified reproduction

Confirmed against the current tree with a throwaway spec under `packages/db-p2p/test/` (not kept
— no permanent home for it exists yet; the eventual fix should pin it in
`test/with-read-cache.spec.ts`):

- build a driver that reports a fixed store identity,
- `const hostBuilt = new KvRawStorage(new CachedStoreDriver(driver, pool, 'host-built'))`,
- `withReadCache(hostBuilt, 'seam', pool)`.

Result: throws `two caches over one backing store never converge: "probe:one" is already cached
(label "host-built"); this registration (label "seam") would be a second, independent view. Share
one CachedRawStorage — withReadCache does this for you — or dispose the first.`

No production wiring in this repository builds the driver-level shape, so nothing here breaks
today. The reachable path is an embedding host that supplies its own storage — the
`rawStorageFactory` seam in `collection-factory.ts:314`, or a `RawStorageProvider` at
`libp2p-node-base.ts:385` — and follows the documentation's own recommendation.

## Required behavior

- `withReadCache` returns the storage **unchanged, with no lease**, for *either* documented
  construction. Unchanged-and-unleased is already the contract for a host-built
  `CachedRawStorage`: the cache stays the host's to dispose, and the seam must not release it.
- The guard in `SharedCachePool.registerStore` keeps throwing for the case it was built for —
  two genuinely side-by-side caches over one identity — and its message stays true for that case.
  It should simply never see a stacked wrap, because the seam no longer builds one.
- Nothing about the existing dedupe registry changes. In particular the pinned case in
  `test/cached-raw-storage.spec.ts:414-446` — host hand-builds a cache over one storage object,
  a seam is later handed a *different, uncached* object over the same directory — must still
  throw. That is a real side-by-side pair; the marker only speaks for the object actually passed.

## Shape of the fix (architecture, not a task list)

"Is this storage already read-cached?" should be a property a storage can **report**, not
something a caller infers from its concrete class. Both constructions end up with a
`CachedStoreDriver` somewhere below; that fact just needs to travel upward.

The wire already exists and is used for three sibling questions. `KvRawStorage`'s constructor
conditionally wires `getStoreIdentity`, `listBlockIds`, and `getApproximateBytesUsed` through
from its driver, and `RawStorageDriverAdapter`'s constructor mirrors it in the other direction.
A cached-marker capability — an optional member on `RawStoreDriver` that `CachedStoreDriver`
always sets, passed through by `KvRawStorage` onto an optional member of `IRawStorage` — travels
the same wire. Then:

- the driver-level shape reports cached, because its driver is a `CachedStoreDriver`;
- `CachedRawStorage` reports cached for free, since it *is* a `KvRawStorage` over a
  `CachedStoreDriver` — so the `instanceof CachedRawStorage` check in `withReadCache` can be
  replaced by the marker rather than joined to it;
- no future composition shape can be misread, because the answer comes from the composition
  instead of from a class name. The bad state stops being representable rather than being
  detected case by case.

Naming and exact typing are the plan's call; keep it a capability the way the three siblings are
(present only when true, so feature-detection reads the real capability), not a method that
returns `false`.

## Open question this exposes

Decide, and write the answer into `packages/db-p2p/docs/storage.md`, whether the driver-level
construction is meant to be handed **across a seam** at all. Two coherent answers:

- Yes — then the marker above is the fix and the docs keep recommending it.
- No — then the docs should say the driver-level form is for internal composition only, and a
  host handing storage to `rawStorageFactory` / `RawStorageProvider` should pass either an
  uncached storage or a `CachedRawStorage`.

The marker is worth doing either way (it removes an `instanceof` that guesses at composition),
but the doc sentence differs, and a host reading the current text has no way to know which
answer is intended.
