----
description: The fake multi-node network used by most tests now repairs missing data using the real "several machines must agree" rule instead of trusting the first machine that answers, so tests can no longer pass on evidence a real deployment would reject.
prereq:
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (the rewire — 404 lines)
  - packages/db-p2p/test/mesh-reconcile-quorum.spec.ts (new spec, 199 lines, 4 cases)
  - packages/db-p2p/src/cluster/cluster-policy.ts (resolveClusterPolicy — reference, unchanged)
  - packages/db-p2p/src/cluster/reconcile-block.ts (createReconcileBlock — reference, unchanged)
  - packages/db-p2p/src/libp2p-node-base.ts (the production composition root this now mirrors — reference, unchanged)
difficulty: medium
----

# Mesh harness runs real reconcile — review handoff

## What this changed, in one paragraph

`createMesh` is the in-process fake network that most of `db-p2p`'s tests run on. When a node was
missing a block, the harness used to hand it a stub repair function that asked peers one at a time
and believed the first one that answered. Production does not do that: it asks the cohort, and
adopts a revision only when enough *distinct* peers agree both on which revision is current and on
the block's *contents*. So any test exercising repair was passing on evidence a real deployment
would have rejected. The harness now builds the real `createReconcileBlock` and resolves its
thresholds through the same `resolveClusterPolicy` call a real node's startup uses.

## The three substantive shifts

**Policy comes from the production resolver.** Two hand-written config literals (the member's
`ClusterConsensusConfig`, the coordinator's `CoordinatorRepoConfig`) are gone, replaced by one
`resolveClusterPolicy` call per mesh whose result feeds both — mirroring `libp2p-node-base.ts`.
Two consequences worth the reviewer's attention:

- An omitted `clusterSize` now resolves to `DEFAULT_CLUSTER_SIZE` (10), where it used to silently
  become `nodeCount`. For any cohort giving the reader ≥2 peers this changes nothing (the
  corroboration floor is `min(2, capacity)`, already ≥2 either way). It changes exactly one shape:
  a two-node / one-sibling mesh that declares nothing now has a floor of 2 with only 1 peer
  available, so it declines *permanently*. That is the honest outcome, and case 2 below pins it.
- The coordinator's `minAbsoluteClusterSize` moves 3 → 2 (production's value).

**One reconcile instance per node, shared by both paths.** The member's commit-path
`reconcileBlock` and the coordinator's read-path `acquireBlockFromCohort` are now the *same*
object, as in production. A spec can no longer tell the two paths apart — previously it could.

**`makeFetchArchive` replaces the stub.** It builds an archive shaped like
`SyncService.buildArchive` (including the `transform: { insert: block }` filler, produced the way
the sync service produces it rather than invented) and returns `undefined` for self, for
`failures.silentPeers`, for unknown peers, and for peers holding nothing — deliberately conflating
"unreachable" with "holds nothing", which is what production's `fetchArchiveFromPeer` does.

`MeshOptions` gained `clusterPolicy?:` (passed through verbatim). The legacy top-level
`superMajorityThreshold` / `allowClusterDownsize` shorthands still work; an explicit `clusterPolicy`
entry wins over the matching shorthand.

## What to exercise — the four new cases

`packages/db-p2p/test/mesh-reconcile-quorum.spec.ts`, all passing:

- **Declared `clusterSize: 2` two-node mesh converges end-to-end.** Capacity `max(1,1) = 1`, floor
  relaxes to a single voter, repair completes. This is the "you told us how big you are, so we can
  reason about you" path.
- **Undeclared two-node mesh never repairs.** Asserts `cluster-fetch:no-quorum` exactly once per
  read pass across 3 passes, exactly ONE `cluster-fetch:repair-deadlock` carrying
  `reason: 'cohort-too-small'`, and the reader surfacing `unavailable: 'claimed-elsewhere'`. This is
  the case the old first-peer-wins stub silently papered over.
- **A lone inflated-revision outlier cannot steer repair.** One peer claims a revision nobody
  corroborates; the corroborated pair is adopted instead.
- **A cohort split on *content* declines rather than picking a side.** Same `(rev, actionId)`,
  different bytes → `reconcile:no-content-quorum`, nothing persisted. Declines are retryable: a
  later pass converges once the cohort settles.

## Validation actually run

| Suite | Command | Result |
|---|---|---|
| `@optimystic/db-p2p` (full) | `mocha "test/**/*.spec.ts"` | **1931 passing, 44 pending, 0 failing** (57s) |
| `@optimystic/quereus-plugin-optimystic` | `mocha "test/**/*.spec.ts" --exit` | **656 passing, 13 pending, 0 failing** (3m) |
| plugin smoke | `npm run test:smoke` | `smoke ok quereus@4.17.1` |
| `@optimystic/db-p2p-storage-fs` (spot-check) | `mocha "test/**/*.spec.ts"` | **54 passing, 1 pending, 0 failing** |
| typecheck | `tsc --noEmit` (db-p2p) | clean |
| build | `tsc` (db-p2p), `tsup` (plugin) | clean |

**Zero fallout. No pre-existing spec needed to move or change an assertion.** The predicted risk did
not materialise: the undeclared two-node meshes in `coordinator-repo-integration.spec.ts` (~327,
~353, ~367) all assert non-convergence outcomes already, so the stricter floor agrees with them.

The plugin package resolves `@optimystic/db-p2p/testing` through the package `exports` map to
`dist/`, **not** source — so db-p2p was rebuilt before the plugin suite ran, and those 656 tests did
exercise the new harness rather than a stale copy. A reviewer re-running the plugin suite must
rebuild db-p2p first or they will be testing the old code.

Integration specs (`*.integration.spec.ts`) self-skip without `OPTIMYSTIC_INTEGRATION=1` and were
**not** run — they are part of the 44 pending.

## Known gaps — please probe these

- **The membership admission gate is still disarmed.** `allowUnvalidatedSmallCluster` is passed
  explicitly as `true` with a comment naming it a deliberate disarming. Harness meshes run below the
  safe floor on purpose, so this is load-bearing today; ticket `mesh-harness-admission-gate` flips
  it to `false` and drives a real partition. Nothing here proves that gate works.
- **Members now receive `assumedClusterSize: 2` but it is inert.** `admitMembership` in
  `cluster-repo.ts` short-circuits entirely while `allowUnvalidatedSmallCluster` is `true`, so the
  newly-arriving value has no effect in the harness *today*. It goes live the moment the gate ticket
  lands — that ticket's implementer should expect behaviour to change from this commit, not from
  their own.
- **Case 3 is a FOUR-node mesh, deviating from the ticket's three-node sketch.** With three nodes the
  reader has only two peers and one honest vote per group, so the pass declines — outlier-resistant,
  but it adopts nothing, which does not pin the interesting half. Four nodes pin the adoption. The
  deviation is documented in the spec comment. Worth a second opinion on whether the three-node
  decline also deserves its own case.
- **Signature enforcement is still unwired** — `clusterMember({ … validator })` is never populated.
  That is ticket `mesh-harness-signature-enforcement`, not a gap introduced here.
- **`resolveClusterPolicy` runs once per mesh, not per node** (see tripwire below).
- The resolver's one-line `repair-fault-tolerance` advisory now fires once per `createMesh` under
  the `optimystic:db-p2p:cluster-policy` debug namespace. Harmless unless a spec captures that
  namespace; none currently does.

## Tripwires parked in code

Both are `NOTE:` comments at their exact sites in `mesh-harness.ts` — conditional concerns, not
queued work, so no tickets filed:

- At the `resolveClusterPolicy` call: one policy object is shared by every node, so nodes can never
  disagree about cluster size. Correct for repair tests. A test needing nodes to *disagree* (a
  partition where each side derives its own view — exactly `mesh-harness-admission-gate`) must move
  the resolve inside the phase-1 loop and accept per-node overrides.
- At `makeFetchArchive`: the archive served always carries exactly one revision (the peer's latest),
  because that is all `storageRepo.get` surfaces. Enough for repair, which targets a single
  `(rev, actionId)`. A future gap-fill across a revision *range* needs the real range served.

## Housekeeping

- `tickets/.pre-existing-known.md` does not exist in this repo; no pre-existing failure surfaced, so
  no `.pre-existing-error.md` was written.
- Logs from this run are in `tickets/.logs/mesh-harness-real-reconcile.{dbp2p,plugin}.test.log`
  (git-ignored, runner-pruned). No other artifacts written.
- Keep the slug `mesh-harness-real-reconcile` — `mesh-harness-admission-gate` (seq 4) and
  `mesh-harness-signature-enforcement` (seq 5) both gate on it via `prereq:`.
