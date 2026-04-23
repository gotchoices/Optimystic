description: Block transfer protocol for rebalance-driven data migration
files:
  - packages/db-p2p/src/cluster/block-transfer.ts
  - packages/db-p2p/src/cluster/block-transfer-service.ts
  - packages/db-p2p/test/block-transfer.spec.ts
----

## Summary

Block transfer protocol for migrating data when the topology changes. Two components:

**BlockTransferService** — libp2p protocol handler on `/db-p2p/block-transfer/1.0.0`. Handles incoming `pull` (serves local blocks) and `push` (validates received blocks) requests using length-prefixed JSON over streams. Factory `blockTransferService()` follows the libp2p service pattern.

**BlockTransferCoordinator** — consumes `RebalanceEvent` from the RebalanceMonitor. Pull path delegates to `RestorationCoordinator.restore()` (no duplication of ring-walking discovery). Push path reads blocks locally and sends to new owners via `BlockTransferClient`. Features: semaphore-based concurrency limiting, exponential backoff retries, configurable transfer timeout, partition guard, in-flight dedup.

## Review findings and fixes

1. **Fixed: Deadlock in retry path** — Original code used recursive calls for retries while holding the semaphore. If `maxConcurrency` tasks all retried simultaneously, the recursive calls would block waiting for semaphore slots held by the sleeping outer calls. Converted to loop-based retry that releases the semaphore between attempts.

2. **Fixed: Duplicate RebalanceEvent type** — Removed inline `RebalanceEvent` from `block-transfer.ts` and imported from canonical `rebalance-monitor.ts`.

3. **Fixed: Missing package exports** — Added `block-transfer.ts` and `block-transfer-service.ts` to `index.ts`.

4. **Fixed: Unused imports** — Removed `BlockTransferRequest`, `BlockTransferResponse`, `BlockId`, `PeerId` imports that were no longer referenced.

5. **Noted: Push handler does not persist** — `handlePush()` validates incoming block data but does not store it. The pushed data format (raw IBlock JSON) doesn't match `BlockArchive` needed by `BlockStorage.saveRestored()`. This should be wired when RebalanceMonitor integrates with storage. TODO comment added in code.

## Integration point

```typescript
rebalanceMonitor.onRebalance(async (event) => {
  await blockTransferCoordinator.handleRebalanceEvent(event);
});
```

## Testing (20 tests)

- Pull via RestorationCoordinator (success, failure, retry)
- Push to new owners (success, no local data, push disabled)
- Partition guard (pull and push)
- Concurrency limiting (verified max <= config)
- Deadlock regression: all concurrent tasks retrying simultaneously
- Rebalance event handling (gained + lost, empty)
- Idempotent block receipt
- Timeout for slow transfers
- Service start/stop and idempotent lifecycle
- Protocol string building
- Request/Response type shape validation
