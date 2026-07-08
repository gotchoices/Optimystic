description: Add an end-to-end network-simulation test proving that during a real split-brain partition the smaller side actually refuses to write, instead of only testing the individual node's decision logic in isolation.
files:
  - packages/db-p2p/test/cluster-membership-admission.spec.ts (existing member-layer split-brain test — the floor this would build above)
  - packages/db-p2p/src/testing/mesh-harness.ts (mesh simulation harness; currently sets allowUnvalidatedSmallCluster:true, which disables the gate — see note below)
  - packages/db-p2p/src/cluster/cluster-repo.ts (admitMembership — the behavior under test)
difficulty: medium
----

## Background

The membership admission gate (shipped in `cluster-membership-admission-gate`) makes each cluster
member independently re-derive its view of a block's responsible peer set and refuse to sign an
`approve` inside a set it can't admit — the defense that stops a minority partition from voting a
self-shrunk cluster into super-majority (docs/correctness.md, Theorem 2).

The gate is well covered at the **unit / member layer**: `cluster-membership-admission.spec.ts` has a
`split-brain prevention` test that configures two members independently (one majority-side confident,
one minority-side low-confidence) and asserts the asymmetry — minority rejects, majority approves.

## What's missing

That test asserts each member's *decision* in isolation; it does not run a real mesh where routing +
a key-network returning genuinely shrunk clusters + FRET confidence that actually collapses under the
simulated partition drive the outcome. A partition-simulation **integration** test would be a stronger
regression: stand up a multi-node mesh, sever it into a majority and a minority slice, and assert that
the minority slice cannot commit a write while the majority slice can (or, if neither reaches 75%,
neither commits).

## Why it's not trivial

The existing mesh harness (`src/testing/mesh-harness.ts`) sets `allowUnvalidatedSmallCluster: true`,
which is the documented escape hatch that **turns the gate off** — so the gate is transparent there by
design and the harness as-is cannot exercise it. This ticket needs either a harness mode that leaves
the gate armed (opt-in flag), plus a `MockMeshKeyNetwork` that returns partition-shrunk clusters and a
FRET stub whose `getNetworkSizeEstimate().confidence` drops below 0.5 on the minority side. That's real
test infrastructure, which is why it's deferred rather than done inline in the review pass.

## Acceptance

- A mesh/integration test simulates an N-node cluster partitioned into a majority and minority.
- Minority-side members refuse admission (emit `membership-not-admitted:*`) and the minority reaches no
  super-majority; majority side behaves per the 75% rule.
- The gate is *armed* in the harness path this test uses (not bypassed via `allowUnvalidatedSmallCluster`).
