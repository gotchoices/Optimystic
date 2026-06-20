description: SpreadOnChurnMonitor is defined but never driven by the running node — wire NetworkManagerService.initSpreadOnChurnMonitor into node startup and feed it the blocks this node owns via trackBlock, so churn actually triggers re-replication pushes.
prereq: optimystic-churn-rereplication-persist-handlepush
files: packages/db-p2p/src/cluster/spread-on-churn.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-node-base.ts
----

# Wire SpreadOnChurnMonitor into the node + track owned blocks

## Problem

`SpreadOnChurnMonitor` (`packages/db-p2p/src/cluster/spread-on-churn.ts`) implements
the churn-resilient spread protocol: on a debounced `connection:close` it re-pushes
the blocks it is tracking to expansion-cohort peers so a departing owner's data keeps
a durable replica count. With `optimystic-churn-rereplication-persist-handlepush`
landed, the **receiving** side now persists those pushes — but the **sending** side is
never activated on a real node:

- `NetworkManagerService.initSpreadOnChurnMonitor(...)`
  (`network-manager-service.ts:97`) constructs the monitor, but **nothing calls it**.
- Nothing ever calls `monitor.trackBlock(blockId)`, so even if it were started,
  `performSpread` early-returns (`trackedBlocks.size === 0`).
- `createLibp2pNodeBase` (`libp2p-node-base.ts`) never instantiates or starts the
  monitor.

Net effect: churn re-replication is inert end-to-end. The persistence fix proved the
landing path works in isolation, but no running node drives it.

## Expected behavior / requirements

- During node startup (`createLibp2pNodeBase`), once libp2p + FRET + the partition
  detector + key network are available, initialize and `start()` the
  `SpreadOnChurnMonitor`, wired with the node's local repo and peer network and the
  configured `clusterSize` / `protocolPrefix` (the prefix must match the registered
  `blockTransfer` protocol handler so client and server agree).
- The monitor must be fed the set of blocks this node is responsible for via
  `trackBlock` / `untrackBlock`, kept in sync as responsibility changes (gained/lost).
  Identify the authoritative source of "blocks this node owns" — likely the same
  responsibility signal `RebalanceMonitor` consumes (`rebalance-monitor.ts` also has
  `trackBlock`/`untrackBlock`) — and decide whether the two monitors should share one
  tracked-block source rather than each maintaining its own set.
- Provide config plumbing (`SpreadOnChurnConfig`) through `NodeOptions` so the
  protocol can be tuned/disabled per node.
- Ensure the monitor is disposed on node stop (mirror the existing
  `node.stop` cleanup chaining used for the cluster member / arachnode interval).

## Use case

A peer in a block's cluster disconnects. A surviving middle-cohort peer detects the
departure, and after the debounce window pushes its tracked blocks to expansion-cohort
peers, which now durably persist them — restoring the replica count without waiting
for a full rebalance. This ticket is what makes that sequence fire on a live node.

## Notes / open questions

- Decide the relationship with `RebalanceMonitor`: both track owned blocks and both
  react to topology change. Avoid two divergent tracked-block registries.
- Eligibility (`neighborDistance`/`effectiveD`) and partition suppression already live
  in `performSpread`; this ticket is about *driving* it, not re-implementing it.
- End-to-end coverage will likely need an `OPTIMYSTIC_INTEGRATION`-gated multi-node
  test (a real departure → push → receiver `repo.get` serves the replica).
