----
description: A node decides how many peers a group should have in more than one place, and those places disagree — so a safety check can measure against the wrong number. Separately, when the numbers a node does settle on make block repair impossible, nothing tells the operator.
files: packages/db-p2p/src/libp2p-node-base.ts (~616, ~684, ~926), packages/db-p2p/src/libp2p-key-network.ts (constructor ~154), packages/db-p2p/src/cluster/cluster-policy.ts (resolveClusterPolicy), packages/db-p2p/src/cluster/quorum-restore.ts (corroboratorCapacity), packages/db-p2p/src/cluster/cluster-repo.ts (admitMembership), packages/db-p2p/src/repo/coordinator-repo.ts (decline log sites), docs/transactions.md
difficulty: easy
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: Neither arm changes a default and a deployment that explicitly configures every size sees no symptom, so a maintainer focused on features could reasonably say "configure it properly" and defer; the counter-argument is that both arms bit real users on the default path.
----

# One resolved cluster size per node, and say out loud what was resolved

A node carries several "how many peers" numbers: the replication factor (`clusterSize`), the
yardstick the membership admission gate uses to judge whether a declared peer set is suspiciously
small (`assumedClusterSize`), and the corroboration floor block repair requires
(`repairCorroborationClusterSize`). `packages/db-p2p/src/cluster/cluster-policy.ts`
(`resolveClusterPolicy`) already exists as the place these are settled.

Two separate incidents show the same weakness: **the resolution is neither complete nor visible.**
One consumer bypasses it and gets a different number than everyone else; and when the resolved
numbers make a deployment unable to heal itself, the only signal is a decline log line that never
names the setting responsible.

The deliverable is the invariant, not two patches: every size consumer takes its number from one
resolved policy object produced at construction, a construction-time assertion fails fast when two
consumers would disagree (in the spirit of the existing `assertSuperMajorityCoupling`), and the
resolution announces itself when it produces a self-defeating combination.

## Arm A — the peer-selection layer defaults to a different cluster size than everything else

`createLibp2pNodeBase` resolves `options.clusterSize` for its consumers, but not consistently
(verified by reading the code, not inferred):

- `networkManagerService` gets `options.clusterSize ?? 10` (`libp2p-node-base.ts:616`)
- `consensusConfig.clusterSize` gets `options.clusterSize ?? 10` (`libp2p-node-base.ts:926`)
- `new Libp2pKeyPeerNetwork(node, options.clusterSize, ...)` gets it **raw**
  (`libp2p-node-base.ts:684`), so when the option is unset the key network falls back to *its own*
  constructor default of `16` (`libp2p-key-network.ts:154`)

An embedder who never sets `clusterSize` therefore runs a node whose peer-selection layer assembles
cohorts of up to sixteen members while the consensus layer believes "full size" is ten.

Why it matters: `clusterSize` is not only a replication target. The membership admission gate in
`ClusterMember` uses the configured size as its yardstick for "is this declared peer set suspiciously
small?" — the protection against a partitioned or attacker-shrunk group being voted through as if it
were whole. With real cohorts of sixteen and a yardstick of ten, a set that has quietly lost six
members still measures as full size and passes the gate. The gap is exactly the size of the default
mismatch.

The same figure feeds the corroboration floor used when repairing a block. There the mismatch is
harmless — the floor takes the larger of observed peers and configured size, so the observed sixteen
wins — but it is the same number reading differently in two places, which is how the admission gap
above went unnoticed.

Found during review of `bug-reconcile-cannot-heal-two-node-cohort`; not caused by it.

## Arm B — warn when the repair corroboration floor cannot be met by the cohort that exists

`clusterPolicy.assumedClusterSize` feeds two consumers with **opposite** unconfigured defaults
(documented at length in `cluster/cluster-policy.ts`):

- membership admission gate → defaults to `minAbsoluteClusterSize` (2)
- repair corroboration floor → defaults to **`clusterSize`**, the replication factor

The sereus embedder set `clusterSize: 16` for its control network and left `assumedClusterSize`
unset, recording in its own source comment:

> `assumedClusterSize` is deliberately left at Optimystic's default of 2 (a party may genuinely run
> two nodes).

That is true of the admission gate and false of the repair floor. With `clusterSize: 16`,
`corroboratorCapacity(cohortPeerCount, 16)` is `max(peers, 15)`, so the floor of two binds; a
two-node party has exactly one peer other than the reader, the quorum can never be met, and **every**
read-repair and reconcile declines — permanently, silently, on a product whose headline capability is
multi-machine operation. Setting `assumedClusterSize: 2` fixes it and is a no-op for the admission
gate, since 2 is already that consumer's default.

Nothing was wrong with the code. The failure was entirely in how discoverable the consequence is.

## Expected outcome

- **One resolved size per node.** Every consumer — including `Libp2pKeyPeerNetwork` — is handed the
  value `resolveClusterPolicy` produced; no consumer keeps a private constructor default that can
  win by omission. A node must not be able to start with its peer-selection breadth and its
  consensus yardstick disagreeing.
- **A construction-time assertion** that fails fast when two consumers would resolve different sizes,
  matching `assertSuperMajorityCoupling`.
- **A one-time startup warning** from `resolveClusterPolicy` when `assumedClusterSize` is absent and
  `clusterSize > minAbsoluteClusterSize`: this node will require `CORROBORATION_FLOOR` distinct peers
  to repair a block, a cohort smaller than that cannot heal itself, and
  `clusterPolicy.assumedClusterSize` is the fix — stating that declaring it does not shrink the
  replication factor. One line, at construction, naming both numbers.
- **The knob named at the decline.** `cluster-fetch:no-quorum`, `reconcile:no-rev-quorum`, and
  `reconcile:no-content-quorum` carry the resolved `repairCorroborationClusterSize`, the required
  quorum, and the responder count they actually got.

Do not change any default. The strict fallback is the researched decision
(`cluster/cluster-policy.ts` § "Why two size yardsticks, not one"); this ticket makes it legible and
consistent, not different.

## Edge cases & interactions

- The warning must fire once per node, not per repair — a per-attempt warn on a busy node is noise
  that gets filtered, which is how the current situation stays invisible.
- A node with `clusterSize: 16` that genuinely runs 16 peers is correctly configured and would still
  see the warning. Word it as "if you run fewer than N machines" rather than as a fault, or gate it
  on an observed cohort smaller than the floor at first repair.
- `feat-admission-floor-from-observed-cohort-high-water-mark` (backlog) would subsume the whole
  two-yardstick split by learning the reference instead of being told it. This ticket is deliberately
  the cheap, mechanical interim; do not build that here.
- The deeper question — that one setting is doing two unrelated jobs (replication factor and
  admission yardstick) — is a design item that may resolve Arm A as a side effect. Arm A is worth
  fixing regardless of how that lands, since two defaults disagreeing is a bug under any
  interpretation of what the setting means.

## Tests to add

- Constructing a node with no `clusterSize` yields the same resolved size in the key network, the
  consensus config, and the network manager (and the coupling assertion fires when they are forced
  apart).
- The startup warning fires for `clusterSize > 2` with no `assumedClusterSize`, and does not fire
  when it is declared.
- Cross-link from `docs/transactions.md` § the two-node repair paragraph to the warning's text so the
  log line and the doc use the same words.

Merged from `bug-key-network-cluster-size-default-diverges` (Arm A) and
`feat-warn-when-repair-floor-is-unsatisfiable` (Arm B) during backlog gardening.
