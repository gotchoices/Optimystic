description: Verify and land the just-implemented fix for writers being told a write succeeded when the cluster never durably stored it — all three code arms are written but NO tests or builds have been run yet; this ticket is the verification pass plus the review handoff.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (Arm 1 + Arm 3 implemented in commit's catch; new classifyCommitStaleRejection after pend's classifiers)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (ConflictRaceLostError doc-comment updated)
  - packages/db-p2p/src/cluster/cluster-repo.ts (Arm 2: new validateCommitRevisions wired into evaluatePromise before validateCommitOperations; NOTE added at the apply 'ahead' tolerance)
  - packages/db-p2p/src/storage/storage-repo.ts (new IRevisionActionReader interface + StorageRepo.getRevisionAction via listRevisions(rev, rev))
  - packages/db-core/src/transaction/coordinator.ts (commitCollection NOTE updated; no behavior change)
  - packages/db-p2p/test/coordinator-repo-commit-conflict.spec.ts (NEW, unrun — Arms 1+3 unit tests)
  - packages/db-p2p/test/cluster-commit-staleness.spec.ts (NEW, unrun — Arm 2 member-vote tests)
  - packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts (keep green)
  - packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts (keep green)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (DELIBERATELY RED mesh spec — getting it green is the exit criterion; do NOT weaken or skip it)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (original reproducer)
  - tickets/.logs/1-consensus-pend-refusal-finish.mesh.log (captured trace of the commit-tier loss)
difficulty: hard
----

# Verify the commit-tier acknowledgement fix (continuation)

Fifth ticket in this chain (replaces `1-consensus-pend-refusal-commit-tier-close`, whose run
implemented all three arms but hit the token budget before running ANY validation). **Do not
re-derive the diagnosis or re-design the arms** — the code is written; this run's job is:
compile it, run the tests, fix fallout, run the mesh/reproducer verification, and write the
review handoff. Read the implemented code first (files above), then go straight to
"Verification TODO".

## What the previous run implemented (all edits landed, none validated)

**Arm 1 — `CoordinatorRepo.commit` converts `ConflictRaceLostError` to a conflict result.**
In `commit`'s catch (`coordinator-repo.ts`), before the rethrow:
`if (error instanceof ConflictRaceLostError) return { success: false, conflict: true, reason: error.message }`
(no `staleAt` — confirmed-only, matching pend's conversion). This removes db-core
`commitCollection`'s verbatim-retry route into the hole: a RETURNED `success:false` is surfaced
immediately as `stale: true`, the writer cancels the pend, re-reads, and re-drives pend+commit at
a fresh revision. `ConflictRaceLostError`'s doc-comment (`cluster-coordinator.ts`) and
`commitCollection`'s NOTE (`db-core/src/transaction/coordinator.ts` ~1178) were both updated; the
NOTE documents why no db-core behavior change is needed (all returned failures already map to
`stale: true`; `isConflictFailure` covers the new shape).

**Arm 2 — member-side promise-round stale-commit check.**
New `ClusterMember.validateCommitRevisions` (`cluster-repo.ts`), called from `evaluatePromise`
between `validatePendOperations` and `validateCommitOperations`. Per commit operation it reads
`this.storageRepo.get({ blockIds: commit.blockIds })` (the member's raw StorageRepo — same seam
pend votes read) and applies the four-way rule per block:
- no `latest` or `latest.rev < commit.rev` → abstain (lagging tolerance preserved);
- `latest.rev === commit.rev` same action → abstain (idempotent redelivery — MUST NOT reject,
  else the writer rebases an already-landed action into a duplicate entry);
- `latest.rev === commit.rev` different action → reject with plain-prose signed reason
  `stale commit: block X rev N committed by a different action`;
- `latest.rev > commit.rev` → structural probe for the new `IRevisionActionReader` capability
  (`getRevisionAction(blockId, rev)`): rival → reject; own action → abstain; undefined/absent/
  fault → abstain. Every read is try/catch → abstain; nothing throws out of the vote path.

New capability: `IRevisionActionReader` in `storage-repo.ts` (named-interface pattern mirroring
`ICommitDigestPreviewer`), implemented by `StorageRepo.getRevisionAction` off
`listRevisions(rev, rev)` — inclusivity VERIFIED against `i-block-storage.ts:79`,
`i-raw-storage.ts:14`, and `kv-raw-storage.ts` ("Both bounds inclusive"). Node-local, not wire.

**Arm 3 — coordinator-side classification of commit `ValidatorRejectionError`.**
New `CoordinatorRepo.classifyCommitStaleRejection` (commit-shaped sibling of
`classifyStaleRejection`, placed near `tolerateLocalCommitDivergence`), called from `commit`'s
catch after the Arm-1 conversion. Local re-read only; reject text never consulted. Scans every
block; confirmation EXCLUDES own-action-at-rev: `latest.rev === rev` compares `latest.actionId`
(ours → bail, stays a throw); `latest.rev > rev` consults `getRevisionAction` (ours → bail;
rival → confirmed; undefined/absent/fault → unconfirmed). Confirmed rival →
`{ success: false, conflict: true, reason, staleAt }` with `staleAt` = highest confirmed
(`highestStaleAt`). Anything unconfirmed, including read errors → rethrow (fail-fast).

**Tests written (NOT yet executed):**
- `test/coordinator-repo-commit-conflict.spec.ts` — Arms 1+3: race-lost → conflict; confirmed
  rival at rev → conflict+staleAt; rival via capability → conflict; own-action at rev / via
  capability → throw; capability absent / undefined / behind / read-fault → throw; plain
  transport error → rethrow untouched.
- `test/cluster-commit-staleness.spec.ts` — Arm 2 member votes, harness mirrors
  `cluster-commit-digest.spec.ts` (`clusterMember` factory + `member.update`, vote read from
  `record.promises[self]`): rival-at-rev rejects (exact prose reason asserted); rival via
  capability rejects; own-action / lagging / never-seen / capability-own / capability-unknown /
  capability-absent / capability-throws / get-throws all approve.

## Key finding for the handoff: the ticket's ordering premise is REFUTED

The prior ticket's no-commit-verdict-threading rationale claimed "members apply a winning commit
(handleConsensus) BEFORE cleaning its record out of the conflict/reservation table, so there is no
window where a member has stopped conflict-voting for the winner but has not yet advanced its
storage to the winner's revision", and asked for verification. **Verified FALSE**: per
`cluster-repo.ts`'s phase loop (`OurCommitNeeded` sets `shouldPersist = false` → `clearTransaction`)
and the explicit NOTE above it (~line 870: "signing the commit drops this member's reservation…
The safety argument is quorum intersection, NOT the reservation"), a member drops its reservation
when it SIGNS the winner's commit — which can precede applying it by a full propagation round. In
that window the member neither conflict-votes the loser's re-commit (no held record) nor rejects
it under Arm 2 (storage still behind the winner's rev → abstain). So the Arm-2 residual is wider
than the prior ticket stated: a dead rival's re-commit can still pass the promise round if EVERY
member is simultaneously in one of {signed-but-not-yet-applied, capability-less,
history-truncated-below-latest}. This is documented in `validateCommitRevisions`' doc-comment
(the "Residual" paragraph) and in the NOTE added at the apply 'ahead' tolerance. Arm 1 closes the
OBSERVED route (the verbatim re-drive); Arms 2+3 narrow the rest; the residual goes in the
handoff verbatim. The third prior-ticket candidate (making db-core's verbatim commit retry
distinguish thrown conflict errors from transport errors) remains NOT needed: with arms 1+3
returning conflicts as results, remaining throws out of commit are genuinely transport-shaped and
the verbatim retry is correct for them.

## Verification TODO (nothing below has been run)

- Build first (`yarn build` from root or the db-p2p/db-core workspaces), then run the db-p2p unit
  suite; fix any compile/test fallout in the new code. Expect possible interactions in suites that
  stub `IRepo.get` on the member seam — Arm 2 adds a `get` per commit vote, but abstains on throw
  and on empty results, so mock-repo harnesses (whose `get` returns `{}`) should stay green.
  Also confirm `cluster-consensus-divergence.spec.ts` still passes: if it drives commit records
  through the promise phase on a member seeded AHEAD at the same rev under a different action,
  Arm 2 now rejects where it used to approve — if that trips, inspect whether the spec models a
  genuine lagging/redelivery case (fix the test setup expectations deliberately, in the spirit of
  the arm) or a real regression. Do not weaken the four-way rule to get green.
- Keep green: `coordinator-repo-pend-divergence.spec.ts` (8 tests) and
  `coordinator-repo-commit-divergence.spec.ts` (4 tests).
- **Run the mesh spec until the concurrent test passes**
  (`packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts` — its
  membership/uniqueness assertions also catch the duplicate-entry hazard from a wrong Arm-2
  same-action arm), then remove its entry from `tickets/.pre-existing-known.md` (listed under the
  predecessor slug `1-consensus-pend-refusal-commit-tier-and-verify`).
- **Run the reference-peer reproducer** and confirm "should handle concurrent writes" passes;
  keep the trace in tickets/.logs/:

  ```
  cd packages/reference-peer
  DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:storage*,optimystic:db-p2p:coordinator*' \
    node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" \
    --reporter spec --timeout 60000 --grep "concurrent writes"
  ```
- **`yarn check` from root** (lint + build + typecheck + test + test:integration). Run long
  validations in the foreground (no silent redirection); `| tee tickets/.logs/<slug>.log` only if
  grepping afterwards.
- **Verify the index-fork link** (inherited): with the fix applied, re-run the downstream index
  reproducer or capture a run where two actions both reach `storage-repo commit … rev=1` on
  disjoint member subsets; record the result either way. (Arm 2 narrows the fork window: a member
  holding the winner at rev now rejects the loser's commit at promise time instead of abstaining.)
- **Review handoff into review/**, stating: the pend tier is closed (evidence: 8 green unit tests
  in `coordinator-repo-pend-divergence.spec.ts` + the retained-verdict wiring); whether the commit
  tier is closed and on what evidence (the mesh spec going green); the pend-tier `missing`-shape
  deviation (for a *pend*, `missing` means the requested rev is already committed and the pend can
  never win — deliberate deviation, treated as conflict); the residual that only the COORDINATOR's
  own member's verdict is threaded back for pends; the WIDENED Arm-2 residual and refuted ordering
  premise (paragraph above — quote it); and the no-verbatim-retry-change rationale.

## Constraints (inherited, binding)

- No timeout widening; the reference-peer failing test stays as-is in shape and strength; keep the
  per-instance `Collection` latch key; `advanceContext`'s no-lower guard stays; acknowledged means
  durable; wire format / storage format / signed reasons stay unchanged (Arm 2's reject reason is
  prose inside the existing signed-reason field; `IRevisionActionReader` is node-local, not wire);
  two-lineage handling stays parked in partition-healing.
- `fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits the custom-validator
  guard in `validatePendOperations` — expect a textual conflict there for whoever lands second;
  `validateCommitRevisions` sits between it and `validateCommitOperations` in `evaluatePromise`.

## End
