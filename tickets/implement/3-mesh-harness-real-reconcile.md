----
description: The fake multi-node network used by most tests now repairs missing data through the real several-machines-must-agree rule instead of a first-answer-wins shortcut — that code change is done and its new tests pass; what remains is running the full existing test suites and triaging any tests that were relying on the old shortcut.
prereq:
files:
  - packages/db-p2p/src/testing/mesh-harness.ts (DONE — rewired; see "State of the work" below)
  - packages/db-p2p/test/mesh-reconcile-quorum.spec.ts (DONE — new spec, 4 cases, all passing)
  - packages/db-p2p/test/mesh-sanity.spec.ts, test/coordinator-repo-integration.spec.ts, test/byzantine-fault-injection.spec.ts, test/empty-state-contract.spec.ts, test/fresh-node-ddl.spec.ts, test/fresh-node-ddl-multi.spec.ts, test/mid-ddl-crash.spec.ts (fallout surface — NOT yet run)
  - packages/quereus-plugin-optimystic/test/mesh-node-harness.ts and that package's specs (fallout surface — NOT yet run)
  - packages/db-p2p/src/cluster/reconcile-block.ts, src/cluster/cluster-policy.ts, src/cluster/quorum-restore.ts (reference — unchanged)
difficulty: medium
----

# Mesh harness real reconcile — CONTINUATION: fallout triage + handoff

<!-- resume-note -->
A prior agent run completed the implementation and new-spec phases of this ticket, then hit the
runner's soft token budget before running the pre-existing test suites. **Do not redo the
implementation.** Resume at "Remaining work" below. No log file was written; the full state is
captured here.
<!-- /resume-note -->

## State of the work (verified, do not redo)

All edits are in the working tree, uncommitted (runner commits).

**`packages/db-p2p/src/testing/mesh-harness.ts` — rewired:**

- Both hand-built config literals (member `ClusterConsensusConfig`, coordinator
  `CoordinatorRepoConfig`) are replaced by ONE `resolveClusterPolicy` call per mesh, exactly as
  `libp2p-node-base.ts` resolves a real node. The member gets the resolved object as
  `consensusConfig`; the coordinator factory gets `{ ...policy }` spread, mirroring
  `libp2p-node-base.ts:848`.
- `MeshOptions` gained `clusterPolicy?: ClusterPolicyOptions['clusterPolicy']` (passed through
  verbatim; an explicit entry wins over the legacy top-level `superMajorityThreshold` /
  `allowClusterDownsize` shorthands, which are kept and mapped). `clusterSize` doc comment now
  states that OMITTED resolves to `DEFAULT_CLUSTER_SIZE` (10), never `nodeCount`.
- `allowUnvalidatedSmallCluster` still defaults to `true` but is passed explicitly with a comment
  naming it a disarmed gate and pointing at ticket `mesh-harness-admission-gate` (which flips it).
- `makeReconcileBlock` (first-peer-wins) is DELETED. Each node now builds one real
  `createReconcileBlock` in phase 1 (stashed in a local `Map<string, ReconcileBlockCallback>` keyed
  by peer id — `MeshNode` was not widened) and the SAME instance serves both the member's
  `reconcileBlock` and the coordinator's `acquireBlockFromCohort` in phase 2.
- New `makeFetchArchive` helper mirrors `SyncService.buildArchive`'s archive shape (including the
  `transform: { insert: block }` filler) and returns `undefined` for self, for
  `failures.silentPeers`, for unknown peers, and for peers holding nothing — matching production
  `fetchArchiveFromPeer`'s conflation of unreachable with holds-nothing.

**`packages/db-p2p/test/mesh-reconcile-quorum.spec.ts` — new, all 4 passing** (verified with
`node --import ./register.mjs node_modules/mocha/bin/mocha.js test/mesh-reconcile-quorum.spec.ts`):

1. Declared `clusterSize: 2` two-node mesh converges end-to-end (floor relaxes to one voter).
2. Undeclared two-node mesh never repairs: `cluster-fetch:no-quorum` on every pass (asserted
   exactly one per pass × 3 passes), exactly ONE `cluster-fetch:repair-deadlock` with
   `reason: 'cohort-too-small'`, reader flagged `unavailable: 'claimed-elsewhere'`.
3. Lone inflated-revision outlier cannot steer repair — corroborated pair adopted. NOTE: built as a
   FOUR-node mesh, deliberately deviating from the ticket's three-node sketch: with three nodes the
   reader has only two peers, one honest vote per group, so the pass declines (also
   outlier-resistant, but adopts nothing); four nodes pin the adoption behaviour. The deviation is
   documented in the spec comment.
4. Content-split cohort declines (`reconcile:no-content-quorum`, nothing persisted) and a later
   pass converges once the cohort settles.

**Verification done:** `tsc --noEmit` on db-p2p is clean; the new spec passes. **Nothing else has
been run.**

## Learnings that bound the expected fallout

- The corroboration floor is `min(2, capacity)`, so for any cohort giving the reader ≥2 peers the
  quorum arithmetic is UNCHANGED by the `clusterSize ?? nodeCount → DEFAULT_CLUSTER_SIZE`
  default switch (capacity was already ≥2 both ways). The divergence is exactly the two-node/
  one-sibling shapes with nothing declared: floor was 1, is now 2 (permanent decline). Grep showed
  the undeclared two-node meshes in `coordinator-repo-integration.spec.ts` (lines ~327, ~353, ~367)
  all assert NON-convergence outcomes (silence / authoritative absent), so they should still pass —
  confirm rather than assume.
- Coordinator `minAbsoluteClusterSize` moves 3 → 2 (production's value, via the resolved policy).
  `validateSmallCluster` now triggers only for cohorts < 2; `allowUnvalidatedSmallCluster: true`
  admitted those before and still does. Solo meshes verified unaffected in principle; the member's
  admission gate short-circuits entirely on `allowUnvalidatedSmallCluster: true`
  (`cluster-repo.ts` `admitMembership`), so the newly-arriving `assumedClusterSize: 2` on members
  is inert in the harness today — it becomes live when `mesh-harness-admission-gate` re-arms the
  gate; note this in that ticket's implementation if it surprises.
- The resolver's one-line `repair-fault-tolerance` advisory now fires once per `createMesh` under
  the `optimystic:db-p2p:cluster-policy` debug namespace — harmless unless a spec captures that
  namespace.

## Remaining work (in order)

- Run `yarn workspace @optimystic/db-p2p test` in the FOREGROUND (no redirection). Triage every
  failure per the original rules: if the scenario genuinely is its node count, declare it
  (`clusterSize: <nodeCount>` or `clusterPolicy: { assumedClusterSize: <nodeCount> }`); if it was
  passing only because a lone peer's word was enough, change the assertion to the honest outcome.
  Record each decision as a comment in the spec that moved. Never skip/loosen to get green;
  pre-existing failures go through `tickets/.pre-existing-known.md` / `.pre-existing-error.md`.
- Run the Quereus plugin package's tests (`yarn workspace @quereus/quereus-plugin-optimystic test`
  or per that package's scripts — check its package.json name). Its `startMockMesh` passes
  `clusterSize: size` explicitly and `collection-factory.ts` declares `clusterSize: 1`, so specs
  should be unaffected — confirm. `MeshOptions` changed shape (additive only), and the package
  imports it through the published `@optimystic/db-p2p/testing` subpath, so if that package
  resolves `db-p2p` from `dist/` rather than source, REBUILD db-p2p first (`yarn workspace
  @optimystic/db-p2p build`) or the plugin tests exercise the stale harness.
- Write the `review/` handoff (distilled summary emphasizing the four new test cases and the
  fallout decisions), including: which specs moved and why; that `allowUnvalidatedSmallCluster`
  remains disarmed by default in the harness and `mesh-harness-admission-gate` arms it; the
  member-side `assumedClusterSize` note above; and the case-3 four-node deviation. Then delete
  this ticket file.

Keep this ticket's slug (`mesh-harness-real-reconcile`) until the handoff moves to `review/` —
`mesh-harness-admission-gate` and `mesh-harness-signature-enforcement` gate on it via `prereq:`.
