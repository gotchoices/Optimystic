----
description: Review fix for FileRawStorage.saveRevision serialization mismatch causing coordinator failures
dependencies: @optimystic/db-p2p-storage-fs
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## Summary

`FileRawStorage.saveRevision` was writing the raw `actionId` string to disk without `JSON.stringify()`, but `getRevision` (via `readIfExists<T>`) uses `JSON.parse()` to deserialize. Since `actionId` is a base64url-encoded value (not valid JSON), `JSON.parse()` threw `SyntaxError`, cascading through the 2PC protocol to exclude all coordinators.

## Changes Made

1. **`packages/db-p2p-storage-fs/src/file-storage.ts:32`** — Wrapped `actionId` with `JSON.stringify()` in `saveRevision`, matching all other `save*` methods.

2. **`packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts`** — Switched distributed tests from `MemoryRawStorage` to `FileRawStorage`:
   - Imported `FileRawStorage` from `@optimystic/db-p2p-storage-fs`
   - Changed `storage` option in `createLibp2pNode` from `() => new MemoryRawStorage()` to `new FileRawStorage(storagePath)`
   - Removed unused `rawStorage`/`storageRepo` locals and stale debug comment
   - Removed unused `StorageRepo`/`BlockStorage`/`MemoryRawStorage` imports
   - Removed `storageRepo` from `TestNode` interface
   - Added file-existence assertion in "should verify file storage persistence across operations" test

## Testing / Validation

- All 5 distributed transaction tests pass (1 pending/skipped as before)
- The persistence test now verifies block directories exist on disk after INSERT
- Build passes cleanly for `@optimystic/db-p2p-storage-fs`

## Key Use Cases for Review

- **CREATE TABLE + INSERT**: The primary failure path — schema creation writes a revision via `saveRevision`, then INSERT reads it back via `getRevision`. Verify the round-trip works with `FileRawStorage`.
- **Multi-node replication**: All 3 nodes should see consistent data after INSERT (tested by sum check = 600).
- **File persistence**: Storage path should contain block directories on disk (asserted in test).
