description: A shared storage core (KvRawStorage) now backs the in-memory block store, and one reusable test suite proves any storage backend behaves identically — review the core and suite before the four disk/db backends adopt them.
prereq:
files: packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/memory-store-driver.ts, packages/db-p2p/src/storage/memory-storage.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts, packages/db-p2p/test/kv-raw-storage.spec.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/testing/index.ts, docs/internals.md
difficulty: hard
----

# Review: shared ordered-KV storage kernel (`KvRawStorage` + `RawStoreDriver` + conformance suite)

## What was built

A **typed multi-store driver** kernel that hoists the genuinely-shared storage logic
(value serialization + call orchestration) ABOVE the storage primitive, while leaving each
backend's key/topology layer alone. New files:

- **`raw-store-driver.ts`** — `RawStoreDriver` interface: bytes-valued, per-logical-store
  surface (metadata / revisions / pending / transactions / materialized). Documents the two
  contracts the kernel relies on but can't share code for: **drain-before-yield** iteration
  (`rangeRevisions` / `listPendingActionIds` must drain their native cursor before yielding,
  because a live LevelDB iterator / IndexedDB transaction / SQLite cursor can't straddle the
  consumer's awaits) and **promote atomicity** (the only cross-key atomic op).
- **`raw-store-codec.ts`** — `encodeJson`/`decodeJson` (TextEncoder/TextDecoder + JSON) for
  `BlockMetadata`/`Transform`/`IBlock`, and `encodeActionId`/`decodeActionId` for the
  `ActionId` string.
- **`kv-raw-storage.ts`** — `KvRawStorage implements IRawStorage` over a driver. Owns the
  codec calls, `listRevisions` lo/hi/reverse bound computation, `saveMaterializedBlock`
  put-or-delete, `promotePendingTransaction` → `driver.promote`, and the optional
  `listBlockIds`/`getApproximateBytesUsed` passthroughs (wired **only** when the driver
  provides them, so feature-detection sees the driver's true capability). Carries the
  `// NOTE:` marking the single put/delete write path where a future incremental byte counter
  (`st-storage-sweep-archival-and-capacity-estimate`) would hook in — **not implemented here**.
- **`memory-store-driver.ts`** — in-memory `RawStoreDriver` (five `Map`s of `Uint8Array`).
- **`memory-storage.ts`** — `MemoryRawStorage` is now a thin `extends KvRawStorage` over the
  memory driver. Name/import path kept stable. `structuredClone` discipline **deleted**.
- **`raw-storage-conformance.ts`** — `runRawStorageConformance(name, makeStorage)` registers a
  `describe` block of ~30 `it()`s. Exported from `src/testing/index.ts` (the `./testing` entry).
- **`kv-raw-storage.spec.ts`** — runs the suite against the in-memory driver.

Exports added to `index.ts` and `rn.ts`; `docs/internals.md` "Storage Returns References"
updated to record that the byte boundary makes clone-on-store/read structural for
kernel-backed stores.

## Why the design is a driver, not a flat byte-KV

The four real backends do NOT share a storage topology — LevelDB is one ordered byte
keyspace, SQLite five tables, IndexedDB five object stores, fs a directory tree. Forcing them
onto one flat byte-KV would break SQLite/IndexedDB on-disk formats and can't work for fs at
all. So the shared seam is value-serialization + orchestration; the driver keeps each
backend's native key layout. `promote` is a first-class driver primitive (not a generic
atomic batch) because it's the sole cross-key atomic op and fs can only satisfy it via a
single `rename`.

## The correctness upgrade to verify

The clone-on-store / clone-on-read pitfall is now **structural, not a discipline**: values
cross the driver boundary as `Uint8Array` (JSON-encode on save, JSON-decode on read), so every
save stores an independent byte snapshot and every read yields a fresh object by construction.
The conformance suite asserts this for metadata, materialized blocks, and both transaction
stores — a driver that shortcuts the byte copy is caught.

## Validation done

- `npx tsc --noEmit -p tsconfig.json` → clean.
- Full db-p2p unit suite (excluding `*.integration.spec.ts`): **1292 passing, 11 pending, 0
  failing** (`node --import ./register.mjs mocha "test/**/*.spec.ts" --ignore "test/**/*.integration.spec.ts"`).
- Conformance suite (30 tests) green against the memory driver, including the `BlockStorage`
  parity slice (pend→commit seeds open-ended `[[E]]` never `[[0]]`; saveReplica→saveDeletion
  tombstone reads back `undefined`).

## Use cases / what to exercise in review

- **Conformance coverage completeness.** The suite is the artifact that will guard all four
  real backends. Confirm it covers the union of the existing per-package
  `test/*-storage.spec.ts` asserts PLUS the parity-critical behaviors. Concretely check:
  round-trips + `undefined`-on-miss for all five stores; `listRevisions` ascending/descending,
  inclusive bounds, sparse-skip, blockId scoping, empty range; pending scoping + delete;
  `saveMaterializedBlock(undefined)` deletes; promote atomicity + the **exact**
  `Pending action <id> not found for block <id>` message; clone-on-store/read; `listBlockIds`
  exactness (optional-guarded); drain-before-yield (interleaved awaits).
- **Metadata byte-fidelity.** `BlockMetadata` with an open-ended one-element `RevisionRange`
  (`[5]`) must round-trip byte-exact (`JSON.stringify([5])` → `"[5]"` → `[5]`). The codec must
  NOT normalize ranges. Covered by a test — verify it actually pins this.
- **Promote behavior change (flag).** The old `MemoryRawStorage.promotePendingTransaction`
  **silently no-op'd** on a missing pending; the new memory driver **throws**, matching all
  four real backends. Verified safe: `internalCommit` (storage-repo.ts:633) and the
  retry-commit path (storage-repo.ts:501) both check pending presence before promoting, so no
  production caller hits the throw on a legitimate path. Worth a second look.

## Known gaps — treat this as a starting point, not a finish line

- **The four real drivers are NOT migrated.** `db-p2p-storage-{rn,ns,web,fs}` still implement
  `IRawStorage` directly and do **not** yet call `runRawStorageConformance`. The "one suite
  replaces four copied specs" win and the "fs is a first-class driver via `rename`" resolution
  are only *designed* here, proven only against the in-memory driver. Migrating each backend to
  a `RawStoreDriver` + wiring the conformance suite is follow-up work (one ticket per backend
  is the natural split). The four copied `test/*-storage.spec.ts` files still exist and were
  intentionally left in place.
- **Drain-before-yield is only trivially exercised.** The memory driver has no live cursor, so
  its drain test passes without proving anything about a real cursor. The contract is doc-only
  until a real driver adopts it; the interleaved-await test becomes meaningful then.
- **`listBlockIds`/`getApproximateBytesUsed` are now optional on `KvRawStorage`.** They're
  wired only when the driver implements them. `MemoryRawStorage`'s driver implements both, so
  it always has them at runtime, but the *static* type is now optional — a caller that typed a
  concrete `MemoryRawStorage` and called `.listBlockIds()` without a guard would need `!`/a
  guard. The one such caller (`test/memory-storage.spec.ts`) was **deleted** because its two
  test groups (clone-on-store, `listBlockIds`) are fully subsumed by the conformance suite now
  running against `MemoryRawStorage` (a committed-transaction clone assertion was added to the
  suite to keep coverage a strict superset). A monorepo grep found no other static caller.
  Reviewer: re-confirm that deletion lost no coverage.
- **Byte counter not built.** Only a `// NOTE:` marks the seam, per ticket scope.
- **`getApproximateBytesUsed` stays per-driver** (backend-specific: full scan / PRAGMA /
  storage.estimate / dir walk / memory sum) — passthrough, not shared logic, by design.
