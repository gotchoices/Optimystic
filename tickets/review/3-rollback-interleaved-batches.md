# Review: Rollback preserves interleaved batches from all remaining sessions

description: coordinator.rollback() replays ALL remaining stamps (not just higher-order ones) to handle interleaved batch application
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts (rollback method, ~line 202)
  - packages/db-core/test/transaction.spec.ts (interleaved batches test, ~line 2882)
----

## What was built

Fixed `TransactionCoordinator.rollback(stampId)` to correctly preserve interleaved batches from all remaining sessions during rollback. Previously, rollback only replayed stamps with `order > data.order`, which lost batches from lower-order stamps that were applied after the rolled-back stamp's snapshot.

### Fix details (coordinator.ts, rollback method)

1. Finds the **earliest** `preSnapshot` among the rolled-back stamp and all remaining stamps
2. Restores collections to that earliest snapshot
3. Replays **all** remaining stamps' `actionBatches` in order (not just those with higher order)

## Key use case for testing

Interleaved session execution followed by rollback of a higher-order stamp:

```
session1.execute(insert Alice)   // stamp1 (order=0), snapshot S0={}
session2.execute(insert Bob)     // stamp2 (order=1), snapshot S1={Alice}
session1.execute(insert Charlie) // stamp1 batch added after S1
session2.rollback()              // should preserve Alice AND Charlie, remove only Bob
```

## Test coverage

- Test: `should preserve interleaved batches from lower-order stamp when higher-order stamp is rolled back` in "Consensus Protocol Correctness" describe block
- Verifies: Alice and Charlie survive session2 rollback; Bob is removed
- All 269 tests passing, build succeeds

## Review checklist

- [ ] Rollback logic correctly finds earliest snapshot across all remaining stamps
- [ ] Snapshot update during replay is correct (preSnapshot reassigned for replayed stamps)
- [ ] No performance regression from replaying all stamps vs. only higher-order ones
- [ ] Test covers the specific interleaving scenario described in the bug
- [ ] Edge cases: rollback of lowest-order stamp, rollback with no remaining stamps, multiple rollbacks in sequence
