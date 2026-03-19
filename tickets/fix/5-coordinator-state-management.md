# Coordinator State Management Bugs

description: coordinator.execute() never resets collection trackers or updates actionContext.rev after commit, causing stale transforms and revision drift in sequential transactions
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Bug

`TransactionCoordinator.execute()` does not clean up state after a successful commit:

1. **Collection trackers never reset** — transforms from a committed transaction accumulate into subsequent transactions, causing stale or duplicate operations.
2. **`actionContext.rev` never updated** — after commit, the revision stays at whatever it was before the first transaction (typically 1). Subsequent transactions always compute pend/commit against rev 1 instead of the latest committed revision, causing spurious stale-revision failures.

Both bugs were confirmed with reproducing tests in `transaction.spec.ts` (TEST-10.3.1 from system-review.md).

## Expected Behavior

After a successful commit, `execute()` (or `commit()`) should:
- Reset all collection trackers so the next transaction starts clean
- Update `actionContext.rev` to reflect the newly committed revision

## Reproducing Tests

Already exist in `packages/db-core/test/transaction.spec.ts` under the TEST-10.3.1 test group.
