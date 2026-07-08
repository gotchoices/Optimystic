description: Rewrite the NativeScript SQLite block store to plug into the new shared storage core, keeping its existing tables and its serialized-transaction safety.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts
difficulty: medium
----

# SQLite driver: reimplement `SqliteRawStorage` as a `RawStoreDriver`

Depends on `st-kvkernel-core`. **Keep the existing five-table schema** (`metadata`, `revisions`,
`pending`, `transactions`, `materialized`) — this is a code refactor, **not** a storage-format
change. The kernel takes over JSON serialization, so column values that were JSON strings become
`Uint8Array` blobs the kernel produces/consumes; the SQL shape is otherwise unchanged.

## Design

Replace `SqliteRawStorage implements IRawStorage` with `SqliteStoreDriver implements
RawStoreDriver` over the same `SqliteDb`/prepared-statement setup (`db.ts`). Values move from
`TEXT`/JSON-string columns to blob columns holding the kernel's `Uint8Array` (SQLite stores
`Uint8Array` as a BLOB; the `value` columns become BLOB — adjust the `CREATE TABLE`/bindings
accordingly). The driver no longer calls `JSON.stringify/parse` on values.

Method mapping (prepared statements largely unchanged, minus the JSON step):

- `getMetadata`/`putMetadata` → `SELECT/INSERT OR REPLACE ... metadata` (value BLOB).
- `getRevision`/`putRevision` → `revisions` (value BLOB = encoded ActionId bytes).
- `rangeRevisions(blockId, lo, hi, reverse)` → the existing `listRevisionsAsc`/`listRevisionsDesc`
  (`... WHERE block_id = ? AND rev BETWEEN ? AND ? ORDER BY rev ASC|DESC`), `.all(...)` drained,
  yielding `[row.rev, row.value]`.
- pending / transactions / materialized get/put/delete → existing statements (value BLOB;
  materialized keeps its separate delete statement — the put-or-delete branch is in the kernel).
- `listPendingActionIds` → existing `listPending` (`ORDER BY action_id ASC`).
- `promote(blockId, actionId)` → the existing `db.transaction(async tx => …)` that re-prepares
  `getPending`/`saveTransaction`/`deletePending` **against the open transaction**, throws
  `Pending action … not found …` when absent, else `INSERT` the transaction row + `DELETE` the
  pending row. **Keep the transaction-scoped re-prepare** — it is what makes the move atomic and
  runs on the held mutex slot without re-locking (a re-lock would deadlock; see
  `st-nativescript-sqlite-transaction-mutex`, in `complete/`).
- `listBlockIds` → existing `SELECT block_id FROM metadata`.
- `approximateBytesUsed` → existing `PRAGMA page_count * page_size`.

Keep the user-facing constructor returning an `IRawStorage`, built as
`new KvRawStorage(new SqliteStoreDriver(db))`.

## Edge cases & interactions

- **Serialized-transaction mutex is load-bearing.** `SqliteDb.transaction(fn)` serializes access;
  `promote` MUST go through it, and MUST prepare its three statements against the transaction
  handle (not the connection-level cached statements) or it deadlocks. The existing
  `test/sqlite-transaction-serialization.spec.ts` guards this — keep it passing and, if it asserts
  against `SqliteRawStorage` directly, repoint it at the new driver/`KvRawStorage`.
- **BLOB round-trip.** The kernel writes `Uint8Array`; ensure the driver binds it as a BLOB and
  reads it back as `Uint8Array` (not a UTF-8 `TEXT` coercion that would corrupt non-ASCII JSON
  bytes). The conformance suite's clone/round-trip cases will catch a TEXT/BLOB mismatch.
- **Drain-before-yield.** `.all(...)` already materializes rows before yielding — preserve that
  (do not switch to a streaming cursor held across awaits, which would straddle the transaction).
- **node:sqlite test driver.** Tests run against `node:sqlite` (`test/node-sqlite-driver.ts`);
  production is NativeScript SQLite. Both satisfy `SqliteDb`, so the driver is oblivious — keep
  that seam.

## TODO

- Change `value` columns to BLOB in the schema (`db.ts` / wherever tables are created); rewrite
  `sqlite-storage.ts` as `SqliteStoreDriver implements RawStoreDriver`; export an `IRawStorage`
  factory (`new KvRawStorage(new SqliteStoreDriver(db))`) under the current public name.
- Add a conformance run: `runRawStorageConformance('SQLite', …)` wired to the `node:sqlite`
  driver; keep the transaction-serialization spec (repointed if needed).
- `yarn test:db-p2p-storage-ns 2>&1 | tee /tmp/kv-ns.log`; typecheck the package.
