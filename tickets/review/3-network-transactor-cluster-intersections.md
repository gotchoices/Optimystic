description: NetworkTransactor uses cluster intersections via greedy set-cover to minimize coordinator count
dependencies: NetworkTransactor, IKeyNetwork.findCluster, batch-coordinator
files:
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/test/network-transactor.spec.ts
  - packages/db-core/test/test-transactor.ts
----

## Summary

`consolidateCoordinators()` in `NetworkTransactor` (network-transactor.ts:185) uses `findCluster()` to get the full cluster peer set for each block in a transaction, then applies a greedy set-cover algorithm to select the fewest peers that can coordinate all blocks. This reduces network round trips when blocks share cluster members.

### Algorithm (lines 185–278)

1. For each blockId, call `findCluster(blockIdBytes)` → `ClusterPeers` (map of peerIdStr → multiaddrs+publicKey)
2. Build `peerBlocks: Map<string, BlockId[]>` — which blocks each peer can coordinate
3. Greedy set cover: pick peer covering the most uncovered blocks, assign, repeat
4. Any uncovered blocks (from `findCluster` failure or no shared peers) fall back to `findCoordinator()`
5. Convert assignments to `CoordinatorBatch[]`

### Scope

Only `consolidateCoordinators()` (called by `pend()`) is modified. Other operations (`get`, `cancel`, `commit`) continue using `findCoordinator` directly, which is appropriate since `pend` is where coordinator selection matters for initiating cluster consensus.

## Testing

4 dedicated tests in `describe('cluster intersection consolidation')` (network-transactor.spec.ts:347–585):

- **Shared cluster peer consolidation**: Two blocks with overlapping clusters (peerA+peerShared, peerB+peerShared) → single batch via peerShared
- **Non-overlapping clusters fallback**: Disjoint clusters → 2 separate batches (same as old behavior)
- **Single-block transaction**: No intersection possible → single batch (functionally unchanged)
- **findCluster failure graceful degradation**: When findCluster throws, falls back to findCoordinator

All tests use `MockKeyNetwork` with explicit cluster control and `TestTransactor` for in-memory transacting.

## Validation

- Build passes: `npm run build --workspace=packages/db-core`
- All 255 tests pass: `npm test --workspace=packages/db-core`
- All 12 NetworkTransactor tests pass

## Usage

No interface changes. The optimization is transparent — `pend()` automatically uses cluster intersections when available. Callers see fewer round trips for multi-block transactions with overlapping clusters, identical behavior otherwise.
