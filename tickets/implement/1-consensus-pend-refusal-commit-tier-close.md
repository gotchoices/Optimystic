description: Finish the fix for writers being told their write succeeded when the cluster never durably stored it — the pend tier is done and tested; what remains is the same silent loss one tier up at commit, and the design for closing it is now fully settled (three concrete arms below), plus the verification runs.
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts (Arm 1 at commit's catch ~line 1642; Arm 3 reuses/generalizes classifyStaleRejection ~1454; pend's ConflictRaceLostError conversion pattern to mirror is at ~1425)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (ConflictRaceLostError doc-comment ~36-54 must be updated; throw site ~449)
  - packages/db-p2p/src/cluster/cluster-repo.ts (Arm 2: evaluatePromise ~979, validateCommitOperations ~1324; apply 'ahead' tolerance ~1632 stays as-is, add NOTE)
  - packages/db-p2p/src/storage/storage-repo.ts (new revision→actionId capability, mirroring ICommitDigestPreviewer at ~80; commit's alreadyDone/missedCommits partition ~646-690 is the semantics to mirror)
  - packages/db-core/src/transaction/coordinator.ts (commitCollection ~1170-1193 — behavior already correct for the fix; only its NOTE at ~1178 needs updating)
  - packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts (pend tier's 8 green unit tests — keep green)
  - packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts (4 tests pinning the lagging-member commit tolerance — keep green)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (concurrent test DELIBERATELY RED, pins the commit-tier hole; getting it green is the exit criterion — do NOT weaken or skip it)
  - tickets/.logs/1-consensus-pend-refusal-finish.mesh.log (captured trace of the commit-tier loss)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (original reproducer — re-run once commit tier fixed)
difficulty: hard
----

# Close the commit-tier acknowledgement hole (continuation)

Fourth ticket in this chain (replaces `1-consensus-pend-refusal-commit-tier-and-verify`, which
replaced `1-consensus-pend-refusal-finish-and-verify`, which replaced
`1-consensus-pend-refusal-is-reported-to-the-writer-as-success`). **Do not re-derive the diagnosis
or the design** — the pend tier is DONE and verified (8 green unit tests in
`coordinator-repo-pend-divergence.spec.ts`, retained-verdict wiring fixed), the commit-tier hole is
observed and traced (`tickets/.logs/1-consensus-pend-refusal-finish.mesh.log`), and this run
settled the implementation design below by reading all the relevant code. Start implementing
directly at "The three arms".

## The commit-tier hole (recap; trace in the log above)

3-node mesh, three concurrent appends to one diary. All three pends succeed (policy `'c'`). Three
commits race one revision; one wins commit-consensus; each loser gets `ConflictRaceLostError`
("3/3 member(s) hold a conflicting winner (0/3 approvals)"). `CoordinatorRepo.commit`'s catch
RETHROWS it (only `pend` converts it). db-core's `commitCollection`
(`packages/db-core/src/transaction/coordinator.ts` ~1170) retries a THROWN commit error verbatim
up to 3 times (it treats throws as transport failures; a RETURNED `success:false` is never
retried there). The retry starts a fresh commit-consensus; by then members applied the winner and
cleared its reservation, so no conflict votes; the promise-phase content-digest check ABSTAINS for
update-only transforms whose declared `baseRev` no longer matches the advanced local base
(`validateCommitOperations`' documented checkable/abstain rule); all approve; consensus reached.
At apply every member's storage refuses `commit:stale … missed=1` and every member tolerates it as
`consensus-commit-diverged { divergence: 'ahead' }`; the coordinator sees `localExecuted: true`
and returns `{ success: true }`. The writer's append fulfills; the entry exists on no node.

This disproves the earlier "commit-consensus is authoritative (Theorem 9), do not thread commit
results" premise for DEAD rivals: after the winner commits and reservations clear, a dead rival's
re-broadcast commit assembles its own super-majority unimpeded — consensus without durability.

## The three arms (settled design — implement these)

**Arm 1 — `CoordinatorRepo.commit` converts `ConflictRaceLostError` to a conflict result.**
In the catch at `coordinator-repo.ts` ~1642, before the rethrow, mirror `pend`'s ~1425:
`if (error instanceof ConflictRaceLostError) return { success: false, conflict: true, reason: error.message }`.
At the moment it is thrown, 0 members approved and members hold the winner — nothing of the loser
landed, so a retryable-conflict answer is truthful. db-core's `commitCollection` returns a
RETURNED `success:false` immediately as `stale: true` (no verbatim retry), `coordinateTransaction`
cancels the pend, `commitOnceLatched` restores trackers and throws `CoordinatorStaleLossError`,
and the `commit()` wrapper re-reads and re-drives the whole pend+commit at a fresh revision. The
verbatim-retry route into the hole is gone. Update the `ConflictRaceLostError` doc-comment
(`cluster-coordinator.ts` ~36-54), which currently says it should escape as a throw from non-pend
paths. Also update the stale NOTE in `commitCollection` (~1178) which says "no commit producer
sets `conflict` today" — one now does; the behavior there needs no change (all returned failures
already map to `stale: true`, and `isConflictFailure` — `stale-failure.ts:11`,
`conflict ?? (missing?.length || pending?.length)` — covers the new shape).

**Arm 2 — member-side promise-phase rival-took-the-revision check (`cluster-repo.ts`).**
So OTHER routes into the dead-rival re-commit can't resurrect the hole. Add a stale-commit check
for commit operations on the promise round (in `evaluatePromise` ~979, beside
`validateCommitOperations` ~1324 — same "must run on the promise round" rule; the commit-round
vote is deliberately blind). For each commit op, `this.storageRepo.get({ blockIds: commit.blockIds })`
(that is the member's raw `StorageRepo` — no cluster recursion), then per block, with
`latest = state.latest` (an `ActionRev` — carries `actionId`, `db-core/src/network/struct.ts:176`):
- `latest` undefined or `latest.rev < commit.rev` → abstain (approve). Preserves the
  lagging-member tolerance pinned by `coordinator-repo-commit-divergence.spec.ts` (4 tests).
- `latest.rev === commit.rev && latest.actionId === commit.actionId` → abstain (approve).
  **Idempotent redelivery of an already-durable commit — MUST NOT reject.** Rejecting here and
  classifying to conflict would make the writer rebase and re-append its already-committed
  actions at a new revision: a DUPLICATE log entry. (Storage's `alreadyDone` partition,
  `storage-repo.ts` ~656, returns success at apply for this shape.)
- `latest.rev === commit.rev && latest.actionId !== commit.actionId` → **reject**, plain-prose
  signed reason (e.g. `stale commit: block X rev N committed by a different action`). This is the
  trace's exact shape. Reason stays prose (fed to computeSigningPayload) — same discipline as the
  stale-revision pend reject at ~1248.
- `latest.rev > commit.rev` → consult a NEW revision→actionId capability on StorageRepo
  (structural probe named-interface pattern, exactly like `ICommitDigestPreviewer`,
  `storage-repo.ts` ~80): e.g. `getRevisionAction(blockId, rev): Promise<ActionId | undefined>`,
  implemented off the block storage's revision index (`listRevisions(rev, rev)` — VERIFY
  inclusivity against `block-storage.ts` before relying on it; storage-repo's commit uses
  `listRevisions(request.rev, latest.rev)` to collect actions at revs ≥ request.rev). Taken by a
  different action → reject; same action → abstain (already durable); `undefined` / capability
  absent / read fault → abstain. Never throw out of the vote path — wrap in try/catch → abstain,
  mirroring the digest check's preview-error arm.

Why no commit-verdict threading (no `getExecutedCommitResult` analog) is needed: members apply a
winning commit (`handleConsensus`) BEFORE cleaning its record out of the conflict/reservation
table, so there is no window where a member has stopped conflict-voting for the winner but has not
yet advanced its storage to the winner's revision. Any member past the reservation window rejects
under this new check; any member still in it conflict-votes; a member genuinely behind abstains —
but if a majority were behind the winner, the winner never reached commit-consensus. So the dead
rival's re-commit can never assemble a super-majority, on any route. Verify this ordering claim
once against `handleConsensus`/record-cleanup code before relying on it in the handoff.

**Arm 3 — coordinator-side classification of commit `ValidatorRejectionError`.**
Arm 2's reject surfaces at the losing coordinator as a thrown `ValidatorRejectionError`; without
classification, db-core's verbatim retry re-drives it 3× and then fails hard (loud, but not the
clean retryable conflict the writer deserves). In `CoordinatorRepo.commit`'s catch, classify it
the way `pend` does — local re-read only, reject text never consulted: generalize
`classifyStaleRejection` (~1454) to take `{ actionId, rev? }` + blockIds (CommitRequest has all
three), or add a commit-shaped sibling. One commit-specific delta: confirmation must EXCLUDE the
own-action-at-rev case — at `latest.rev === rev` compare `latest.actionId`; at `latest.rev > rev`
consult the Arm-2 capability; unreadable → stays a throw (fail-fast, conservative). Confirmed
rival → `{ success: false, conflict: true, reason, staleAt }`.

The third candidate from the prior ticket — making db-core's verbatim commit retry distinguish
thrown conflict errors from transport errors — is NOT needed once arms 1+3 return conflicts as
results: remaining throws out of commit are genuinely transport-shaped, and the verbatim retry is
correct for those. Note this reasoning in the handoff.

## Remaining verification (unchanged from prior ticket)

- **Run the mesh spec until the concurrent test passes**
  (`packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts` — its
  membership/uniqueness assertions also catch the duplicate-entry hazard from a wrong Arm-2
  same-action arm), then remove its entry from `tickets/.pre-existing-known.md` (listed there
  under the predecessor slug `1-consensus-pend-refusal-commit-tier-and-verify`).
- **Run the reference-peer reproducer** and confirm "should handle concurrent writes" passes;
  keep the trace in tickets/.logs/:

  ```
  cd packages/reference-peer
  DEBUG='optimystic:db-p2p:cluster*,optimystic:db-p2p:storage*,optimystic:db-p2p:coordinator*' \
    node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" \
    --reporter spec --timeout 60000 --grep "concurrent writes"
  ```
- **`yarn check` from root** (lint + build + typecheck + test + test:integration). Watch suites
  that stub `IRepo.get`: `validatePendOperations` calls `get` on every pend vote, the pend-tier
  `classifyPendingConflictRejection` calls `get` in `pend`'s catch, and Arm 2 adds a `get` per
  commit vote — a mock whose `get` throws could newly reject or misclassify in existing specs
  (Arm 2's try/catch-to-abstain is what protects the vote path; the coordinator-side classifiers
  already treat read errors as unconfirmed).
- **Keep green**: `coordinator-repo-pend-divergence.spec.ts` (8 tests, pend tier) and
  `coordinator-repo-commit-divergence.spec.ts` (4 tests, lagging tolerance).
- **Verify the index-fork link** (inherited): with the full fix applied, re-run the downstream
  index reproducer or capture a run where two actions both reach `storage-repo commit … rev=1` on
  disjoint member subsets; record the result either way. (Arm 2 also narrows the fork window: a
  member holding the winner at rev now rejects the loser's commit at promise time instead of
  abstaining.)
- **Review handoff into review/**, stating: the pend tier is closed (evidence: unit spec + the
  retained-verdict trace); whether the commit tier is closed and on what evidence (the mesh spec
  going green); the pend-tier `missing`-shape deviation (for a *pend*, `missing` means the
  requested rev is already committed and the pend can never win — deliberate deviation from the
  original ticket, treated as conflict); the residual that only the COORDINATOR's own member's
  verdict is threaded back for pends (a refusal confined to remote members alone can still be
  acknowledged — the promise-phase votes narrow exactly that window); the Arm-2 residual (a
  member without the revision→actionId capability, or with truncated history below `latest`,
  abstains at `latest.rev > commit.rev` — a dead rival's late re-commit could still assemble
  consensus if EVERY checkable member is in exactly that state); and the
  no-commit-verdict-threading rationale above with its ordering premise.

## Constraints (inherited, binding)

- No timeout widening; the reference-peer failing test stays as-is in shape and strength; keep the
  per-instance `Collection` latch key; `advanceContext`'s no-lower guard stays; acknowledged means
  durable; wire format / storage format / signed reasons stay unchanged (Arm 2's reject reason is
  prose inside the existing signed-reason field — allowed; the new capability is node-local, not
  wire); what to do once two lineages exist stays parked in partition-healing (the commit-tier
  hole is NOT a two-lineage question — nothing landed for the loser).
- `fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits the custom-validator
  guard in `validatePendOperations` — expect a textual conflict there for whoever lands second.
  Arm 2 lives beside `validateCommitOperations`, so overlap should be minimal.

## TODO

- Arm 1: convert `ConflictRaceLostError` in `CoordinatorRepo.commit`; update its doc-comment and
  db-core `commitCollection`'s NOTE.
- Arm 2: revision→actionId capability on StorageRepo (verify `listRevisions` inclusivity first);
  promise-phase stale-commit check in cluster-repo with the four-way rule above; verify the
  apply-before-cleanup ordering claim in `handleConsensus`.
- Arm 3: commit-shaped classification of `ValidatorRejectionError` in `CoordinatorRepo.commit`'s
  catch, excluding own-action-at-rev.
- Unit tests for the new arms (extend `coordinator-repo-commit-divergence.spec.ts` or a sibling
  spec: conflict-race-lost → conflict result; rejected-and-confirmed-rival → conflict result;
  rejected-unconfirmed → throw; member vote: rival-at-rev rejects, own-action-at-rev approves,
  behind abstains).
- Verification runs + `.pre-existing-known.md` cleanup + review handoff, per above.

## End
