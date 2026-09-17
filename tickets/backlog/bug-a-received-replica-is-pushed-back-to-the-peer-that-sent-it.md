description: When a machine receives a copy of a block from another machine, its background rebalance check treats the block as brand new and sends it straight back to the sender, along with every other group member. Each received copy therefore costs a second, useless transfer.
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`recordCommittedHolders`: the evidence path commits already use)
  - packages/db-p2p/src/cluster/block-transfer-service.ts (`handlePush`: knows the sending peer)
  - packages/db-p2p/src/cluster/reconcile-block.ts (reconcile and read-repair acquisition: know which peers served the agreed copy)
  - packages/db-p2p/src/libp2p-node-base.ts (`ownedBlocks` feed; `committedHoldersTarget` late-bound sink)
repro: static
severity: cosmetic
likelihood: normal-use
tradeoffs: The echo stops after one round, because each side records the other as a holder from its own push result, so a maintainer may judge one extra transfer per received replica not worth another reporting path.
----
# A received replica is pushed back to the peer that sent it

## What the code does

`StorageRepo.saveReplicatedBlock` emits a collection change, so a block received as a replica enters the node's tracked set just as a commit does. Replicas arrive through a block-transfer push (`handlePush`), a commit-path reconcile, or read-repair acquisition. The rebalance monitor has no memory of the block, so its next check reports the whole non-self cohort `grown`, which pushes the block to every member including the one that just sent it. It also reports the block `gained`, which triggers a pull; see `bug-rebalance-pulls-blocks-it-already-holds-and-discards-the-copy`.

Ticket `rebalance-pushes-freshly-committed-blocks-back-to-members-that-hold-them` closed this for commits. `RebalanceMonitor.recordCommittedHolders` takes evidence of who holds a block, and the cluster member and coordinator report it. No receive path reports anything.

## Expected

A node that stores a replica records the peer(s) the copy came from as holders, as commits already do. The sender is known in `handlePush`, and the agreeing archive sources are known in reconcile. The next check then pushes only to cohort members with no evidence of holding it.

## How to confirm

In a two-member setup like `test/rebalance-committed-holders.spec.ts`, deliver a growth push from one member to the other, run `checkNow()` on the receiver, and count `grown` entries that point back at the sender.
