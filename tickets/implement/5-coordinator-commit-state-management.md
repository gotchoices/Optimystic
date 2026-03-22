# Coordinator commit() State Management Fix

description: coordinator.commit() (TransactionSession path) never resets collection trackers or updates actionContext.rev after successful coordinateTransaction(), causing stale transforms and revision drift in sequential session-based transactions
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transaction/session.ts
  - packages/db-core/test/transaction.spec.ts
----

## Context

`TransactionCoordinator` has two commit paths:

1. **`execute()` (lines 283-385)** — used by `commitTransaction()` / Quereus direct calls. Already fixed at lines 361-376 with post-commit cleanup that resets trackers and updates `actionContext.rev`.

2. **`commit()` (lines 75-145)** — used by `TransactionSession.commit()` (line 140). This is the **active, non-deprecated** path for incremental session-based transactions. It still has both bugs.

## Bug Details

After `coordinateTransaction()` succeeds at line 140, `commit()` returns without:

1. **Resetting collection trackers** — transforms from a committed session accumulate into subsequent sessions, causing stale or duplicate operations.

2. **Updating `actionContext.rev`** — stays at its initial value (typically `undefined`/0). Both `pendPhase()` (line 578) and `commitPhase()` (line 627) compute `rev = (actionContext?.rev ?? 0) + 1`, so sequential sessions always compute `rev=1`. After the first commit sets `blockState.latestRev=1`, the second commit's stale-revision check (`latestRev >= rev`) fails.

## Root Cause

The `execute()` path was fixed (lines 361-376) but the parallel `commit()` path was not updated to include the same post-commit cleanup.

## Fix

Add the same post-commit cleanup block from `execute()` step 5 to `commit()`, after the `coordinateTransaction()` success check (after line 144, before the method returns).

The cleanup iterates over `collectionData` (which is already computed at line 81) and for each affected collection:
- Computes `newRev = (collection['source'].actionContext?.rev ?? 0) + 1`
- Updates `collection['source'].actionContext` with the new revision and committed entry
- Calls `collection.tracker.reset()`

This mirrors exactly what `execute()` does at lines 361-376, but uses `collectionData` (available in `commit()`) instead of `result.actions` (available in `execute()`).

### Code Change (coordinator.ts, after line 144)

```typescript
if (!coordResult.success) {
    throw new Error(`Transaction commit failed: ${coordResult.error}`);
}

// Reset trackers and update actionContext after successful commit
for (const { collectionId, collection } of collectionData) {
    const newRev = (collection['source'].actionContext?.rev ?? 0) + 1;
    collection['source'].actionContext = {
        committed: [
            ...(collection['source'].actionContext?.committed ?? []),
            { actionId: transaction.id, rev: newRev }
        ],
        rev: newRev,
    };
    collection.tracker.reset();
}
```

## Tests

Existing TEST-10.3.1 tests all go through the `execute()` path. New tests should go through the `TransactionSession.commit()` → `coordinator.commit()` path:

- **Session tracker reset** — After `session.commit()`, `coordinator.getTransforms()` should be empty.
- **Session actionContext update** — After `session.commit()`, `collection.source.actionContext.rev` should equal 1.
- **Sequential session commits** — Two successive session create/execute/commit cycles should both succeed, with `actionContext.rev` incrementing to 2 after the second.

These should be added to the TEST-10.3.1 describe block in `transaction.spec.ts`.

## TODO

- Add post-commit cleanup block to `coordinator.commit()` after coordinateTransaction success (mirror lines 361-376 of execute)
- Add test: session tracker reset after commit (via TransactionSession path)
- Add test: session actionContext.rev update after commit
- Add test: sequential session commits succeed with correct rev progression
- Verify all existing tests still pass
