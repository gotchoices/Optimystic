----
description: Churn re-replication validates but never persists pushed blocks
files: packages/db-p2p/src/cluster/block-transfer-service.ts, packages/db-p2p/src/cluster/spread-on-churn.ts
----

When a peer departs the cluster, `spread-on-churn` pushes the blocks that peer was responsible for to their new owners so the data remains replicated across the surviving devices. It does this through `BlockTransferClient.pushBlocks`, sent with a `'replication'` reason for resilience (`packages/db-p2p/src/cluster/spread-on-churn.ts:227`).

On the receiving side, `BlockTransferService.handlePush` does not actually store the pushed blocks (`packages/db-p2p/src/cluster/block-transfer-service.ts:130-158`). For each pushed block it only base64-decodes and `JSON.parse`s the payload to confirm it is parseable, then echoes the block id back as `accepted` in the response. Nothing is written to local storage. The method carries a `TODO` stating that persistence should be wired when `RebalanceMonitor` integrates with `BlockStorage.saveRestored()`.

The consequence is that churn-triggered re-replication silently fails: the sending node sees a successful push and marks the target as succeeded, while the receiving node retains nothing. After the departing peer is gone, the block has no durable replica on the new owner. This directly defeats Sereus's stated goal that data is distributed across devices for resilience — the resilience mechanism reports success while leaving the data unreplicated.

Expected behavior: `handlePush` must persist the blocks it accepts so that re-replication on churn genuinely replicates data to the new owner. Accepted pushed blocks should be written to local storage (e.g. via `BlockStorage.saveRestored`), reconciling the pushed wire format (a serialized `IBlock`) with whatever shape the storage layer requires for a durable restored block. Only blocks that are both received and successfully persisted should be reported back as accepted; a block that fails to persist must be surfaced as missing/failed so the sender does not falsely treat it as replicated.

Related prior work: `tickets/complete/6.5-block-transfer-protocol.md` introduced this protocol and explicitly noted under review finding 5 that the push handler does not persist, deferring it to storage integration. This ticket tracks closing that gap now that churn-driven spread depends on it.
