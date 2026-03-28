----
description: Fix FileRawStorage.saveRevision serialization mismatch causing coordinator failures
dependencies: @optimystic/db-p2p-storage-fs
files: packages/db-p2p-storage-fs/src/file-storage.ts, packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## Root Cause

`FileRawStorage.saveRevision` writes the raw `actionId` string to disk without `JSON.stringify()`, but `getRevision` (via `readIfExists<T>`) uses `JSON.parse()` to deserialize it. Since `actionId` is a base64url-encoded 256-bit value (e.g. `Xs4kl9j2mP-vWqL3n...`), it is not valid JSON, and `JSON.parse()` throws a `SyntaxError`.

Every other `save*` method in `FileRawStorage` correctly wraps its content in `JSON.stringify()` — only `saveRevision` is missing it.

### Failure chain

1. `CREATE TABLE ... USING optimystic(...)` stores the table schema via a pend/commit cycle, calling `saveRevision(rev, actionId)` which writes the raw actionId
2. A subsequent `INSERT` triggers cluster validation: `storageRepo.get()` → `BlockStorage.getBlock()` → `materializeBlock()` → `listRevisions()` → `getRevision()`
3. `getRevision()` → `readIfExists<ActionId>()` → `JSON.parse(rawBase64url)` → **SyntaxError**
4. Error propagates through each cluster member's `update()`, failing the promise phase on all peers
5. ClusterCoordinator cannot collect super-majority promises → 2PC fails → coordinator excluded
6. All coordinators fail for the same reason → `"No coordinator available for key (all candidates excluded)"`

### Key files for reference

- Bug location: `packages/db-p2p-storage-fs/src/file-storage.ts:30` (`saveRevision` method)
- Deserialization: `packages/db-p2p-storage-fs/src/file-storage.ts:145` (`readIfExists` method)
- Correct examples: `saveMetadata` (line 22), `savePendingTransaction` (line 40), `saveTransaction` (line 80) — all use `JSON.stringify()`
- MemoryRawStorage reference: `packages/db-p2p/src/storage/memory-storage.ts` (stores raw values in Maps, no serialization needed)
- IRawStorage interface: `packages/db-p2p/src/storage/i-raw-storage.ts`

## TODO

### Phase 1: Fix serialization bug

- In `packages/db-p2p-storage-fs/src/file-storage.ts`, change `saveRevision` to wrap `actionId` with `JSON.stringify()`:
  ```ts
  async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
      await this.ensureAndWriteFile(
          this.getRevisionPath(blockId, rev),
          JSON.stringify(actionId)  // was: actionId (raw string)
      );
  }
  ```

### Phase 2: Update test to use FileRawStorage

- In `packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts`, update the `createNode` function:
  - Import `FileRawStorage` from `@optimystic/db-p2p-storage-fs`
  - Change the `storage` option in `createLibp2pNode` from `() => new MemoryRawStorage()` to `new FileRawStorage(storagePath)`
  - Remove the unused local `rawStorage` / `storageRepo` (lines 575-577) — the coordinator uses its own internal storage
  - Remove the stale comment about MemoryRawStorage debugging (line 574)
- In the "should verify file storage persistence across operations" test, add a file-existence assertion to verify that FileRawStorage actually persists data to disk (e.g., check that `storagePath` contains block directories after INSERT)

### Phase 3: Build and test

- Build the `db-p2p-storage-fs` package
- Run the `distributed-transaction-validation.spec.ts` tests to verify the fix
