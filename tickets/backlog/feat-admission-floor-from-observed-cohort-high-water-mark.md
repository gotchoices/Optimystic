----
description: Nodes currently need an operator to tell them how many peers the network really has before they can spot a suspiciously small group of writers; they could instead remember the largest group they have ever seen and use that, so the protection works without configuration.
files: packages/db-p2p/src/cluster/cluster-repo.ts (admitMembership), packages/db-p2p/src/cluster/quorum-restore.ts (corroboratorCapacity), packages/db-p2p/src/libp2p-node-base.ts (persistence wiring)
difficulty: hard
tradeoffs: The design is not settled — nobody has an answer for how a deployment that legitimately shrinks recovers from a high-water mark it can never meet again — so this is not yet buildable, and the cheap interim already covers the discoverability half.
----

# Learn the cohort-size reference instead of being told it

## Background

Two safety checks need to know how big a peer group *ought* to be:

- The membership admission gate refuses to co-sign a write whose declared peer set looks
  suspiciously small.
- The block-repair corroboration floor refuses to trust a lone peer's copy of a block unless the
  group genuinely cannot supply a second one.

Both currently take that number from configuration (`assumedClusterSize`, after
`split-admission-floor-from-replication-factor` and `corroboration-floor-uses-assumed-cluster-size`
land). Configuration is used rather than what the node currently observes because the observed view
comes from unauthenticated peer routing: a partition, or an attacker with routing influence, can
shrink what a node sees and thereby talk the safety requirement down.

The cost is that the protection is only as good as the operator's willingness to configure it, and
the default has to be permissive so that small deployments work out of the box. An unconfigured
large network therefore gets a weak check exactly when its own network-size estimate is unconfident
— which is the condition a partition creates.

## The idea

Track the largest cohort this node has ever confidently observed, persist it, and use that as the
reference instead of (or as a floor under) the configured value.

The property that makes it attractive: the figure is monotonically non-decreasing, so an attacker
who shrinks a node's current view cannot lower it. Only a node that has *never* seen the real
network could be fooled, which narrows the exposure to fresh nodes bootstrapping directly into a
partition.

## What needs deciding before this is buildable

- **Where the figure lives and how it is persisted.** It must survive restart or it is worthless
  after any process bounce. What is the storage seam?
- **What counts as a confident observation.** Presumably the same confidence gate the admission
  path already uses, but it needs stating.
- **What happens on a legitimate permanent shrink.** A deployment decommissioned from ten nodes to
  three would be write-dead forever against a high-water mark of ten. Some decay, reset, or explicit
  operator override is mandatory, and its design is the hard part — a decay rule loose enough to
  allow real shrinkage is also loose enough for a patient attacker to wait out.
- **Whether the configured value becomes a ceiling, a floor, or is retired.**

Until the shrink question has an answer, this is not ready to plan.

## Related

- `implement/split-admission-floor-from-replication-factor` — introduces `assumedClusterSize` and
  documents the tradeoff this ticket would remove.
- `implement/corroboration-floor-uses-assumed-cluster-size` — the second consumer.
- `corroboration-floor-defaults-to-two-for-large-meshes` (landed) — the two consumers no longer share
  a *default*, only the operator field. Resolution now happens in
  `packages/db-p2p/src/cluster/cluster-policy.ts` (`resolveClusterPolicy`), which produces
  `assumedClusterSize` (admission gate; permissive default 2) and `repairCorroborationClusterSize`
  (repair floor; strict default = `clusterSize`). So the "default has to be permissive" cost above now
  applies only to the admission gate. A learned high-water mark should still subsume **both**;
  `cluster-policy.ts` is the site where it would replace them.
