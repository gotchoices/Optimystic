description: A new test proves the mesh's membership-admission safety check works correctly during a network split, the full test suites for both affected packages pass, and one real bug the testing uncovered has already been filed separately for a fix.
files:
  - packages/db-p2p/test/mesh-partition-admission.spec.ts (new, 7 cases)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cancel() solo short-circuit fix)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts (new regression case)
  - packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (comment only, no logic change)
  - packages/db-p2p/src/repo/cluster-coordinator.ts:212-265 (site of filed defect, unchanged here)
difficulty: easy
---

# Mesh partition admission gate — validated, both suites green

Builds on the mesh test harness's real coordinator/member reconciliation (`mesh-harness-real-reconcile`,
already landed). This ticket added the actual admission-gate-under-partition test and closed out the
package suite runs.

## What was built

`packages/db-p2p/test/mesh-partition-admission.spec.ts` — 7 cases, drives the real coordinator +
member stack over a 5-node mesh with a declared cohort size
(`clusterPolicy: { assumedClusterSize: 5 }`), splitting the mesh 3|2 via the harness's
`MeshFailureConfig.partitionSides`:

1. minority side (2 of 5) refuses admission, commits nowhere — no node holds a committed revision.
2. a throwing `deriveExpectedCluster` fails closed the same way.
3. confident 3-peer majority is admitted on the **pend** path (by design — see "Is this a bug?" below).
4. commit path is pinned to the CURRENT (buggy) behavior — see "Known gap" below.
5. confidence collapsed everywhere → neither side can pend.
6. `self-not-member` enforced even with `allowUnvalidatedSmallCluster: true`.
7. unpartitioned control: pends, commits, reads back correctly.

**Production fix alongside it:** `CoordinatorRepo.cancel()` had a solo-node gap — `pend`/`commit`
short-circuit a 1-peer cohort straight to local storage, `cancel` did not, so a single-node
deployment could pend and commit but never cancel without opening the `allowUnvalidatedSmallCluster`
escape hatch. Fixed by deciding the short-circuit per block id (a multi-block cancel can span
cohorts of different sizes) instead of once for the first block. Regression case added:
`should cancel on a solo cohort without opening the small-cluster hatch`.

**No mesh was opted out of the gate.** All ~41 `createMesh` call sites across both packages keep
the gate armed; the cancel() fix above was the only production fallout.

## How to validate / use cases

- `yarn workspace @optimystic/db-p2p test` → 1939 passing, 44 pending, 0 failing (~49s).
- `yarn workspace @optimystic/quereus-plugin-optimystic test` → 656 passing, 13 pending, 0 failing
  (~4m). Re-run confirmed clean; this package's `startMockMesh` harness (`test/mesh-node-harness.ts`)
  never opted out of the gate either — no `assumedClusterSize` is passed there, so it resolves to
  `minAbsoluteClusterSize` (2) and the fallback floor is `max(2, ceil(0.75*2)) = 2`, which its
  3-node specs clear regardless of the commit-path gap below. A comment was added at
  `startMockMesh` recording this arithmetic so its specs don't each have to re-derive it.
- To exercise the gate directly: read `mesh-partition-admission.spec.ts` cases 1–3 for the
  admit/refuse boundary, case 6 for the `self-not-member` invariant, case 7 for the unpartitioned
  control.

## Is the majority-admitted-at-pend case (case 3) a bug?

No — by design. Theorem 2's safety property is that the minority side cannot ALSO commit while
the majority proceeds (split-brain), not that every partition must halt. A confidently-measured
majority (3 of 5, above the super-majority floor) is meant to be admitted and proceed. This is
asserted directly in case 1 (minority refuses) and case 3 (majority admits).

## Known gap — pinned in the spec, already filed for fix

Case 4 (`commit path: the gate has no block to derive from (KNOWN GAP)`) pins CURRENT behavior:
`ClusterCoordinator.executeClusterTransaction` is handed the coordinating block id, but
`makeRecord` (`cluster-coordinator.ts:222`) copies `coordinatingBlockIds` off the *message*
instead of that parameter. Only `CoordinatorRepo.pend` puts the field on its message; `commit`
(`coordinator-repo.ts:1382`) and `cancel` (`:1346`) don't. So on those two paths
`ClusterMember.deriveExpectedClusterView` gets no block id and falls back to a much weaker floor
— meaning a confidently-admitted majority can be admitted at pend and then refused at commit
(availability bug), and at the low default `assumedClusterSize` the commit/cancel paths barely
gate at all (safety gap).

**Already filed** as `tickets/fix/1-commit-and-cancel-records-omit-the-coordinating-block.md` —
do not re-file. That ticket was independently re-verified when filed and corrects one number from
earlier drafts of this work: the "admits almost anything" case is `assumedClusterSize === undefined`,
not `2`. When that fix lands, case 4 in this spec should flip from asserting rejection to asserting
a successful commit — whoever fixes it should update the spec's expectation, not just the
production code.

## Known gaps / left to reviewer judgment

- Case 4 is intentionally pinned to a known-buggy behavior rather than skipped or deleted — this is
  the correct way to track a filed defect from its test, but flag it in review so nobody mistakes
  the pin for the bug being acceptable long-term.
- The cancel() short-circuit fix changes behavior for solo cohorts; reviewer should confirm the
  per-block-id decision (rather than deciding once for `blockIds[0]`) is correct for the
  multi-block-cancel-spans-different-cohort-sizes case it's meant to cover — this implementer did
  not find an existing multi-block-cancel-different-cohorts test to exercise it directly.
- No performance testing done on the 5-node partition spec; each case builds a fresh mesh, so wall
  time is dominated by mesh setup, not the assertions themselves.
