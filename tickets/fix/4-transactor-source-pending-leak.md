# TransactorSource Leaks Pending Actions on Commit Failure

description: transact() does not call cancel after a failed commit, leaving pending actions orphaned in the transactor
dependencies: none
files:
  - packages/db-core/src/transactor/transactor-source.ts
  - packages/db-core/test/transactor-source.spec.ts
----

## Bug

In `TransactorSource.transact()`, when the commit step fails, the method returns the failure without issuing a `cancel()` call to the underlying transactor. The pending actions from the `pend()` call remain in the transactor until they expire, potentially blocking subsequent transactions on the same blocks.

## Expected Behavior

On commit failure, `transact()` should cancel the pending transaction before returning the error, ensuring clean state for retries.

## Reproducing Tests

Already exist in `packages/db-core/test/transactor-source.spec.ts` (TEST-4.2.1 from system-review.md).
