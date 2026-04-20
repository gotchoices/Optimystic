description: Fix getBlock() to return undefined (not throw) when metadata exists with no committed revision — the "pending-only" state seeded by savePendingTransaction. Restores the contract StorageRepo.get() expects.
dependencies: none
files:
  - packages/db-p2p/src/storage/block-storage.ts (fix at getBlock, lines 23-36)
  - packages/db-p2p/src/storage/i-block-storage.ts (tighten doc comment on getBlock)
  - packages/db-p2p/test/storage-repo.spec.ts (add regression test)
----

## Fix

In `BlockStorage.getBlock(rev?)` at `packages/db-p2p/src/storage/block-storage.ts:23-36`, change the branch that currently throws when `targetRev` is undefined:

```ts
async getBlock(rev?: number): Promise<{ block: IBlock, actionRev: ActionRev } | undefined> {
    const meta = await this.storage.getMetadata(this.blockId);
    if (!meta) {
        return undefined;
    }

    // If no specific rev was requested and there's no committed latest,
    // the block is in a pending-only state (metadata seeded by savePendingTransaction
    // but never committed). Treat as "doesn't exist yet" — matches the contract
    // that StorageRepo.get() relies on (returning undefined => empty state).
    if (rev === undefined && meta.latest === undefined) {
        return undefined;
    }

    const targetRev = rev ?? meta.latest!.rev;
    // ...rest unchanged
}
```

Keep the throw path only for the case where a caller explicitly asked for a `rev` that cannot be materialized — that *is* an error. In practice, the existing `ensureRevision` / `materializeBlock` calls will throw naturally if the specific revision can't be found, so no extra throw is needed for the `rev !== undefined` path here.

## Contract clarification

Update `packages/db-p2p/src/storage/i-block-storage.ts` doc comment on `getBlock` to state: returns `undefined` when the block has no materialized content yet (no metadata, or metadata exists but no committed revision). Throws only when a specific `rev` was requested but cannot be located.

## Regression test

Add to `packages/db-p2p/test/storage-repo.spec.ts` (alongside existing `get` tests or in a new `describe('get')` block):

- Test: "returns empty state when block has only pending transaction (no committed revision)"
  - Arrange: create `StorageRepo` as in existing tests; call `repo.pend(...)` to pend an insert — this seeds metadata via `savePendingTransaction` but does NOT commit.
  - Act: call `repo.get({ blockIds: [blockId] })` with no context.
  - Assert: result has `state: {}` (the empty-result branch at storage-repo.ts:54-56 should fire), and the call does not throw.

Optional second test: same scenario but pass a `context.actionId` referencing the pending action — should return a block built by applying the pending transform (covers the `context?.actionId` branch at storage-repo.ts:59-72, which currently would also hit the throw when `blockRev` is needed but fails before reaching the undefined check).

Note: the `context.actionId` branch currently requires `blockRev` to exist — it calls `applyTransform(blockRev.block, ...)`. With the fix, `blockRev` will be `undefined` for a pending-only block. The second test may reveal that path needs `applyTransform(undefined, pendingTransform)` (valid for inserts). Verify during implement and adjust if needed — it's a small follow-on, not a blocker.

## Validation

- Run `npm test` (or the workspace equivalent) in `packages/db-p2p` — new test passes, existing tests still pass.
- Manually trace: fresh solo node → first DDL → `savePendingTransaction` seeds metadata → subsequent `getBlock(undefined)` returns `undefined` → `StorageRepo.get()` returns `{ state: {} }` → no exception surfaced to the coordinator path.

## Out of scope

- Changing `savePendingTransaction`'s metadata-seeding behavior (option 2 from the fix ticket). Current behavior is fine; only the reader contract needed fixing.
- Propagating a richer "pending-only" signal up to callers. No current caller needs to distinguish pending-only from truly-absent.

## TODO

- Apply the two-line fix to `block-storage.ts` getBlock().
- Update doc comment in `i-block-storage.ts`.
- Add regression test to `storage-repo.spec.ts` (primary + optional context.actionId test).
- If the `context.actionId` path needs a small tweak to handle `undefined` blockRev, apply it in `storage-repo.ts` get().
- Run db-p2p test suite; confirm green.
