description: On a private network the application knows exactly which machines are members, but the storage layer still works out who should hold each block by looking at whichever peers happen to be advertising the right protocol at that moment. Let the application hand the storage layer its authenticated member list, so small private groups get a fixed, unspoofable answer and the hash-based rule only kicks in once the group is bigger than the replication factor.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (~line 972 `findCluster`, ~line 1010-1043 the membership-scoped path that admits only peers advertising the network's cluster or repo protocol; ~line 1220-1230 `membershipOf`)
  - packages/db-core/src/cohort-topic (the existing `IMembershipSource` port, which already expresses "an authenticated list of member peer ids" for the topic substrate)
  - packages/db-p2p/src/cluster/cluster-policy.ts (`repairCorroborationClusterSize`, the one yardstick sereus already derives from enrolled machines; this ticket generalizes that instinct)
  - ../sereus/packages/cadre-core/src/cadre-node.ts (`listAuthorizedMembers`, the authenticated count the control network already computes)
difficulty: hard
tradeoffs: A declared list that is wrong in the too-high direction makes every cohort unfillable, which sereus's docs already identify as the worse failure, and strands today have no authenticated per-strand serving list at all; a maintainer may prefer to wait until that census exists rather than add a second, optional placement input.
----

# Why

The 2026-09-14 design review of `blocked/writer-and-servers-disagree-on-where-a-block-lives` found that every small-network rule in the codebase (self always in the cohort, writer always coordinates, cohort shrinks to whoever is visible) is a consequence of the same fact: the storage layer has no notion of *declared* membership, only *observed* membership from unauthenticated routing. The docs already say the safety yardsticks must be "declared, never observed" because an attacker who can shrink the observed view must not be able to talk a threshold down. Cohort assembly is the one place that principle is not applied.

# What to build

- An optional membership source on the key network: an authenticated, application-supplied list of the peer ids that serve this network. When present, `findCluster` for a block is: if the member count is at most the cluster size, the whole list; otherwise the `clusterSize` members nearest the block's ring coordinate. Self is in the cohort if and only if self is in that result. When absent, today's observed-serving-peers behaviour stands.
- The quorum denominator for a cohort assembled from a declared list is the declared cohort size, never a downsized observed one. This is what makes "one of three phones is offline" a stall rather than a silent two-node commit, which is the precondition for the tentative lane in `feat-long-lived-pend-completes-as-members-appear` to be safe.
- Open networks (no list) keep the ring rule for everything and never see a change.

# Interactions to think about

- The membership-binding digest already folds the peer set into every record hash, so a declared cohort is naturally pinned for the life of a record.
- Sereus's control network has the exact list (every enrolled machine serves it). Strands do not yet (`../sereus/tickets/backlog/feat-strand-yardstick-from-serving-machines`); a strand would keep observed membership until that lands.
- Relay-only peers never advertise the storage protocols and would never appear in a declared list either; nothing changes for them.
