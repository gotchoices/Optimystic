description: Review fix for BlockStorage.getBlock() throwing on pending-only metadata. The reader contract now matches what StorageRepo.get() expects (undefined => empty state).
dependencies: none
files:
  - packages/db-p2p/src/storage/block-storage.ts (getBlock at lines 23-39)
  - packages/db-p2p/src/storage/i-block-storage.ts (doc comment on getBlock)
  - packages/db-p2p/src/storage/storage-repo.ts (get(), context.actionId branch reordered to handle undefined blockRev)
  - packages/db-p2p/test/storage-repo.spec.ts (regression test in `describe('get')`)
----

## What was changed

1. `BlockStorage.getBlock(rev?)` — when `rev` is unspecified AND `meta.latest` is undefined (pending-only state seeded by `savePendingTransaction`), returns `undefined` instead of throwing. The throw path is preserved for the case where a caller asks for a specific `rev` that cannot be located (still occurs naturally in `materializeBlock`).

2. `IBlockStorage.getBlock` doc comment updated to specify the new contract: returns `undefined` when no metadata exists OR metadata exists but no revision has been committed; throws only when a specific `rev` is requested but not located.

3. `StorageRepo.get()` — the `context?.actionId` branch was reordered so it runs BEFORE the `!blockRev` empty-state return. Uses `blockRev?.block` so a pending-only insert can be served by applying the pending transform to `undefined` (valid for inserts). Defensive — covers the case where a caller wants the see-through view of a pending action against a not-yet-committed block.

## Test coverage

Added one regression test in `packages/db-p2p/test/storage-repo.spec.ts` under `describe('get')`:

- **"returns empty state when block has only pending transaction (no committed revision)"** — pends an insert without committing (which seeds metadata via `savePendingTransaction` but never commits a revision), then calls `repo.get({ blockIds: [...] })` with no context. Asserts the result is `{ state: {} }` and the call does NOT throw.

The optional second test (context.actionId on a pending-only block) was deferred. To make it work without changing the throw-on-specific-rev contract would require either bypassing `getBlock` when `context.actionId` is present, or making `ActionContext.rev` optional. Neither change is in scope for this ticket — the storage-repo.ts reorder already handles a `blockRev=undefined` case defensively if a future caller sets up that scenario via a different code path.

## Validation

- `npm test` in `packages/db-p2p`: **391 passing** (no failures, no regressions).
- `npm run build` in `packages/db-p2p`: clean.
- Manual trace: fresh solo node → first DDL → `savePendingTransaction` seeds metadata → `getBlock(undefined)` now returns `undefined` → `StorageRepo.get()` returns `{ state: {} }` → no exception bubbled to coordinator path.

## Use cases for review

- Confirm the new `getBlock` contract is consistent with all callers (greppable: `getBlock(`).
- Verify the storage-repo `context?.actionId` reorder doesn't change observable behavior for the existing context-driven promotion tests (TEST-5.4.3 in the same spec file — all passing).
- Confirm `applyTransform(undefined, pendingTransform)` is safe for inserts (verified: `db-core/src/transform/helpers.ts:127-137` handles `block: undefined` and assigns from `transform.insert`).

## Out of scope

- No changes to `savePendingTransaction`'s metadata-seeding behavior.
- No richer "pending-only" signal propagated to callers — current empty-state semantics suffice.
- The optional context.actionId regression test (see above) — not a blocker per the source ticket.
