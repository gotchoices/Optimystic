# Coordinator commit() State Management Fix

description: coordinator.commit() (TransactionSession path) now resets collection trackers and updates actionContext.rev after successful coordinateTransaction()
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts (lines 146-157)
  - packages/db-core/test/transaction.spec.ts
----

## What Was Built

Added post-commit cleanup to `TransactionCoordinator.commit()` (the `TransactionSession.commit()` path) that mirrors the existing cleanup in `execute()` (lines 374-389). After `coordinateTransaction()` succeeds, the code now:

1. Computes `newRev` from the current `actionContext.rev`
2. Updates `collection.source.actionContext` with the new revision and committed entry
3. Calls `collection.tracker.reset()` to clear stale transforms

This prevents two bugs:
- **Stale transforms**: Committed transforms no longer accumulate into subsequent sessions
- **Revision drift**: `actionContext.rev` now increments correctly, so sequential session-based commits don't fail the stale-revision check

## Key Files

- `packages/db-core/src/transaction/coordinator.ts` — lines 146-157: post-commit cleanup block in `commit()`
- `packages/db-core/test/transaction.spec.ts` — three new tests in TEST-10.3.1 block

## Testing

Three tests added covering the `TransactionSession.commit()` → `coordinator.commit()` path:

1. **Tracker reset after session commit** — verifies `coordinator.getTransforms()` is empty after `session.commit()`
2. **actionContext.rev update after session commit** — verifies `actionContext.rev === 1` after first session commit
3. **Sequential session-then-execute commits** — verifies session commit followed by `execute()` succeeds with `actionContext.rev` incrementing to 2

All 267 tests pass. Build succeeds.

## Usage / Validation

- Any code using `TransactionSession.create()` → `session.execute()` → `session.commit()` now correctly updates state
- Sequential session-based transactions no longer fail with revision conflicts
- The `execute()` path behavior is unchanged
