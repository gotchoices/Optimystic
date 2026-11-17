description: When a machine stops being responsible for a piece of data and cannot confirm that the newly responsible machines have copies, it keeps the data, which is right, but it never tries the handoff again, although the code and docs say it does.
architecture: docs/internals.md#rebalancemonitor
files: packages/db-p2p/src/cluster/rebalance-monitor.ts (`performRebalanceCheck`, the `lost` condition), packages/db-p2p/src/libp2p-node-base.ts (the rebalance reaction, the "is retried on the next rebalance" comment), packages/db-p2p/src/cluster/block-transfer-service.ts (`BlockTransferCoordinator.handleRebalanceEvent`), docs/internals.md (§RebalanceMonitor, "Gated release")
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: The block stays stored and served on the old holder, other paths (the cohort-growth push from members still responsible, read repair, the under-replication drain) can still deliver it to the new owners, and the only certain cost is storage that is never released; a fix adds state to a monitor that is already intricate.
----
# A block kept after a failed handoff is never offered again

Found while planning native blobs (`tickets/backlog/blobs/2.61-feat-blob-rebalance-monitor-takes-a-routing-rule.md`), by reading the code. Not reproduced by a test.

## What the code does

`RebalanceMonitor.performRebalanceCheck` reports a block as `lost` on the one check where this node was responsible for it and no longer is (`!isResponsible && wasResponsible`). That check stores the block's state as not responsible, so on every later check `wasResponsible` is false and the block is not reported again.

The reaction (`BlockTransferCoordinator.handleRebalanceEvent`) releases a lost block only after confirming copies on enough new owners. A block whose push failed, or was skipped during a partition, is returned as `retained`: still tracked, still served. The comment at that site in `libp2p-node-base.ts` and docs/internals.md §RebalanceMonitor ("is retried next rebalance") both say the handoff is tried again on the next rebalance. Nothing does that: the monitor will not report the block `lost` a second time, and no other code walks the retained set.

## Consequence

A block retained once stays on a node that is no longer responsible for it until the node becomes responsible again or restarts (the restart seed re-tracks it with no prior state, so it is not reported `lost` then either). The storage is never released. Whether the new owners ever receive it depends on other paths: a member still in the cohort pushing through the growth arm, a read repairing it, or the under-replication drain if a ledger entry names it. If this node was the only holder, none of those is guaranteed to run.

## What would confirm it

A `rebalance-monitor` test: track a block, make the node lose responsibility with the reaction's confirm failing (so the block is retained), run a second check, and assert whether the block is reported `lost` again. The blob work adds an opt-in (`retainLost`) that makes the monitor re-report an id the reaction retained; blocks could use the same mechanism.

## Expected

A block the reaction retained is offered to its new owners again on later checks, bounded as the growth arm's retries are, until it is confirmed and released; or the comment and the doc are corrected to say it is not.
