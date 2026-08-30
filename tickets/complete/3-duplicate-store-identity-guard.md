description: Two caches placed in front of one storage folder used to quietly serve each half of the program a different, never-updating view of the data; now the second one refuses to be built and says why.
files: packages/db-p2p/src/storage/shared-cache-pool.ts, packages/db-p2p/src/storage/cached-store-driver.ts, packages/db-p2p/test/shared-cache-pool.spec.ts, packages/db-p2p/test/cached-raw-storage.spec.ts, packages/db-p2p-storage-fs/test/file-store-identity.spec.ts, packages/db-p2p-storage-fs/src/file-storage.ts, packages/db-p2p/docs/storage.md
----

# Refuse a second cache over one backing store — complete

## What shipped

A read cache sits between the database and its storage backend. It stays correct only while
every writer in the process goes through the *same* cache; two caches side by side over one
directory each serve their own stale picture forever. A prior ticket made the `withReadCache`
helper hand back one shared cache per backing store, which covers every cache that helper
builds. This ticket closed the remaining hole: a cache can also be built by hand, and a
hand-built one the helper never saw still produced a second, divergent view.

Every cache, however constructed, registers a store with a `SharedCachePool`. That registration
is the choke point all paths share, so the guard lives there.

- `SharedCachePool.registerStore(label?, identity?)` takes the backing store's identity and
  **throws** when that identity already has a live registration on the pool. The message names
  the identity, the incumbent label, the arriving label, and the fix. The check runs before any
  mutation, so a refused registration leaves the pool untouched — no store row, no consumed id,
  no claim.
- `CacheStoreHandle` carries the identity so `unregisterStore` can free the claim, and frees it
  only when the claim map still points at *that* handle, so a late second unregister cannot
  strip a successor's claim.
- `CachedStoreDriver`'s constructor passes `inner.storeIdentity?.()` through to the pool. The
  throw escapes the constructor before anything is wired; the half-built driver is never
  returned.
- `packages/db-p2p/docs/storage.md` section 6 documents the guard and every escape left open.

Escapes left open deliberately, each stated in the pool's class doc and in the docs: two
*different* pools (the claim map is per-pool), backends reporting no identity (memory drivers —
correctly uncovered, two memory drivers are two real stores), and the cross-process case
(Invariant 5's standing unenforced precondition).

## Review findings

### Scope of the pass

Read the implement diff before the handoff. Traced every construction path into
`registerStore` (one production call site, `cached-store-driver.ts:212`), the full
`withReadCache` retire/dispose ordering, `CachedRawStorage`'s pre-`super()` throw,
double-close and sequential-reuse behaviour of the claim map, every `stores`/`claims`
mutation in the pool (`registerStore`, `unregisterStore`, `stats` — no other writer), the four
backends' `storeIdentity()` implementations, and the three documentation surfaces the change
touches. Ran lint, build, typecheck, and six test suites.

### Major — one ticket filed

- **`withReadCache` can only recognize one of the two documented ways to attach a cache.**
  Its already-cached check is `storage instanceof CachedRawStorage`. The second documented
  construction — `new KvRawStorage(new CachedStoreDriver(driver))`, which
  `cached-raw-storage.ts` explicitly recommends preferring — is not a `CachedRawStorage`, so
  the helper does not recognize it and tries to attach a second cache. Since this ticket's
  guard that no longer happens silently: it throws, and the host's node fails to start.
  Two ways the failure misleads: the message claims the caches "never converge", which is true
  of side-by-side caches but not of these (they would be *stacked*, so merely redundant); and
  the fix it suggests is `withReadCache`, which is what threw.

  Verified by running it against this tree with a throwaway spec (since deleted); the exact
  message is quoted in the ticket. Nothing in this repository builds that shape, so nothing
  here breaks — the reachable path is an embedding host supplying its own storage.

  Filed at the representation rung rather than as a point fix: "is this already read-cached"
  should be a property a storage reports, propagated the way `getStoreIdentity` already is,
  so no construction shape can be misread.
  → `tickets/backlog/bug-driver-level-cache-invisible-to-read-cache-seam.md`

### Minor — fixed in this pass

- **The ticket's own end-to-end scenario was not directly tested.** The handoff named this
  ("production wiring is only covered transitively"). Added
  `packages/db-p2p/test/cached-raw-storage.spec.ts` → "the seam refuses to build a second cache
  over a store a host already cached": a host hand-builds its cache, then `withReadCache`
  receives the same store and is refused. It also asserts the refused wrap leaves the helper's
  dedupe registry clean, so a later wrap builds a live cache rather than hitting a stale entry.
- **The retire/dispose ordering was argued but not pinned.** The handoff's reasoning is
  correct — `Lease.release()` calls `retire()`, then `dispose()`, whose synchronous prefix
  reaches `unregisterStore` before any `await` — but nothing observed it. Added "releasing the
  last lease frees the store, so the seam can wrap it again", which pins the observable
  consequence without needing to interleave at the exact point.
- **A neighbouring comment went stale.** The win32 case-fold `NOTE:` in
  `packages/db-p2p-storage-fs/src/file-storage.ts` described the consequence of its
  under-approximation as "the two stores would read through one cache". Since this change a
  directly-built second cache is refused outright instead. Updated the note to say both. Its
  stated revisit condition (targeting a case-sensitive-enabled Windows directory) has not
  tripped, so the tradeoff itself stands untouched.

### Tripwires — recorded, not filed

- **Cross-file coupling through two process-global registries.** The handoff raised pool
  ordering; the helper's `byIdentity` map is global in the same way. Nothing collides today —
  every identity-bearing spec passes its own pool and its own identity — but a future spec
  reusing an identity, or registering an identity-bearing store on `defaultCachePool()`, would
  couple to another file and fail on file order. Recorded as a `NOTE:` on the new guard test in
  `cached-raw-storage.spec.ts`, where a test author adding the next case will meet it.
- The implementer's `NOTE:` at `CachedStoreDriver.close()` (unregister must stay in the
  synchronous prefix) is correct and stays as written; the new re-wrap test now backs it.

### Checked and found clean

- **Claim-map lifecycle.** Double `close()` is safe (the identity-match check makes the second
  unregister a no-op); handle ids are never reused, so no aliasing; `clearCache()` correctly
  leaves the claim held; `stats()` is the only other reader and mutates nothing.
- **The throw's escape path.** `new CachedStoreDriver(...)` is evaluated before `super(...)` in
  `CachedRawStorage`, which is legal and lets the throw propagate with nothing half-built —
  confirmed by the fs spec, not only by reading.
- **Identity is a `string`,** so the claim `Map` compares by value. Worth stating because an
  object-typed identity would have made the whole guard silently inert.
- **`storeIdentity()` at construction time** is cheap and non-throwing on all four backends
  (the filesystem one precomputes in its constructor), so calling it from `CachedStoreDriver`'s
  constructor adds no cost and no new failure mode.
- **Test quality.** The message test asserts four substrings plus the suggested fix; the
  handoff flagged that as weak. Left as is — it pins the parts that make the message
  actionable, and asserting prose more tightly buys nothing.
- **Source hygiene.** `cached-store-driver.ts` is 898 lines and `shared-cache-pool.ts` 516
  (`wc -l`), but this diff added 16 and 70 lines respectively to files that were already that
  size; no size finding belongs to this ticket. Comments are at the density of the surrounding
  files and each explains a decision rather than restating code.
- **Documentation.** Read `docs/storage.md` section 6, the pool class doc, `with-read-cache.ts`'s
  helper doc, `cached-raw-storage.ts`, and `i-raw-storage.ts`. All reflect the new behaviour;
  the only stale line found is the fs one fixed above. The `withReadCache` doc's claim that "an
  already-cached storage is not wrapped twice" is the inaccuracy behind the filed ticket and is
  called out there rather than patched here, since the fix changes the mechanism.

### Considered and not filed

- **`stats()` does not expose which identity a store claims.** The handoff offered it as a
  debugging aid. It is a new field on a public stats shape with no current consumer and no
  condition that would make it necessary, so it is neither a ticket nor a tripwire — noted here
  so the next reader knows it was weighed.

## Validation

All green, all foreground, after the review's edits:

- `yarn lint`, `yarn build`, `yarn typecheck` — exit 0
- `yarn workspace @optimystic/db-p2p test` — 2334 passing, 49 pending (2332 before; +2 added here)
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 671 passing, 13 pending, smoke ok
- `yarn workspace @optimystic/db-p2p-storage-fs test` — 72 passing, 1 pending
- `yarn workspace @optimystic/db-p2p-storage-ns test` — 58 passing
- `yarn workspace @optimystic/db-p2p-storage-rn test` — 53 passing
- `yarn workspace @optimystic/db-p2p-storage-web test` — 52 passing

No pre-existing failures surfaced; nothing skipped or loosened.

Worth keeping from the implementer's handoff: the fs/ns/rn/web suites resolve
`@optimystic/db-p2p` from its `dist/`, not `src/`, so a source change to db-p2p is invisible to
them until `yarn build` runs.
