description: FileRawStorage.saveRevision serialization fix — JSON.stringify round-trip corrected
dependencies: @optimystic/db-p2p-storage-fs
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## What was built

One-line fix in `FileRawStorage.saveRevision` (file-storage.ts:32): wrapped `actionId` with `JSON.stringify()` so the write path matches all other `save*` methods and round-trips correctly with `getRevision` → `readIfExists<T>` → `JSON.parse()`.

Previously, the raw base64url `actionId` string was written to disk without JSON quoting, causing `JSON.parse()` to throw `SyntaxError` on read, which cascaded through the 2PC protocol to exclude all coordinators.

## Key files

- `packages/db-p2p-storage-fs/src/file-storage.ts` — the fix (line 32)
- `packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts` — tests switched from `MemoryRawStorage` to `FileRawStorage`, dead code removed, disk persistence assertion added

## Testing

- 5 distributed transaction tests pass (1 pending/skipped — multi-collection index test)
- Tests cover: CREATE TABLE + INSERT round-trip, multi-node replication (sum=600 check), CHECK constraints, StampId non-repeatability, local schema enforcement, and file persistence on disk
- Build passes for `@optimystic/db-p2p-storage-fs`

## Review notes

- All `save*`/`get*` methods in `FileRawStorage` now have symmetric JSON.stringify/JSON.parse serialization
- Pre-existing DTS type error in `schema-manager.ts` (`autoIncrement` on `PrimaryKeyColumnDefinition`) is unrelated to this fix
