description: NetworkTransactor uses cluster intersections via greedy set-cover to minimize coordinator count
dependencies: NetworkTransactor, IKeyNetwork.findCluster, batch-coordinator
files:
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/src/utility/batch-coordinator.ts
  - packages/db-core/test/network-transactor.spec.ts
  - packages/db-core/test/test-transactor.ts
----

## What was built

`consolidateCoordinators()` in `NetworkTransactor` uses `findCluster()` to get the full cluster peer set for each block in a multi-block `pend()`, then applies a greedy set-cover algorithm to select the fewest peers that can coordinate all blocks. This reduces network round trips when blocks share cluster members.

Only `pend()` uses the cluster intersection path. Other operations (`get`, `cancel`, `commit`) continue using `findCoordinator` directly, which is appropriate since `pend` is where coordinator selection matters for initiating cluster consensus.

## Review fixes

- Added `coordinatingBlockIds?: BlockId[]` to the `CoordinatorBatch` type in `batch-coordinator.ts`, eliminating three `as any` casts in `network-transactor.ts` where the property was being set and read without type support.

## Key files

- `packages/db-core/src/transactor/network-transactor.ts` — `consolidateCoordinators()` (line 187) and its caller `pend()` (line 282)
- `packages/db-core/src/utility/batch-coordinator.ts` — `CoordinatorBatch` type (line 11)
- `packages/db-core/test/network-transactor.spec.ts` — 4 cluster intersection tests (line 347+)

## Testing

4 dedicated tests in `describe('cluster intersection consolidation')`:

- **Shared cluster peer consolidation**: Two blocks with overlapping clusters → single batch via shared peer
- **Non-overlapping clusters fallback**: Disjoint clusters → 2 separate batches
- **Single-block transaction**: Single batch, functionally unchanged
- **findCluster failure graceful degradation**: Falls back to findCoordinator

All 261 tests pass. Build clean.

## Usage

No interface changes. The optimization is transparent — `pend()` automatically uses cluster intersections when available. Callers see fewer round trips for multi-block transactions with overlapping clusters, identical behavior otherwise.
