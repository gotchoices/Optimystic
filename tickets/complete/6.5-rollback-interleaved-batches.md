# Complete: Rollback preserves interleaved batches from all remaining sessions

description: coordinator.rollback() replays ALL remaining stamps (not just higher-order ones) to handle interleaved batch application
files:
  - packages/db-core/src/transaction/coordinator.ts (rollback method, line 202)
  - packages/db-core/test/transaction.spec.ts (interleaved batches test, line 2882)
----

## What was built

Fixed `TransactionCoordinator.rollback(stampId)` to correctly preserve interleaved batches from all remaining sessions during rollback. Previously, rollback only replayed stamps with `order > data.order`, which lost batches from lower-order stamps that were applied after the rolled-back stamp's snapshot.

### Fix details (coordinator.ts, rollback method)

1. Finds the **earliest** `preSnapshot` among the rolled-back stamp and all remaining stamps
2. Restores collections to that earliest snapshot via `structuredClone`
3. Replays **all** remaining stamps' `actionBatches` in order, updating each stamp's `preSnapshot` for future rollback correctness

## Review results

All checklist items verified:

- **Earliest snapshot logic**: Correctly iterates remaining stamps to find the one with lowest `order`, using its `preSnapshot` as the restore baseline
- **Snapshot update during replay**: Before each stamp's replay, captures current tracker state as the new `preSnapshot` — ensures subsequent rollbacks have accurate data
- **Performance**: Replaying all stamps instead of only higher-order ones is negligible overhead (bounded by concurrent session count)
- **Test coverage**: Dedicated test covers the exact Alice→Bob→Charlie interleaving scenario from the bug
- **Edge cases**: Existing tests cover rollback of lowest-order stamp, no remaining stamps, double rollback (throws), execute-after-rollback (throws), and multi-collection rollback

## Testing

- All 269 tests pass (`npm test` in packages/db-core)
- Build passes clean (`tsc`)
- Key test: `should preserve interleaved batches from lower-order stamp when higher-order stamp is rolled back` (line 2882)
