description: The mobile (NativeScript) SQLite backend now serializes all writes on its shared database connection, so two simultaneous writes can no longer tangle their transactions and silently undo each other's committed data.
prereq:
files: packages/db-p2p-storage-ns/src/connection-mutex.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/test/connection-mutex.spec.ts, packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts
difficulty: medium
----

# Review: Serialize SQLite transactions (and plain writes) on the shared NativeScript connection

## What the bug was

`NSPluginDbWrapper` shared **one** SQLite connection across all storage classes with **no
mutex**. SQLite permits at most one open transaction per connection, so two concurrent
`transaction()` bodies each ran `BEGIN`; the second threw `cannot start a transaction within a
transaction`, and its `catch` ran `ROLLBACK` — discarding the **first** transaction's still-open
writes. A write the caller believed committed was silently undone by an unrelated concurrent
operation's failure. Secondary defect: any plain write (`savePendingTransaction`, `saveRevision`,
`setLatest`, …) issued while a transaction was open got folded into that open transaction and
lost on its rollback.

The concurrency arises because `StorageRepo`'s per-block commit latch serializes only *same-block*
work; disjoint-block operations (e.g. block A's promote vs block B's promote/pend) run
concurrently against the one shared connection.

## What was implemented

**New `src/connection-mutex.ts`** — `ConnectionMutex`, an instance-scoped FIFO promise-chain
mutex (`serialize<T>(task)`). Same shape as `db-core`'s `latches.ts`, but bound to one connection
instead of the global keyed `Latches` map. The chain tail is kept non-rejecting so a failing task
cannot poison the queue behind it, while each task's own result/error still reaches its own caller.

**`src/db.ts`** — new `SqliteTransaction` interface: a `prepare(sql)` whose statements bind to the
*already-open* transaction and **bypass** the mutex (they run inside the held slot; re-locking
would deadlock). `SqliteDb.transaction` signature changed from `fn()` to `fn(tx: SqliteTransaction)`.
This explicit `tx` context is the reentrancy seam — a shared `inTransaction` flag could not tell an
inner statement (must bypass) from a concurrent external write (must block), since both read the
same flag while the transaction is open.

**`src/ns-opener.ts`** (`NSPluginDbWrapper`, production) and **`test/node-sqlite-driver.ts`**
(`NodeSqliteWrapper`, test driver) — kept byte-for-byte parallel so the regression spec exercises
the real production shape:
- one `ConnectionMutex` per wrapper instance;
- `exec` and outside-transaction statement `run` → `mutex.serialize(...)`;
- `get`/`all` → run directly on the raw connection, **unserialized** (read concurrency preserved);
- `transaction(fn)` → whole body inside one mutex slot: `BEGIN IMMEDIATE` → `fn(tx)` →
  `COMMIT`/`ROLLBACK`; `tx.prepare` statements bypass the mutex.

**`src/sqlite-storage.ts`** — `promotePendingTransaction` rewritten to use `tx.prepare` for its
three statements (get pending / insert transaction / delete pending). Class-level
`getPending`/`saveTransaction`/`deletePending` prepared statements retained — each is still used on
non-transaction paths (`getPendingTransaction`, `saveTransaction`, `deletePendingTransaction`).

**Tests** — `connection-mutex.spec.ts` (new, 4 unit tests: FIFO order, per-caller result/error
propagation, non-poisoning after a rejection, sync-task acceptance). `sqlite-transaction-
serialization.spec.ts` `.skip` removed — both regression tests now run.

## How to validate

Run in `packages/db-p2p-storage-ns`:

```
yarn build        # tsc, clean
yarn test         # 31 passing, 0 failing
```

Key cases exercised (all green at handoff):
- **two concurrent promotes on disjoint blocks both survive** — the primary cross-rollback bug;
  serialized, both commit; unserialized this failed with `cannot start a transaction within a
  transaction` + a lost commit.
- **a plain write concurrent with a rolling-back transaction is neither swept in nor lost** — the
  secondary plain-write defect; the concurrent `savePendingTransaction` for another block stays
  durable even though the promote transaction it raced rolls back (missing pending).
- ConnectionMutex unit tests cover the primitive directly.

## Reviewer: where to look hard

- **Deadlock surface.** The invariant is: inside a `transaction(fn)` body you must issue writes
  **only** through the provided `tx`, and must not call `db.transaction(...)` again. Either would
  re-acquire the held slot and deadlock. Documented in `db.ts:transaction` doc comment; only caller
  today is `promotePendingTransaction`, which obeys it. No runtime guard exists — worth a look at
  whether a cheap reentrancy assertion is warranted, or whether the doc note suffices. (Judged
  sufficient for now: single caller, no dynamic transaction nesting anywhere in the package.)
- **Wrapper parity.** Production `ns-opener.ts` and test `node-sqlite-driver.ts` must stay
  identical in serialization behavior or the spec stops testing production. Confirm they match.
- **`BEGIN IMMEDIATE`.** Chosen over plain `BEGIN` to take the write lock up front. For an
  in-memory / single-connection test DB this is behaviorally equivalent to `BEGIN`; on a real
  file-backed NS connection it front-loads contention. No multi-connection test covers the
  file-lock path (the NS plugin isn't installed in the Node test env) — this is a known coverage
  gap, not a regression.

## Known gaps (honest floor, not finish line)

- No test drives the **real `@nativescript-community/sqlite` plugin** — it's a peer dep absent in
  the Node test env. Serialization is verified against `node:sqlite` via a mirror driver only. The
  production wrapper's mutex logic is identical, but plugin-specific transaction semantics are
  unverified here.
- No **stress/fuzz** test (many concurrent mixed ops); coverage is the two targeted races plus the
  mutex unit tests.
- Reads are intentionally unserialized — see tripwire below.

## Review findings

- **Tripwire (recorded, not a ticket):** reads (`get`/`all`) run unserialized to preserve read
  concurrency. A read on this connection while a write transaction is open observes that
  transaction's *uncommitted* rows (read-your-connection semantics). Fine today — the only
  transaction writer is same-block promote under the commit latch, and cross-block reads are
  independent. Parked as a `// NOTE:` at the `get`/`all` bypass site in
  `src/ns-opener.ts` (`NSPluginStatement.get`/`all`); serialize reads too if a future caller ever
  reads rows mid-transaction on the same connection.
