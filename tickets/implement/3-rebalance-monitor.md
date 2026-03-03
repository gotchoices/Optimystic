description: Topology change detection and rebalance scheduling
dependencies: libp2p connection events, FRET assembleCohort, ArachnodeFretAdapter, NetworkManagerService, PartitionDetector
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (new)
  - packages/db-p2p/src/cluster/rebalance-monitor.spec.ts (new test)
  - packages/db-p2p/src/storage/arachnode-fret-adapter.ts (wire status transitions)
  - packages/db-p2p/src/network/network-manager-service.ts (integrate monitor)
----

## Overview

When peers join or leave the network, responsibility sets shift but the system currently only discovers this lazily (on the next request for a key). This task adds a **RebalanceMonitor** that proactively detects topology changes and identifies responsibility shifts so that data migration can happen promptly.

## Architecture

```
libp2p events ──→ RebalanceMonitor ──→ RebalanceEvent[]
                     ↑        ↓
              PartitionDetector   ArachnodeFretAdapter
                                    (status transitions)
```

### RebalanceMonitor

A `Startable` service that:

1. **Listens** for libp2p `connection:open` and `connection:close` events.
2. **Debounces** topology changes (e.g. 5s window) to avoid thrashing on transient connects/disconnects.
3. **Recomputes** responsibility for locally-tracked block IDs using `computeResponsibility()`.
4. **Emits** `RebalanceEvent` objects describing gained and lost responsibilities.
5. **Integrates** with `PartitionDetector` — suppresses rebalancing when a partition is detected (to avoid split-brain migration).
6. **Updates** `ArachnodeInfo.status` via `ArachnodeFretAdapter` to signal intent (`active` → `moving` during rebalance, back to `active` when done).

### Key Types

```typescript
interface RebalanceEvent {
  /** Block IDs this node has gained responsibility for */
  gained: string[];
  /** Block IDs this node has lost responsibility for */
  lost: string[];
  /** Peers that are now closer for the lost blocks */
  newOwners: Map<string, string[]>; // blockId → peerId[]
  /** Timestamp of the topology change that triggered this */
  triggeredAt: number;
}

interface RebalanceMonitorConfig {
  /** Debounce window for topology changes (ms). Default: 5000 */
  debounceMs?: number;
  /** Maximum frequency of full rebalance scans (ms). Default: 60000 */
  minRebalanceIntervalMs?: number;
  /** Whether to suppress rebalancing during detected partitions. Default: true */
  suppressDuringPartition?: boolean;
}

interface RebalanceMonitor extends Startable {
  /** Register a callback for rebalance events */
  onRebalance(handler: (event: RebalanceEvent) => void): void;
  /** Register block IDs that this node stores locally */
  trackBlock(blockId: string): void;
  /** Remove a block ID from tracking */
  untrackBlock(blockId: string): void;
  /** Force a rebalance check (e.g. on startup) */
  checkNow(): Promise<RebalanceEvent | null>;
}
```

### Responsibility Tracking

The monitor maintains a `Set<string>` of locally-stored block IDs. On each rebalance check:

1. For each tracked block ID, compute `sha256(blockId)` to get the key.
2. Call `fret.assembleCohort(key, clusterSize)` to get the current responsible set.
3. Determine if this node is in the top `responsibilityK` peers by XOR distance.
4. Compare against previous responsibility snapshot.
5. Emit gained/lost sets.

The previous responsibility snapshot is stored as a `Map<string, boolean>` (blockId → wasResponsible).

### ArachnodeInfo Status Lifecycle

Wire the existing `ArachnodeFretAdapter` status transitions:

- On node start: set status to `joining`
- After first successful rebalance check: transition to `active`
- When rebalance detects lost blocks needing migration: transition to `moving`
- After migration completes: transition back to `active`
- On graceful shutdown: transition to `leaving` (integrate with libp2p stop)

### Integration Points

- **NetworkManagerService**: Add a `getRebalanceMonitor()` accessor. The monitor is created during service construction and started/stopped with the service.
- **Existing code**: The monitor does NOT change how `findCluster` or `computeResponsibility` work — it layers on top as an event source.

## TODO

- Create `RebalanceMonitor` class implementing the `Startable` interface
- Add debounced listener for libp2p `connection:open` / `connection:close`
- Implement responsibility recomputation using existing `computeResponsibility()` and FRET
- Integrate `PartitionDetector.detectPartition()` as a guard
- Wire `ArachnodeInfo` status transitions in `ArachnodeFretAdapter`
- Add `onRebalance` event handler registration
- Write unit tests for:
  - Debounce behavior (rapid joins/leaves produce single event)
  - Correct gained/lost computation when peers change
  - Partition suppression
  - ArachnodeInfo status transitions
- Integrate into `NetworkManagerService` lifecycle
