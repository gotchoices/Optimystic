description: When two parts of a program open the same storage folder separately, each gets its own private copy of recently-read data and neither ever sees what the other saved. Make them share one copy instead, released only when the last user is done.
prereq: store-identity-plumbing
files: packages/db-p2p/src/storage/with-read-cache.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/with-read-cache.spec.ts, packages/db-p2p/test/node-read-cache-wiring.spec.ts, packages/quereus-plugin-optimystic/test/read-pull-mechanism.spec.ts, packages/quereus-plugin-optimystic/test/oldkeyvalues-compact-shape.spec.ts, packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts, packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts, packages/quereus-plugin-optimystic/test/local-transactor-read-cache.spec.ts, packages/db-p2p/docs/storage.md
difficulty: hard
----

<!-- resume-note -->
**A prior run implemented this ticket in full but hit its token budget before running the
test suites.** `yarn build` passed (all packages). Nothing has been executed under mocha and
`yarn typecheck` has not been run. All code, test, and doc edits are in the working tree
(uncommitted — do not revert them). Resume at **"Remaining work"** below; the original spec
follows it for reference.

## What is already done (working tree)

- **`packages/db-p2p/src/storage/with-read-cache.ts`** — rewritten. Exports `ReadCacheLease`
  and `ResolvedReadCache = { storage, lease }` (`ownedCache` is gone). Module-level registry:
  `byIdentity: Map<StoreIdentity, RegistryEntry>` + `byObject: WeakMap<IRawStorage, RegistryEntry>`;
  identity-bearing storages are keyed by identity only. `withReadCache` is synchronous; hit →
  `refs += 1` and a fresh `Lease`; miss → construct, register with refs 1. `Lease.release()`
  latches a `released` flag, decrements synchronously, and only the release that lands on 0
  calls `entry.retire()` (map delete) then `await cache.dispose()`. Registry-retention `NOTE:`
  is at the registry declaration. Class doc rewritten to describe dedupe + leases + what
  remains of Invariant 5.
- **`packages/db-p2p/src/libp2p-node-base.ts`** — `resolveStorage` returns `lease`; stop
  wrapper calls `lease.release()`; `RawStorageProvider` doc and the label `NOTE:` rewritten.
- **`collection-factory.ts`** — `readCaches: CachedRawStorage[]` → `readCacheLeases:
  ReadCacheLease[]`; `dispose()` releases each; doc comments on `createLocalTransactor` and
  `dispose` rewritten (no longer promise a fresh cold cache per transactor).
- **`packages/db-p2p/test/with-read-cache.spec.ts`** — rewritten: the "never converge" guard
  is flipped to converge; new cases for identity dedupe (via a `Proxy` driver helper
  `identified(inner, id)` that adds `storeIdentity`), distinct-identity / identity-less
  independence, refcount lifecycle with cold re-wrap (asserts one real backend read), double
  release + stale-lease inertness + concurrent `Promise.all` release, different-pool-ignored,
  first-label-wins; existing cases converted from `ownedCache.dispose()` to `lease.release()`.
  `meta()` helper is typed as `Parameters<IRawStorage['saveMetadata']>[1]` — if the diagnostics
  still complain about `ranges: [[1]]` not being a `RevisionRange[]`, fix the literal there.
- **`node-read-cache-wiring.spec.ts`** — no `ownedCache` reference existed (it observes pool
  labels); ADDED a case: two nodes over one `KvRawStorage(MemoryStoreDriver)` → one pool row
  labelled by the first node, first stop keeps it, last stop retires it.
- **`read-pull-mechanism.spec.ts`** — `createDb`'s `shared` parameter and the hand-built
  `CachedRawStorage` are removed; the cross-writer test uses two plain
  `rawStorageFactory: () => new FileRawStorage(dir)` peers and each peer calls
  `plugin.dispose()` in its `finally`. Both stale comment blocks rewritten. **This test passing
  is the acceptance criterion** (measured table row 2 becoming correct). Not yet run.
- **Sweep of `packages/quereus-plugin-optimystic/test/` for "mutate the directory behind the
  storage's back between two `Database`s over one dir":**
  - No spec hand-writes files into a dir that a `Database` also uses. The only direct file
    writer (`file-raw-storage-actionid.spec.ts`) drives `FileRawStorage` directly, no `Database`.
  - `legacy-commit-atomicity.spec.ts` and `committed-read-isolation.spec.ts` DO write behind the
    plugin's cache, via an injected transactor over a bare `FileRawStorage` — but the injected
    `Database` never calls `createLocalTransactor` (the transactor is pre-registered), so it
    never takes a lease; only the plain reopen does. Added `await plugin.dispose()` to
    `reopenCount` in the legacy spec so a second reopen in one test can never inherit a warm
    cache. `committed-read-isolation` was left untouched (single reopen per dir; verify when
    running).
  - `oldkeyvalues-compact-shape.spec.ts` (every `createDb` site + `reopenScalar`; the second
    handle in the rotated-PK test is now `plugin2`) and `session-mode-commit.spec.ts` (the
    "survives reopen from disk" case) now `plugin.dispose()` on close so their reopen still
    reads disk rather than the previous `Database`'s warm cache. Comments explain why.
  - **Left warm on reopen, deliberately (report in the handoff):** `deferred-constraint-rollback`,
    `insert-pk-uniqueness`, `savepoint-rollback`, `update-pk-move-uniqueness` each have a
    reopen helper (`hydrate` + `close`) and many `db.close()` sites (25 in insert-pk-uniqueness)
    with no `plugin.dispose()`. Their reopens now join the still-warm shared cache. That is
    coherent (every write went through the cache) but they no longer prove on-disk persistence.
    Not changed — a mechanical edit of ~40 sites; flag for the reviewer rather than doing it here.
- **`docs/storage.md`** — Invariant 5 "Detecting a violation" bullets updated (the cache dedupe
  is now the consumer of `getStoreIdentity()`); § 6 wiring: `{ storage, lease }`, new
  "One cache per backing store, shared under leases", "Lease obligations", "Lifetime now spans
  consumers", and "What remains of Invariant 5 for the cache" paragraphs replace the old
  "Dispose obligations" + "Precondition" text.
- Grepped repo for stale "hand that same object / share the wrapper" prose: the two remaining
  hits are in test comments describing the host-built-cache path, which is still valid.

## Remaining work

- Run, in the foreground, and fix anything red that is yours:
  `yarn workspace @optimystic/db-p2p test`,
  `yarn workspace @optimystic/quereus-plugin-optimystic test`,
  `yarn workspace @optimystic/db-p2p-storage-fs test`, then `yarn typecheck`
  (build already passes; re-run `yarn build` if you touch db-p2p `src/`, since the plugin
  tests import db-p2p's `dist`).
- Things most likely to bite, in order: (1) the `meta()` literal typing in
  `with-read-cache.spec.ts`; (2) the `identified()` Proxy helper — if `KvRawStorage` reads
  private fields off the driver through `this`, switch the helper to a hand-written delegating
  class; (3) `local-transactor-read-cache.spec.ts` expects `dispose` to drop the pool store count
  by exactly 1 — it passes the SAME memory driver object to a fresh `KvRawStorage` per factory
  call, so those storages are distinct objects with no identity and should NOT dedupe; confirm
  the counts hold rather than assuming; (4) the new node-wiring case spins two nodes on port 0.
- Write the `review/` handoff: acceptance criterion result (cross-writer test with two plain
  `FileRawStorage` peers), the sweep report above verbatim, the four warm-on-reopen specs as a
  known gap, and the tripwire index line for the registry-retention `NOTE:` in
  `with-read-cache.ts`. Then delete this file.

---

# Original ticket (for reference)

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

## The fix: `withReadCache` returns one cache per store, under a lease

```ts
export interface ReadCacheLease {
	readonly cache: CachedRawStorage;
	release(): Promise<void>;
}
export type ResolvedReadCache = { storage: IRawStorage; lease: ReadCacheLease | undefined };
```

Resolution order: `MemoryRawStorage` → unchanged; already `CachedRawStorage` → unchanged
(host owns it); registry hit by `getStoreIdentity()` (else by object in a `WeakMap`) → refcount
+1, same cache, fresh lease; miss → construct, register refcount 1.

## What this does not fix

A host that builds a `CachedRawStorage` itself never enters the registry; a second consumer
wrapping a fresh `FileRawStorage` over that directory still gets a second cache. The follow-on
`duplicate-store-identity-guard` closes it at the pool. No host opt-out is added.

## Edge cases pinned in tests

Idempotent release; concurrent release lands one disposal; departure order (A, B lease; A
releases → B live; B releases → retired; re-wrap → cold); host-supplied cache passes through
with `lease: undefined`; different pool on a hit is ignored; first label wins; memory and
identity-less drivers keep independent caches per object; reopen-starts-cold releases the
lease rather than disposing.
