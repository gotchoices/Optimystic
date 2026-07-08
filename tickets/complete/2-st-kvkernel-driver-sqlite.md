description: The NativeScript SQLite block store now runs on the shared storage kernel, storing raw bytes in BLOB columns; reviewed and accepted with a migration tripwire recorded in code.
files: packages/db-p2p-storage-ns/src/sqlite-storage.ts, packages/db-p2p-storage-ns/src/db.ts, packages/db-p2p-storage-ns/src/index.ts, packages/db-p2p-storage-ns/test/sqlite-storage.spec.ts, packages/db-p2p-storage-ns/README.md, packages/db-p2p/src/storage/raw-store-driver.ts, packages/db-p2p/src/storage/kv-raw-storage.ts
----

# Complete: SQLite driver reimplemented as `SqliteStoreDriver implements RawStoreDriver`

`SqliteRawStorage` was rewritten from a hand-rolled `IRawStorage` (own `JSON.stringify/parse`)
into a thin `extends KvRawStorage` shell whose constructor does `super(new SqliteStoreDriver(db))`.
The shared kernel owns all JSON/UTF-8 serialization; `SqliteStoreDriver` reads/writes raw
`Uint8Array` bytes over the same five-table schema. The only storage-format change: value columns
became **BLOB** (they held JSON strings before). Public surface (`new SqliteRawStorage(db)` →
`IRawStorage`) unchanged. Mirrors the fs/web/rn/leveldb sibling drivers.

## Review findings

Adversarial pass over the implement diff (`02464a1`), read before the handoff. Checked against the
`RawStoreDriver` contract, the `KvRawStorage` kernel, the `node:sqlite` test driver, and the sibling
reviews.

**Correctness / parity — clean.** All 12 driver methods map 1:1 to the `RawStoreDriver` interface
(`raw-store-driver.ts`); byte in / byte out with no codec in the driver, matching the kernel's
"drivers speak only `Uint8Array`" contract. `promote` re-prepares its three statements against the
OPEN transaction (`tx.prepare`) so they run on the held mutex slot without re-locking — the
load-bearing detail; verified against `db.ts`'s `SqliteTransaction` seam. `rangeRevisions` /
`listPendingActionIds` / `listBlockIds` all drain via `.all(...)` before yielding (drain-before-yield
contract). `saveMaterializedBlock`'s put-or-delete branch now lives in the kernel; driver exposes
`putMaterialized`/`deleteMaterialized` separately — correct. Optional passthroughs
(`listBlockIds`/`approximateBytesUsed`) implemented; `SqliteRawStorage` `declare`-re-declares the two
kernel passthroughs as always-present, which is sound because the driver always provides them.

**Type safety — clean.** `SqliteParam` already includes `Uint8Array`; `row.value as Uint8Array` casts
are safe (node:sqlite returns BLOB as `Uint8Array`; the NS plugin's BLOB round-trip is already
production-proven by `identity.ts`).

**Tests — adequate, expanded.** The hand-rolled per-method spec was replaced by
`runRawStorageConformance('SQLite', …)` (the shared parity suite: round-trips, listRevisions
asc/desc + sparse + single-bound + block-scoping + empty, promote atomicity + exact missing-pend
error, clone-on-store/read via the byte boundary, drain-before-yield, `BlockStorage` pend→commit
`[[E]]` + tombstone) plus a "SQLite driver specifics" block (non-ASCII BLOB round-trip;
`getApproximateBytesUsed` ≥ 0). Verbose run confirms the `SQLite` conformance block, the specifics
block, `listBlockIds` cases (NOT skipped), and `sqlite-transaction-serialization.spec.ts` all ran and
passed. **49 passing, 0 failing.** No gaps found worth a new test.

**Docs — verified current.** README persistence table and intro reflect the BLOB columns + kernel/
driver split; `db.ts` header and `sqlite-storage.ts` class docs are accurate. `ns-opener.ts` mentions
`SqliteRawStorage` only in a comment (surface preserved). No stale `implements IRawStorage` claims
remain.

**Nuance (not a defect):** the "round-trips non-ASCII metadata through the BLOB value column" spec
is a weaker guard than the handoff implies — SQLite keeps a bound `Uint8Array` as a BLOB even in a
TEXT-affinity column, so that test proves byte fidelity but does not by itself prove the column is
BLOB. The real "BLOB not TEXT" guarantee is the schema in `db.ts` (verified: `value BLOB NOT NULL`).
Left as-is; no behavior impact.

**Major / new tickets:** none.

**Fixed inline (minor):** added a `NOTE:` tripwire comment at the `SCHEMA_SQL` site in `db.ts`
documenting the migration gap (below).

## Tripwires recorded (not ticketed)

- **No migration for a pre-existing on-device db** (`db.ts` `SCHEMA_SQL`). Every table is
  `CREATE TABLE IF NOT EXISTS`, so a database file from a pre-refactor build keeps its old TEXT-column
  schema and its JSON-*string* rows — which the new kernel reads back and `TextDecoder.decode`s,
  garbling/throwing. SQLite BLOB affinity does not coerce an existing TEXT value. Genuinely
  conditional: this backend is NativeScript-only with no shipped production data per repo state, so
  wipe-and-recreate is acceptable today. Recorded as a `NOTE:` comment at the schema site (prescribes
  a `user_version` bump that drops+recreates the five tables if a build ever ships to devices that
  later upgrade) — NOT a ticket, because it only becomes work if field devices exist, a deployment
  fact that does not hold now.
- **`listBlockIds` drains the whole `metadata` table; `approximateBytesUsed` reads two PRAGMAs.**
  Behavior-identical to pre-refactor code, not defects. Existing `NOTE:` comments already sit at the
  `listBlockIds` statement (`db.ts`) and the kernel write-path counter seam (`kv-raw-storage.ts`
  `saveMetadata`), where an incremental byte counter would replace the PRAGMA scan if it ever matters.

## Known gaps carried forward (accepted)

- **Never run against real NativeScript SQLite.** All validation uses `node:sqlite` under Mocha;
  production is `@nativescript-community/sqlite`. The driver's "BLOB in, `Uint8Array` out" assumption
  matches the already-production-proven `identity.ts` peer-key path, but an on-device run is the true
  check and is out of band for an agent — same gap the fs/web/rn/leveldb reviews flag for their native
  paths. Accepted.

## Validation performed (this session, win32, Node v24)

- `yarn workspace @optimystic/db-core build` + `@optimystic/db-p2p build` — clean.
- `yarn workspace @optimystic/db-p2p-storage-ns build` (tsc, before and after the `db.ts` NOTE edit) — clean.
- `yarn workspace @optimystic/db-p2p-storage-ns test` — **49 passing, 0 failing**; `test:verbose`
  confirms the `SQLite` conformance block, "SQLite driver specifics", `listBlockIds` cases, and the
  transaction-serialization spec all ran (not skipped) and passed.
- `npx eslint src/sqlite-storage.ts src/db.ts src/index.ts test/sqlite-storage.spec.ts` — clean (exit 0).

## End
