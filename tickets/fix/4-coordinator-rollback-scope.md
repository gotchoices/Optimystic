# Coordinator Rollback Ignores stampId

description: coordinator.rollback(stampId) ignores the stampId parameter and resets ALL collection trackers, destroying concurrent sessions' transforms
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Bug

`TransactionCoordinator.rollback(stampId)` resets ALL collection trackers regardless of the `stampId` argument. In a scenario with concurrent transaction sessions sharing a coordinator, rolling back one session destroys the in-progress transforms of all other sessions.

## Expected Behavior

`rollback()` should only discard transforms associated with the given `stampId`, leaving other sessions' state intact.

## Reproducing Tests

Already exist in `packages/db-core/test/transaction.spec.ts` (TEST-10.3.1 from system-review.md).
