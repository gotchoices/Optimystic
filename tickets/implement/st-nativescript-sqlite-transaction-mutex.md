<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-07-04T05:03:25.266Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\st-nativescript-sqlite-transaction-mutex.implement.2026-07-04T05-03-25-266Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: The mobile (NativeScript) SQLite backend shares one database connection with no locking, so two simultaneous writes tangle their transactions and one write's rollback can silently undo another's committed data — serialize writes on the connection so this can't happen.
prereq:
files: packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts
difficulty: medium
----

# Serialize SQLite transactions (and plain writes) on the shared NativeScript connection

## What's wrong (confirmed)

`NSPluginDbWrapper.transaction()` (`ns-opener.ts:74-88`) issues `BEGIN`/`COMMIT`/`ROLLBACK`
on a single shared connection with **no mutex**. `StorageRepo` drives concurrent writes on
disjoint blocks (e.g. `commit()`→`internalCommit`→`promotePendingTransaction` for block A runs
concurrently with `pend()`→`savePendingTransaction` or another block's promote — the per-block
commit latch in `storage-repo.ts` serializes only *same-block* work, not disjoint blocks).
SQLite has at most one transaction per connection, so:

- **Transaction nesting / cross-rollback (primary, definite):** two concurrent `transaction()`
  bodies each call `BEGIN`. The second `BEGIN` throws `cannot start a transaction within a
  transaction`; its `catch` runs `ROLLBACK`, which discards the **first** transaction's
  still-open writes. Net: a write the caller believes committed is silently undone by an
  unrelated concurrent operation's failure.
- **Plain-write sweep (secondary, narrower):** any plain statement (`savePendingTransaction`,
  `saveRevision`, `setLatest`, …) executed while a transaction is open on the shared connection
  is folded into that open transaction and lost if it later rolls back.

### Reproduction (deterministic, already committed)

`packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts` reproduces this
against **real `node:sqlite`** via the existing `NodeSqliteWrapper` test driver, whose
`transaction()` is a byte-for-byte mirror of the production `ns-opener` one. It is committed
`describe.skip`ped (keeps the pipeline green). Unskipped at fix time, the first test fails with:

```
promote outcomes: [ 'fulfilled', 'rejected' ] [ 'cannot start a transaction within a transaction' ]
   1) two concurrent promotes on disjoint blocks both survive
```

**First task: remove the `.skip` and make both tests pass.**

## Why the obvious fixes don't work

- A bare "serialize `transaction()`" mutex fixes the primary nesting bug but leaves the
  plain-write sweep: plain statements still run unserialized against an open transaction.
- Serializing *plain writes too* on the same mutex deadlocks the transaction body: the
  transaction holds the mutex, and `promotePendingTransaction`'s inner statements
  (`getPending`/`saveTransaction`/`deletePending`) would re-acquire it. A shared instance flag
  (`inTransaction`) **cannot** distinguish an inner statement (must bypass the lock) from a
  concurrent external write (must block on it): both read the same flag at call time while the
  transaction is open. Reentrancy must be threaded through an **explicit context**, not a flag
  (AsyncLocalStorage is not reliably available in the NativeScript runtime, so don't reach for
  it).

## The fix — mutex + explicit transaction executor

Serialize every mutating operation on the connection through one FIFO promise-chain mutex, and
give the transaction body a dedicated executor whose statements run **directly on the raw
connection** (already inside the held mutex slot), so they never re-enter the lock.

### Shared serialization primitive

Both the production wrapper (`ns-opener.ts`) and the test driver
(`test/node-sqlite-driver.ts`) duplicate the identical `transaction()` logic — so the fix must
land in **both**, or the regression spec can't exercise it. Extract a tiny per-connection FIFO
mutex helper (a promise-chain `serialize<T>(task): Promise<T>`, in the shape of
`packages/db-core/src/utility/latches.ts` but instance-scoped — do **not** use the global
`Latches` keyed map here) into a small module both import. Reference implementation shape:

```ts
class ConnectionMutex {
  private tail: Promise<unknown> = Promise.resolve();
  serialize<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(task, task); // run regardless of prior task outcome
    this.tail = run.then(() => undefined, () => undefined); // never reject the chain
    return run;
  }
}
```

### Interface (`db.ts`)

Add a transaction-scoped executor and thread it into the callback. Keep reads
(`get`/`all`) OUT of the mutex (WAL readers on the same connection stay consistent enough — a
cross-block read during a write is unaffected; same-block writes are already commit-latched).
Serialize `exec` and every statement **write** (`run`).

```ts
/** Statements that execute directly on an OPEN transaction — no re-locking. */
export interface SqliteTransaction {
  prepare(sql: string): SqliteStatement;
}

export interface SqliteDb {
  exec(sql: string): Promise<void>;
  prepare(sql: string): SqliteStatement;                          // outside-txn writes: mutex-guarded
  transaction<T>(fn: (tx: SqliteTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

### Wrapper behavior (both `NSPluginDbWrapper` and `NodeSqliteWrapper`)

- Hold one `ConnectionMutex` per wrapper instance.
- `exec(sql)` and `SqliteStatement.run(...)` → `mutex.serialize(() => raw…)`.
- `SqliteStatement.get/all(...)` → run directly on `raw` (unserialized reads).
- `transaction(fn)` → `mutex.serialize(async () => { raw BEGIN IMMEDIATE; try { const tx = { prepare: sql => <statement bound directly to raw, NO mutex> }; const r = await fn(tx); raw COMMIT; return r } catch { try { raw ROLLBACK } catch {}; throw } })`.
  - Prefer `BEGIN IMMEDIATE` so the write lock is taken up front.
  - The `tx.prepare` statements bypass the mutex (they're already inside the held slot).

### Caller (`sqlite-storage.ts`)

Rewrite `promotePendingTransaction` to use the injected `tx`, so its three statements run on
the open transaction without re-locking:

```ts
async promotePendingTransaction(blockId, actionId): Promise<void> {
  await this.db.transaction(async (tx) => {
    const getPending      = tx.prepare('SELECT value FROM pending WHERE block_id = ? AND action_id = ?');
    const saveTransaction = tx.prepare('INSERT OR REPLACE INTO transactions (block_id, action_id, value) VALUES (?, ?, ?)');
    const deletePending   = tx.prepare('DELETE FROM pending WHERE block_id = ? AND action_id = ?');
    const row = await getPending.get(blockId, actionId);
    if (!row) throw new Error(`Pending action ${actionId} not found for block ${blockId}`);
    await saveTransaction.run(blockId, actionId, row.value as string);
    await deletePending.run(blockId, actionId);
  });
}
```

Driver-level prepared-statement caches (both wrappers already cache by SQL text) make the
re-prepare cheap; the constructor's `this.stmts.getPending/saveTransaction/deletePending` are no
longer used inside the transaction (keep or drop them as the outside-txn paths dictate — note
`getPending` is still used outside a transaction elsewhere, so don't remove that one).

## Result to verify

- The reproduction spec (unskipped) passes: concurrent transactions serialize, none nest; a
  plain write concurrent with a rolling-back transaction is neither swept in nor lost.
- Existing `test/**/*.spec.ts` still green (`yarn test` in `packages/db-p2p-storage-ns`).
- `yarn build` (tsc) clean for the package.

## Tripwire to record in the review handoff

Reads (`get`/`all`) are intentionally left unserialized to preserve read concurrency. A read
issued on the connection while a write transaction is open observes that transaction's
*uncommitted* rows (read-your-connection semantics). This is fine today — the only transaction
writer is same-block promote under the commit latch, and cross-block reads are independent. Add
a `// NOTE:` at the `get`/`all` bypass site: *if a future caller reads a block on this
connection while another op's transaction on the same rows is mid-flight, it may see
uncommitted state; serialize reads too if that ever matters.*

## TODO

- Remove `.skip` from `test/sqlite-transaction-serialization.spec.ts:describe.skip` and confirm both tests fail first (red), then pass after the fix.
- Add a `ConnectionMutex`/`serialize` helper module in `packages/db-p2p-storage-ns/src/` (instance-scoped FIFO promise chain; never rejects the chain tail).
- Add `SqliteTransaction` interface and change `SqliteDb.transaction` signature in `src/db.ts`.
- Update `NSPluginDbWrapper` in `src/ns-opener.ts`: per-instance mutex; serialize `exec` + statement `run`; unserialized `get`/`all`; `transaction()` runs inside the mutex slot with a raw-bound `tx.prepare`; use `BEGIN IMMEDIATE`.
- Mirror the same changes in the test driver `test/node-sqlite-driver.ts` (`NodeSqliteWrapper`).
- Rewrite `SqliteRawStorage.promotePendingTransaction` in `src/sqlite-storage.ts` to use `tx.prepare` (do not remove the outside-transaction `getPending` prepared statement still used by reads).
- Add the `// NOTE:` tripwire comment at the `get`/`all` unserialized-read site in `src/ns-opener.ts`.
- Update the `openOptimysticNSDb` doc comment in `src/ns-opener.ts:20-32` — it currently claims "single-connection contention is a non-issue"; correct it to describe the serialization now in place.
- Run `yarn test` and `yarn build` in `packages/db-p2p-storage-ns`; both must be clean.
