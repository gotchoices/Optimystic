description: The mobile SQLite storage now serializes concurrent writes, but its tests only cover two hand-picked race scenarios; add a randomized stress test that hammers it with many mixed concurrent operations to catch races the two targeted tests miss.
prereq:
files: packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts, packages/db-p2p-storage-ns/test/connection-mutex.spec.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/src/connection-mutex.ts
difficulty: medium
----

# Add a concurrency stress/fuzz test for the shared-connection SQLite mutex

## Why

The `db-p2p-storage-ns` write-serialization fix (ticket
`st-nativescript-sqlite-transaction-mutex`) is verified by:
- two targeted regression tests (two concurrent promotes on disjoint blocks;
  a plain write racing a rolling-back transaction), and
- four `ConnectionMutex` unit tests (FIFO order, per-caller result/error
  propagation, non-poisoning after a rejection, sync-task acceptance).

That is solid coverage of the *specific* failure the fix targeted, but it is a
fixed pair of interleavings. Concurrency primitives are exactly where a
randomized workload tends to surface interleavings a human didn't enumerate —
e.g. a plain write, a promote, and an `exec` all landing in an order the two
canned tests never produce.

This is hardening (`debt-`), not a known defect. The fix looks correct on
inspection; this ticket buys confidence, not a bug fix.

## What to build

A test (under `packages/db-p2p-storage-ns/test/`, runs against the existing
`node:sqlite` mirror driver `openTestDb()` — no NativeScript host needed) that:

- seeds N blocks with pending transforms,
- fires a large randomized batch (`Promise.allSettled`) of mixed operations
  across those blocks — `savePendingTransaction`, `promotePendingTransaction`,
  `saveRevision`/`saveMetadata`, and some deliberately-failing promotes (missing
  pending) to exercise the rollback path,
- then asserts the final state is internally consistent: every fulfilled
  promote moved its row from `pending` → `transactions` exactly once, every
  rejected promote left its (missing) row absent, and no committed write from
  any *other* operation was lost to an unrelated rollback.

Determinism note: workflow/`tess` scripts forbid `Math.random()` in some
contexts, but this is an ordinary mocha test — a seeded PRNG (or a fixed
shuffled operation list) keeps failures reproducible. Prefer a fixed seed and
log it, so a red run is replayable.

## Out of scope

- Driving the real `@nativescript-community/sqlite` plugin — it is an
  uninstalled peer dependency in the Node test env; that coverage gap is
  tracked separately and is not what this ticket buys.
