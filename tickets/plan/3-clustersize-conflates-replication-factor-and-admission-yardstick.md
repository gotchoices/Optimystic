----
description: One setting controls two unrelated things — how many copies of data to keep, and how small a group of nodes a member will accept a write from — and its default is large enough that any small deployment silently refuses every write.
files: packages/db-p2p/src/libp2p-node-base.ts (lines 639-650), packages/db-p2p/src/cluster/cluster-repo.ts (lines 865-945), packages/db-core/src/cluster/structs.ts (ClusterConsensusConfig)
difficulty: medium
----

# `clusterSize` does two jobs, and its default breaks small deployments

Reported by the Sereus embedder, which lost time to it. Filed as `plan/` because the fix is a
design call for this project's maintainers, not a mechanical change.

## What happens today

`clusterSize` originally meant one thing: **the replication factor** — how many nodes should
hold a copy of each block. It is the coordinator's target breadth.

The `cluster-membership-admission-gate` work (`e285cdb`, `f568454`) gave it a second,
unrelated job: `libp2p-node-base.ts:649` now feeds it into `ClusterMember`, where
`admitMembership` (`cluster-repo.ts:865-945`) uses it as the **yardstick for whether an
inbound write comes from a legitimately-sized group**. When a member cannot confidently
estimate the network size via FRET, it refuses to co-sign any write whose declared peer set is
smaller than its own configured `clusterSize`, reporting
`membership-not-admitted:low-confidence-downsize`.

These two jobs pull in opposite directions:

- As a replication factor, you want it **high** — more copies, more durability.
- As an admission yardstick, you want it **no higher than the number of nodes that actually
  exist**, or every write is refused.

An operator cannot satisfy both with one number. Sereus had to lower its replication factor
from 3 to 2 purely to make writes work at all, and has escalated the durability consequence to
its own product owners as a separate decision. That is a real cost imposed by the conflation.

## The default makes it worse

`libp2p-node-base.ts:649` is `clusterSize: options.clusterSize ?? 10`. Before the admission
gate that default was coordinator-only and effectively inert for members. Now **any embedder
who never set `clusterSize` runs the admission gate against a ten-node reference** and, under
low FRET confidence, refuses every write from any group smaller than ten. A two- or three-node
deployment using the library out of the box is silently write-dead.

The failure is also hard to diagnose from the outside: it surfaces as transaction rejection by
validators, which reads like a peer problem rather than a configuration default.

## What to decide

The shape of the fix is a maintainer call. The options, with the tradeoffs the reporter can see:

1. **Split the setting.** Keep `clusterSize` as the replication factor and add a separate
   admission floor (`minAdmissibleClusterSize`, or similar) with its own small default (2–3).
   Clearest semantics; costs a new config field and a migration note for anyone who tuned
   `clusterSize` since 0.16.
2. **Derive the yardstick from observed membership** rather than configuration, using the
   configured size only as a ceiling. Removes the operator burden entirely, but leans harder on
   `findCluster`, which is unauthenticated — a partition or routing-level attacker could shrink
   a member's view and talk the requirement down. Note this is the same tension already resolved
   one way in `quorumSize`'s `corroboratorCapacity` (commit `50af693`), which deliberately takes
   `max(observed, configured − 1)` for exactly this reason. Whatever is chosen here should be
   consistent with that decision or explain why it differs.
3. **Keep one setting but change the default to something small** (2 or 3) and document the
   dual role prominently. Cheapest; leaves the conflation in place and merely moves which
   deployments break — a large deployment that never configures it now gets a weak admission
   gate instead of a dead one. Arguably worse, since the failure becomes silent rather than loud.

Whichever is picked, the reporter asks that the error message name the configured value —
`membership-not-admitted:low-confidence-downsize (configured clusterSize=10, declared=2)` —
because the current message gives no hint that a local setting is responsible.

## Related

- `bug-read-repair-unrepairable-small-cluster` (fixed, `50af693`) was the read-side half of the
  same "small clusters were not really supported" theme.
- `feat-inbound-stream-authorization-hook` is a separate request from the same embedder.
