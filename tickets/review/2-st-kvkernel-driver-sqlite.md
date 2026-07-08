description: The NativeScript SQLite block store was rewritten to run on the shared storage core, keeping its five tables and its serialized-transaction safety; ready for an adversarial review pass for parity with the other backends.
prereq: st-kvkernel-core
files: packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/index.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p-storage-ns/test/sqlite-transaction-serialization.spec.ts, packages/db-p2p-storage-ns/test/node-sqlite-driver.ts, packages/db-p2p-storage-ns/src/ns-opener.ts, packages/db-p2p-storage-ns/src/identity.ts, packages/db-p2p-storage-ns/README.md, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/testing/raw-storage-conformance.ts
difficulty: medium
----

# Review: SQLite driver reimplemented as `SqliteStoreDriver implements RawStoreDriver`

`SqliteRawStorage` was rewritten from a hand-rolled `IRawStorage` (that did its own
`JSON.stringify/parse`) into a thin `extends KvRawStorage` shell whose constructor does
`super(new SqliteStoreDriver(db))`. The shared kernel now owns all JSON/UTF-8 serialization;
`SqliteStoreDriver` reads/writes raw `Uint8Array` bytes over the same `SqliteDb`/prepared-statement
setup. The five-table schema is unchanged in shape — the only storage-format change is that the
value columns became **BLOB** (they held JSON *strings* before). Public surface
(`new SqliteRawStorage(db)` → `IRawStorage`) is unchanged. Mirrors the fs/web/rn sibling drivers.

## What changed

- **`db.ts` schema** — `value` columns on `metadata`/`pending`/`transactions`/`materialized`, and the
  `action_id` value column on `revisions`, changed `TEXT NOT NULL` → `BLOB NOT NULL`. Keys
  (`block_id`, `rev`, and the `action_id` *key* columns on pending/transactions/materialized) stay
  TEXT/INTEGER. `kv` table untouched (not kernel-backed). Header comment updated.
- **`sqlite-storage.ts`** — `SqliteStoreDriver implements RawStoreDriver`: the same 18 prepared
  statements bound once in the constructor, now binding/returning `Uint8Array` instead of
  `JSON.stringify/parse`ing. `rangeRevisions(lo, hi, reverse)` picks the asc/desc statement and drains
  `.all(...)` before yielding `[rev, actionIdBytes]`. `listPendingActionIds`/`listBlockIds` drain
  `.all(...)` before yielding. `promote` is ported verbatim: `db.transaction(fn)` re-preparing its
  three statements against the OPEN transaction (the load-bearing mutex-slot detail — a re-lock
  deadlocks). Optional `listBlockIds`/`approximateBytesUsed` implemented so the kernel wires them.
  `SqliteRawStorage extends KvRawStorage` with `declare` re-declarations of the two optional passthroughs.
- **`index.ts`** — also exports `SqliteStoreDriver` (symmetric with the exported fs/web/rn drivers).
- **`test/sqlite-storage.spec.ts`** — the hand-rolled per-method spec was replaced by
  `runRawStorageConformance('SQLite', …)` wired to the `node:sqlite` driver, plus a small
  "SQLite driver specifics" block (non-ASCII BLOB round-trip; `getApproximateBytesUsed` ≥ 0).
- **`README.md`** — persistence table now shows BLOB value columns + logical decoded types, and the
  intro describes the kernel/driver split.
- **Not touched:** `ns-opener.ts`, `sqlite-kv-store.ts`, `identity.ts`, `connection-mutex.ts`,
  `sqlite-transaction-serialization.spec.ts` (still asserts against `SqliteRawStorage` — surface
  preserved, so no repoint needed).

## What to test / validate (reviewer)

- **Cross-backend parity (authoritative).** `yarn workspace @optimystic/db-p2p-storage-ns test:verbose`
  — the `SQLite` conformance block must run **not skipped** and pass: round-trips, `listRevisions`
  asc/desc + sparse gaps + single-bound + block-scoping + empty range, promote atomicity + exact
  missing-pend error string, clone-on-store/read via the byte boundary, drain-before-yield for both
  scans, `BlockStorage` pend→commit `[[E]]` + saveReplica→saveDeletion tombstone.
- **BLOB round-trip, not TEXT.** The "round-trips non-ASCII metadata through the BLOB value column"
  spec is the guard that a TEXT column (which would UTF-8-coerce multi-byte bytes) was not left in
  place. Worth confirming the schema really emits `BLOB` and that a stored value reads back as
  `Uint8Array` (node:sqlite returns BLOB as `Uint8Array`).
- **Serialized-transaction safety.** `sqlite-transaction-serialization.spec.ts` must still pass: two
  concurrent promotes on disjoint blocks both survive, and a plain write concurrent with a
  rolling-back transaction is neither lost nor swept into the rollback. This guards the mutex +
  transaction-scoped re-prepare.
- **Migration awareness.** This is the ONE backend of the four with a real on-disk format change:
  old rows stored JSON *strings* in TEXT columns; new rows store the kernel's byte BLOBs. An existing
  on-device `optimystic.sqlite` from a prior release would have TEXT rows that the new kernel reads
  back and `TextDecoder.decode`s — SQLite BLOB affinity does not coerce an existing TEXT value, so a
  read returns a string, not `Uint8Array`, and `decoder.decode(string)` would throw/garble. **There
  is no migration.** Assess whether that matters (see gaps).

## Honest gaps carried forward (not defects — reviewer should weigh)

- **Never run against real NativeScript SQLite.** All validation uses `node:sqlite` under Mocha.
  Production is `@nativescript-community/sqlite`, whose `execute(sql, params)` binding of a
  `Uint8Array` as BLOB and whose BLOB-column *return* shape are not exercised here. This is the same
  seam the peer-key path already ships on: `identity.ts:32` already binds a `Uint8Array` into a BLOB
  column and `identity.ts:25` already reads a BLOB back as `instanceof Uint8Array`. So the driver's
  "BLOB in, `Uint8Array` out" assumption matches an already-production-proven contract — but an
  on-device run is the true check and is out of band for an agent (same gap the fs/web/rn reviews
  flag for their native paths).
- **No migration for a pre-existing on-device db.** The four-table value-format change (TEXT JSON
  string → BLOB bytes) is not migrated. Since this backend is NativeScript-only and (per repo state)
  has no shipped production data yet, a wipe-and-recreate is likely acceptable — but that is a
  product call, not an implementation detail. If pre-refactor devices exist, this needs a decision
  (migration script, or a version bump that drops+recreates the tables). Flagged for the reviewer to
  either accept ("no field data yet") or spin into a follow-up ticket; NOT ticketed here because the
  answer depends on deployment facts the implementer does not have.

## Tripwires (conditional; recorded, not ticketed)

- **`listBlockIds` drains the whole `metadata` table; `approximateBytesUsed` reads two PRAGMAs.**
  Both behavior-identical to the pre-refactor code, not defects. `NOTE:` comments are already at the
  `listBlockIds` statement and the kernel's write-path counter seam (`kv-raw-storage.ts` `saveMetadata`)
  is where an incremental byte counter would replace the PRAGMA scan if it ever matters. No ticket.

## Validation performed (this session, win32, Node v24)

- `yarn workspace @optimystic/db-core build` + `@optimystic/db-p2p build` (dependencies) — clean.
- `yarn workspace @optimystic/db-p2p-storage-ns build` (tsc typecheck) — clean.
- `yarn workspace @optimystic/db-p2p-storage-ns test` — **49 passing, 0 failing**;
  `test:verbose` confirms the `SQLite` conformance block, the "SQLite driver specifics" block, and the
  transaction-serialization spec all ran and passed (not skipped).
- `npx eslint` over the four changed src/test files — clean.

## End
