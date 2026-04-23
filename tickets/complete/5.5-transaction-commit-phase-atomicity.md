# Transaction Commit Phase Atomicity — Forward Recovery + Targeted Cancel

description: Fixed commitPhase partial failure atomicity violation by adding retry (forward recovery) and targeted cancel of only still-pending collections.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## Summary

Fixed an atomicity violation where `commitPhase` partial failure left orphaned pendings. When collection A's commit succeeded but collection B's failed, `cancelPhase` couldn't undo A's commit and was recomputing block IDs from transforms instead of using authoritative `pendedBlockIds` from `pendPhase`.

### Changes
1. **`commitPhase`** returns `committedCollections`/`failedCollections` sets; retries each collection's commit up to 3 times (forward recovery for transient failures).
2. **`cancelPhase`** accepts `pendedBlockIds: Map<CollectionId, BlockId[]>` and optional `excludeCollections: Set<CollectionId>` — no longer recomputes from transforms.
3. **`coordinateTransaction`** passes `committedCollections` to `cancelPhase` so only still-pending collections are cancelled.

## Testing

### Unit Tests (TEST-10.2.1, transaction.spec.ts)
- Pend failure cleanup: partial pend failure cancels already-pended collections
- Forward recovery + targeted cancel: permanent commit failure on 2nd collection leaves 1st committed, cancels only the failed collection
- Transient retry success: both collections commit after one transient failure, no cancel calls

### Integration Tests (re-enabled)
9 distributed tests un-skipped across `distributed-quereus.spec.ts` (4) and `distributed-transaction-validation.spec.ts` (5).

### Review Notes
- All 268 db-core tests pass
- Build succeeds across all packages
- Tightened weak assertion in transient retry test (label vs actual check mismatch)
- Pre-existing `it.skip` for multi-collection coordination in distributed-transaction-validation.spec.ts is unrelated
