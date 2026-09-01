description: A host could attach the storage read cache in either of two documented ways, but the code that checked "is a cache already attached?" only recognized one of them, so picking the other made the program refuse to start with a misleading error. It now asks the storage whether it is cached instead of guessing from the class name.
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
difficulty: medium
----

# Review: "already read-cached" is now a reported capability, not an `instanceof` guess

## What a reader needs to know first

A **read cache** sits between the database and its storage backend so repeated reads of the
same small records do not go back to disk. It is *write-through*: correct only while every
in-process writer to one store goes through the same cache instance.

`packages/db-p2p/docs/storage.md` documents two ways to attach one, and recommends the first:

- **Driver-level** — `new KvRawStorage(new CachedStoreDriver(driver))`. Preferred when the
  backend's `RawStoreDriver` is reachable; skips a redundant encode/decode pass on cold misses.
- **Storage-level** — `new CachedRawStorage(inner)`. For when only the `IRawStorage` surface is.

Every production seam that resolves an `IRawStorage` goes through `withReadCache(storage, …)`,
which attaches a cache when none is attached and returns the storage unchanged when one is.

**The defect:** `withReadCache` decided "already cached" with
`storage instanceof CachedRawStorage`. The *recommended* driver-level construction produces a
plain `KvRawStorage`, so the helper did not recognize it, tried to attach a second cache, and
`SharedCachePool.registerStore` threw — the host's node failed to start. The message blamed
data divergence (wrong: the two caches would be *stacked*, not side-by-side) and told the
reader to use `withReadCache`, which is what had just thrown.

## What changed

**Primary arm — a `readCached` capability replaces the class check.**

`RawStoreDriver` and `IRawStorage` each gained `readCached?: true` — optional, typed as the
literal `true`, present only when a read cache really sits at or below that object, so
"present and false" is unrepresentable and truthiness *is* the feature detection. It travels
up the same wire as the existing `storeIdentity` capability:

| site | rule |
| --- | --- |
| `CachedStoreDriver` | `readonly readCached: true = true` — unconditional; it *is* the cache |
| `KvRawStorage` ctor | `if (driver.readCached) this.readCached = true` |
| `RawStorageDriverAdapter` ctor | `if (inner.readCached) this.readCached = true` |
| `CachedRawStorage` | `declare readonly readCached: true` — type-only narrowing, **no emit** |

`withReadCache`'s `instanceof CachedRawStorage` check was **replaced** (not joined) by
`storage.readCached`. The `instanceof MemoryRawStorage` check is unrelated and untouched.

**Secondary arm — the guard message stops lying.** `CachedStoreDriver`'s constructor now
throws on `inner.readCached` in its synchronous prefix, *before* `pool.registerStore`, with a
message naming redundancy ("the inner driver is already read-cached … stacks a second
bookkeeping layer") and pointing at the inner cache — not at divergence, and not at
`withReadCache`. `SharedCachePool.registerStore` keeps its throw and message verbatim; it is
now reached only by the genuinely side-by-side case it was written for.

**Behavior change worth a reviewer's attention:** a stacked wrap over an **identity-less**
driver (memory drivers, test doubles) previously succeeded silently — pure overhead, never
useful — and now throws. Grepped `new CachedStoreDriver(` / `new CachedRawStorage(` across
`packages/**/*.ts` (excluding `dist`): every existing construction wraps an uncached inner, and
the full suite is green, so nothing in the tree relied on it.

## Validation performed

Full foreground runs, no redirection:

- `yarn build` — success.
- `yarn typecheck` — clean (this is what covers the two tsup/esbuild-built packages, whose
  build strips types without checking them).
- `yarn lint` — clean.
- `yarn workspace @optimystic/db-p2p test` — **2415 passing, 49 pending**.
- `yarn workspace @optimystic/db-p2p-storage-fs test` — **72 passing, 1 pending** (this is the
  package whose `test/file-store-identity.spec.ts` exercises the guard over real identities).
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **683 passing, 13 pending**,
  plus `test:smoke` ok.

No pre-existing failures surfaced; nothing was skipped or loosened.

Emitted JS was inspected directly to confirm the `useDefineForClassFields` hazard is avoided:
`awk '/class CachedRawStorage/,0' packages/db-p2p/dist/src/storage/cached-raw-storage.js`
shows **no** `readCached;` field in that class, so nothing clobbers what the base constructor
assigns after `super()`. `CachedStoreDriver` emits `readCached = true;` as expected.

## Six new tests (all pass; each fails or misbehaves without the fix)

In `packages/db-p2p/test/with-read-cache.spec.ts`:

- *returns a driver-level cache unchanged, with no lease* — the reproduction. Builds
  `new KvRawStorage(new CachedStoreDriver(identified(new MemoryStoreDriver(), 'spec:drv-level'), pool, 'host-built'))`,
  hands it to `withReadCache`; asserts same object back, `lease === undefined`, one pool
  registration. **Before the fix this threw.**
- *…identity-less driver-level cache unchanged too* — the quiet half: with no identity the
  pool guard never fired, so this silently returned a doubly-cached storage under a lease.
  Only a pass-through assertion catches it.
- *the readCached marker is present for both constructions and absent otherwise* — the
  propagation table (driver-level `true`, `CachedRawStorage` `true`, plain `KvRawStorage`
  `undefined`, `MemoryRawStorage` `undefined`).

In `packages/db-p2p/test/cached-raw-storage.spec.ts`, new describe
*"CachedStoreDriver over an already-cached inner driver"*:

- *refuses a stacked wrap over an identity-bearing cached driver* — asserts the message says
  `already read-cached` and does **not** match `/never converge/` or `/withReadCache/`, and
  that the refused wrap registered nothing. This is what pins the ordering: the identity IS
  claimed, so registration would also have thrown, with the wrong story.
- *refuses a stacked wrap over an identity-LESS cached driver too* — the case the pool cannot
  see at all.
- *the adapter carries the marker up from a cached storage* —
  `new RawStorageDriverAdapter(cachedStorage).readCached === true`, `undefined` over a plain
  `MemoryRawStorage`, and `new CachedRawStorage(alreadyCachedStorage)` now throws.

Pre-existing assertions confirmed still passing unchanged: the `CachedRawStorage`
pass-through in `with-read-cache.spec.ts` (now succeeding via the marker rather than the
deleted class check), the side-by-side throws at `cached-raw-storage.spec.ts:414-446`, and
`shared-cache-pool.spec.ts`'s assertion that the pool message names `withReadCache`.

## Honest gaps — where a reviewer should push

- **No test asserts the marker over a real filesystem backend.** Every new test uses memory
  drivers plus the `identified()` Proxy. `db-p2p-storage-fs`'s suite passes, but nothing there
  constructs the driver-level shape over a real `FileRawStorage` and pushes it through
  `withReadCache`. That composition is the actual reachable production path (an embedding host
  supplying storage via `rawStorageFactory` / `RawStorageProvider`), and it is covered only by
  analogy.
- **No end-to-end test of the reachable path.** The bug's real trigger is a host calling
  `rawStorageFactory` (`collection-factory.ts:314`) or supplying a `RawStorageProvider`
  (`libp2p-node-base.ts:385`) with a driver-level cache. Both seams call `withReadCache`, which
  is what the new tests exercise directly — but no test goes through a `CollectionFactory` or a
  node with such a provider.
- **The error-message assertions are regex-shaped** (`/already read-cached/`,
  `.to.not.throw(/never converge/)`). They pin the two failures apart, but they do not pin the
  full wording; a future edit could keep the phrase and lose the useful detail.
- **No production wiring in this repo builds the driver-level shape**, so the fix is validated
  against constructed cases rather than an in-tree consumer. Worth confirming the interface
  additions really are non-breaking for an out-of-tree host implementing `IRawStorage` by hand
  — they are optional members, so they should be, but nothing in this repo proves it.
- **The stacked-wrap throw is a new failure mode.** It is the intended behavior change, but it
  turns a previously-silent (if wasteful) construction into a startup crash. If any
  out-of-tree host stacks caches deliberately, this breaks it. Deliberate — the stack can only
  ever read through the inner cache — but a reviewer should agree it is worth the sharp edge.
- **Only one pool is consulted.** The pre-existing "two different `SharedCachePool` instances"
  hole (documented in `storage.md`) is untouched and still open by design; the new marker does
  not narrow it, because it speaks about the object passed, not about pools.

## Tripwire recorded (not filed as a ticket)

`packages/db-p2p/test/support/cache-test-helpers.ts` — `CountingStoreDriver` forwards no
`readCached`. Correct today because every use places it *under* a cache or alone; put one
*above* a `CachedStoreDriver` and the composition would report itself uncached, so
`withReadCache` would attach a second cache and the redundant-wrap guard would not fire.
Parked as a `NOTE:` in that class's doc comment, beside the existing note explaining why it
deliberately withholds `storeIdentity`.

## Documentation updated

`packages/db-p2p/docs/storage.md` § "Wiring":

- The `withReadCache` bullet now says "already read-cached", explains that the check is the
  `readCached` capability rather than a class, names what the old class check got wrong, and
  states that a pass-through hands back **no lease**.
- A new bullet answers the question the source ticket left open: **either** construction may
  cross a composition seam, with the driver-level form still preferred when the driver is
  reachable.
- "The construction guard behind the dedupe" is now "guard**s**", split into the *stacked*
  case (caught in `CachedStoreDriver`'s constructor, redundant) and the *side-by-side* case
  (caught in `SharedCachePool.registerStore`, incoherent). The identity residuals, two-pools
  hole, and cross-process case are unchanged.

Prose comments refreshed so none of them implies a host must hand over a `CachedRawStorage`
specifically: `libp2p-node-base.ts` (the `RawStorageProvider` type doc and `resolveStorage`'s
doc) and `collection-factory.ts` (`createLocalTransactor`'s doc and its lease comment).
