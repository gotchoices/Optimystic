description: The mobile (NativeScript) SQLite backend now serializes all writes on its shared database connection so two simultaneous writes can no longer tangle their transactions and silently undo each other's committed data.
prereq:
files: packages/db-p2p-storage-ns/src/connection-mutex.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/README.md, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/test/connection-mutex.spec.ts, packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts
----

# Complete: Serialize SQLite transactions on the shared NativeScript connection

## What shipped

`NSPluginDbWrapper` (and its test twin `NodeSqliteWrapper`) shared one SQLite
connection across all storage classes with no mutex. SQLite permits at most one open
transaction per connection, so two concurrent `transaction()` bodies each ran `BEGIN`;
the second nested and threw, and its `catch` ran `ROLLBACK` — discarding the *first*
transaction's still-open writes. Plain writes issued while a transaction was open were
also folded into it and lost on rollback.

Fix: a per-connection FIFO promise-chain mutex (`ConnectionMutex.serialize`) guards every
mutating op (`exec`, statement `run`, whole `transaction` bodies). Reads (`get`/`all`)
bypass it to preserve read concurrency. Transaction bodies receive a `SqliteTransaction`
whose `tx.prepare` statements bypass the mutex (they already hold the slot; re-locking
would deadlock). See the implement handoff (git `ticket(fix)` /resume commit) for the
full per-file breakdown.

## Review findings

Read the implementation diff with fresh eyes, then scrutinized the mutex, both wrapper
twins, the storage layer, the tests, and the docs. Build clean, **31 passing / 0 failing**
(was 27 before this review pass added the mutex unit spec).

**Checked and clean:**
- **Mutex correctness** — FIFO chain, non-poisoning tail (a rejected task advances the
  queue with a sanitized `.then(()=>u,()=>u)`), per-task result/error propagation, sync +
  async tasks. Verified by reasoning *and* now by a direct unit spec.
- **Deadlock surface** — only one `db.transaction` caller (`promotePendingTransaction`),
  and it writes exclusively through `tx.prepare`. No class-level (mutex-guarded) statement
  is `run` inside a transaction body; no nested `db.transaction`. Both are the only ways to
  deadlock the held slot.
- **No stray writers** — grep of `src/` confirms every write path (`sqlite-storage`,
  `sqlite-kv-store`, `identity`) goes through the wrapper's `db.prepare(...).run`/`exec`,
  never the raw connection. `db.transaction` has exactly one caller.
- **Wrapper twins mirror** — `ns-opener` and `node-sqlite-driver` `transaction()` bodies
  match statement-for-statement (`BEGIN IMMEDIATE` → body → `COMMIT`/swallowed `ROLLBACK`),
  modulo the driver's single- vs multi-statement `exec` capability. Only the test twin runs
  in CI, so drift would hide a production bug — the handoff already flags this; left as-is.
- **Test correctness** — the two regression specs run against real `node:sqlite`; test #2's
  "plain write survives a concurrent failing transaction" implicitly exercises non-poisoning
  (the write is queued behind the failing promote and still lands).

**Minor — fixed inline this pass:**
- **Stale README (doc-out-of-date).** `README.md` claimed "SQLite serializes writes inside
  a single connection; ... contention is a non-issue" — the exact false premise this bug
  disproved (SQLite throws on nested `BEGIN`; it does *not* serialize concurrent transaction
  bodies — the wrapper mutex does). Rewrote the paragraph to describe the mutex.
- **Missing direct mutex coverage (test).** The mutex — the crux of the fix — was only
  integration-tested. Added `test/connection-mutex.spec.ts` (4 tests): FIFO ordering with a
  no-overlap assertion, result/error propagation, non-poisoning, and sync-task support.

**Major — none.** No new fix/plan/backlog tickets filed.

**Tripwires (recorded, not filed):**
- *Unserialized reads on the shared connection* — carried over from implement. Reads bypass
  the mutex and can observe a concurrent transaction's uncommitted rows on the same
  connection. Fine today (only same-block promote writes, under the per-block commit latch).
  Parked as `// NOTE:` at the `get`/`all` bypass sites in `src/ns-opener.ts`.
- *Nested-transaction / class-statement-in-transaction deadlock* — noticed during this
  review: calling `db.transaction` inside a transaction fn, or running a `db.prepare(...)`
  statement inside one, re-acquires the held mutex slot and deadlocks. No caller does either
  today. Parked as a `NOTE:` in the `transaction` doc-comment in `src/db.ts`.

## Honest gaps carried forward (unchanged from implement)

- No production runtime coverage — regression + mutex tests run against `node:sqlite`, never
  the real `@nativescript-community/sqlite` plugin (needs a NativeScript host, not
  agent-runnable). Twins kept identical by hand.
- Ordering, not isolation — the mutex guarantees write serialization, not snapshot
  isolation; test concurrency is cooperative microtask interleaving under single-threaded
  `node:sqlite`, not true parallel threads.

## Validation

`packages/db-p2p-storage-ns`: `yarn build` clean; `yarn test` → **31 passing, 0 failing**.
