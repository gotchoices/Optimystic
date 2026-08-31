description: Finish the fix for writers being told their write succeeded when the cluster never durably stored it — the pend-tier fix is now complete and tested; a new mesh regression test proves the same silent loss still happens one tier up, at commit, and that is what remains, plus the verification runs.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (pend tier DONE this run — see "Landed"; commit tier is the remaining work: `commit`'s catch rethrows ConflictRaceLostError, and `tolerateLocalCommitDivergence` premise is now disproven by trace)
  - packages/db-p2p/src/cluster/cluster-repo.ts (consensus-commit-diverged 'ahead' tolerance — the member-side half of the commit-tier hole)
  - packages/db-core/src/transaction/coordinator.ts (commitPhase — find who retries a THROWN commit error verbatim; the retry is what converts the lost race into a fake success)
  - packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts (NEW this run — 8 passing unit tests for the pend tier)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (NEW this run — mesh regression; concurrent test DELIBERATELY RED, pins the commit-tier residual; sequential test green)
  - tickets/.logs/1-consensus-pend-refusal-finish.mesh.log (this run's captured trace of the commit-tier loss)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (the original reproducer — still to be re-run once commit tier is fixed)
difficulty: hard
----

# Finish: acknowledged means durable — commit tier (continuation)

Third ticket in this chain (replaces `1-consensus-pend-refusal-finish-and-verify`, which replaced
`1-consensus-pend-refusal-is-reported-to-the-writer-as-success`; the concurrent-create fix ticket
`bug-concurrent-create-commits-two-actions-at-one-revision` was also folded into this same chain).
Do not re-derive the diagnosis — the pend tier is DONE and verified; resume at "The commit-tier
hole" below.

## Landed this run (2026-08-31; db-p2p builds, unit spec green)

- **`classifyPendingConflictRejection`** added to `CoordinatorRepo` and wired into `pend`'s catch
  after `classifyStaleRejection`: a promise-phase pending-conflict rejection
  (`ValidatorRejectionError`) is confirmed against LOCAL storage (`state.pendings` carrying a
  rival actionId; self excluded; reject text never consulted) and returned as
  `{ success: false, conflict: true, pending: ActionPending[] }`. Unconfirmed stays a throw.
- **Missing wire found and fixed**: the prior run's retention plumbing never worked end-to-end —
  `CoordinatorRepo`'s constructor built `localClusterRef` WITHOUT binding
  `getExecutedPendResult`, so every retained verdict read as absent (`localVerdict: 'none'` in
  trace) and the fabricated-success fallback always won. Now bound (and declared on
  `LocalClusterWithExecutionTracking`). This is why the prior run's "landed" code had no effect in
  any real mesh.
- **Unit spec** `packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts` — 8 tests, all
  passing: retained `pending`-refusal ⇒ conflict; retained `missing`-refusal ⇒ conflict (the
  deliberate deviation from the original ticket — for a *pend*, `missing` means the requested rev
  is already committed and the pend can never win; keep this in the review handoff); bare-reason
  refusal tolerated; retained success verbatim; no-verdict fallback; classifier confirms rival ⇒
  conflict; self-actionId not a rival ⇒ throw; unconfirmed ⇒ throw.
- **Mesh regression spec** `packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts`:
  sequential-appends test passes; the concurrent test is RED on purpose — it caught the next tier
  (below). Listed in `tickets/.pre-existing-known.md` under this ticket's slug so other agents
  don't re-report it. Getting it green is this ticket's exit criterion — do NOT weaken or skip it.

## The commit-tier hole (observed, trace in tickets/.logs/1-consensus-pend-refusal-finish.mesh.log)

3-node mesh, one diary, three concurrent appends. With the pend tier fixed the loss moved up one
layer, same silent-acknowledgement shape:

1. All three pends succeed (policy `'c'` lets pendings coexist; verdicts retained correctly now).
2. Three commits race for the same revision. One wins commit-consensus. The two losers each get
   `ConflictRaceLostError` ("3/3 member(s) hold a conflicting winner (0/3 approvals)").
3. `CoordinatorRepo.commit`'s catch logs `commit-error` and RETHROWS (only `pend` converts that
   error to a conflict result). Nothing landed for the loser at this point — a loud loss so far.
4. Something above (db-core's transaction coordinator / transactor layer — locate it in
   `packages/db-core/src/transaction/coordinator.ts` `commitPhase`) treats the thrown error as a
   transport-style failure and RETRIES THE SAME COMMIT VERBATIM.
5. The retry starts a fresh commit-consensus. Members' reservations were cleared when the winner
   committed; the promise-phase digest check ABSTAINS for update-only transforms whose declared
   `baseRev` no longer equals the (now advanced) local base (`validateCommitOperations`'s
   documented checkable/abstain rule). All three members approve. Commit-consensus reached.
6. At apply, every member's storage refuses `commit:stale … missed=1`, and every member TOLERATES
   the refusal as `consensus-commit-diverged { divergence: 'ahead', hasMissing: true }` — the
   tolerance built for a lagging member assumes "local latest.rev >= request.rev" means this
   member already has the commit; here the revision was taken by the RIVAL action, so all three
   members tolerate a commit that landed on nobody.
7. The coordinator sees `localExecuted: true` and returns `{ success: true }`. The writer's append
   FULFILLS; the entry exists on no node. Exactly the pend bug, one tier up.

**This disproves the prior ticket's carried-forward premise** ("commit's `{ success: true }` rests
on commit-consensus being authoritative (Theorem 9)… justified for commits"). Theorem 9's quorum
intersection holds for concurrently-pending rivals, but after the winner commits and reservations
clear, a dead rival's re-broadcast commit assembles its own super-majority unimpeded — consensus
without durability. The prior instruction "do not thread commit results" was premised on this not
happening; the reviewer/implementer must now weigh it against this trace.

## Remaining work

- **Close the commit-tier acknowledgement hole.** Candidate arms (evaluate; likely need the first
  plus one member-side arm):
  - `CoordinatorRepo.commit`: convert `ConflictRaceLostError` to
    `{ success: false, conflict: true, reason }` exactly as `pend` does. At the moment it is
    thrown, 0 members approved and members hold the winner — nothing of the loser landed, so a
    retryable-conflict answer is truthful, db-core's commitPhase takes its stale branch, and the
    writer rebases instead of the verbatim retry ever happening. (Update the
    `ConflictRaceLostError` doc-comment which currently says it should escape as a throw from
    non-pend paths.) This alone probably makes the mesh test green.
  - Member-side, so OTHER routes into step 5 can't resurrect the hole: in the commit
    promise/apply path, distinguish "I already hold THIS action at/past this rev" (genuine
    'ahead', tolerate) from "a DIFFERENT action took this rev" (the commit can never apply
    anywhere — reject/refuse honestly). The block's revision→actionId is locally readable; no
    reject-text parsing needed. Touches `cluster-repo.ts`'s `consensus-commit-diverged` tolerance
    and/or `validateCommitOperations`' abstain rule; be careful to keep the lagging-member
    tolerance (that fix is pinned by `coordinator-repo-commit-divergence.spec.ts` — keep those 4
    tests green).
  - Check whether the db-core-layer verbatim commit retry should distinguish thrown conflict
    errors from transport errors at all.
- **Run the mesh spec until the concurrent test passes**, then remove its entry from
  `tickets/.pre-existing-known.md`.
- **Run the reference-peer reproducer** (below) and confirm "should handle concurrent writes"
  passes; keep the trace in tickets/.logs/:

  ```
  cd packages/reference-peer
  DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:storage*,optimystic:db-p2p:coordinator*' \
    node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" \
    --reporter spec --timeout 60000 --grep "concurrent writes"
  ```
- **`yarn check` from root** (lint + build + typecheck + test + test:integration). Watch suites
  that stub `IRepo.get`: `validatePendOperations` now calls `get` on every pend vote, and the new
  `classifyPendingConflictRejection` calls `get` in `pend`'s catch — a mock whose `get` throws
  could newly reject or misclassify in existing specs.
- **Verify the index-fork link** (inherited): with the full fix applied, re-run the downstream
  index reproducer or capture a run where two actions both reach `storage-repo commit … rev=1` on
  disjoint member subsets; record the result either way.
- **Review handoff into review/**, stating: the pend tier is closed (evidence: unit spec + the
  retained-verdict trace); whether the commit tier is closed and on what evidence (the mesh spec
  going green); the `missing`-shape deviation for pends (above); the residual that only the
  COORDINATOR's own member's verdict is threaded back for pends (a refusal confined to remote
  members alone can still be acknowledged — the promise-phase votes narrow exactly that window);
  and whatever residual the chosen commit-tier arm leaves.

## Constraints (inherited, binding)

- No timeout widening; the reference-peer failing test stays as-is in shape and strength; keep the
  per-instance `Collection` latch key; `advanceContext`'s no-lower guard stays; acknowledged means
  durable; wire format / storage format / signed reasons stay unchanged; what to do once two
  lineages exist stays parked in partition-healing (note: the commit-tier hole above is NOT a
  two-lineage question — nothing landed for the loser).
- `fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits the custom-validator
  guard in `validatePendOperations` — expect a textual conflict there for whoever lands second.
