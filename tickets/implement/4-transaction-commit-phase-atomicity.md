# Fix commitPhase Partial Failure Atomicity Violation

description: When commitPhase succeeds for collection A but fails for collection B, cancelPhase can't undo A's commit — leaving an atomicity violation. Fix: retry failed commits (forward recovery), then targeted cancel of only still-pending collections.
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Context

`TransactionCoordinator.coordinateTransaction()` runs GATHER → PEND → COMMIT phases. On COMMIT failure (line 494-498), it calls `cancelPhase()` for all collections. But cancel is a no-op on already-committed blocks — the pending state was already moved to committed during the successful commit call.

This is documented by the existing TEST-10.2.1 test at line 2475 which asserts the **buggy** behavior: `committed.size > 0` despite the overall transaction failure.

Note: Bug 1 (partial PEND failure) is already fixed — `pendPhase` (lines 594-597) correctly cancels already-pended collections using the actual `pendedBlockIds`. The TEST-10.2.1 test at line 2426 verifies this.

## Root Cause

`commitPhase` (lines 614-660) commits collections sequentially and returns immediately on the first failure. `coordinateTransaction` (line 496) then calls `cancelPhase` for all collections, but `transactor.cancel()` only deletes from `pendingActions` — it has no effect on already-committed blocks.

Additionally, `cancelPhase` (lines 665-685) recomputes block IDs from transforms (`blockIdsForTransforms(transforms)`) instead of using the actual pended block IDs returned from `pendPhase`. While functionally equivalent in the current test transactor, this is fragile and should use the authoritative `pendedBlockIds`.

## Fix: Forward Recovery + Targeted Cancel

Following standard 2PC semantics: once all collections are pended successfully (Phase 1 passes), the coordinator has decided to commit. Failed commits should be retried before giving up.

### 1. Modify `commitPhase` to return partial state

Change the return type to include which collections committed vs failed:

```typescript
private async commitPhase(
    actionId: ActionId,
    criticalBlockIds: BlockId[],
    pendedBlockIds: Map<CollectionId, BlockId[]>
): Promise<{
    success: boolean;
    error?: string;
    committedCollections: Set<CollectionId>;
    failedCollections: Set<CollectionId>;
}>
```

Track which collections commit successfully. On failure, return both sets so the caller can make informed decisions.

### 2. Add retry logic in `commitPhase`

When a single collection's commit fails, retry it up to 2 more times before giving up. This handles transient failures (network blips, lock contention) without hanging indefinitely.

```typescript
for (const [collectionId, blockIds] of pendedBlockIds.entries()) {
    // ... existing setup ...

    let committed = false;
    for (let attempt = 0; attempt < 3 && !committed; attempt++) {
        const commitResult = await this.transactor.commit(commitRequest);
        if (commitResult.success) {
            committed = true;
            committedCollections.add(collectionId);
        } else if (attempt === 2) {
            failedCollections.add(collectionId);
            return {
                success: false,
                error: `Commit failed for collection ${collectionId} after 3 attempts`,
                committedCollections,
                failedCollections
            };
        }
    }
}
```

### 3. Update `coordinateTransaction` to do targeted cancel

Replace the blanket `cancelPhase` call with targeted cancellation of only still-pending collections, using the actual `pendedBlockIds`:

```typescript
if (!commitResult.success) {
    // Only cancel collections that are still pending (not already committed)
    for (const [collectionId, blockIds] of pendResult.pendedBlockIds!.entries()) {
        if (!commitResult.committedCollections.has(collectionId)) {
            await this.transactor.cancel({ actionId: transaction.id as ActionId, blockIds });
        }
    }
    return { success: false, error: commitResult.error };
}
```

### 4. Refactor `cancelPhase` to accept pended block IDs

Change signature from `cancelPhase(actionId, collectionTransforms)` to `cancelPhase(actionId, pendedBlockIds)` so it uses the authoritative pended block IDs rather than recomputing from transforms:

```typescript
private async cancelPhase(
    actionId: ActionId,
    pendedBlockIds: Map<CollectionId, BlockId[]>,
    excludeCollections?: Set<CollectionId>
): Promise<void> {
    for (const [collectionId, blockIds] of pendedBlockIds.entries()) {
        if (excludeCollections?.has(collectionId)) continue;
        await this.transactor.cancel({ actionId, blockIds });
    }
}
```

### 5. Update the TEST-10.2.1 test (line 2475)

Change the second test from asserting buggy behavior to asserting correct behavior:

- After partial commit failure with retry, the committed collection count should be 0 (the retry fails because the mock always rejects the 2nd+ commit)
- But the cancel should only target the **still-pending** collections
- No orphaned pending actions should remain

Change the assertion at line 2532 from:
```typescript
expect(committed.size, 'BUG: 1st collection committed despite tx failure — atomicity violation').to.be.greaterThan(0);
```
to:
```typescript
expect(committed.size, 'forward recovery: 1st collection should still be committed after retry succeeds for it').to.equal(1);
// OR if retry makes the mock succeed for all:
// expect(committed.size).to.equal(2); // all committed via retry
```

The exact assertion depends on how the mock is structured. With the current mock (`commitCallCount >= 2` returns failure), the first collection commits on attempt 1, and the second collection fails all 3 retries. So the test should assert:
- `committed.size === 1` (first collection committed, unavoidable)
- `pending.size === 0` (second collection's pending was cancelled)
- The cancel was called only for the non-committed collection

Add a new test: "should retry and succeed when commit transiently fails":
- Mock: fail on 2nd commit call, but succeed on 3rd
- Both collections should end up committed
- No cancel calls should be made

## TODO

- Modify `commitPhase` return type to include `committedCollections` and `failedCollections` sets
- Add retry loop (3 attempts) in `commitPhase` for individual collection commits
- Update `coordinateTransaction` to use targeted cancel (skip committed collections)
- Refactor `cancelPhase` signature to accept `pendedBlockIds: Map<CollectionId, BlockId[]>` and optional `excludeCollections` set
- Update existing TEST-10.2.1 partial commit test to assert improved behavior (targeted cancel, no orphaned pendings)
- Add new test: transient commit failure recovers via retry (all collections committed)
- Verify all 261 existing tests still pass
