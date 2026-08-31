description: Finish verifying the commit-tier acknowledgement fix — the failing mesh regression test now passes after two more code arms landed this run, but the full test suites, the live-swarm reproducer, and the review handoff are still outstanding.
files:
  - packages/db-core/src/transactor/network-transactor.ts (NEW this run — non-tail commit conflicts now surface; staleFromBatches helper shared with commitBlock)
  - packages/db-p2p/src/cluster/cluster-repo.ts (NEW this run — executedCommitResults retention + getExecutedCommitResult; updated Residual doc on validateCommitRevisions and the apply 'ahead' NOTE)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (NEW this run — localCommitResult threaded out of executeClusterTransaction)
  - packages/db-p2p/src/repo/coordinator-repo.ts (NEW this run — localExecuted branch of commit consults the retained verdict; confirmCommitRivalAgainstLocal extracted as shared core of classifyCommitStaleRejection)
  - packages/db-p2p/test/coordinator-repo-stale-classification.spec.ts (assertion fix this run — see below)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (exit-criterion mesh spec — NOW GREEN, both tests; do not weaken)
  - packages/db-p2p/test/coordinator-repo-commit-conflict.spec.ts (Arms 1+3 unit tests — all 10 pass; EXTEND with threading cases, see TODO)
  - packages/db-p2p/test/cluster-commit-staleness.spec.ts (Arm 2 member-vote tests — passed in the pre-change suite run)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (original reproducer — NOT yet re-run)
  - tickets/.pre-existing-known.md (mesh-spec entry to remove once suites are green)
  - tickets/.logs/1-consensus-pend-refusal-commit-tier-verify.mesh2.log (trace that exposed the db-core swallow)
difficulty: hard
----

# Commit-tier acknowledgement fix — remaining verification (continuation)

Sixth ticket in this chain (continues `1-consensus-pend-refusal-commit-tier-verify`, which hit
the token budget mid-verification). **The diagnosis is settled and the code is written — do not
re-derive or re-design.** The deliberately-red mesh regression spec
(`concurrent-diary-append-acknowledgement.spec.ts`) is now GREEN (both tests, verified twice this
run). What remains: full-suite runs, new unit tests for the two arms added this run, the
reference-peer reproducer, `yarn check`, and the review handoff.

## State when this ticket was written

Builds clean (`db-core`, `db-p2p`). Mesh spec green. The full db-p2p suite was last run BEFORE
this run's code changes: 2367 passing, 2 failing — the mesh spec (now green) and one stale
assertion in `coordinator-repo-stale-classification.spec.ts` (fixed this run, see below). The
suite has NOT been re-run since the new arms landed. db-core's own suite has not been run at all.

## What this run found and fixed (two NEW arms beyond the original three)

Running the mesh spec with `DEBUG='optimystic:*'` showed the acknowledged-but-lost write
surviving Arms 1–3, via a chain of two further swallows:

**Finding A — the signed-but-not-yet-applied window is the COMMON case, not a corner.** Three
concurrent diary appends each commit two blocks: their own private tail block (no contention,
commits fine) and the shared header block (all race revision 1). On the header block, the loser's
commit ASSEMBLES FULL CONSENSUS: every member signs the winner's commit (dropping its reservation
at sign time, per the deliberate design NOTE in cluster-repo.ts ~line 895) before applying it, so
when the loser's commit arrives moments later there is no reservation to conflict-vote against
and storage is still at rev 0 so `validateCommitRevisions` (Arm 2) abstains as "lagging". Every
member's APPLY then refuses the loser as stale (`commit:stale missed=1` on all three members in
the trace), the member-side 'ahead' tolerance swallows the refusal, and the coordinator fabricated
`{success: true}`. Fix (mirrors the pend tier's retained-verdict wiring exactly):
- `ClusterMember` retains local storage's commit verdict per messageHash
  (`executedCommitResults`, beside `executedPendResults`; same TTL/rollback/clear lifecycle;
  accessor `getExecutedCommitResult`). The missing-pending throw path deliberately retains
  nothing — a member genuinely behind keeps the fabricated-success + reconcile shape.
- `ClusterCoordinator.executeClusterTransaction` returns it as `localCommitResult`
  (only when `localExecuted`).
- `CoordinatorRepo.commit`, in its `localExecuted` branch: a retained refusal triggers
  `confirmCommitRivalAgainstLocal(request)` — the extracted shared core of
  `classifyCommitStaleRejection` (local re-read only; never the verdict's prose). Confirmed
  rival → return the conflict `StaleFailure` (with `staleAt`). Own-action-durable or
  unconfirmed → keep the prior fabricated success (log tag
  `coordinator-repo:commit-local-refusal-tolerated`). The helper returns
  `StaleFailure | 'own-durable' | undefined`; `classifyCommitStaleRejection` maps both
  non-object results to "stays a throw".

**Finding B — db-core's non-tail commit tolerance swallowed the returned conflict.** With
Finding A fixed, the coordinator RETURNED the conflict for the header block — and
`NetworkTransactor.commit` (network-transactor.ts ~712) logged
`WARN: non-tail commit had errors; proceeding after tail commit` and returned overall success
anyway: the loser's private tail block had already committed, and non-tail failures were
categorically tolerated on the theory that reconciliation finishes lagging peers. That theory
holds for transport faults (the commit consensus exists; peers converge) but is WRONG for a
returned conflict: a rival owns that block's revision and no reconcile will ever apply our
transform — the action is torn and the acknowledged entry unreachable. Fix: the non-tail sweep
now runs the same returned-refusal extraction `commitBlock` already used for the tail (extracted
as `staleFromBatches`), returns the merged `StaleFailure` when any cohort coordinator answered
`success: false`, and keeps the tolerance only for transport-shaped (thrown) failures.
`commitCollection` already maps any returned failure to `stale: true`, so the writer cancels,
re-reads, and re-drives at a fresh revision — which is exactly what the now-green mesh spec
observes. Known cost, flag in the handoff: the already-committed private tail block of the loser
is orphaned garbage (nothing references it); the re-driven action appends into the winner's
chain.

**Test assertion fix (deliberate, not a weakening):** in
`coordinator-repo-stale-classification.spec.ts`, the "rethrows when the request carries no rev"
test asserted zero classification re-reads. That predates `classifyPendingConflictRejection`
(landed three commits back with the suite never run since), which legitimately performs one
rev-independent confirmation read on every pend `ValidatorRejectionError`. The substantive
assertion (the rethrow) is unchanged; the read-count is now 1 with a comment explaining why.

## Verification TODO (in order)

- Run the full db-p2p suite; fix fallout. Watch specifically: `coordinator-repo-commit-divergence.spec.ts`
  (its tolerated-divergence cases now pass through the new localCommitResult consult — a mock
  coordinator returning `localExecuted: true` with no `localCommitResult` keeps the old behavior,
  so they should stay green), `cluster-consensus-divergence.spec.ts`, and
  `coordinator-repo-pend-divergence.spec.ts` (8 tests, must stay green).
- Run the db-core suite (`yarn workspace @optimystic/db-core test`) — the transactor change is
  there; check any spec that exercised the non-tail tolerance.
- Add unit tests:
  - `coordinator-repo-commit-conflict.spec.ts` (harness stubs the coordinator object — extend it
    to resolve `{record, localExecuted: true, localCommitResult}`): retained refusal + rival at
    rev → conflict with staleAt; retained refusal + own action at rev → success (no conflict);
    retained refusal + unconfirmed (behind/capability-absent) → success; retained success →
    success; no retained verdict → success (prior shape).
  - Member-side retention: drive a commit consensus through `ClusterMember` (see
    `cluster-consensus-divergence.spec.ts` for a harness that reaches apply) and assert
    `getExecutedCommitResult` returns storage's verdict, and that it is dropped on apply
    rollback.
  - db-core: non-tail sweep returning a merged StaleFailure when a batch response is
    `success:false`, and still tolerating a thrown (transport) failure. Mirror whatever harness
    `network-transactor` specs already use.
- Re-run the mesh spec (must stay green — it is the exit criterion; its membership/uniqueness
  assertions also catch the duplicate-entry hazard of a wrong own-action arm).
- Remove the mesh-spec entry from `tickets/.pre-existing-known.md` (listed under slug
  `1-consensus-pend-refusal-commit-tier-and-verify`) once suites are green. The reference-peer
  entry there falls with the reproducer run below.
- Run the reference-peer reproducer ("should handle concurrent writes"):

  ```
  cd packages/reference-peer
  DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:storage*,optimystic:db-p2p:coordinator*' \
    node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" \
    --reporter spec --timeout 60000 --grep "concurrent writes"
  ```
- `yarn check` from root (lint + build + typecheck + test + test:integration). Foreground, no
  silent redirection; `| tee tickets/.logs/<slug>.log` only if grepping afterwards.
- Verify the index-fork link (inherited): with the fix, capture whether two actions can still
  both reach `storage-repo commit … rev=1` on disjoint member subsets; record the result either
  way. Note: per-member apply ORDER of two consensus-passing commits is not globally coordinated,
  so a fork window may remain when members apply in different orders — if observed, that is
  partition-healing scope; document, don't chase.
- Write the review handoff into review/ (delete this ticket). It must state:
  - pend tier closed (8 green tests in `coordinator-repo-pend-divergence.spec.ts` + retained
    pend-verdict wiring);
  - commit tier closed on the evidence of the mesh spec going green, listing all FIVE arms:
    (1) `ConflictRaceLostError` returned as conflict, (2) member promise-round
    `validateCommitRevisions`, (3) coordinator classification of commit
    `ValidatorRejectionError`, (4) retained commit-verdict threading (this run), (5) db-core
    non-tail conflict surfacing (this run);
  - the REFUTED ordering premise, quoted: members drop a commit's reservation when they SIGN it,
    which can precede applying it by a full propagation round; on a fast cohort every member sits
    in that window simultaneously, so a rival's commit assembling consensus is the COMMON case —
    the residual doc on `validateCommitRevisions` and the NOTE at the apply 'ahead' tolerance
    both describe this and name the retained-verdict backstop;
  - remaining residuals: only the COORDINATING node's own member verdict is threaded back (pend
    and commit both); non-coordinating members' refusals are invisible if the coordinator's own
    member happened to apply the rival first-and-successfully; capability-less or
    history-truncated storage abstains/unconfirms; the loser's committed private tail block is
    orphaned garbage;
  - the pend-tier `missing`-shape deviation (a pend's `missing` means the requested rev is
    already committed and the pend can never win — deliberately treated as conflict);
  - why db-core's verbatim commit retry needed no change (with all returned-conflict arms in
    place, remaining throws out of commit are transport-shaped and verbatim retry is correct).

## Constraints (inherited, binding)

- No timeout widening; the reference-peer failing test stays as-is in shape and strength; keep
  the per-instance `Collection` latch key; `advanceContext`'s no-lower guard stays; acknowledged
  means durable; wire format / storage format / signed reasons unchanged (`IRevisionActionReader`
  and the retained verdicts are node-local, not wire); two-lineage handling stays parked in
  partition-healing. Do not weaken or skip the mesh spec.
- `fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits the custom-validator
  guard in `validatePendOperations` — expect a textual conflict there for whoever lands second.

## End
