# Partition Healing and Reconciliation

description: partition healing is designed (docs/transactions.md) but not implemented; divergent state after a network partition requires manual intervention
dependencies: 2-2pc-state-persistence
files:
  - docs/transactions.md (lines 1776-1880, design spec)
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-p2p/src/cluster/cluster-repo.ts
----

The partition healing protocol is designed in `docs/transactions.md` with three classifications — Behind (normal sync), Ahead (tentative), Forked (conflict) — but none of the reconciliation logic is implemented. Currently the system relies on normal sync after partition recovery; if both sides committed divergent transactions during the partition, the resulting conflict requires manual intervention.

The super-majority (75%) threshold prevents both sides from committing in a 50/50 split, but asymmetric partitions (e.g., 80/20 where 80% side commits) can still produce divergent state when the 20% side reconnects.
