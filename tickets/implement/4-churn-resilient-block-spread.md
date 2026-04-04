# Churn-Resilient Block Spread (Middle-Out)

description: Proactive block spreading on neighbor departure — only middle peers push to cluster edges, bounding fan-out to 2d
dependencies: FRET neighborDistance + assembleCohort + expandCohort, PartitionDetector, BlockTransferClient, RebalanceMonitor (pattern), NetworkManagerService (wiring)
files:
  - packages/db-p2p/src/cluster/spread-on-churn.ts (NEW - SpreadOnChurnMonitor)
  - packages/db-p2p/src/network/network-manager-service.ts (init + config wiring)
  - packages/db-p2p/src/index.ts (export)
  - packages/db-p2p/test/spread-on-churn.spec.ts (NEW - tests)
----

## Architecture

### Problem

When peers leave a cluster, block replicas erode. Without inner Arachnode rings, the system needs proactive spreading. The naive approach — every cluster peer spreads on departure — creates N-fold amplification (a bandwidth storm).

### Solution: Middle-Out Spread

Only peers within the closest `d` positions to a block's coordinate perform spread. FRET's `neighborDistance(selfId, coord, k)` returns self's 0-based rank in the k-nearest cohort to `coord`. If `rank < d`, the peer is **spread-eligible**. This bounds fan-out to at most `2d` spread operations per cluster per churn event.

Spread-eligible peers push blocks to **expansion targets** — peers just beyond the current cluster boundary, found via `fret.expandCohort(currentCohort, coord, step)`.

### Properties

- Zero coordination: each peer independently computes its rank via `neighborDistance`
- Idempotent: if 2-3 middle peers push the same blocks to the same targets, receivers deduplicate
- Graceful degradation: if middle peers depart, the new middle inherits spread duty
- Bounded: at most `2d` peers react per departure event per cluster

## SpreadOnChurnMonitor

A `Startable` service following the same patterns as `RebalanceMonitor` (rebalance-monitor.ts).

### Config

```typescript
export interface SpreadOnChurnConfig {
  /** Enable the churn-resilient spread protocol. Default: true */
  enabled: boolean
  /** Number of middle-closest peers eligible to spread (d). Default: 3 */
  spreadDistance: number
  /** Enable dynamic d scaling based on cluster health. Default: true */
  dynamicSpreadDistance: boolean
  /** Cluster size ratio below which spread becomes more aggressive. Default: 0.6 */
  healthThreshold: number
  /** Debounce window for departure detection (ms). Default: 5000 */
  departureDebounceMs: number
  /** Number of peers beyond cluster boundary to target. Default: 4 */
  expansionStep: number
}
```

### Dependencies

```typescript
export interface SpreadOnChurnDeps {
  libp2p: Libp2p
  fret: FretService
  partitionDetector: PartitionDetector
  repo: IRepo
  peerNetwork: IPeerNetwork
  clusterSize: number
  protocolPrefix?: string
}
```

### Core Algorithm

On `connection:close` (debounced by `departureDebounceMs`):

```
for each tracked blockId:
  coord = await hashKey(encode(blockId))
  rank = fret.neighborDistance(selfId, coord, clusterSize)
  effectiveD = computeEffectiveD()   // dynamic d logic
  if rank >= effectiveD → skip (not a middle peer for this block)

  cohort = fret.assembleCohort(coord, clusterSize)
  expanded = fret.expandCohort(cohort, coord, expansionStep)
  targets = expanded.filter(id => !cohortSet.has(id) && id !== selfId)
  if targets.length === 0 → skip

  read block from repo
  for each target:
    push via BlockTransferClient with reason 'replication'
```

### Dynamic d

Track recent departure timestamps in a sliding window (use `departureDebounceMs * 4` as window). The effective d scales up when:

1. **Rapid churn**: If `recentDepartures >= 3` within the window, increase d by 1 (capped at `clusterSize / 2`).
2. **Low cluster health**: If `observedCohortSize / clusterSize < healthThreshold`, set `effectiveD = Math.ceil(d * (clusterSize / observedCohortSize))`, capped at `clusterSize / 2`.

When neither condition holds, `effectiveD = d` (the configured default).

### Lifecycle

- `start()`: register `connection:close` listener
- `stop()`: remove listener, clear debounce timer
- `trackBlock(blockId)` / `untrackBlock(blockId)`: manage tracked set
- `checkNow()`: force immediate spread check (for testing)

### SpreadEvent (diagnostic, emitted to handlers)

```typescript
export interface SpreadEvent {
  /** Blocks that were spread */
  spread: Array<{ blockId: string; targets: string[]; succeeded: string[]; failed: string[] }>
  /** Current effective d */
  effectiveD: number
  /** Timestamp of the departure that triggered this */
  triggeredAt: number
}
```

## NetworkManagerService Wiring

Add `initSpreadOnChurnMonitor()` and `getSpreadOnChurnMonitor()` methods to `NetworkManagerService`, following the exact same pattern as `initRebalanceMonitor()` (line 70-85).

Add `spreadOnChurn?: Partial<SpreadOnChurnConfig>` to `NetworkManagerServiceInit` (line 12).

The caller passes `repo` and `peerNetwork` since `NetworkManagerService` doesn't hold those references directly — same as how `BlockTransferCoordinator` receives them in its constructor.

## Exports

Add to `packages/db-p2p/src/index.ts`:
```
export * from "./cluster/spread-on-churn.js"
```

## Key Integration Points

| What | Where | How |
|------|-------|-----|
| Rank check | `fret.neighborDistance(selfId, coord, clusterSize)` | Returns 0-based index; < d means eligible |
| Current cohort | `fret.assembleCohort(coord, clusterSize)` | Includes self, alternates R/L neighbors |
| Expansion targets | `fret.expandCohort(cohort, coord, step)` | Returns cohort + step additional peers |
| Block read | `repo.get({ blockIds: [blockId] })` | Same pattern as BlockTransferCoordinator (block-transfer.ts:180) |
| Push | `new BlockTransferClient(peerId, peerNetwork, prefix).pushBlocks(...)` | Reuse existing client (block-transfer-service.ts:219) |
| Partition guard | `partitionDetector.detectPartition()` | Skip spread during partitions |

## Tests

Follow the test patterns from `rebalance-monitor.spec.ts` — MockLibp2p, MockFret with configurable cohort results. The MockFret needs to also support `neighborDistance` and `expandCohort`.

### Key test cases

- **Eligibility**: middle peer (rank < d) triggers spread; edge peer (rank >= d) does not
- **Expansion targets**: only peers beyond the cohort boundary are targeted, not existing members
- **Dynamic d**: increases under rapid churn; resets when stable
- **Partition suppression**: no spread during detected partition
- **Debounce**: multiple rapid departures coalesce into single spread check
- **Push mechanics**: correct block data sent to correct targets; partial failures tracked
- **Lifecycle**: start/stop register/remove listeners; idempotent; no spread after stop
- **Empty cohort / no targets**: graceful no-op when expand returns nothing new
- **Config: disabled**: `enabled: false` skips all spread logic
- **SpreadEvent emission**: handlers receive events with correct block/target/result data
- **Multiple handlers + error isolation**: one handler throwing doesn't prevent others

## TODO

### Phase 1: SpreadOnChurnMonitor core
- Create `packages/db-p2p/src/cluster/spread-on-churn.ts`
- Implement `SpreadOnChurnConfig`, `SpreadOnChurnDeps`, `SpreadEvent` types
- Implement `SpreadOnChurnMonitor` class (Startable, connection:close listener, debounce, block tracking)
- Implement eligibility check using `fret.neighborDistance`
- Implement expansion target selection using `assembleCohort` + `expandCohort`
- Implement push via `BlockTransferClient`
- Implement dynamic d logic (sliding window of departures, health threshold)
- Implement partition suppression

### Phase 2: NetworkManagerService integration
- Add `spreadOnChurn?: Partial<SpreadOnChurnConfig>` to `NetworkManagerServiceInit`
- Add `initSpreadOnChurnMonitor()` method (pattern: initRebalanceMonitor at line 70)
- Add `getSpreadOnChurnMonitor()` accessor
- Add stop() integration (pattern: line 113-116)

### Phase 3: Exports
- Add `export * from "./cluster/spread-on-churn.js"` to `packages/db-p2p/src/index.ts`

### Phase 4: Tests
- Create `packages/db-p2p/test/spread-on-churn.spec.ts`
- Extend MockFret with `neighborDistance()` and `expandCohort()` support
- Implement all test cases listed above
- Run `yarn test:p2p` to verify all tests pass (existing + new)
- Run build to verify type-checking passes
