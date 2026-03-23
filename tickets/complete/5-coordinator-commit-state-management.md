# Coordinator commit() State Management Fix

description: coordinator.commit() (TransactionSession path) now resets collection trackers and updates actionContext.rev after successful coordinateTransaction()
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts (lines 176-190)
  - packages/db-core/test/transaction.spec.ts (TEST-10.3.1 block, lines ~2607-2828)
----

## What Was Built

Added post-commit cleanup to `TransactionCoordinator.commit()` (the `TransactionSession.commit()` path) that mirrors the existing cleanup in `execute()` (lines 430-448). After `coordinateTransaction()` succeeds, the code now:

1. Computes `newRev` from the current `actionContext.rev`
2. Updates `collection.source.actionContext` with the new revision and committed entry
3. Calls `collection.tracker.reset()` to clear stale transforms
4. Deletes stamp tracking data

This prevents two bugs:
- **Stale transforms**: Committed transforms no longer accumulate into subsequent sessions
- **Revision drift**: `actionContext.rev` now increments correctly, so sequential session-based commits don't fail the stale-revision check

## Key Files

- `packages/db-core/src/transaction/coordinator.ts` — lines 176-190: post-commit cleanup block in `commit()`
- `packages/db-core/src/transaction/session.ts` — `commit()` delegates to `coordinator.commit()`
- `packages/db-core/test/transaction.spec.ts` — TEST-10.3.1 block with 6 tests

## Testing

Six tests in TEST-10.3.1 cover both commit paths:

**execute() path (pre-existing):**
1. Tracker reset after successful `coordinator.execute()`
2. actionContext update after `coordinator.execute()`
3. Sequential `coordinator.execute()` calls succeed

**session commit path (new):**
4. Tracker reset after successful `session.commit()`
5. `actionContext.rev` update after `session.commit()`
6. Sequential session-then-execute commits — verifies session commit followed by `execute()` succeeds with `actionContext.rev` incrementing to 2

268 tests passing. Build clean.

## Review Notes

- Mild DRY duplication between `commit()` and `execute()` cleanup blocks is acceptable: iteration sources differ structurally, and extracting a shared helper for ~8 lines would add unnecessary abstraction.
- `commit()` path correctly omits the null-check on collection that `execute()` needs, because `collectionData` is sourced from `this.collections.entries()` (guaranteed to exist).

## Usage

Any code using `TransactionSession.create()` → `session.execute()` → `session.commit()` now correctly updates state. Sequential session-based transactions no longer fail with revision conflicts. The `execute()` path behavior is unchanged.
