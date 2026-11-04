description: After the move to version 4 of the phone SQLite plugin, the storage still sends each row of a write group to the database thread as its own call and waits for the answer; sending the whole group in one call would shorten every commit.
prereq: feat-nativescript-storage-moves-to-sqlite-4
architecture: packages/db-p2p-storage-ns/README.md
files: packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/ns-opener.ts
tradeoffs: Each awaited statement already yields the JavaScript thread on version 4, so this shortens commits rather than unblocking anything, the size of the gain on real write groups is unmeasured, and it changes a write path nobody can test here without a device.
----

# A write group commits in one native call

`SqliteBatchBackend.applyEntries` in `packages/db-p2p-storage-ns/src/sqlite-storage.ts` awaits one `run` per entry, each a round trip from JavaScript to the database's native thread and back through the event loop. Version 4 of `@nativescript-community/sqlite` has `batch()`, which takes many statements in one native call. The plugin's README reports 5,000 inserts in a transaction at 313 ms awaited one by one and 56 ms by `batch()` on an Android 14 phone. Those are its numbers, not ours, and nobody has measured a typical write group of this storage, which is far smaller.

The expected behaviour: one write group still lands as one transaction, whole or not at all, with the same ordering against the sync bookkeeping (`SyncDeadlines.defer` and `take` run inside the transaction body, under the connection mutex), and the same latch on failure.

Two things a design has to answer:

- **`batch()` is atomic by default, and that does not compose with the wrapper's transaction.** The wrapper sends `BEGIN IMMEDIATE` as a plain `execute`, so the plugin does not know a transaction is open. An atomic batch outside the plugin's own `transaction` issues its own `BEGIN IMMEDIATE` (the `atomic` arm of the batch request in the plugin's `core/db.c`), which SQLite refuses inside an open transaction. So a batch inside `SqliteDb.transaction` has to pass `{ atomic: false }`, and the first failing statement has to fail the body so that `runTransaction` rolls back. What a non-atomic batch does after a failing statement needs confirming from that source.
- **`SqliteTransaction` would need a batch method**, and the `node:sqlite` stand-in in the test driver has to implement it with the same semantics.

It needs a device check before release: the reporter's run for the move to 4.x did not exercise `batch()`.
