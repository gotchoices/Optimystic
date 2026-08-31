description: Finish verifying the commit-tier acknowledgement fix — all unit suites and the new arm-specific tests now pass; what remains is the live-swarm reproducer, the full repo gate, one fork-window observation, and writing the review handoff.
files:
  - packages/db-core/src/transactor/network-transactor.ts (non-tail commit conflicts surface; staleFromBatches shared with commitBlock)
  - packages/db-p2p/src/cluster/cluster-repo.ts (executedCommitResults retention + getExecutedCommitResult; residual docs on validateCommitRevisions and the apply 'ahead' NOTE)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (localCommitResult threaded out of executeClusterTransaction)
  - packages/db-p2p/src/repo/coordinator-repo.ts (localExecuted branch consults retained verdict; confirmCommitRivalAgainstLocal shared core)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (exit-criterion mesh spec — GREEN; do not weaken)
  - packages/db-p2p/test/coordinator-repo-commit-conflict.spec.ts (17 tests green — 7 NEW this run for retained-verdict threading)
  - packages/db-p2p/test/cluster-consensus-divergence.spec.ts (17 tests green — 4 NEW this run for member-side verdict retention/rollback)
  - packages/db-core/test/network-transactor.spec.ts (2 NEW tests this run — "commit non-tail conflict surfacing" describe, both green)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (original reproducer — NOT yet re-run)
  - tickets/.pre-existing-known.md (mesh-spec entry removed this run; reference-peer entry remains, falls with the reproducer run)
difficulty: hard
----

# Commit-tier acknowledgement fix — final verification + review handoff (continuation)

Seventh ticket in this chain (continues `1-consensus-pend-refusal-commit-tier-verify2`, which hit
the token budget). **The diagnosis is settled, the code is written, and ALL unit-level
verification is done — do not re-derive, re-design, or re-run what is listed as verified below.**
What remains is purely: the reference-peer reproducer, `yarn check`, one observational check, and
the review handoff.

## Verified this run (do not repeat)

- **Full db-p2p suite: 2369 passing, 0 failing, 49 pending** (~51s). Includes the mesh
  exit-criterion spec (`concurrent-diary-append-acknowledgement.spec.ts`, both tests green),
  `coordinator-repo-commit-divergence.spec.ts`, `cluster-consensus-divergence.spec.ts`,
  `coordinator-repo-pend-divergence.spec.ts` (8 tests), `cluster-commit-staleness.spec.ts`.
  Log: `tickets/.logs/1-consensus-pend-refusal-commit-tier-verify2.dbp2p.log`.
- **Full db-core suite: 1446 passing, 0 failing** (~11s).
  Log: `tickets/.logs/1-consensus-pend-refusal-commit-tier-verify2.dbcore.log`.
- **New unit tests, all green** (scoped runs after writing them: 34 passing across the two
  db-p2p specs, 2 passing in db-core):
  - `coordinator-repo-commit-conflict.spec.ts` — new describe "locally-executed consensus
    consults the retained member verdict": rival-at-rev → conflict with `staleAt`;
    rival-via-capability → conflict; own-action-durable → success; behind/unconfirmed →
    success; capability-absent → success; retained success → success with ZERO classification
    reads; no retained verdict → success with zero reads (prior shape preserved).
  - `cluster-consensus-divergence.spec.ts` — new describe "commit-verdict retention":
    success verdict retained; ahead-shaped refusal retained (with `missing`); missing-pend
    behind path retains NOTHING (deliberate); bare-reason propagated fault rolls the verdict
    back alongside the executed marker.
  - `network-transactor.spec.ts` (db-core) — new describe "commit non-tail conflict surfacing":
    returned non-tail conflict → merged StaleFailure with `staleAt` (tail already committed);
    thrown transport-shaped non-tail failure → still tolerated, overall success.
- **`tickets/.pre-existing-known.md`**: mesh-spec entry REMOVED (suites green). The
  reference-peer entry remains, now pointing at THIS ticket; it falls when the reproducer below
  passes.

NOTE: the full suites ran BEFORE the new test files were edited; the new tests then passed in
scoped runs. `yarn check` below re-runs everything anyway, so no separate full-suite re-run is
needed first.

## Remaining TODO (in order)

- Run the reference-peer reproducer ("should handle concurrent writes"):

  ```
  cd packages/reference-peer
  DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:storage*,optimystic:db-p2p:coordinator*' \
    node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" \
    --reporter spec --timeout 60000 --grep "concurrent writes"
  ```

  On pass, remove the reference-peer entry from `tickets/.pre-existing-known.md` (leave the
  dated removal comments in place).
- `yarn check` from root (lint + build + typecheck + test + test:integration). Foreground, no
  silent redirection; `| tee tickets/.logs/<slug>.log` only if grepping afterwards. Note
  `yarn typecheck` must run after `yarn build` — `yarn check` already orders this.
- Verify the index-fork link (inherited): with the fix, capture whether two actions can still
  both reach `storage-repo commit … rev=1` on disjoint member subsets; record the result either
  way (grep a mesh-spec DEBUG run, e.g.
  `DEBUG='optimystic:*' … concurrent-diary-append-acknowledgement.spec.ts` teed into
  `tickets/.logs/`). Per-member apply ORDER of two consensus-passing commits is not globally
  coordinated, so a fork window may remain when members apply in different orders — if observed,
  that is partition-healing scope; document in the handoff, don't chase.
- Write the review handoff into review/ (delete this ticket). It must state:
  - pend tier closed (8 green tests in `coordinator-repo-pend-divergence.spec.ts` + retained
    pend-verdict wiring);
  - commit tier closed on the evidence of the mesh spec going green, listing all FIVE arms:
    (1) `ConflictRaceLostError` returned as conflict, (2) member promise-round
    `validateCommitRevisions`, (3) coordinator classification of commit
    `ValidatorRejectionError`, (4) retained commit-verdict threading, (5) db-core non-tail
    conflict surfacing — arms 4 and 5 now each have direct unit coverage (see Verified above);
  - the REFUTED ordering premise, quoted: members drop a commit's reservation when they SIGN it,
    which can precede applying it by a full propagation round; on a fast cohort every member sits
    in that window simultaneously, so a rival's commit assembling consensus is the COMMON case —
    the residual doc on `validateCommitRevisions` and the NOTE at the apply 'ahead' tolerance
    both describe this and name the retained-verdict backstop;
  - remaining residuals: only the COORDINATING node's own member verdict is threaded back (pend
    and commit both); non-coordinating members' refusals are invisible if the coordinator's own
    member happened to apply the rival first-and-successfully; capability-less or
    history-truncated storage abstains/unconfirms; the loser's committed private tail block is
    orphaned garbage (nothing references it — the re-driven action appends into the winner's
    chain);
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
