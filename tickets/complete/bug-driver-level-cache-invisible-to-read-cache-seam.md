description: A host could attach the storage read cache in either of two documented ways, but the code that checked "is a cache already attached?" only recognized one of them, so picking the other made the program refuse to start with a misleading error. It now asks the storage whether it is cached instead of guessing from the class name.
files: packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/docs/storage.md, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p/test/support/cache-test-helpers.ts, packages/db-p2p-storage-fs/test/file-store-identity.spec.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts
----

# "Already read-cached" is a reported capability, not an `instanceof` guess

## What shipped

A **read cache** sits between the database and its storage backend so repeated reads of the same
small records do not go back to disk. It is *write-through*, so it is correct only while every
in-process writer to one store goes through the same cache instance.

`packages/db-p2p/docs/storage.md` documents two ways to attach one and recommends the first:

- **Driver-level** — `new KvRawStorage(new CachedStoreDriver(driver))`. Preferred when the
  backend's `RawStoreDriver` is reachable; skips a redundant encode/decode pass on cold misses.
- **Storage-level** — `new CachedRawStorage(inner)`. For when only the `IRawStorage` surface is.

Every production seam that resolves an `IRawStorage` goes through `withReadCache(storage, …)`,
which attaches a cache when none is attached and returns the storage unchanged when one is. That
helper decided "already cached" with `storage instanceof CachedRawStorage`. The *recommended*
driver-level construction produces a plain `KvRawStorage`, so the helper did not recognize it,
tried to attach a second cache, and `SharedCachePool.registerStore` threw — the host's node failed
to start, with a message that blamed data divergence (wrong: the two caches would be *stacked*,
not side-by-side) and told the reader to call `withReadCache`, which is what had just thrown.

**Primary arm.** `RawStoreDriver` and `IRawStorage` each gained `readCached?: true` — optional,
typed as the literal `true`, present only when a read cache really sits at or below that object,
so "present and false" is unrepresentable and truthiness *is* the feature detection. It travels up
the same wire as the existing `storeIdentity` capability: `CachedStoreDriver` sets it
unconditionally (it *is* the cache); `KvRawStorage` and `RawStorageDriverAdapter` copy it from
their inner object in the constructor; `CachedRawStorage` narrows it with a type-only `declare`.
`withReadCache`'s class check was replaced by `storage.readCached`. The unrelated
`instanceof MemoryRawStorage` exclusion is untouched.

**Secondary arm.** `CachedStoreDriver`'s constructor now throws on `inner.readCached` in its
synchronous prefix, *before* `pool.registerStore`, with a message naming redundancy rather than
divergence. `SharedCachePool.registerStore` keeps its throw; it is now reached only by the
genuinely side-by-side case it was written for.

**Behavior change:** a stacked wrap over an identity-less driver previously succeeded silently —
pure overhead, never useful — and now throws.

## Review findings

### Verified before anything else

Read the implement diff (source, tests, docs) with fresh eyes before the handoff summary.

- **Capability propagation is complete.** Enumerated every `implements RawStoreDriver`,
  `implements IRawStorage`, and `extends KvRawStorage` in the tree. Only two *wrapper* drivers
  exist — `CachedStoreDriver` and `RawStorageDriverAdapter` — and both forward. The four backend
  packages (`-fs`, `-ns`, `-rn`, `-web`) all subclass `KvRawStorage`, so they inherit propagation
  with no edit; correct that the diff left them alone. Confirmed by a passing marker test over a
  real `FileStoreDriver` (added below).
- **The class-field emit hazard is real and correctly handled.** `tsconfig.base.json` sets
  `target: ES2022` and does not set `useDefineForClassFields`, so it defaults to `true` — a plain
  field declaration on `CachedRawStorage` really would have run after `super()` and clobbered what
  the base constructor assigns. Rebuilt and grepped the emitted JS:
  `packages/db-p2p/dist/src/storage/cached-raw-storage.js` has no `readCached;` in that class, and
  `cached-store-driver.js:139` emits `readCached = true;`. The `declare` is load-bearing.
- **Guard ordering leaves no partial state.** `CachedStoreDriver` throws before
  `pool.registerStore`, so a refused wrap registers nothing (asserted). `withReadCache` constructs
  the cache *before* inserting into its module registry, so a throw there leaves the registry
  clean too.
- **No downstream caller assumes the old shape.** Grepped every `clearCache()` / `.dispose()` call
  site: nothing casts `ResolvedReadCache.storage` to `CachedRawStorage`, so widening the
  pass-through set cannot break a caller. `ResolvedReadCache.storage` is typed `IRawStorage`.
- **The recommended construction is actually reachable.** `FileStoreDriver` is exported from
  `@optimystic/db-p2p-storage-fs`, so a host over the filesystem backend really can build the
  driver-level shape the docs steer it toward. Worth confirming, since a doc that recommends an
  unbuildable shape would be its own bug.

### Fixed in this pass (minor)

- **The pool's error message still named a class as the fix.** `SharedCachePool.registerStore`
  said "Share one `CachedRawStorage` — withReadCache does this for you". That is the same
  class-instead-of-capability mistake this ticket removed from `withReadCache`: a host that built
  a driver-level cache and hit a side-by-side collision was being told to switch to the shape the
  docs call strictly worse. Now "Share one **read cache**". Also added a line to `registerStore`'s
  doc saying it now catches the side-by-side case only, and points at the earlier guard for the
  stacked case. No test asserted the class name (checked); `shared-cache-pool.spec.ts`'s
  assertions on `/never converge/` and `withReadCache` still hold, and the full suite is green.
- **Three stale sentences still said "a host-built `CachedRawStorage`"** where either construction
  now applies — `with-read-cache.ts`'s jsdoc, and two in `storage.md`'s *Lease obligations*
  paragraph (including its framing question, "The result is a `CachedRawStorage`", now "The result
  is read-cached"). The implement pass updated the *Wiring* section thoroughly and missed these.
- **DRY: the `identified()` Proxy helper was triplicated.** Two copies pre-existed in
  `cached-raw-storage.spec.ts` and `with-read-cache.spec.ts`; the implement pass added a third,
  byte-identical, rather than hoisting. Consolidated as `identifiedDriver` in
  `test/support/cache-test-helpers.ts` — where `CountingStoreDriver` already lives — with a doc
  comment covering both uses (several fronts over one store vs. distinct stores that merely claim
  to be one), and the now-unused type imports dropped from `with-read-cache.spec.ts`.
- **Closed the test gap the handoff itself listed first.** Four tests added to
  `packages/db-p2p-storage-fs/test/file-store-identity.spec.ts`, over a real `FileStoreDriver`
  reporting a real directory identity — not memory drivers behind an identity proxy: the marker
  and the file identity both travel up through the kernel; the shape passes through
  `withReadCache` unchanged with no lease and no second registration (the reported bug, over the
  real backend); a stack over it is refused with the redundancy message, not the divergence one
  (both guards are reachable here, so this pins which wins); and a genuinely side-by-side cache
  over the same directory is still refused. Package went 72 → 76 passing.

### Findings weighed and NOT filed

- **No end-to-end test through `CollectionFactory` or a live node.** Still true. Both seams call
  `withReadCache` and nothing else, that call is now covered directly *and* over a real backend,
  and standing up a `Database` or a libp2p node to exercise a two-line branch is more machinery
  than the case earns. Recorded here as an accepted limit rather than filed.
- **Regex-shaped error-message assertions** (`/already read-cached/`, `.to.not.throw(/never
  converge/)`). Correct as written: they pin the two failures *apart*, which is the property that
  matters, without freezing wording that should stay editable.
- **The stacked-wrap throw as a new failure mode** — reviewed and agreed. A stacked cache can only
  ever read through the inner one, so it is never useful, and the message names the fix. The sharp
  edge is worth it.
- **Non-breaking for out-of-tree `IRawStorage` implementers** — confirmed rather than assumed:
  both additions are optional interface members, `yarn typecheck` and the two tsup/esbuild
  packages' DTS emit pass, and a hand-written implementation that omits them still satisfies the
  type.
- **Only one `SharedCachePool` is consulted** — the pre-existing two-pools hole, untouched by
  design and already documented in `storage.md`. The marker speaks about the object passed, not
  about pools, so it neither widens nor narrows it.
- **`cached-store-driver.ts` is 921 lines** (`wc -l`). Pre-existing; this diff added ~23. One
  cohesive class with a long doc block, not size debt this ticket created. Not filed.

### Major findings: none

Nothing in the diff justified a new `fix/`, `plan/`, or `backlog/` ticket. The change is small,
the capability is threaded through every wrapper that exists, the two failure modes are now
distinguished at the right sites, and the one class-shaped concern behind it (unenforced
capability forwarding by wrapper drivers) is genuinely conditional, so it was recorded as a
tripwire rather than queued as work.

### Tripwires recorded

- `packages/db-p2p/src/storage/raw-store-driver.ts`, `NOTE:` at the end of the interface —
  forwarding the optional capabilities is a written contract for wrapper drivers, not an enforced
  one, and a wrapper that forgets `readCached` makes a seam attach a redundant second cache. Fine
  today: two wrapper drivers, both forwarding deliberately, both directly tested. Names the
  revisit condition (a third wrapper driver ⇒ replace per-wrapper tests with one shared
  conformance check plus an explicit exception list).
- `packages/db-p2p/test/support/cache-test-helpers.ts` — the implement pass's own tripwire on
  `CountingStoreDriver` forwarding no `readCached`; left in place, still accurate.

### Validation

Full foreground runs, no redirection, after the review edits:

- `yarn build` — success. `yarn typecheck` — clean. `yarn lint` (`eslint .`) — clean, exit 0.
- `yarn test` (whole monorepo) — **5197 passing, 63 pending, 0 failing** across every workspace.
  Per-package where it matters: `@optimystic/db-p2p` 2415 passing / 49 pending,
  `@optimystic/db-p2p-storage-fs` 76 passing / 1 pending (was 72 before the four added here),
  `@optimystic/quereus-plugin-optimystic` 683 passing / 13 pending plus `test:smoke` ok.

No pre-existing failures surfaced. Nothing was skipped, disabled, or loosened.
