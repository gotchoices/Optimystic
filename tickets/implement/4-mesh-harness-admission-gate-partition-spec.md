----
description: The safety check that stops a cut-off minority of machines from voting itself into control is now switched ON in the fake test network; what remains is to write the test that splits the network and proves the check holds, and to run the suites to confirm nothing regressed.
prereq: mesh-harness-real-reconcile
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (harness changes DONE — see below)
  - packages/db-p2p/test/mesh-partition-admission.spec.ts (TO CREATE — the whole remaining deliverable)
  - packages/db-p2p/src/cluster/cluster-repo.ts:975-1126 (admitMembership; read-only reference)
  - packages/db-p2p/src/repo/cluster-coordinator.ts:331-474 (super-majority + rejection arithmetic; read-only reference)
  - packages/db-p2p/test/support/capture-log.ts (captureLog/hasTag helpers)
  - packages/db-p2p/test/cluster-membership-admission.spec.ts (record/hash helpers to copy for the crafted-record case)
  - packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (needs a one-comment decision, see TODO)
difficulty: medium
----

# Mesh partition-admission spec (continuation of `4-mesh-harness-admission-gate`)

Continuation ticket: the prior run implemented **all harness changes** for arming the membership
admission gate, then hit its token budget before writing the new spec or running the suites. This
ticket is the remainder. The original ticket `4-mesh-harness-admission-gate` is replaced by this one.

## What is ALREADY DONE (in the working tree, `packages/db-p2p/src/testing/mesh-harness.ts`)

All edits compile clean per editor diagnostics; **no test suite has been run yet**.

- **Gate armed by default.** `resolveMeshPolicy` no longer forces
  `allowUnvalidatedSmallCluster ?? true`; the option now passes through untouched, so
  `resolveClusterPolicy`'s production default (`false`) applies. A mesh wanting the escape hatch
  must say `clusterPolicy: { allowUnvalidatedSmallCluster: true }` at its own call site.
- **`MeshOptions` gained** `deriveExpectedCluster?: (node, blockId) => Promise<ExpectedClusterView>`
  and `meshConfidence?: (node) => number` (the FRET confidence stand-in, default 1, evaluated per
  vote so a spec can flip it after mesh creation).
- **Default member derivation wired** into every `clusterMember({...})`: production-shaped
  (`libp2p-node-base.ts:791` analogue) — the node's own self-including per-node key network plus
  `meshConfidence`. Key-network construction was moved BEFORE member construction (phase 1), no
  late-bound slot; the per-node wrappers are stashed in `nodeKeyNetworkByPeer` and reused verbatim
  by phase 2's coordinators, so member and coordinator on one node can never see different
  topologies.
- **`MeshFailureConfig.partitionSides?: Set<string>[]` added** and honoured caller-aware in the
  per-node wrapper (`makeNodeKeyNetwork`): a caller inside a side sees only its side's cohort
  members; callers in no side see the unpartitioned cohort; self is re-added after filtering.
  `IKeyNetwork` itself is untouched. Partition shapes VIEWS only, not transport (doc-comment says
  so).

## Key facts the next agent should NOT re-derive

- **`CoordinatorRepo.pend`/`commit` short-circuit `peerCount <= 1` straight to local storage**
  (`coordinator-repo.ts:1221`, `:1375`) — solo cohorts never reach the member gate OR the
  coordinator's `validateSmallCluster` (which itself only triggers below
  `minAbsoluteClusterSize` = 2, i.e. solo). So solo meshes need NO opt-in.
- **Armed-gate arithmetic passes for every existing `createMesh` site** (checked by hand, pending
  test confirmation): 2-node K2 → kEst 2, floor max(2, ceil(0.75·2))=2, D=2, symDiff 0 → admit.
  3-node K1 → either short-circuits (writer responsible) or D={responsible, coordinator} (the
  coordinator wrapper self-adds): responsible member kEst 1 → floor 2 ≤ 2, symDiff 1 ≤
  ceil(0.5·1)=1 → admit; coordinator member kEst 2 → admit. 3-node K2 → symDiff ≤ 1 ≤ 1 → admit.
  K=n full meshes (3/3, 4/4, 5/5) → D=E → admit. **Expectation: NO existing spec needs the
  opt-in.** If the run proves otherwise, opt the mesh in explicitly at its call site with a
  one-line reason — never re-default the harness.
- Member reject reasons: assert only the `membership-not-admitted:<variant>` PREFIX
  (`cluster-repo.ts` says so; the tail carries local numbers).
- When every voter rejects, the coordinator throws `ValidatorRejectionError` whose message embeds
  each peer's rejectReason (`cluster-coordinator.ts:391`) — so the write-outcome assertion can
  match `membership-not-admitted:low-confidence-downsize` in the thrown message, satisfying the
  "log AND outcome" requirement.
- Super-majority is `Math.ceil(DECLARED_PEER_COUNT · superMajorityThreshold)`
  (`cluster-coordinator.ts:355`) — measured against the (possibly shrunk) declared set, which is
  exactly why the admission gate, not the threshold, is the split-brain defence.
- The member's confidence check is STRICTLY greater than `MembershipConfidenceThreshold = 0.5`
  (`cluster-repo.ts:235,1000`).
- `captureLog` namespace for the member is `'cluster-member'` (logger at `cluster-repo.ts:23`);
  the reject log tag is `cluster-member:admission-reject` with a structured payload whose `reason`
  field is the bare variant (`'low-confidence-downsize'` etc.).
- Fallback floor with `assumedClusterSize: 5` is `max(2, ceil(0.75·5)) = 4`.
- Write-driving pattern: `node.coordinatorRepo.pend({ actionId, transforms, policy: 'c' })` then
  `.commit({ actionId, tailId, rev, blockIds })` — copy helpers from
  `coordinator-repo-integration.spec.ts`.
- For the crafted-record (self-not-member) case, copy `canonicalJson`/`computeMessageHash`/
  `makeClusterPeers`/`makeRecord` from `cluster-membership-admission.spec.ts` and call
  `node.clusterMember.update(record)` directly.

## TODO

- **Create `packages/db-p2p/test/mesh-partition-admission.spec.ts`** with these cases (base mesh
  for partition cases: `createMesh(5, { responsibilityK: 5, clusterSize: 5, clusterPolicy: {
  assumedClusterSize: 5 }, meshConfidence: node => lowConfidence.has(node.peerId.toString()) ? 0.2 : 1 })`
  where `lowConfidence` is a mutable `Set<string>` the spec fills after creation; sides:
  majority = nodes 0–2, minority = nodes 3–4, `mesh.failures.partitionSides = [majSet, minSet]`):
  - **Minority side refuses admission** (targets the `low-confidence-downsize` predicate).
    `lowConfidence` = minority. Pend from a minority node. Both minority voters reject (declared 2 <
    fallback floor 4) → expect thrown error message to include
    `membership-not-admitted:low-confidence-downsize`, `captureLog('cluster-member', …)` to carry
    an `admission-reject` with `reason: 'low-confidence-downsize'`, and no node's `storageRepo` to
    hold the block.
  - **Majority side behaves per the threshold** (documents the confident-majority posture).
    `lowConfidence` = minority only. Pend+commit from a majority node. Arithmetic (state it in a
    comment): declared D = its 3-peer side; each majority member's confident derived view E = D
    (kEst 3, floor 3, symDiff 0) → 3 approvals; super-majority = ceil(0.75·3) = 3 → the write
    COMMITS. Assert commit success and that NO `membership-not-admitted` appears in the captured
    log. (A confidently-measured majority is allowed to proceed; Theorem 2's protection is that the
    minority cannot ALSO commit — previous case.)
  - **Neither side commits when partition collapses confidence everywhere** (the Theorem 2
    property: floor is measured against the TRUE size 5). `lowConfidence` = ALL nodes. Pend from a
    majority node AND from a minority node: both fail with `low-confidence-downsize` (declared 3
    and 2, both < floor 4 = ceil(0.75·5) — comment the 2·0.75·0.75 > 1 arithmetic).
  - **`self-not-member` enforced even with the hatch open.** Separate
    `createMesh(3, { responsibilityK: 3, clusterSize: 3, clusterPolicy: { assumedClusterSize: 3,
    allowUnvalidatedSmallCluster: true } })`; craft a record whose peers are nodes 1–2 only and
    call `nodes[0].clusterMember.update(record)`; expect its promise sig type `reject` with reason
    exactly `membership-not-admitted:self-not-member`.
  - **A throwing derivation fails closed.** 5-node mesh as above but
    `deriveExpectedCluster: async () => { throw new Error('derivation-unavailable') }`, partition
    set, pend from a minority node → rejected `low-confidence-downsize` (derived undefined →
    fallback floor 4 > declared 2); also assert `cluster-member:derive-expected-cluster-error` was
    logged.
  - **Unpartitioned control.** Same 5-node shape, no partition, default confidence → pend+commit
    succeed and the block reads back. Guards against a gate that rejects everything.
- **Run `yarn workspace @optimystic/db-p2p test` in the foreground** (no redirection). Triage any
  fallout per the armed-gate arithmetic above; the expectation is zero failures. Follow the
  pre-existing-failure protocol for anything plainly unrelated.
- **Run the Quereus plugin tests** (`yarn workspace @optimystic/quereus-plugin-optimystic test`)
  the same way. `startMockMesh` (K=size, clusterSize=size) should pass armed; add a one-line
  comment in `mesh-node-harness.ts` recording that the admission gate is ARMED there and why it
  admits (derived view equals the declared full-mesh cohort, confidence defaults to 1), so its
  specs don't each re-answer the question. `collection-factory.ts`'s solo `mesh-test` transactor
  needs nothing (solo short-circuit).
- **Handoff to review/**: state that no mesh opted out of the gate (or list the ones that had to,
  with reasons), that solo meshes are protected by the coordinator short-circuit rather than the
  gate, and that the majority-side-commits outcome in case 2 is by design (confident measurement),
  with the neither-side case covering the partition-collapsed-confidence posture.
