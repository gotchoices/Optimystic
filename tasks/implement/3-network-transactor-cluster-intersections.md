description: NetworkTransactor should use cluster intersections rather than arbitrary coordinators
dependencies: NetworkTransactor, cluster topology (IKeyNetwork.findCluster)
files:
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/src/network/i-key-network.ts
  - packages/db-core/src/utility/batch-coordinator.ts
  - packages/db-core/test/network-transactor.spec.ts
  - packages/db-core/test/simulation.ts
----

## Problem

When a transaction spans multiple blocks, `consolidateCoordinators()` calls `findCoordinator()` independently for each block. Each block gets whichever FRET neighbor happens to be first. If blocks A and B share cluster members but get different coordinators, the transaction requires two network round trips instead of one.

## Solution

Modify `consolidateCoordinators()` to use `findCluster()` for all blocks in a transaction, compute peer-to-block coverage, and use a greedy set-cover to minimize the number of distinct coordinators. This batches more blocks per coordinator when clusters overlap.

No interface changes needed — `IKeyNetwork.findCluster()` already exists and returns `ClusterPeers` (a map of peer ID string to multiaddrs + publicKey). The `peerIdFromString` import already exists in NetworkTransactor.

## Algorithm

In `consolidateCoordinators()` (network-transactor.ts:185):

1. For each blockId, call `findCluster(blockIdBytes)` to get `ClusterPeers`
2. Build `peerBlocks: Map<string, BlockId[]>` — which blocks each peer can coordinate
3. Greedy set cover:
   - Find peer covering the most uncovered blocks
   - Assign those blocks to that peer
   - Remove from uncovered set
   - Repeat until empty or no peer covers remaining blocks
4. For remaining uncovered blocks (no shared peers): fall back to `findCoordinator()`
5. Convert assignments to `CoordinatorBatch[]` (same shape as current output)

If `findCluster()` throws for any block, fall back to `findCoordinator()` for that block.

The existing retry mechanism in `processBatches` handles connectivity failures — if an intersection peer isn't reachable, the batch retries with a different coordinator.

## Scope

Only `consolidateCoordinators()` (used by `pend()`) is modified. The `pend` operation is where coordinator selection matters most — it initiates cluster consensus. For `get`/`cancel`/`commit`, the coordinator is routing convenience and already benefits indirectly via `recordCoordinator` caching after pend.

## Edge Cases

- **Single block**: no intersection possible, `findCluster` returns one cluster, greedy picks one peer — functionally same as `findCoordinator`
- **All blocks in same cluster**: one peer covers all blocks — single batch (optimal)
- **No overlapping clusters**: each block assigned separately — same as current behavior
- **`findCluster` failure**: falls back to `findCoordinator` per block — graceful degradation

## TODO

- Modify `consolidateCoordinators()` with greedy set-cover algorithm using `findCluster()`
- Add test: multi-block transaction with overlapping clusters produces fewer batches
- Add test: non-overlapping clusters falls back to per-block behavior
- Add test: single-block transaction unchanged
- Ensure build and tests pass
