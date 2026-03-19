# Transaction Phase Partial Failure Handling

description: partial PEND failure orphans pending actions in already-pended collections; partial COMMIT failure violates atomicity (committed collections cannot be cancelled)
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Bug 1: Partial PEND Failure

When `pendPhase` processes collections sequentially and collection N fails after collections 1..N-1 succeed, the already-pended collections are left with orphaned pending actions. No `cancelPhase` is called for the successful collections, and their pending state blocks future transactions on those collections until expiration.

## Bug 2: Partial COMMIT Failure

When `commitPhase` succeeds for collection A but fails for collection B, `cancelPhase` is called — but cancelling an already-committed collection is a no-op. This leaves collection A committed and collection B uncommitted, violating atomicity.

## Expected Behavior

- On partial PEND failure: cancel all already-pended collections before returning the error.
- On partial COMMIT failure: the system should either prevent partial commit (e.g., commit atomically) or have a compensation mechanism. This may tie into the 2PC state persistence ticket.

## Reproducing Tests

Already exist in `packages/db-core/test/transaction.spec.ts` (TEST-10.2.1 from system-review.md).
