----
description: The fake multi-node network used by most integration tests has its main safety checks stubbed out or switched off, so tests that look like they prove data repair, split-brain protection, and signature enforcement actually prove none of those things.
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (makeReconcileBlock ~121; allowUnvalidatedSmallCluster; no deriveExpectedCluster callback; no per-node validator options)
  - packages/db-p2p/src/cluster/reconcile-block.ts (createReconcileBlock — the real implementation the harness stands in for)
  - packages/db-p2p/src/cluster/cluster-repo.ts (admitMembership — the gate the harness disables)
  - packages/db-p2p/test/reconcile-block.spec.ts (unit coverage of the real reconcile)
  - packages/db-p2p/test/cluster-membership-admission.spec.ts (member-layer split-brain test — the floor this builds above)
  - packages/quereus-plugin-optimystic/src/transaction/quereus-validator.ts (requireClientSignature — currently only set by unit tests)
  - packages/quereus-plugin-optimystic/test/ (the plugin mesh harness that builds per-node validators)
  - packages/db-p2p/test/client-tx-signature.spec.ts (existing single-process integration coverage)
difficulty: hard
tradeoffs: This is test infrastructure with no user-visible payoff, and arming the gates will make existing mesh tests fail in ways that each need a judgement call — a maintainer could reasonably say the unit-layer coverage is adequate and spend the time on features instead.
----

# Make the mesh harness run the real gates

## The weakness

`packages/db-p2p/src/testing/mesh-harness.ts` builds an in-memory mesh of nodes with real storage and
real consensus but mock transport. It is the only test tier that combines real storage, real
consensus, and multiple nodes — and therefore the only tier that can catch a regression in the rules
that decide *whether to accept something from another node*.

Those are exactly the rules the harness does not run. Three independent findings, one root cause:
for each safety gate, the harness either substitutes a permissive hand-written stand-in, sets the
documented escape hatch that turns the gate off, or simply never threads the option that arms it. A
mesh test that passes therefore tells you nothing about the gate, and — worse — would keep passing if
the gate regressed to permanently declining, or to permanently accepting.

The deliverable is the invariant: **the mesh harness exercises the production acceptance paths, and a
harness mode that disables a gate has to say so explicitly at the call site** (so the next test author
cannot silently inherit a disarmed gate). Expect fallout from arming them, and treat it as signal
rather than noise — each existing test that starts failing needs a decision about whether the scenario
was ever supposed to succeed.

## Arm A — block repair uses a first-peer-wins stand-in with none of the acceptance rules

For "pull a block I am missing from a sibling node" the harness supplies its own `makeReconcileBlock`
(~line 121), which walks the cohort peer list in order, takes the **first** node reporting a revision
at least as new as the committed one, and saves that node's bytes.

The production implementation (`cluster/reconcile-block.ts`, `createReconcileBlock`) instead asks
every cohort peer in parallel, requires a quorum of *distinct* peers to agree on the target revision
and action id, then requires a quorum to agree on the block **content** at that revision, declines and
retries later if either vote fails, and reports peers that served contradicting content to the
reputation subsystem.

The stand-in's own comment calls it "the mesh analogue of `createReconcileBlock`". It is an analogue
of the data movement, not of the acceptance rules. Both the commit path and the read path in the
harness use it, so **every** mesh-level test involving block repair runs first-peer-wins. Those gates
are what three consecutive bug fixes have had to correct.

Done looks like: the harness drives the real `createReconcileBlock`, with its `fetchArchive`
dependency implemented over a sibling node's `StorageRepo` (building a minimal `BlockArchive` — the
reconcile logic reads only `revisions[rev].action.actionId` and `revisions[rev].block`). Known
fallout: a harness mesh currently declares no `clusterSize` in its consensus config, and the real
logic needs one to decide how many corroborators a cohort could supply; existing mesh tests where
exactly one sibling holds the block will begin to decline unless the mesh declares a cluster size
matching its node count. Worth adding once the harness is honest: a mesh-level test that two nodes
converge end-to-end, currently covered only by unit tests and by an integration scenario in a sibling
repository that cannot be run from here. (The original ticket cited a
`blocked/two-node-convergence-acceptance-cross-repo-build` ticket for that cross-repo constraint; no
such ticket is on the board any more, so the constraint is recorded here instead of by reference.)

## Arm B — the membership admission gate is switched off in the harness

The admission gate (shipped in `cluster-membership-admission-gate`) makes each cluster member
independently re-derive its view of a block's responsible peer set and refuse to sign an `approve`
inside a set it cannot admit — the defence that stops a minority partition from voting a self-shrunk
cluster into super-majority (`docs/correctness.md`, Theorem 2).

It is well covered at the unit/member layer: `cluster-membership-admission.spec.ts` has a
`split-brain prevention` test that configures two members independently (one majority-side confident,
one minority-side low-confidence) and asserts the asymmetry. But that asserts each member's *decision*
in isolation. Nothing runs a real mesh where routing, a key network returning genuinely shrunk
clusters, and FRET confidence that actually collapses under a simulated partition drive the outcome.

Arming it takes **two** harness changes, not one. The harness sets `allowUnvalidatedSmallCluster: true`
(the documented escape hatch that turns the gate off), *and* wires no `deriveExpectedCluster` callback
at all — so every member takes the "cannot measure the cohort" path, where the gate needs an
`assumedClusterSize` in its config to have any size reference. Without one it approves everything, and
a test written against the harness would pass without exercising anything.

Done looks like: an opt-in harness mode that leaves the gate armed, a `MockMeshKeyNetwork` returning
partition-shrunk clusters, a FRET stub whose `getNetworkSizeEstimate().confidence` drops below 0.5 on
the minority side, a derivation callback (or stub), and an asserted cohort size. Then a test that
partitions an N-node mesh into majority and minority slices and asserts the minority-side members
refuse admission (emitting `membership-not-admitted:*`) and reach no super-majority, while the majority
side behaves per the 75% rule (or, if neither reaches 75%, neither commits).

## Arm C — client-signature enforcement is never armed on any node

The client-transaction-signature feature (`implement-client-tx-signature-p2p`, landed) has two halves.
**Signing** ships ON whenever a node key exists and is exercised through the live mesh. **Enforcement**
— a receiving node with `requireClientSignature: true` rejecting an unsigned or badly-signed
transaction at PEND — ships OFF by default for phased rollout, and is proven only at the validator
seam: `createQuereusValidator({ requireClientSignature: true })` called directly in unit/integration
tests (`quereus-engine.spec.ts`, `client-tx-signature.spec.ts`), plus real-Ed25519 round-trips through
db-core's `TransactionValidator` in a single process.

It has **never run through a live cluster PEND path**: the plugin mesh tests all run with enforcement
OFF, the mesh harness does not thread the flag, and there is currently **no production code anywhere**
that sets `requireClientSignature: true` — `createQuereusValidator` is only invoked from tests. So the
wire-level guarantee ("an unsigned client is refused by the cluster") is asserted nowhere.

Done looks like: the harness threads the flag through whatever builds each node's validator, and a
mesh test asserts that an unsigned client (e.g. a legacy/local transactor with no node key) is rejected
at PEND across nodes with the `Missing client signature` reason surfacing through the live path; that a
client signing with a key not matching its `stamp.peerId` is rejected with `Invalid client signature`;
and that a correctly-signed client commits successfully under enforcement.

**Also decide here (production wiring):** nothing flips `requireClientSignature: true` in production
today. Either surface the flag as a configurable option on the plugin/validator construction path so a
deployment can opt in, or explicitly document why enforcement stays test-only for now. The rollout
order the implementation assumes is: land signing → observe clients signing in the field → *then* flip
enforcement on. Flipping it on before clients sign rejects every legacy (unsigned) client at PEND, so
the config surface must exist before anyone can safely turn it on.

## Sequencing note

The three arms share one file and one refactor of how a mesh node is assembled, which is why they are
one ticket. Arm A is the largest and produces the most fallout; Arm C is the smallest and independent
of the other two. Whoever plans this may split it into `prereq:`-chained implement tickets, but the
harness changes should land as one coherent design rather than three competing bolt-ons.

Merged from `debt-mesh-harness-reconcile-double-bypasses-quorum` (Arm A),
`debt-mesh-level-partition-admission-regression` (Arm B), and `debt-mesh-client-signature-enforcement`
(Arm C) during backlog gardening. Arm C's original `prereq: implement-client-tx-signature-p2p` is
dropped — that ticket is complete.

## Arm D — added 2026-08-24 from `fix/1-two-node-index-divergence-guard-never-fires`

Same root cause as A/B/C, fourth instance: **the harness cannot express an undeclared cluster
size, so no mock-mesh test can ever exercise the repair-corroboration floor.**

`createMesh` passes `clusterSize: options.clusterSize ?? nodeCount` into the coordinator factory
(`packages/db-p2p/src/testing/mesh-harness.ts`, phase 2). A caller that omits `clusterSize` — which
every existing two-node mesh spec does — therefore gets an *honest* declaration, and
`CoordinatorRepo` resolves `repairCorroborationClusterSize` to it. For a two-node mesh that is
`corroboratorCapacity(1, 2) = 1`, the corroboration floor relaxes to one voter, and repair always
converges.

A real deployment that declares nothing resolves `repairCorroborationClusterSize` to
`DEFAULT_CLUSTER_SIZE` (10), giving `corroboratorCapacity(1, 10) = 9`, a floor of 2, and a two-node
cohort that can *never* repair — the permanent decline
`tickets/complete/1-repair-deadlock-is-never-named.md` documents and names. The harness default
silently excludes that entire class from every mesh test.

Cost already paid: the 2026-08-13 investigation behind `secondary-index-update-never-reaches-the-sibling`
reported that "eight two-node/two-Database shapes on the mock mesh all converged" and concluded the
trigger "needs something the mock mesh lacks". Every one of those eight ran under a declared
`clusterSize: 2`, so the repair-deadlock class could not have appeared in any of them. The
conclusion was sound but the coverage claim behind it was weaker than it read.

Done looks like: `MeshOptions` can express "the operator declared nothing" distinctly from "the
operator declared `nodeCount`" — most directly by threading `clusterPolicy.assumedClusterSize`
and letting `clusterSize` default to `DEFAULT_CLUSTER_SIZE` rather than to `nodeCount` — plus at
least one spec that pins the permanent-decline shape on the mesh (two nodes, nothing declared, one
holding a newer revision: expect `cluster-fetch:no-quorum` on every pass and exactly one
`cluster-fetch:repair-deadlock`). Changing the default will surface which existing specs were
relying on the relaxed floor; each of those is a judgement call in the same family as Arm A's
fallout.
