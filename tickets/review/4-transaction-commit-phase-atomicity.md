# Transaction Commit Phase Atomicity — Forward Recovery + Targeted Cancel

description: Fixed commitPhase partial failure atomicity violation by adding retry (forward recovery) and targeted cancel of only still-pending collections.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/test/transaction.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-quereus.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## What Was Built

### Problem
When `commitPhase` succeeded for collection A but failed for collection B, `cancelPhase` couldn't undo A's commit — leaving an atomicity violation. The cancel was also calling `blockIdsForTransforms()` to recompute block IDs instead of using the authoritative `pendedBlockIds` from `pendPhase`.

### Fix: Forward Recovery + Targeted Cancel

1. **`commitPhase` returns partial state** — now returns `committedCollections` and `failedCollections` sets so the caller knows exactly what happened.

2. **Retry logic (3 attempts)** — each collection's commit is retried up to 3 times before giving up, handling transient failures (network blips, lock contention).

3. **Targeted cancel in `coordinateTransaction`** — on commit failure, only cancels collections that are still pending (skips already-committed ones using the `committedCollections` set).

4. **`cancelPhase` refactored** — now accepts `pendedBlockIds: Map<CollectionId, BlockId[]>` and optional `excludeCollections: Set<CollectionId>` instead of recomputing block IDs from transforms.

### Key Behavior
- If collection A commits but collection B fails all 3 retries: A stays committed, B's pending is cancelled, no orphaned pendings remain.
- If collection B's commit transiently fails then succeeds on retry: both collections commit, no cancel calls made.

## Testing

### Updated Tests (TEST-10.2.1)
- **"should do forward recovery with retry and targeted cancel on partial commit failure"** — verifies that when 2nd collection commit permanently fails: 1st collection remains committed (forward recovery), cancel is only called for the failed collection (targeted), no orphaned pendings, retry count is correct (4 total: 1 success + 3 retries).

- **"should retry and succeed when commit transiently fails"** — verifies that when 2nd collection commit fails once then succeeds on retry: both collections end up committed, no cancel calls made, 3 total commit calls.

### Re-enabled Integration Tests
9 distributed integration tests in `quereus-plugin-optimystic` were un-skipped:
- `distributed-quereus.spec.ts`: 4 tests (create/access table, INSERT, UPDATE, DELETE across nodes)
- `distributed-transaction-validation.spec.ts`: 5 tests (CHECK constraints, StampId non-repeatability, file persistence, sequential transactions, local schema enforcement)

### Test Results
- All 268 db-core tests pass
- Build succeeds across all packages
