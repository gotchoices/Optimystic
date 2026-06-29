description: A second background component that re-homes data when the network's peer membership shifts is also switched off; turn it on and have it share one list of "blocks this node owns" with the churn re-replication component instead of each keeping its own.
prereq: optimystic-spread-on-churn-monitor-wiring
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/block-transfer.ts
----

# Wire RebalanceMonitor and unify the tracked-block source with SpreadOnChurnMonitor

## Background

While wiring `SpreadOnChurnMonitor` (`optimystic-spread-on-churn-monitor-wiring`) it was found
that `RebalanceMonitor` (`packages/db-p2p/src/cluster/rebalance-monitor.ts`) is **also** entirely
inert in production: `NetworkManagerService.initRebalanceMonitor` is never called, it is never
`start()`ed, and nothing feeds its `trackBlock`. Both monitors maintain their **own**
`trackedBlocks: Set<string>` and both react to libp2p topology change, but neither is driven on a
live node.

The spread ticket wired `SpreadOnChurnMonitor` from the authoritative owned-block feed
(`StorageRepo.onAnyCollectionChange`) and bounded its set with a no-local-data self-prune, but it
deliberately did **not** wire `RebalanceMonitor` (out of scope; `RebalanceMonitor` additionally
depends on `ArachnodeFretAdapter`, only constructed when arachnode is enabled, and on a separate
block-transfer reaction path via `cluster/block-transfer.ts`).

## What this ticket is about

- Wire `RebalanceMonitor` into `createLibp2pNodeBase` (when arachnode/FRET are available),
  `start()` it, and connect its `RebalanceEvent { gained, lost, newOwners }` to the actual
  block-transfer reaction (move replicas toward `newOwners` on `lost`; optionally pull on
  `gained`) — the rebalance counterpart to spread's churn push.
- **Unify the tracked-block source.** Today each monitor would keep a divergent `Set`. Introduce a
  single owned-block registry (the `StorageRepo.onAnyCollectionChange` feed established by the
  spread ticket) shared by both monitors, and drive eviction from `RebalanceMonitor`'s `lost`
  signal (the authoritative "no longer responsible" event) so `SpreadOnChurnMonitor` can untrack
  on responsibility loss rather than only on the no-local-data self-prune.
- Consider an initial-scan seed so blocks already durable from a previous run (persistent storage)
  are tracked at startup — the spread ticket documented this gap (events only fire on
  commit/replica, not for pre-existing blocks).

## Use case

When the network's peer membership shifts (not just a departure but a rebalance of which peers are
closest to a key), a node that has gained or lost responsibility for blocks should move data
accordingly, and both resilience mechanisms should agree on exactly which blocks this node owns
rather than tracking divergent sets.

## Notes

- `RebalanceMonitor` already computes gained/lost via FRET cohort membership
  (`rebalance-monitor.ts:151`); this ticket drives it and reacts to it.
- `BlockTransferCoordinator` (`packages/db-p2p/src/cluster/block-transfer.ts`) is the existing
  reaction primitive (see `test/block-transfer.spec.ts`).
- Keep the change sized to one agent run; if "wire + react" and "unify tracked set" prove too
  large together, split into prereq-chained tickets.
