description: Block transfer protocol for rebalance-driven data migration
files:
  - packages/db-p2p/src/cluster/block-transfer.ts
  - packages/db-p2p/src/cluster/block-transfer-service.ts
  - packages/db-p2p/test/block-transfer.spec.ts
----

## Summary

Implemented the block transfer protocol for rebalance-driven data migration. When the (forthcoming) RebalanceMonitor identifies gained/lost responsibilities, the BlockTransferCoordinator orchestrates pulling blocks from existing holders and pushing blocks to new owners.

### What was built

**BlockTransferService** (`block-transfer-service.ts`):
- Libp2p protocol handler on `/db-p2p/block-transfer/1.0.0`
- Handles incoming `pull` requests by reading blocks from local repo and returning base64-encoded data
- Handles incoming `push` requests by accepting and validating block data
- Uses length-prefixed JSON over streams, matching the existing SyncService pattern
- Includes `BlockTransferClient` extending `ProtocolClient` for outbound requests
- Factory function `blockTransferService()` follows the libp2p service pattern

**BlockTransferCoordinator** (`block-transfer.ts`):
- Consumes `RebalanceEvent` (type defined here, matching the RebalanceMonitor ticket spec)
- **Pull path**: Delegates to `RestorationCoordinator.restore()` which already handles ring-based discovery and fetching — no duplication of discovery logic
- **Push path**: Reads blocks from local repo, sends to new owners via `BlockTransferClient`
- Concurrency limiting via semaphore pattern (`maxConcurrency` config, default 4)
- Exponential backoff retries on failure (`maxRetries` config, default 2)
- Configurable transfer timeout (`transferTimeoutMs` config, default 30s)
- Partition guard: pauses all transfers when `PartitionDetector.detectPartition()` is true
- In-flight tracking prevents duplicate concurrent transfers for the same block
- `handleRebalanceEvent()` method processes a full event (pull gained + push lost in parallel)

### Integration point

The coordinator exposes `handleRebalanceEvent(event: RebalanceEvent)` which should be wired from `CoordinatorRepo` when the RebalanceMonitor (sibling ticket `3-rebalance-monitor`) is implemented:

```typescript
rebalanceMonitor.onRebalance(async (event) => {
  await blockTransferCoordinator.handleRebalanceEvent(event);
});
```

### Testing (19 tests)

- Pull from existing holder on gained responsibility
- Failed pulls when restoration returns undefined
- Retry behavior for failed pulls
- Push to new owner on lost responsibility
- Push fails gracefully when no local data available
- Push disabled via config
- Partition guard (no transfer during partition) — pull and push
- Concurrency limiting (verified maxConcurrent <= config)
- Complete rebalance event handling (gained + lost)
- Empty rebalance event (no-op)
- Idempotent block receipt
- Timeout behavior for slow transfers
- Service start/stop protocol registration
- Idempotent service start/stop
- Protocol string building
- Request/Response type shape validation

### Key design decisions

1. **Reuses RestorationCoordinator for pulls** — avoids duplicating the ring-walking discovery logic that already works for cache-miss restoration
2. **Push is optional** (`enablePush: false` disables it) — allows gradual rollout
3. **RebalanceEvent type defined inline** — matches the sibling ticket spec exactly; when RebalanceMonitor is built, either re-export from there or keep the shared type
4. **No changes to existing files** — all new code; wiring happens when RebalanceMonitor lands
