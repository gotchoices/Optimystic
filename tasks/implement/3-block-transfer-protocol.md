description: Block transfer protocol for rebalance-driven data migration
dependencies: 3-rebalance-monitor (RebalanceEvent), cluster protocol, repo get/pend/commit
files:
  - packages/db-p2p/src/cluster/block-transfer.ts (new)
  - packages/db-p2p/src/cluster/block-transfer-service.ts (new — libp2p protocol handler)
  - packages/db-p2p/test/block-transfer.spec.ts (new test)
  - packages/db-p2p/src/repo/coordinator-repo.ts (consume RebalanceEvent)
----

## Overview

After the RebalanceMonitor identifies gained/lost responsibilities (from `3-rebalance-monitor`), this task implements the actual block transfer mechanism. When a peer gains responsibility for a block, it fetches the block from an existing holder. When a peer loses responsibility, it can proactively push blocks to the new owners.

## Architecture

```
RebalanceMonitor ──→ BlockTransferCoordinator
                         ↓ (pull)          ↓ (push)
               existing holders      new responsible peers
                         ↕ BlockTransfer protocol ↕
```

### Protocol: `/db-p2p/block-transfer/1.0.0`

A new libp2p protocol for peer-to-peer block transfer:

```typescript
/** Request to transfer blocks */
interface BlockTransferRequest {
  type: 'pull' | 'push';
  /** Block IDs being transferred */
  blockIds: string[];
  /** Reason for transfer */
  reason: 'rebalance' | 'replication' | 'recovery';
}

/** Response with block data */
interface BlockTransferResponse {
  /** Blocks successfully transferred: blockId → serialized data */
  blocks: Record<string, Uint8Array>;
  /** Block IDs that couldn't be found/transferred */
  missing: string[];
}
```

### BlockTransferCoordinator

Consumes `RebalanceEvent` and orchestrates migration:

```typescript
interface BlockTransferConfig {
  /** Max concurrent transfers. Default: 4 */
  maxConcurrency?: number;
  /** Timeout per block transfer (ms). Default: 30000 */
  transferTimeoutMs?: number;
  /** Retry attempts for failed transfers. Default: 2 */
  maxRetries?: number;
  /** Whether to push blocks to new owners proactively. Default: true */
  enablePush?: boolean;
}
```

**For gained blocks** (pull):
1. Identify existing holders by querying `fret.assembleCohort()` for each block.
2. Open a `BlockTransfer` stream to the closest available holder.
3. Request block data via `pull` message.
4. Store received blocks locally via the storage layer.

**For lost blocks** (push):
1. If `enablePush` is true, proactively send blocks to new responsible peers.
2. Open `BlockTransfer` streams to `newOwners` from the `RebalanceEvent`.
3. Send block data via `push` message.
4. After confirmed receipt, optionally garbage-collect local copies (with a grace period).

### Backpressure & Throttling

- Limit concurrent transfers via a semaphore (`maxConcurrency`).
- Use exponential backoff on failed transfers.
- Respect `PartitionDetector` — pause transfers if partition detected.
- Track in-flight transfers to avoid duplicates.

### Integration with CoordinatorRepo

`CoordinatorRepo` subscribes to `RebalanceMonitor.onRebalance()` and delegates to `BlockTransferCoordinator`:

```typescript
// In CoordinatorRepo constructor or init:
rebalanceMonitor.onRebalance(async (event) => {
  if (event.gained.length > 0) {
    await blockTransfer.pullBlocks(event.gained);
  }
  if (event.lost.length > 0 && event.newOwners.size > 0) {
    await blockTransfer.pushBlocks(event.lost, event.newOwners);
  }
});
```

### Consistency Guarantees

- Transfers are idempotent — receiving a block you already have is a no-op.
- The 2PC consensus protocol remains the source of truth for writes. Block transfer is for **read availability**, not write consensus.
- A node that loses responsibility stops accepting new writes for those blocks (via `computeResponsibility` check) but continues serving reads until migration completes.

## TODO

- Define `BlockTransferRequest` / `BlockTransferResponse` message types
- Implement `BlockTransferService` as a libp2p protocol handler (length-prefixed JSON over streams)
- Implement `BlockTransferCoordinator` consuming `RebalanceEvent`
- Add pull logic: fetch blocks from existing holders
- Add push logic: send blocks to new responsible peers
- Add concurrency limiter (semaphore pattern)
- Wire into `CoordinatorRepo` via `rebalanceMonitor.onRebalance()`
- Write unit tests for:
  - Pull from existing holder on gained responsibility
  - Push to new owner on lost responsibility
  - Concurrency limiting
  - Timeout and retry behavior
  - Idempotent block receipt
  - Partition guard (no transfer during partition)
