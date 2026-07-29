----
description: When an operator does not choose a group size, the part of the node that picks which peers form a group assumes sixteen while every other part assumes ten — so groups come out larger than the safety checks are measuring against, and the check meant to catch a suspiciously small group can be fooled.
files: packages/db-p2p/src/libp2p-node-base.ts (lines ~612, ~680, ~699-713), packages/db-p2p/src/libp2p-key-network.ts (constructor, line ~114)
difficulty: easy
----

# The peer-selection layer defaults to a different cluster size than everything else

## What happens

`createLibp2pNodeBase` resolves `options.clusterSize` for its consumers, but not consistently:

- `networkManagerService` gets `options.clusterSize ?? 10`
- `consensusConfig.clusterSize` gets `options.clusterSize ?? 10`
- `new Libp2pKeyPeerNetwork(node, options.clusterSize, ...)` gets it **raw**, so when the option is
  unset the key network falls back to *its own* constructor default of `16`

An embedder who never sets `clusterSize` therefore runs a node whose peer-selection layer assembles
cohorts of up to sixteen members while the consensus layer believes "full size" is ten.

## Why it matters

`clusterSize` is not only a replication target. The membership admission gate in `ClusterMember`
uses the configured size as its yardstick for "is this declared peer set suspiciously small?" — the
protection against a partitioned or attacker-shrunk group being voted through as if it were whole.
With real cohorts of sixteen and a yardstick of ten, a set that has quietly lost six members still
measures as full size and passes the gate. The gap is exactly the size of the default mismatch.

The same figure feeds the corroboration floor used when repairing a block. There the mismatch is
harmless — the floor takes the larger of observed peers and configured size, so the observed sixteen
wins — but it is the same number reading differently in two places, which is how the admission gap
above went unnoticed.

## Expected behaviour

One resolved cluster size per node, computed once and handed to every consumer. A node should not be
able to start with its peer-selection breadth and its consensus yardstick disagreeing. A construction-
time assertion in the same spirit as `assertSuperMajorityCoupling` (`libp2p-node-base.ts`, which
already fails fast when the member and coordinator resolve different super-majority thresholds) would
keep them coupled.

## Related

`plan/3-clustersize-conflates-replication-factor-and-admission-yardstick` covers the deeper problem —
that one setting is doing two unrelated jobs — and may resolve this as a side effect. This ticket is
the narrower, mechanical half and is worth fixing regardless of how that design question lands, since
the two defaults disagreeing is a bug under any interpretation of what the setting means.

Found during review of `bug-reconcile-cannot-heal-two-node-cohort`; not caused by it.
