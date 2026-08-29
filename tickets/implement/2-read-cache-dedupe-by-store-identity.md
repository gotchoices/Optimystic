description: When two parts of a program open the same storage folder separately, each gets its own private copy of recently-read data and neither ever sees what the other saved. Make them share one copy instead, released only when the last user is done.
prereq: store-identity-plumbing
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/node-read-cache-wiring.spec.ts, packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts, packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts, packages/db-p2p/docs/storage.md
difficulty: hard
----

# One cache per backing store, shared and refcounted

## The defect

`withReadCache` constructs a new `CachedRawStorage` per call. Cache identity is per-object, so
two consumers over one backing store get two caches, and each serves its own stale view
forever. Measured on a create/insert workload over one temp directory:

| wiring | peer A's row count after peer B commits 3 rows |
| --- | --- |
| no cache (behavior before the cache landed) | 3 — correct |
| two `FileRawStorage(dir)` instances, one cache each | **1 — wrong** |
| one unwrapped instance passed to `withReadCache` twice | **1 — wrong** |
| one `CachedRawStorage` object shared by both consumers | 3 — correct |

The plugin seam produces row 2 by construction: `CollectionFactory.createLocalTransactor`
calls the host's `rawStorageFactory` once per transactor, and that factory is built fresh per
`register()`. A host that opens two `Database`s over one directory lands in the broken wiring
without doing anything unusual. Today's only correct wiring is for the host to build a
`CachedRawStorage` itself and hand the same object to every consumer — which nothing in the
API surface suggests.

## The fix: `withReadCache` returns one cache per store, under a lease

With `getStoreIdentity()` available (prereq ticket), `withReadCache` can recognise that two
storage objects name one store and hand back the same wrapper. Sharing a wrapper means no
single caller may dispose it, so ownership becomes a **refcounted lease**.

```ts
/** One consumer's claim on a shared read cache. Release exactly once, when the consumer departs. */
export interface ReadCacheLease {
	/** The cache this lease is a claim on — same object for every lease over one store. */
	readonly cache: CachedRawStorage;
	/**
	 * Drop this claim. Idempotent. The cache is cleared, unregistered from its pool, and
	 * forgotten only when the LAST lease releases; until then other consumers keep reading
	 * through it.
	 */
	release(): Promise<void>;
}

export type ResolvedReadCache = {
	/** The storage to build on — the shared cache, or the argument unchanged. */
	storage: IRawStorage;
	/** This caller's claim, or `undefined` when the argument passed through unwrapped. */
	lease: ReadCacheLease | undefined;
};
```

`ownedCache` is renamed to `lease` deliberately: after this change the returned cache may be
shared, and a field named "owned" invites exactly the exclusive-dispose bug that was already
fixed once at this seam.

Resolution order inside `withReadCache(storage, label?, pool?)`:

1. `MemoryRawStorage` → return unchanged, `lease: undefined`. *(unchanged)*
2. Already a `CachedRawStorage` → return unchanged, `lease: undefined`. The host built it and
   still owns it. *(unchanged)*
3. Look up the registry by `storage.getStoreIdentity?.()` when present, else by the storage
   **object** in a `WeakMap`. Hit → increment the refcount, return the registered cache with a
   fresh lease.
4. Miss → construct the cache, register it with refcount 1, return it with a lease.

Two lookup keys, because they close different rows of the table above: the string identity
closes row 2 (two `FileRawStorage` over one `dir`), and the object key closes row 3 (one
unwrapped instance wrapped twice) for **every** backend, including those with no identity.

The registry is module-level in `with-read-cache.ts`, holding
`{ cache, refs }` per key. On the last `release()`, delete the entry, then `await cache.dispose()`.

`withReadCache` stays fully synchronous with no `await` between lookup and insert, so two
seams resolving concurrently cannot both construct. Keep it that way.

## Seam changes

- **`libp2p-node-base.ts` `resolveStorage`** — returns the lease; the stop wrapper calls
  `lease.release()` instead of `ownedCache.dispose()`.
- **`CollectionFactory`** — `readCaches: CachedRawStorage[]` becomes
  `readCacheLeases: ReadCacheLease[]`; `dispose()` releases each. Update the doc comments on
  both, which currently promise a *fresh, cold* cache per transactor.

## What this does not fix

A host that builds a `CachedRawStorage` itself never enters the registry, so a *second*
consumer whose factory builds a fresh `FileRawStorage` over the same directory still
constructs a second cache and still diverges silently. That is the remaining hole, and the
follow-on ticket `duplicate-store-identity-guard` closes it by making the second registration
throw at the pool. Do not try to close it here by registering host-built caches: the registry
would then have to track a lifetime it does not own.

**No host opt-out is being added.** The ticket that motivated this listed "let a host say
don't cache this one" as an option; deduping makes it unnecessary, because the only reason a
host would want independent consumers on one store is to avoid the divergence this removes.
If a real need for an uncached store appears, it is a separate feature request.

## Edge cases & interactions

- **Lease release is idempotent per lease.** A double `release()` must not decrement twice —
  latch a `released` flag inside the lease. Two leases released concurrently must still land
  the disposal exactly once.
- **Departure order.** A leases, B leases, A releases → B still reads through a live,
  pool-registered cache. B releases → cache cleared, unregistered, registry entry gone. A later
  wrap over the same store builds a **fresh cold** cache. Test all three steps.
- **Host-supplied cache still passes through** with `lease: undefined`; the existing guards
  ("a shared wrapper survives one consumer departing", the node spec's "does not dispose a
  `CachedRawStorage` the host supplied") must keep passing untouched.
- **A different `pool` on a dedupe hit is ignored** — the first wrap fixes the pool, and the
  second caller gets the existing cache. Identity beats sizing; a same-store-different-pool
  pair would diverge, which is the thing being removed. Pin it in a test so it reads as a
  decision.
- **The label on a dedupe hit is the FIRST caller's.** `pool.stats()` will show
  `node:<network>` or `quereus:local` from whoever wrapped first, whatever the second caller
  passed. Assert it and say so in the doc, since pool occupancy is read by humans.
- **Cache lifetime now spans consumers — the sharp new edge.** `db.close()` does not reach
  `CollectionFactory.dispose()` (the vtab module's `disconnect` is per-statement and `destroy`
  is DROP TABLE), and `plugin.dispose()` is opt-in. So a host that never disposes keeps the
  refcount above zero, and a **later** `Database` over the same directory now gets a WARM
  cache where it used to get a cold one. Anything that mutates the directory behind the
  storage's back between two `Database`s — a test that hand-writes or corrupts files — will now
  read pre-tamper values. Sweep `packages/quereus-plugin-optimystic/test/` for that pattern
  (`legacy-commit-atomicity.spec.ts` and `oldkeyvalues-compact-shape.spec.ts` are the
  candidates: both write files directly and both open several `Database`s over one `dir`). Any
  such spec must release between the two — call `plugin.dispose()`. Report what you found
  either way; "no spec does this" is a useful finding, not a skipped step.
- **Registry retention.** An entry lives until its last lease releases, so a host that never
  releases holds one cache per store for the process. That is the same class of leak as today
  (an undisposed cache already stays registered with its pool forever); record it as a `NOTE:`
  at the registry, not as a new ticket.
- **`MemoryRawStorage` and identity-less test drivers** must keep getting independent caches
  per distinct object — several db-p2p specs build two caches over two memory drivers and
  compare them.
- **Reopen-starts-cold** (`with-read-cache.spec.ts`) still holds because it disposes first;
  make sure the test now releases the lease rather than disposing the cache directly.
- **`local-transactor-read-cache.spec.ts`** passes the SAME driver object to a fresh
  `KvRawStorage` per factory call. Those storage objects are distinct and the driver has no
  identity, so no dedupe — confirm the spec's counts still hold rather than assuming.

## Tests

- **Flip the existing guard.** `with-read-cache.spec.ts`'s "two wraps of ONE unwrapped instance
  are two independent caches that never converge" pins today's footgun. Rewrite it as
  *converge*: the same wrapper comes back, one pool registration, and the reader sees the
  writer's SECOND write.
- New: two storages reporting the same `getStoreIdentity()` over one backing driver dedupe to
  one wrapper and one pool registration, and a write through one is visible through the other.
- New: refcount lifecycle — two leases, release one, cache still registered and serving;
  release the other, registration retired and pool entries released; wrap again, fresh cold
  cache (assert a real backend read happens).
- New: `release()` twice on one lease retires the store exactly once (pool store count goes to
  zero and stays; no throw).
- New: different pool on the second wrap → same cache, first pool keeps the registration.
- New: first label wins in `pool.stats()`.
- **The end-to-end confirmation from the originating ticket**, in
  `read-pull-mechanism.spec.ts`: revert `createDb`'s `shared` parameter and the hand-built
  `CachedRawStorage`, so the cross-writer test again uses two plain
  `rawStorageFactory: () => new FileRawStorage(dir)` peers — and passes. That is the measured
  table's row 2 becoming correct, and it is the acceptance criterion for this ticket. Rewrite
  the two long comment blocks in that file that currently explain why sharing was mandatory.

## Docs

`packages/db-p2p/docs/storage.md`: rewrite the "Precondition (Invariant 5)" paragraph in § 6
and the sharing note in the composition list. Two caches over one store in one process is now
prevented, not merely warned about; what remains under Invariant 5 is the **cross-process**
case (the filesystem driver takes no lock — the proper-lockfile TODO in
`db-p2p-storage-fs/src/file-storage.ts`), plus the two documented identity residuals (path
aliases, two handles over one file). Update `withReadCache`'s own class doc and
`RawStorageProvider`'s doc in `libp2p-node-base.ts` to describe leases rather than
"do not hand one uncached instance to two nodes".

## TODO

- Add the registry, `ReadCacheLease`, and the identity/object two-key lookup to
  `with-read-cache.ts`; rename `ownedCache` → `lease` in `ResolvedReadCache`.
- Update `resolveStorage` + the node stop wrapper in `libp2p-node-base.ts`.
- Update `CollectionFactory` (`readCacheLeases`, `dispose`) and its doc comments.
- Flip / add the `with-read-cache.spec.ts` cases listed above; update
  `node-read-cache-wiring.spec.ts` for the renamed field.
- Restore `read-pull-mechanism.spec.ts` to two independent `FileRawStorage` peers and confirm
  the cross-writer test passes; rewrite its stale comments.
- Sweep the plugin test directory for "mutate files between two Databases over one dir" and
  make any such spec release its caches; report the result in the handoff.
- Update `docs/storage.md` § 6 and Invariant 5's cache paragraph.
- Run: `yarn workspace @optimystic/db-p2p test`,
  `yarn workspace @optimystic/quereus-plugin-optimystic test`,
  `yarn workspace @optimystic/db-p2p-storage-fs test`, then `yarn build && yarn typecheck`.
