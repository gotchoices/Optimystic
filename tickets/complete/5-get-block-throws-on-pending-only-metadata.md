description: BlockStorage.getBlock() no longer throws on pending-only metadata. Reader contract aligned with StorageRepo.get()'s undefined=>empty-state expectation.
dependencies: none
files:
  - packages/db-p2p/src/storage/block-storage.ts (getBlock, lines 23-39)
  - packages/db-p2p/src/storage/i-block-storage.ts (doc comment on getBlock, lines 8-15)
  - packages/db-p2p/src/storage/storage-repo.ts (get(), context.actionId branch reordered, lines 53-75)
  - packages/db-p2p/test/storage-repo.spec.ts (regression test, lines 258-272)
----

## What was built

Fixed a regression where a fresh solo-node DDL path would throw when `StorageRepo.get()` was called on a block that had metadata seeded by `savePendingTransaction` but no committed revision. `savePendingTransaction` writes a metadata record with `latest: undefined` before the pending transaction is stored; `getBlock()` previously treated any metadata presence as a commitment to return a materialized block.

### Contract change

`BlockStorage.getBlock(rev?)`:
- **Before**: threw when metadata existed but `latest` was undefined, regardless of whether `rev` was supplied.
- **After**: when `rev` is unspecified and `meta.latest` is undefined, returns `undefined`. Still throws when a specific `rev` is requested that cannot be located (so `materializeBlock`'s callers like `internalCommit` continue to surface real errors).

Doc comment on `IBlockStorage.getBlock` updated to document this.

### StorageRepo.get() reorder

The `context?.actionId` branch now runs before the `!blockRev` empty-state return and uses `blockRev?.block`. This lets a pending-only insert be served to a caller proving commitment via `context.actionId`, by applying the pending transform to an undefined prior block (valid per `db-core/src/transform/helpers.ts:127-137`).

## Key files

- `packages/db-p2p/src/storage/block-storage.ts:23-39` — the guard that returns `undefined` for pending-only metadata when no explicit rev is requested.
- `packages/db-p2p/src/storage/i-block-storage.ts:8-15` — updated contract doc.
- `packages/db-p2p/src/storage/storage-repo.ts:53-75` — reordered branches in `get()`.
- `packages/db-p2p/test/storage-repo.spec.ts:258-272` — regression test `'returns empty state when block has only pending transaction (no committed revision)'`.

## Testing notes

- **Regression test** in `describe('get')`: pends an insert (which seeds metadata via `savePendingTransaction` but never commits), calls `repo.get({ blockIds: [...] })` with no context, asserts `{ state: {} }` and no throw.
- `npm test` (db-p2p): **391 passing**, no failures, no regressions (including TEST-5.4.3 context-driven promotion tests that cover the reordered `storage-repo.ts` branch).
- `npm run build` (db-p2p): clean.

## Usage

The fix is transparent. Callers of `StorageRepo.get()` on a fresh node or on a block with only pending inserts now receive `{ state: {} }` for the affected block ID instead of an exception. No API changes; no call sites needed updates.

## Out of scope / noted

- `packages/db-p2p/README.md:258` shows a stale type signature for `BlockStorage.getBlock` that omits `| undefined`. Pre-existing documentation drift, not introduced by this ticket; left for a future docs pass.
- Optional second regression test (context.actionId against a pending-only block) was deferred per the source ticket — the `storage-repo.ts` reorder handles it defensively if a future code path sets it up, but the current ActionContext shape requires `rev`, so the path isn't reachable via `repo.get` alone.
