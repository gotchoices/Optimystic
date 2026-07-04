description: The mobile (NativeScript) SQLite backend now serializes all writes on its shared database connection so two simultaneous writes can no longer tangle their transactions and silently undo each other's committed data.
prereq:
files: packages/db-p2p-storage-ns/src/connection-mutex.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts
difficulty: medium
----

# Review: Serialize SQLite transactions on the shared NativeScript connection

## What the bug was

`NSPluginDbWrapper` shared **one** SQLite connection across all storage classes with
**no mutex**. SQLite permits at most one open transaction per connection, so two concurrent
`transaction()` bodies each ran `BEGIN`; the second threw `cannot start a transaction within a
transaction`, and its `catch` ran `ROLLBACK` — discarding the **first** transaction's still-open
writes. A write the caller believed committed was silently undone by an unrelated concurrent
operation's failure. Secondary: any plain write (`savePendingTransaction`, `saveRevision`, …)
issued while a transaction was open got folded into that transaction and lost on its rollback.

## What was implemented

**New file `src/connection-mutex.ts`** — `ConnectionMutex`, an instance-scoped FIFO
promise-chain mutex (`serialize<T>(task)`). Modeled on `db-core`'s `latches.ts` shape but per
connection, not the global keyed `Latches` map. The chain tail is kept non-rejecting so a failing
task can't poison the queue behind it.

**`src/db.ts`** — new `SqliteTransaction` interface (a `prepare(sql)` that binds statements to
the *already-open* transaction). `SqliteDb.transaction` signature changed from `fn()` to
`fn(tx: SqliteTransaction)`.

**`src/ns-opener.ts`** (`NSPluginDbWrapper`) and **`test/node-sqlite-driver.ts`**
(`NodeSqliteWrapper`) — mirror each other exactly:
- one `ConnectionMutex` per wrapper instance;
- `exec` and outside-transaction statement `run` → `mutex.serialize(...)`;
- `get`/`all` → run directly on the raw connection, **unserialized** (read concurrency preserved);
- `transaction(fn)` → runs the whole body inside one mutex slot: `BEGIN IMMEDIATE` → `fn(tx)` →
  `COMMIT`/`ROLLBACK`. `tx.prepare` binds statements that **bypass** the mutex (they already hold
  the slot; re-locking would deadlock — this is why reentrancy is threaded through an explicit
  `tx` context, not a shared `inTransaction` flag).

**`src/sqlite-storage.ts`** — `promotePendingTransaction` rewritten to use `tx.prepare` for its
three statements (get pending / insert transaction / delete pending), so they run on the open
transaction without re-locking. The class-level `getPending`/`saveTransaction`/`deletePending`
prepared statements are retained — each is still used on non-transaction paths
(`getPendingTransaction`, `saveTransaction`, `deletePendingTransaction`).

**`test/sqlite-transaction-serialization.spec.ts`** — `.skip` removed; both regression tests now run.

## How to validate (use cases exercised)

Run in `packages/db-p2p-storage-ns`:
- `yarn build` — tsc, clean.
- `yarn test` — **27 passing, 0 failing** (was 25 + 2 skipped). The two unskipped regression tests:
  1. *two concurrent promotes on disjoint blocks both survive* — `Promise.allSettled` of two
     `promotePendingTransaction` calls on different blocks; asserts neither rejects and both rows
     land in `transactions` / clear from `pending`. Before the fix this failed with
     `promote outcomes: [ 'fulfilled', 'rejected' ]  cannot start a transaction within a transaction`.
  2. *a plain write concurrent with a transaction is neither lost nor rolled back with it* —
     a promote of a **missing** pending (forces genuine rollback) concurrent with a
     `savePendingTransaction` for another block; asserts the plain write is durable.

Both run against **real `node:sqlite`** via `NodeSqliteWrapper`, whose `transaction()` is a
byte-for-byte mirror of the production `ns-opener` one — so the test driver actually exercises the
serialization path the production code took.

## Honest gaps / where the reviewer should push

- **No production runtime coverage.** The regression tests run against `node:sqlite`, never the
  actual `@nativescript-community/sqlite` plugin (needs a NativeScript host, not agent-runnable).
  The two wrappers are kept structurally identical *by hand* — verify they haven't drifted, since
  only the test-driver copy is exercised by CI. If they diverge, the tests would pass while
  production stays buggy.
- **Ordering, not isolation.** The mutex guarantees write **serialization**, not snapshot
  isolation. Concurrency in the tests is cooperative (microtask interleaving via `Promise.allSettled`
  under a single-threaded `node:sqlite`) — it reproduces the *nesting* race deterministically but
  does not stress true parallel threads. Consider whether a reviewer wants a higher-contention or
  fuzz-style test.
- **`get`/`all` reads deliberately bypass the mutex** (see tripwire below) — confirm no current
  caller depends on reads observing only committed state on this connection.
- **`BEGIN IMMEDIATE`** was chosen over `BEGIN` to take the write lock up front. On `:memory:`
  test DBs this is a no-op distinction; on a real WAL file it changes lock-acquisition timing.
  Worth a sanity check that no path relied on deferred `BEGIN` semantics.

## Review findings (tripwire index — record, do not re-file as tickets)

- **Unserialized reads on the shared connection** — `NSPluginStatement.get`/`all` in
  `src/ns-opener.ts` run directly on the raw connection to preserve read concurrency. A read issued
  while a write transaction is open on the same connection observes that transaction's
  **uncommitted** rows (read-your-connection semantics). Fine today: the only transaction writer is
  same-block `promotePendingTransaction` under the per-block commit latch, and cross-block reads are
  independent. Parked as a `// NOTE:` at the `get` bypass site in `src/ns-opener.ts` (with a
  shorter pointer on `all`): *if a future caller reads a block on this connection while another op's
  transaction on the same rows is mid-flight, it may see uncommitted state; serialize reads too if
  that ever matters.*
