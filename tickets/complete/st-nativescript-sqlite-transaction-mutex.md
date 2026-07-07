description: The mobile (NativeScript) SQLite backend now serializes all writes on its shared database connection, so two simultaneous writes can no longer tangle their transactions and silently undo each other's committed data.
prereq:
files: packages/db-p2p-storage-ns/src/connection-mutex.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/test/connection-mutex.spec.ts, packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts, packages/db-p2p-storage-ns/README.md
difficulty: medium
----

# Complete: Serialize SQLite transactions (and plain writes) on the shared NativeScript connection

## What shipped

`NSPluginDbWrapper` shared one SQLite connection across all storage classes with no mutex.
SQLite permits at most one open transaction per connection, so two concurrent `transaction()`
bodies each ran `BEGIN`; the second threw `cannot start a transaction within a transaction`, and
its `catch` ran `ROLLBACK` — discarding the *first* transaction's still-open writes. A secondary
defect folded any plain write issued while a transaction was open into that transaction, losing it
on rollback. The concurrency is real because `StorageRepo`'s commit latch serializes only
same-block work; disjoint-block operations run concurrently against the one shared connection.

The fix adds a per-connection FIFO mutex (`ConnectionMutex`) and threads writes through it:
`exec`, outside-transaction statement `run`, and whole `transaction` bodies serialize; reads
(`get`/`all`) stay off the mutex to preserve read concurrency. `transaction(fn)` now hands `fn` a
`SqliteTransaction` whose `tx.prepare` statements run inside the held slot and **bypass** the mutex
(re-locking would deadlock) — the explicit context is the reentrancy seam a shared `inTransaction`
flag could not provide. Production `ns-opener.ts` and the test mirror `node-sqlite-driver.ts` are
kept behaviorally identical so the regression spec exercises the production shape.
`promotePendingTransaction` was rewritten onto `tx.prepare`. README's persistence section documents
the serialization.

## Review findings

**Diff reviewed** — read all seven touched source/test files plus README and the sole
`db.transaction(...)` caller before reading the handoff. Build (`yarn build`, tsc clean),
tests (`yarn test`, **31 passing / 0 failing**), and lint (`eslint` on `src` + `test`, exit 0) all
green after review, including the one edit made in this pass.

**Checked and clear:**
- **Correctness of the primitive.** `ConnectionMutex` is a standard non-poisoning FIFO
  promise-chain: the tail is advanced with a settled-either-way promise so a rejected task cannot
  reject or stall the tasks behind it, while each task's own outcome still reaches its own caller.
  Unit tests pin all four properties directly.
- **Deadlock surface.** Inside a `transaction` body, writes go only through `tx.prepare` (mutex
  bypass) and there is no nested `db.transaction`. The only caller (`promotePendingTransaction`)
  obeys both rules. Reads never lock, so reads inside or outside a transaction cannot deadlock.
- **Wrapper parity.** Production (`ns-opener.ts`) and test (`node-sqlite-driver.ts`) match in
  serialization behavior — same mutex placement on `exec`/`run`/`transaction`, same unserialized
  `get`/`all`, same `BEGIN IMMEDIATE … COMMIT/ROLLBACK` body. The spec therefore tests the
  production shape.
- **Statement-cache aliasing (test driver).** `tx.prepare(sql)` and a class-level `db.prepare(sql)`
  with identical SQL text share one cached `StatementSync`. Safe: `node:sqlite`'s `run`/`get`/`all`
  each execute synchronously and hold no cursor across an `await`, so interleaved reuse of one
  statement object cannot corrupt state.
- **Docs.** README persistence section and the `db.ts`/`ns-opener.ts` doc comments accurately
  describe the mutex, the read-concurrency carve-out, and the `tx`-only-writes invariant.

**Tripwires (recorded in code, not filed as tickets):**
- *Uncommitted reads.* Reads run unserialized, so a read on this connection while a write
  transaction is open observes that transaction's uncommitted rows. Fine today (only same-block
  promote writes in a transaction, under the commit latch). Parked as a `// NOTE:` at the
  `get`/`all` bypass site in `ns-opener.ts` — pre-existing, left in place.
- *Double-wrap footgun (added this pass).* The mutex lives on the wrapper, not the raw handle, so
  wrapping one raw connection twice yields two independent mutexes that don't serialize against
  each other — reintroducing the bug. Added a `// NOTE:` to `wrapNSPluginDb`'s doc comment;
  `openOptimysticNSDb` already wraps each fresh handle exactly once, so no live caller trips it.
- *Reentrancy guard.* No runtime assertion blocks a future caller from writing via a class-level
  statement (or nesting `db.transaction`) inside a transaction body — either would deadlock. Judged
  sufficient to document (already noted in `db.ts:transaction`): single caller, no dynamic
  transaction nesting in the package.

**Filed as follow-up (backlog):**
- `debt-ns-sqlite-concurrency-stress-test` — coverage is two targeted races plus mutex unit tests;
  a randomized mixed-operation stress test would exercise interleavings the canned tests don't.
  Hardening, not a defect.

**Known coverage gaps (unchanged from handoff, honest floor):**
- No test drives the real `@nativescript-community/sqlite` plugin — it's an uninstalled peer
  dependency in the Node test env; serialization is verified via the `node:sqlite` mirror only.
  The production wrapper's mutex logic is identical, but plugin-specific transaction semantics are
  unverified here. Not resolvable inside the Node test harness.
- `BEGIN IMMEDIATE`'s file-lock front-loading is untested (in-memory test DB makes it equivalent to
  plain `BEGIN`); no multi-connection file-lock test exists for the same reason.

## Changes made in this review pass
- Added a `// NOTE:` tripwire to `wrapNSPluginDb` (`ns-opener.ts`) documenting the one-wrapper-per-
  raw-handle invariant.
- Filed `tickets/backlog/debt-ns-sqlite-concurrency-stress-test.md`.

No behavioral code changed; the fix was accepted as implemented.
