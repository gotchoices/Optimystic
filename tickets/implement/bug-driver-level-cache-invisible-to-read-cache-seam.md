description: A host can attach the storage read cache in either of two documented ways, but the code that later checks "is a cache already attached?" only recognizes one of them; pick the other and the program refuses to start, blaming a problem that is not the one it actually has.
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/src/libp2p-node-base.ts
repro: verified
difficulty: medium
----

# Make "already read-cached" a reported capability, not an `instanceof` guess

## Background a reader needs

A **read cache** sits between the database and its storage backend so repeated reads of the
same small records do not go back to disk every time. It is *write-through*: it stays correct
only because every in-process writer to a store passes through the same cache instance. Two
caches sitting **side by side** over one directory each serve their own permanently stale
picture — that is the failure the pool guard exists to prevent.

`packages/db-p2p/docs/storage.md` § "Write-through raw-storage cache" documents two ways to
attach one:

- **Storage-level** — `new CachedRawStorage(inner)`. Used when only the `IRawStorage` surface
  is reachable. Internally: `KvRawStorage` → `CachedStoreDriver` → `RawStorageDriverAdapter`
  → inner storage.
- **Driver-level** — `new KvRawStorage(new CachedStoreDriver(driver))`. The docs (and
  `cached-raw-storage.ts`'s class doc) say to **prefer** this when the backend's
  `RawStoreDriver` is reachable, because it skips a redundant encode/decode pass on cold misses.

Every production seam that resolves an `IRawStorage` goes through one helper,
`withReadCache(storage, label?, pool?)` (`src/storage/with-read-cache.ts`), whose job is to
attach a cache when none is attached and to return the storage unchanged when one is.

## The defect

`withReadCache` decides "already cached" with `storage instanceof CachedRawStorage`
(`with-read-cache.ts:154`). The driver-level construction produces a plain `KvRawStorage`, not
a `CachedRawStorage`, so the helper does not recognize it and tries to attach a second cache.
`CachedStoreDriver`'s constructor calls `SharedCachePool.registerStore`
(`shared-cache-pool.ts:235`), which sees the backing-store identity already claimed and
**throws** — the host's node fails to start.

Two things make that worse than a clean rejection:

- **The message names the wrong cause.** It says the two caches "never converge" and would be
  "a second, independent view". True of two *side-by-side* caches. Here they would be
  *stacked* — the outer reading through the inner — which is redundant, not incoherent. A
  reader chases a data-divergence bug that does not exist.
- **The message's suggested fix is the thing that just failed.** It says to use
  `withReadCache`; `withReadCache` is what threw.

Verified against the current tree: a driver reporting a fixed identity,
`new KvRawStorage(new CachedStoreDriver(driver, pool, 'host-built'))`, then
`withReadCache(hostBuilt, 'seam', pool)` throws
`two caches over one backing store never converge: "probe:one" is already cached (label
"host-built"); this registration (label "seam") would be a second, independent view. …`

No production wiring in this repository builds the driver-level shape, so nothing here breaks
today. The reachable path is an embedding host supplying its own storage through the
`rawStorageFactory` seam (`collection-factory.ts:314`) or a `RawStorageProvider`
(`libp2p-node-base.ts:385`), following the documentation's own recommendation.

## Settled design decisions

Two questions the source ticket left open are decided here; the implementer follows them.

**1. May the driver-level construction cross a composition seam? — Yes.** It stays the
recommended form and hosts may hand it to `rawStorageFactory` / `RawStorageProvider`. Ruling
it out would force the strictly worse composition (an extra codec pass per cold miss) on
exactly the hosts that *have* the driver, to avoid a defect that is one property away from
being fixed. `packages/db-p2p/docs/storage.md` must say so explicitly, because a host reading
the current text has no way to tell.

**2. The marker is an optional property named `readCached`, present only when true.** Both
`RawStoreDriver` and `IRawStorage` gain `readCached?: true`. Typed literal `true` (not
`boolean`) so "present and false" is unrepresentable and truthiness *is* the feature
detection — matching how the three sibling optional capabilities (`storeIdentity` /
`getStoreIdentity`, `listBlockIds`, `approximateBytesUsed` / `getApproximateBytesUsed`) are
present only when genuinely supported. A property rather than a method because there is no
behavior to invoke; a method returning `false` was explicitly rejected.

## Architecture

The answer to "is a read cache already attached below me?" should be **reported by the
composition**, not inferred from a concrete class name. Both documented constructions contain
a `CachedStoreDriver`; that fact just needs to travel up the wire that already carries the
three sibling capabilities.

```
  driver-level:   KvRawStorage ──► CachedStoreDriver ──► backend driver
                       │ readCached: true ◄──┘ (always set)

  storage-level:  CachedRawStorage (is-a KvRawStorage)
                       └─► CachedStoreDriver ─► RawStorageDriverAdapter ─► inner IRawStorage
                       │ readCached: true ◄──┘                    └──► passes inner's up

  seam:           withReadCache(storage) ─── storage.readCached ? pass through : wrap
```

Propagation rules, one per wrapper, each mirroring how that wrapper already handles
`storeIdentity`:

| site | rule |
| --- | --- |
| `CachedStoreDriver` | **always** `readCached = true` — it *is* the cache |
| `KvRawStorage` ctor | `if (driver.readCached) this.readCached = true` (driver → storage) |
| `RawStorageDriverAdapter` ctor | `if (inner.readCached) this.readCached = true` (storage → driver) |
| every other wrapper | none exist; the three above are the complete set |

Then `withReadCache`'s `instanceof CachedRawStorage` check is **replaced** by
`storage.readCached` — not joined to it. `CachedRawStorage` reports the marker for free (it
is a `KvRawStorage` over a `CachedStoreDriver`), so the class check becomes dead weight, and
no future composition shape can be misread. The `instanceof MemoryRawStorage` check is
unrelated and stays exactly as it is.

### Secondary arm — the guard message stops lying

With the marker available, `CachedStoreDriver`'s constructor can tell a **stacked** wrap from
a **side-by-side** one, which `registerStore` cannot. Add, in the constructor's synchronous
prefix **before** the `pool.registerStore(...)` call so nothing is mutated and the accurate
message wins the race:

- if `inner.readCached` → throw naming redundancy: the inner driver is already a read cache,
  wrapping it again adds a second bookkeeping layer with nothing to gain; use the inner one.
  Must **not** claim divergence, and must not tell the reader to call `withReadCache`.

`SharedCachePool.registerStore` keeps its existing throw and its existing message verbatim —
it is now reached only by the genuinely side-by-side case it was written for, and the
`shared-cache-pool.spec.ts:287` assertion that the message names `withReadCache` still holds.

Behavior change to state in the commit: a stacked wrap over an **identity-less** driver
(memory drivers, test doubles) previously succeeded silently — pure overhead, never useful —
and now throws. No test in the tree constructs one; the grep for `new CachedStoreDriver(` /
`new CachedRawStorage(` across `packages/**/*.ts` (excluding `dist`) shows every existing
construction wraps an uncached inner.

### The `useDefineForClassFields` footgun

`tsconfig.base.json` sets `target: ES2022` with no `useDefineForClassFields`, so it defaults
to **true**: a bare class-field declaration with no initializer emits a `defineProperty` to
`undefined` at field-init time, which for a subclass runs *after* `super()` and would clobber
what the base constructor assigned. That is exactly why `FileRawStorage` &c. use
`declare getStoreIdentity: …` rather than re-declaring. So:

- `CachedRawStorage` must **not** re-declare `readCached` as a plain field. If a
  narrowed type is wanted there, use `declare readonly readCached: true;` (type-only, no emit).
- The four backend shells (`FileRawStorage`, and the sqlite / leveldb / indexeddb storages)
  need **no** change: their drivers are uncached, so the marker is correctly absent.

## Edge cases & interactions

The implementer covers these; the reviewer checks them.

- **Driver-level shape with a store identity** handed to `withReadCache` → returned unchanged,
  `lease === undefined`, no throw, `pool.stats().stores` length 1. This is the reproduction.
- **Driver-level shape with NO store identity** (plain `MemoryStoreDriver` under
  `CachedStoreDriver`) handed to `withReadCache` → also returned unchanged with no lease.
  Today this path does not throw (nothing claims an identity) but silently builds a *stacked*
  cache; the marker must close it too, and only a test that asserts pass-through catches it.
- **Unchanged-and-unleased is the whole contract.** A pass-through must never mint a lease:
  the cache is the host's to dispose and the seam releasing it would clear and unregister a
  store other consumers still read through. Assert `lease === undefined`, not just object
  identity of `storage`.
- **The existing `CachedRawStorage` pass-through** (`with-read-cache.spec.ts:54-66`) must keep
  passing after the `instanceof` check is deleted — it now succeeds via the marker.
- **The pinned side-by-side throw stays**: `cached-raw-storage.spec.ts:414-446` — host
  hand-builds a cache over one storage object, the seam is later handed a *different,
  uncached* object over the same directory. Real side-by-side pair, still throws, still with
  the "never converge" message. The marker speaks only for the object actually passed.
- **`MemoryRawStorage`** still passes through by `instanceof`; it never carries the marker.
  A `KvRawStorage` over a bare `MemoryStoreDriver` is *not* a `MemoryRawStorage` and still
  gets wrapped, as today (`with-read-cache.spec.ts:56`) — do not "fix" that.
- **Adapter direction matters**: `new RawStorageDriverAdapter(cachedStorage).readCached`
  must be `true`, and `undefined` over an uncached storage. Without this, re-kerneling a cached
  storage loses the marker; with it, the new `CachedStoreDriver` stacked-wrap throw fires
  correctly for `new CachedRawStorage(alreadyCachedStorage)`.
- **Ordering inside `CachedStoreDriver`'s constructor**: the stacked-wrap throw must precede
  `pool.registerStore`, or the misleading message wins whenever the driver reports an identity.
  Also keep `close()`'s existing rule — `unregisterStore` stays in the synchronous prefix
  before any `await` (see its `NOTE:`); do not disturb it.
- **Concurrent seam resolution**: `withReadCache` stays fully synchronous with no `await`
  between lookup and insert. The marker read is a property access, so this is preserved for
  free — but do not introduce an accessor that could become async.
- **Sequential store reuse** (stop a node, start another over the same directory) must still
  register cleanly — `unregisterStore` frees the identity claim; nothing here touches it.
- **Test doubles**: the `identified()` Proxy in `with-read-cache.spec.ts:36-44` forwards
  arbitrary property reads, so the marker passes through it unchanged. `CountingStoreDriver`
  (`test/support/cache-test-helpers.ts`) is only ever used *below* a cache, so it needs no
  marker passthrough — if a new test puts it above one, it must forward `readCached`.
- **Interface additions are optional members**, so `MemoryRawStorage`, the four backend
  drivers, and any host-supplied `IRawStorage` implementation stay valid with no edits. Adding
  a required member would be a breaking change to a public interface — do not.

## Expected test outcomes

New/changed assertions, all in `packages/db-p2p/test/`:

- `with-read-cache.spec.ts` — *"returns a driver-level cache unchanged, with no lease"*:
  build `new KvRawStorage(new CachedStoreDriver(identified(new MemoryStoreDriver(), 'spec:drv'), pool, 'host-built'))`,
  then `withReadCache(that, 'seam', pool)` → returns the same object, `lease === undefined`,
  `pool.stats().stores` has length 1. Before the fix this **throws**.
- `with-read-cache.spec.ts` — same, with an identity-less `MemoryStoreDriver`. Before the fix
  this returns a *different* (doubly-cached) object with a lease.
- `with-read-cache.spec.ts` — marker propagation table:
  `new KvRawStorage(new CachedStoreDriver(new MemoryStoreDriver())).readCached === true`;
  `new CachedRawStorage(new MemoryRawStorage()).readCached === true`;
  `new KvRawStorage(new MemoryStoreDriver()).readCached === undefined`;
  `new MemoryRawStorage().readCached === undefined`.
- `cached-raw-storage.spec.ts` — adapter direction:
  `new RawStorageDriverAdapter(new CachedRawStorage(new MemoryRawStorage(), pool)).readCached === true`,
  and `undefined` over a plain `MemoryRawStorage`.
- `cached-raw-storage.spec.ts` — stacked wrap throws, and the message does **not** contain
  "never converge" and does **not** name `withReadCache`; assert it says the inner is already
  a read cache. Cover both an identity-bearing and an identity-less inner driver.
- `cached-raw-storage.spec.ts:414-446` — unchanged, still throws the "never converge" message.
- `shared-cache-pool.spec.ts:287` — unchanged, still asserts the message names `withReadCache`.

## Documentation

`packages/db-p2p/docs/storage.md` § 6, "Wiring" (≈ lines 421-540):

- The `withReadCache` bullet: replace "already a `CachedRawStorage`" with "already
  read-cached — **either** documented construction, detected by the `readCached` capability
  rather than by class". State that the pass-through hands back no lease.
- Add the answer to decision 1 above, next to the two "Backend exposes its `RawStoreDriver`"
  / "Only the `IRawStorage` surface is reachable" bullets: **either** form may be handed
  across a composition seam; the driver-level form stays preferred when the driver is reachable.
- "The construction guard behind the dedupe" paragraph: split the two failures — a *stacked*
  wrap is caught at `CachedStoreDriver`'s constructor and is redundant; a *side-by-side* pair
  is caught at `SharedCachePool.registerStore` and is incoherent. Keep the rest (identity
  residuals, two-pools hole, cross-process case) as-is.
- Also refresh the prose comments that say "already-cached" in class-name terms:
  `libp2p-node-base.ts:142-145` and its `resolveStorage` doc, and
  `collection-factory.ts:300-312` — each currently implies a host must hand over a
  `CachedRawStorage` specifically.

## TODO

- Add `readCached?: true` to `RawStoreDriver` (`raw-store-driver.ts`), documented alongside
  `storeIdentity` — present only when a read cache sits at or below this driver; never a stub.
- Add `readCached?: true` to `IRawStorage` (`i-raw-storage.ts`), same doc treatment.
- `CachedStoreDriver`: always set `readCached = true`; add the stacked-wrap throw in the
  constructor's synchronous prefix, before `pool.registerStore`, with a message naming
  redundancy (not divergence) and not pointing at `withReadCache`.
- `KvRawStorage` constructor: wire `readCached` through from the driver, beside the three
  existing conditional passthroughs; extend the class doc's passthrough note to mention it.
- `RawStorageDriverAdapter` constructor: mirror the same passthrough from the inner storage.
- `withReadCache`: replace `storage instanceof CachedRawStorage` with `storage.readCached`;
  keep `instanceof MemoryRawStorage`; drop the now-unused import if the class is no longer
  referenced for anything but construction and the lease type; update the doc comment's
  "already-cached storage" wording to name the capability.
- Optionally add `declare readonly readCached: true;` to `CachedRawStorage` for type narrowing
  — `declare` only, never a plain field (see the `useDefineForClassFields` note).
- Write the tests listed under **Expected test outcomes**.
- Update `packages/db-p2p/docs/storage.md` and the three prose comments listed under
  **Documentation**.
- Run the build and the db-p2p + quereus-plugin test suites in the foreground (no redirection);
  `packages/db-p2p-storage-fs/test/file-store-identity.spec.ts` exercises the guard over real
  identities, so include that package too.
