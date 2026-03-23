# Fix: Rollback preserves interleaved batches from all remaining sessions

description: coordinator.rollback() now replays ALL remaining stamps (not just higher-order ones) to handle interleaved batch application
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Problem

`TransactionCoordinator.rollback(stampId)` only replayed stamps with `order > data.order` after restoring the snapshot. When sessions interleave their `execute()` calls, a lower-order stamp can have batches applied after a higher-order stamp's snapshot was taken. Rolling back the higher-order stamp would restore to its snapshot and skip the lower-order stamp during replay, losing its later batches.

### Reproduction scenario
```
session1.execute(insert Alice)   // stamp1 (order=0), snapshot S0={}
session2.execute(insert Bob)     // stamp2 (order=1), snapshot S1={Alice}
session1.execute(insert Charlie) // stamp1 batch added after S1
session2.rollback()              // restores S1={Alice}, replays order>1 → none
                                 // Result: Charlie LOST
```

## Fix applied

In `coordinator.ts` `rollback()` method (line ~202):

1. Find the **earliest** `preSnapshot` among the rolled-back stamp and all remaining stamps
2. Restore collections to that earliest snapshot
3. Replay **all** remaining stamps' `actionBatches` in order (not just those with higher order)

This ensures no batches are lost regardless of interleaving order.

## Test added

`should preserve interleaved batches from lower-order stamp when higher-order stamp is rolled back` in the "Consensus Protocol Correctness" describe block of `transaction.spec.ts`. The test:
- Creates two sessions (session1 order=0, session2 order=1)
- Interleaves: session1 inserts Alice, session2 inserts Bob, session1 inserts Charlie
- Rolls back session2
- Asserts Bob is gone, Alice AND Charlie survive

## TODO

- [x] Reproducing test case written and confirmed failing
- [x] Fix applied to `coordinator.rollback()`
- [x] All 269 tests passing
- [x] Build succeeds
