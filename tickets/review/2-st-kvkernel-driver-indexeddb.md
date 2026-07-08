description: The browser IndexedDB block store was rewritten to run on the shared storage core, keeping its five object stores and atomic promote; needs an adversarial review for behavioral parity with the other backends and no browser/structured-clone regressions.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-web/src/indexeddb-storage.ts, packages/db-p2p-storage-web/src/db.ts, packages/db-p2p-storage-web/test/indexeddb-storage.spec.ts, packages/db-p2p-storage-web/src/index.ts, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts
difficulty: medium
----

# Review: IndexedDB driver reimplemented as `IndexedDBStoreDriver implements RawStoreDriver`

`IndexedDBRawStorage` (browser IndexedDB block store) was rewritten to plug into the shared
`KvRawStorage` kernel instead of implementing `IRawStorage` by hand. The kernel owns all JSON
serialization; the IndexedDB code became an `IndexedDBStoreDriver` that reads/writes raw
`Uint8Array` bytes over the same `OptimysticWebDBHandle`. Object stores, keys, and the atomic
promote are unchanged. Public surface (`new IndexedDBRawStorage(handle)`) unchanged.

## What changed

- **`src/indexeddb-storage.ts`** — full rewrite. `IndexedDBRawStorage` is now a thin
  `extends KvRawStorage` shell whose constructor does `super(new IndexedDBStoreDriver(handle))`
  (mirrors the fs `FileRawStorage` pattern). All IndexedDB mechanics moved into the new
  `IndexedDBStoreDriver` (exported):
  - metadata/revisions/pending/transactions/materialized get/put/delete map straight onto the
    existing `db.get/put/delete` over the same keys, values now `Uint8Array`.
  - `rangeRevisions` / `listPendingActionIds` keep the **snapshot-first** cursor scans
    (`IDBKeyRange.bound(...)`, drain into an array, `await tx.done`, then yield) — the kernel's
    drain-before-yield contract; a live cursor across a consumer await would be invalidated by
    IndexedDB's idle auto-commit.
  - `promote` keeps the single `readwrite` transaction over `['pending','transactions']` — read
    pending; if absent, `await tx.done.catch(...)` then throw the exact `Pending action … not
    found …`; else put into transactions + delete pending; `await tx.done`. **This is the atomic
    move, ported verbatim.**
  - `listBlockIds` (`getAllKeys('metadata')`) and `approximateBytesUsed`
    (`navigator.storage.estimate()`) are the optional passthroughs; re-declared non-optional on the
    subclass (the driver always provides them, so the kernel constructor always wires them).
- **`src/db.ts`** — the five block-storage stores keep their names + compound array keys; only the
  `value:` types change from live objects (`BlockMetadata`/`ActionId`/`Transform`/`IBlock`) to
  `Uint8Array`. `kv` store unchanged. Now-unused `IBlock`/`Transform`/`BlockMetadata` imports
  dropped. **No object-store or key change → no IndexedDB `version` bump / upgrade path.**
- **`test/indexeddb-storage.spec.ts`** — replaced the hand-rolled assertions with
  `runRawStorageConformance('IndexedDB', …)` over a `fake-indexeddb` handle, plus three
  IndexedDB-only cases the shared suite omits (below).

## Validation performed (this session, win32 dev box)

- **web build / typecheck** (`yarn workspace @optimystic/db-p2p-storage-web build`, i.e. `tsc`):
  clean.
- **web `yarn test`**: **43 passing, 0 failing** (conformance suite + IndexedDB-only cases +
  pre-existing `IndexedDBKVStore` / identity specs). Verbose run confirms the `IndexedDB`
  conformance block ran in full — `listBlockIds` and the `BlockStorage` parity slice passed, **not
  skipped** (the driver implements `listBlockIds`, so the optional-gate did not `this.skip()`).

Note: the ticket's `yarn test:db-p2p-storage-web` script does not exist at the repo root; the
equivalent is `yarn workspace @optimystic/db-p2p-storage-web test`. **db-p2p `dist` must be built
first** — the tests import `@optimystic/db-p2p` and `@optimystic/db-p2p/testing`, which resolve to
`dist/` (git-ignored). It is built in this workspace now.

## Use cases for the reviewer to exercise / validate

- **Cross-backend parity is the authoritative check.** `runRawStorageConformance('IndexedDB', …)`
  is the same suite the memory/fs backends run — round-trips, `listRevisions` asc/desc + sparse
  gaps + single-bound + block-scoping, promote atomicity + exact missing-pend error, clone-on-
  store/read (structural via the byte boundary), drain-before-yield for both cursor scans, and the
  `BlockStorage` pend→commit open-ended-range + saveReplica→saveDeletion tombstone slice.
- **Structured-clone byte fidelity (IndexedDB-specific).** `IndexedDB driver specifics` >
  "stores and returns a byte-identical Uint8Array" pins that a stored `Uint8Array` comes back **as
  a `Uint8Array`** (not an `ArrayBuffer`/`DataView`), byte-for-byte — the exact view-drift the
  ticket calls out that would break the kernel's `decodeJson`.
- **Array-key pending scan.** `listPendingActionIds captures all of a block and leaks no neighbour`
  drives the `[blockId] .. [blockId, []]` bound directly, including a `block-10` neighbour that
  sorts adjacent to `block-1` under string comparison, to prove no cross-block leak.
- **`getApproximateBytesUsed`** returns a number ≥ 0 (0 under Node/fake-indexeddb where
  `navigator.storage` is absent). Not covered by the shared suite.

## Honest gaps — treat tests as a floor, not a finish line

- **Never run against a real browser.** Validation is entirely `fake-indexeddb` under Node.
  Structured-clone `Uint8Array` fidelity, cursor auto-commit timing, and `navigator.storage.estimate()`
  are assumed equivalent in a real browser but not exercised. A real-browser / headless run is the
  true check and is out of band for an agent.
- **Old-format on-disk data will not decode (kernel-migration class, out of scope).** An IndexedDB
  database written by the *old* web backend stored **live objects** (`BlockMetadata`/`Transform`/
  `IBlock`), not bytes. Because the object stores + keys are unchanged, there is **no version bump
  or upgrade hook** — an existing browser DB keeps those object-valued rows, and the kernel's
  `decodeJson` (`JSON.parse(TextDecoder.decode(bytes))`) will fail on a non-`Uint8Array` row. This
  is the same uniform kernel-format migration affecting all four drivers (cf. the fs review's
  "old-format on-disk migration" note); pre-1.0 and out of scope to migrate per-driver. **Flagging
  because for IndexedDB it is silent** — no schema version distinguishes old vs new value shape, so
  a stale browser store surfaces only at read time. Reviewer: confirm this is acceptable pre-1.0
  or spin a migration ticket.
- **`IndexedDBStoreDriver` is newly public** via `export * from './indexeddb-storage.js'` (index.ts
  unchanged). Intentional and symmetric with the fs `FileStoreDriver`, but confirm it is meant to
  be part of the package's public surface.
- **`listBlockIds` snapshots all metadata keys** (`getAllKeys('metadata')`) into memory — unchanged
  from the original, fine as a startup seed; if a browser store ever holds enormous numbers of
  blocks this becomes an O(n) allocation, but that is a tripwire, not a defect (no NOTE added:
  behavior is identical to the pre-refactor code).

## Out of scope (unchanged, intentionally)

`indexeddb-kv-store.ts` (still string-valued over the `kv` store), `identity.ts`, `logger.ts`,
`index.ts`, and `openOptimysticWebDb` (schema/version unchanged). The sibling driver tickets
(`2-st-kvkernel-driver-{sqlite,leveldb}`) are independent.
