# Rollback loses earlier session's batches when later session is rolled back

description: coordinator.rollback() only replays stamps with higher order; interleaved batches from lower-order stamps applied after the snapshot are lost
dependencies: none
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
----

## Problem

`TransactionCoordinator.rollback(stampId)` restores to the rolled-back stamp's `preSnapshot` then replays stamps with `order > data.order`. This misses later batches from stamps with *lower* order that were applied *after* the snapshot was taken.

### Reproduction scenario

```
session1 = create(coordinator, ...)   // stamp1 created, order=0
session2 = create(coordinator, ...)   // stamp2 created, order=1
session1.execute(insert Alice)        // applyActions(_, stamp1) → snapshot S0={}, batch1 applied
session2.execute(insert Bob)          // applyActions(_, stamp2) → snapshot S1={Alice}, batch2 applied
session1.execute(insert Charlie)      // applyActions(_, stamp1) → adds batch3 to stamp1's batches
session2.rollback()                   // restores to S1={Alice}, replays stamps with order > 1 → none
                                      // Result: Alice survives, Charlie LOST
```

After rollback, the state should contain both Alice and Charlie (session1's full work) with Bob removed. Instead, only Alice remains because stamp1 (order=0) is not replayed when stamp2 (order=1) is rolled back.

## Root cause

The replay filter `d.order > data.order` assumes all of a stamp's batches were applied before any higher-order stamp started. With interleaved `execute()` calls, a lower-order stamp may have batches applied after a higher-order stamp's snapshot.

## Potential fix

Instead of only replaying higher-order stamps, replay ALL remaining stamps:

1. Find the earliest `preSnapshot` among the rolled-back stamp and all remaining stamps
2. Restore to that earliest snapshot
3. Replay all remaining stamps' full `actionBatches` in order

This ensures no batches are lost regardless of interleaving.
