----
description: The new partition test for the fake test network is written and the whole database test suite passes; what remains is running the second package's suite, leaving one explanatory comment in its test setup, and filing the one real defect the work uncovered.
prereq: mesh-harness-real-reconcile
files:
  - packages/db-p2p/test/mesh-partition-admission.spec.ts (DONE — 7 cases, all passing)
  - packages/db-p2p/src/repo/coordinator-repo.ts (cancel() solo short-circuit — DONE, see below)
  - packages/db-p2p/test/coordinator-repo-integration.spec.ts (deterministic solo-cancel regression — DONE)
  - packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (TO DO — one comment + run its suite)
  - packages/db-p2p/src/repo/cluster-coordinator.ts:212-265 (makeRecord / executeClusterTransaction — the site the defect below resolves at)
difficulty: easy
----

# Remainder of `4-mesh-harness-admission-gate-partition-spec`

The prior run wrote the whole spec, ran the `@optimystic/db-p2p` suite to green, and fixed the one
production defect that suite exposed. It hit its token budget before running the Quereus plugin
suite. This ticket is the remainder. The original ticket is replaced by this one.

## What is ALREADY DONE (all in the working tree)

### `packages/db-p2p/test/mesh-partition-admission.spec.ts` — created, 7 cases, all passing

Drives the real coordinator + member stack over a 5-node mesh that declares its real cohort size
(`clusterPolicy: { assumedClusterSize: 5 }`), splitting cluster VIEWS 3 | 2 through the harness's
new `MeshFailureConfig.partitionSides`. Cases:

- minority side refuses admission and commits nowhere (`low-confidence-downsize` in both the thrown
  coordinator error and the member log; no node holds a committed revision);
- a throwing `deriveExpectedCluster` fails closed the same way, and logs
  `cluster-member:derive-expected-cluster-error`;
- the confident 3-peer majority is admitted **on the pend path** (kEst 3, floor 3, symDiff 0 →
  3 approvals, super-majority ceil(0.75·3) = 3);
- **commit path known gap**, pinned as-is — see the defect to file below;
- collapse confidence everywhere and NEITHER side can pend (floor stays 4 = ceil(0.75·5), majority
  declares 3, minority 2);
- `self-not-member` is enforced even with `allowUnvalidatedSmallCluster: true`;
- unpartitioned control pends, commits and reads back.

### `CoordinatorRepo.cancel` — solo short-circuit added (production fix)

Arming the gate surfaced a genuine production asymmetry, and it broke two specs (one deterministically,
one about one run in three):

- `Mid-DDL crash recovery (solo node)` → 5s timeout
- `CoordinatorRepo Integration → cancel operation → single-node fast path` →
  `Error: Cluster size 1 below minimum 2 and not validated`

Root cause: `pend` and `commit` both short-circuit `peerCount <= 1` straight to local storage;
`cancel` did not, so a single-peer cohort entered `executeTransaction`, failed
`minAbsoluteClusterSize` (2), and threw. A solo deployment could pend and commit but never cancel
unless the operator opened the `allowUnvalidatedSmallCluster` hatch. Fixed at the site by deciding
per block id (a multi-block cancel can span cohorts of different sizes) rather than once for
`blockIds[0]`. A deterministic regression case was added to `coordinator-repo-integration.spec.ts`
(`should cancel on a solo cohort without opening the small-cluster hatch`, a one-node mesh with the
hatch deliberately shut).

**No mesh anywhere was opted out of the gate.** The armed-gate arithmetic held for all ~41
`createMesh` sites, as the original ticket predicted; the only fallout was the `cancel` defect above.

### Suite status

`yarn workspace @optimystic/db-p2p test` → **1939 passing, 44 pending, 0 failing** (~49s).
`yarn workspace @optimystic/quereus-plugin-optimystic test` → **NOT YET RUN.**

## Key facts the next agent should NOT re-derive

- `startMockMesh` (`mesh-node-harness.ts`) passes armed. It builds `createMesh(size, {
  responsibilityK: size, clusterSize: size, superMajorityThreshold: 0.67 })` — no
  `assumedClusterSize`, so the resolved value is `minAbsoluteClusterSize` (2) and the gate's
  fallback floor is `max(2, ceil(0.75·2)) = 2`. On the **pend** path each member derives the full
  self-including mesh confidently (`meshConfidence` defaults to 1): kEst = size, floor
  `max(2, ceil(0.75·size))`, declared = size, symmetric difference 0 → admit. On the **commit** path
  there is no coordinating block id (see the defect below), so it falls back to floor 2, which any
  cohort of 2+ clears. `size: 1` never reaches the gate at all (solo short-circuit).
- `collection-factory.ts`'s solo `mesh-test` transactor needs nothing — solo short-circuit.
- Member reject reasons: assert only the `membership-not-admitted:<variant>` PREFIX; the tail
  carries local numbers.

## TODO

- **Run `yarn workspace @optimystic/quereus-plugin-optimystic test`** in the foreground, no
  redirection. Expectation: zero failures, for the arithmetic above. Note that package's suite is
  slow (~2m46s) — it is inside the 10-minute idle budget but do not also run `test:integration`.
  Follow the pre-existing-failure protocol for anything plainly unrelated.
- **Add a comment to `packages/quereus-plugin-optimystic/test/mesh-node-harness.ts`** on
  `startMockMesh`, recording that the membership admission gate is ARMED there and stating the
  arithmetic above in two or three lines, so its specs do not each re-answer the question.
- **File the commit-path defect** (details below) into `tickets/fix/`.
- **Handoff to `review/`** stating: no mesh opted out of the gate; solo meshes are protected by the
  coordinator short-circuit rather than the gate; the majority-side pend succeeding is by design
  (a confidently-measured majority may proceed — Theorem 2's protection is that the minority cannot
  ALSO commit); the commit-path case is pinned to CURRENT behavior and flips when the filed defect
  lands.

## The defect to file into `tickets/fix/`

Suggested slug: `commit-records-carry-no-coordinating-block`. `repro: verified` — the case
`commit path: the gate has no block to derive from (KNOWN GAP)` in the new spec observes it.

**Plain statement.** When a node asks the other holders of a record to approve a write, it also tells
them which blocks the write is about. It does that for the first half of the write (the "pend") but
not for the second half (the "commit") or for a cancel. Without that information the other nodes
cannot work out for themselves who should be in the group, so the safety check that is supposed to
catch a shrunken, untrustworthy group falls back to a much weaker rule on those two paths.

**Root cause, one site.** `ClusterCoordinator.executeClusterTransaction(blockId, message)` is handed
the coordinating block id, but `makeRecord` copies `coordinatingBlockIds` off the *message* instead
(`cluster-coordinator.ts:222`). Only `CoordinatorRepo.pend` puts the field on its `RepoMessage`;
`commit` (`coordinator-repo.ts:1382`) and `cancel` (`:1346`) do not. So on those paths
`ClusterMember.deriveExpectedClusterView` finds no block id, returns `undefined`, and
`admitMembership` takes its unconfident fallback branch every time.

**Two observable consequences.**

1. *Availability.* A cohort that the confident predicates admit at pend can be refused at commit,
   stranding the write pended-but-uncommitted across the whole cohort. Reproduced: a confident
   3-of-5 majority passes pend (floor `ceil(0.75·3) = 3`) and is refused at commit against the
   fallback floor `ceil(0.75·5) = 4`. Reachable by any deployment that declares
   `clusterPolicy.assumedClusterSize` above ~2.6 and whose cohort shrinks.
2. *Safety.* Conversely, at the default `assumedClusterSize` (2) the fallback floor is 2, so on the
   commit and cancel paths the gate admits essentially any cohort — the derived-view consistency
   check never runs there at all. Pend gating is the primary defence today, but `CoordinatorRepo.commit`
   explicitly tolerates a coordinator that was "picked for commit after missing the pend phase", so
   the commit path is not always downstream of a gated pend.

**Shape of the fix** (do not treat as a plan — the fix ticket should re-derive it): have
`makeRecord` fall back to the `blockId` `executeClusterTransaction` was already given, rather than
each caller remembering to restate it. Note this changes only the RECORD, not the message, so
`messageHash` preimages are untouched. Landing it should flip the pinned spec case to asserting a
successful commit; check the rest of the db-p2p suite, since it arms the gate's confident predicates
on a path where they have never run.
