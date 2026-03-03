description: Topology change detection and rebalance scheduling — implementation review
dependencies: libp2p connection events, FRET assembleCohort, ArachnodeFretAdapter, NetworkManagerService, PartitionDetector
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (new)
  - packages/db-p2p/test/rebalance-monitor.spec.ts (new, 14 tests)
  - packages/db-p2p/src/storage/arachnode-fret-adapter.ts (added setStatus helper)
  - packages/db-p2p/src/network/network-manager-service.ts (added initRebalanceMonitor/getRebalanceMonitor)
  - packages/db-p2p/src/index.ts (added export)
----

## What was built

**RebalanceMonitor** — a `Startable` service that proactively detects topology changes and identifies responsibility shifts for locally-tracked blocks.

### Key behaviors

- **Listens** to libp2p `connection:open` and `connection:close` events
- **Debounces** rapid topology changes (configurable, default 5s) to avoid thrashing
- **Throttles** rebalance scans to `minRebalanceIntervalMs` (default 60s)
- **Recomputes** responsibility using FRET's `assembleCohort()` + `hashKey()`
- **Emits** `RebalanceEvent` objects with gained/lost blocks and new owners
- **Suppresses** rebalancing when `PartitionDetector.detectPartition()` is true (configurable)
- **Status transitions** via `setStatus()` which updates `ArachnodeInfo` through `ArachnodeFretAdapter`

### Integration points

- `NetworkManagerService.initRebalanceMonitor(partitionDetector, fretAdapter, config?)` — creates and stores the monitor
- `NetworkManagerService.getRebalanceMonitor()` — accessor
- Monitor is stopped automatically during `NetworkManagerService.stop()`
- `ArachnodeFretAdapter.setStatus(status)` — convenience method for updating just the status field

### API surface

```typescript
interface RebalanceMonitor extends Startable {
  onRebalance(handler: (event: RebalanceEvent) => void): void
  trackBlock(blockId: string): void
  untrackBlock(blockId: string): void
  getTrackedBlockCount(): number
  checkNow(): Promise<RebalanceEvent | null>
  setStatus(status: ArachnodeInfo['status']): void
}
```

## Testing notes

14 tests covering:
- Lifecycle: register/remove listeners, idempotent start/stop
- Block tracking: track/untrack
- Responsibility detection: gained, lost, unchanged, combined gained+lost
- Debounce: rapid topology changes coalesce into single event; no events after stop
- Partition suppression: suppressed when detected (configurable)
- Throttling: respects minRebalanceIntervalMs
- Status transitions: setStatus updates ArachnodeInfo correctly
- Event handlers: multiple handlers fire, error in one doesn't block others

All 226 tests pass. Full project build succeeds.

## Usage

```typescript
// After libp2p, FRET, and adapter are available:
const monitor = networkManager.initRebalanceMonitor(partitionDetector, fretAdapter, {
  debounceMs: 5000,
  minRebalanceIntervalMs: 60000,
  suppressDuringPartition: true
});

// Register handler (e.g., feed to BlockTransferCoordinator)
monitor.onRebalance(event => coordinator.handleRebalanceEvent(event));

// Track blocks this node stores
monitor.trackBlock('block-abc');

// Start listening for topology changes
await monitor.start();

// Manual check (e.g., on startup)
const event = await monitor.checkNow();

// Status transitions
monitor.setStatus('moving');  // during rebalance
monitor.setStatus('active');  // after rebalance completes
```
