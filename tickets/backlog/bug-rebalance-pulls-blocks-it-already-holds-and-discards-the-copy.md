description: When a machine notices it has become responsible for a block, its background rebalance fetches a copy from another machine and then throws that copy away. It only ever does this for blocks it already stores, so every such fetch is wasted network traffic, including one per stored block after every restart.
files:
  - packages/db-p2p/src/cluster/block-transfer.ts (`pullBlocks`, `executePull`; `RebalanceReactionResult.pulled` claims "now durably held locally")
  - packages/db-p2p/src/storage/restoration-coordinator.ts (`restore`, `queryPeer`: returns the archive, persists nothing)
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`gained` is computed only over `trackedBlocks`)
  - packages/db-p2p/src/libp2p-node-base.ts (`ownedBlocks` feed and startup seed: the only ways a block becomes tracked)
repro: static
severity: cosmetic
likelihood: normal-use
tradeoffs: The waste is bounded (one fetch per block per responsibility change), and removing the pull outright gives up a hook that would matter if a node ever tracked a block it does not hold, so a maintainer may prefer to wait until a relay-bandwidth profile shows it.
----
# Rebalance pulls blocks it already holds, and discards what it fetches

## What the code does

`RebalanceMonitor` reports a block `gained` when this node becomes responsible for it. The node's reaction (`BlockTransferCoordinator.pullBlocks` → `executePull`) calls `RestorationCoordinator.restore(blockId)`, which walks ring peers with `SyncClient.requestBlock` (one `/db-p2p/sync` stream per peer asked) and returns the first archive it gets. `executePull` records the block as `pulled` and drops the archive. Nothing writes it to storage, although `RebalanceReactionResult.pulled` is documented as "now durably held locally".

The monitor only examines blocks in its tracked set. On a live node that set is filled from local storage change events (commits and received replicas) and from the startup storage scan. So a block reported `gained` is always a block this node already stores. The pull therefore can neither add a missing block nor, since nothing is saved, bring a stale one up to date.

## Where it costs

- After a restart the monitor has no memory, so the first check reports every stored block `gained`. That is one or more sync round trips per stored block. `growthBlockBudget` bounds the `grown` arm only, not `gained`.
- Before ticket `rebalance-pushes-freshly-committed-blocks-back-to-members-that-hold-them`, every freshly committed block was pulled this way. That ticket stops it for commits this node holds, but not for received replicas or restarts.

## Expected

Either the pull stores what it fetches (and is aimed at a block the node is missing or behind on), or the `gained` reaction does no network work for a block the node already holds. `pulled` should mean what its documentation says.
