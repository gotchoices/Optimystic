description: The mobile (NativeScript) SQLite storage backend shares a single database connection with no locking, so two simultaneous writes can tangle their transactions — one write's rollback can silently undo another write's committed data.
prereq:
files: packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/sqlite-storage.ts
difficulty: medium
----

# NativeScript SQLite transactions can nest and cross-rollback — no mutex on the shared connection

The NativeScript SQLite adapter's `transaction()` issues `BEGIN` / `COMMIT` on a single shared
connection with no mutex (`ns-opener.ts:74-88`), while `StorageRepo` allows concurrent commits
on disjoint blocks. Because SQLite does not support real nested transactions on one connection,
concurrent callers corrupt each other:

- Two concurrent promotions nest `BEGIN`s. The second `BEGIN` errors; its `catch` runs
  `ROLLBACK` — which rolls back the **first** transaction's still-uncommitted writes, not its
  own.
- Any concurrent plain statement issued while a transaction is open gets swept into that open
  transaction and is discarded when the transaction rolls back.

The net effect is silent data loss: writes that the caller believes committed are undone by an
unrelated concurrent operation's failure.

Expected behavior: transactions on the shared connection are serialized so at most one is open
at a time, and no statement executes interleaved with another caller's open transaction. A
failing transaction rolls back only its own writes. After the fix, driving two concurrent
`transaction()` calls (and concurrent plain writes) leaves all successfully-committed writes
durable and rolls back only the transaction that actually failed.

## Reproduction notes

- Run two concurrent `transaction()` bodies that each write distinct keys and let one fail;
  assert the other's writes survive and no unrelated plain write is lost.
- This adapter has limited/no standalone test harness on a dev box (NativeScript runtime) — a
  minimal fake honoring the single-connection BEGIN/COMMIT/ROLLBACK semantics may be needed to
  demonstrate the nesting cross-rollback deterministically.

Suggested-fix hint: serialize `transaction()` (ideally all writes) behind an async mutex, or
use `BEGIN IMMEDIATE` with a queued executor so transactions never nest on the shared
connection.
