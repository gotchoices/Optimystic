description: A write could be reported as saved even though no responsible storage node kept it, because the coordinating node counted the cohort's votes instead of checking that the cohort actually stored the data. The commit acknowledgement now requires a majority of the cohort to report durably holding the revision, and the coordinator applies the commit on its own member before fanning out so lagging members can copy the revision from it.
files:
  - packages/db-core/src/cluster/structs.ts (`MemberApplyOutcome.commit`, doc on `ClusterRecord.applyOutcomes`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`applyCommitToStorage`, `durableCommitVerdict`, `holdsCommittedRevision`, `withOwnApplyOutcome`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`executeClusterTransaction` returns `cohortCommitOutcomes`; `broadcastMergedRecord` delivers local-first)
  - packages/db-p2p/src/repo/coordinator-repo.ts (the durability gate in `commit`, `refuseCommitNotDurable`, `cohortDurability`, `isDurableMajority`)
  - packages/db-p2p/src/storage/storage-repo.ts (`COMMIT_NOT_DURABLE_REASON`, `isCommitNotDurableFailure`; tripwire NOTE in `pend`)
  - packages/db-p2p/test/commit-durability-quorum.spec.ts (deterministic pin, three arms)
  - packages/db-p2p/test/coordinator-repo-commit-conflict.spec.ts, coordinator-repo-commit-divergence.spec.ts, coordinator-repo-commit-freshness.spec.ts, cluster-consensus-divergence.spec.ts
  - docs/internals.md, docs/correctness.md
difficulty: hard
repro: verified
----

# Acknowledged Diary commits land on no node — complete

## Summary

A commit's approve votes were never evidence of storage. Every cohort member can sign a commit and then refuse it at apply (it never saw the pend, or holds no base for the block), each member tolerates its own divergence so the stream is not reset, and the coordinator used to count the votes and tell the writer the append had landed.

Now every member retains one post-reconcile durable verdict per applied commit (does local storage record the commit's revision under its action, for every block, after the apply and any reconcile it triggered) and reports it on the record it answers with. The coordinator counts the remote successes plus its own member's verdict against the size of `record.peers` and acknowledges only a strict majority; otherwise it answers the retryable refusal `commit-not-durable: …` (`conflict: true`, so the writer cancels and re-drives at a fresh revision with the same action id). Separately, the coordinator delivers the merged consensus record to its own member first and awaits it before fanning out to the remote members, so a behind member's reconcile finds the coordinator's proof-carrying copy and can adopt it as a single holder.

The invariant, as implemented: a commit is acknowledged to the writer only when more than half of the cohort the commit ran on reports durably holding the committed revision under this action, each member measured after its own reconcile. Freshness arming stays tied to the vote count; the two quorums are not conflated.

## Review findings

**Read first:** the implement-stage diff (commit `7b935081`) in full, then every touched source and test file at HEAD, plus the surrounding code the gate depends on: `StorageRepo.commit` (multi-block ordering, partial landings, `isOwnRevision`), `ClusterMember.processUpdate` and `getTransactionPhase` (when a member can reach consensus), `ClusterCoordinator.collectPromises` / `commitTransaction` / `retryCommits`, `confirmCommitRivalAgainstLocal`, `reconcileDivergentCommit`, and the db-core writer paths that consume a returned commit failure (`TransactorSource.transact` cancels the pend and returns it; `Collection.syncAttempts` retries with backoff under `inFlightActionId`; the multi-collection `commitCollection` maps any returned failure to a retryable stale loss).

**Fixed inline (one finding, minor in size, real in effect).** In the local-executed arm, an own-action confirmation from `confirmCommitRivalAgainstLocal` promoted this node to a durable holder for the gate. That confirmation returns on the first block found held under this action, and `StorageRepo.commit` lands a multi-block batch in order and stops at the first refusal, so a locally torn commit (block A landed, block B refused for a missing base and not reconciled) would have counted the coordinator as holding the whole commit. The member's retained verdict already reports success whenever every block is held, measured after its reconcile, so it is the only local contribution the gate now counts; the confirmation still clears the conflict answer, as before. The conflict spec's "own-durable counts as a holder" case (which the implementer flagged for exactly this scrutiny) was rewritten: with the rest of the cohort durable it acknowledges with no conflict answer, and a new case pins that an own-action confirmation with one remote holder is refused as not durable. The `docs/internals.md` bullet on the locally-executed arm was corrected to match.

**Fixed inline (documentation accuracy).** The `broadcastMergedRecord` doc claimed no member can reach consensus during the commit round; that holds on the first pass (the record carries no commit signatures, and a member's own commit alone never reaches the majority for any cohort larger than one) but not on the scheduled retry, which re-sends a record that already carries commits, in parallel. The doc now says so and points at the retry residual already documented on `executeClusterTransaction`. The pre-existing comment in `commitTransaction` that said members holding super-majority promises reach consensus in that round was over-general for the same reason and was tightened.

**Checked and confirmed correct.**
- The refusal shape is consumed correctly by every writer path: the single-collection path cancels the pend and retries with backoff on the same action id; the multi-collection path maps it to a retryable stale loss. A refused commit whose revision the coordinating member already holds converges through `isOwnRevision` and `inFlightActionId`, as the ticket states.
- The fallback-arm gate runs before the local commit and a failing gate skips it, so a refused commit never seeds a lone off-cohort holder (pinned by `countingCommits` in the divergence spec). A non-consensus record (the "did not reach consensus" case) is now refused before the local commit rather than after it; strictly safer.
- `cohortCommitOutcomes` only ever carries each peer's own entry (`collectApplyOutcomes` reads `response.applyOutcomes[peerId]`), so no member can report for another. The shape check drops anything off the wire that is not a plain success or failure object.
- The ordering witness in `commit-durability-quorum.spec.ts` is deterministic (recorded synchronously on the consensus delivery), and arm 2 uses a repair yardstick larger than the cohort so only the certified single-holder path can adopt the coordinator's copy; the retained proof is asserted.
- Hostile-report analysis in the `MemberApplyOutcome` doc: a false success adds one holder for a member that could equally sign, store, then delete; a false refusal is retry pressure. Accepted.
- Suites at HEAD after the fix: db-p2p 2696 passing / 50 pending / 0 failing (`tickets/.logs/acknowledged-diary-commits-land-on-no-node.review.test.log`), `yarn lint` clean, `yarn lint:docs` clean, `tsc --noEmit` over db-p2p src and test clean; db-p2p rebuilt so downstream `dist` consumers see the change. Not run this pass: `yarn test:integration`, `yarn check`, the reference-peer suite (its concurrent diary test is tracked separately in the ledger).

**Tripwires recorded (a `NOTE:` at the site, not tickets).**
- `ClusterCoordinator.broadcastMergedRecord`: when the coordinating member is itself behind (never saw the pend), its reconcile runs before any remote member has applied, finds no holder, and reports not-durable; the remote members may still carry the majority. Fine while coordinators ordinarily saw the pend; the NOTE names the two remedies if that stops being true.
- `StorageRepo.pend` pass 1 (the implementer's, kept): an update-only pend for a block this node holds no revision of is accepted and can never be promoted here without a reconcile; refuse at `ClusterMember.validatePendOperations` if a wasted consensus round per such write ever becomes worth avoiding.

**Considered and not filed.**
- Pre-upgrade members never stamp the commit arm and count as not holding, so a mixed-version cohort refuses commits its coordinator did not execute locally. Consistent with the project's "no backwards compatibility yet" rule; no ticket.
- A coordinator outside the cohort still writes a local copy when the gate passes (the routing spec's direct-write arm shows `holdersOutsideCohort: 1`). By design per the ticket; the off-cohort residual belongs to `tickets/blocked/writer-and-servers-disagree-on-where-a-block-lives`, which already claims the routing site.
- A member reached only by the scheduled commit-retry timer applies after the coordinator answered, so its report never counts and the gate refuses honestly. Documented in `docs/correctness.md`; the writer's same-action-id retry converges it. No ticket.
- `coordinator-repo.ts` and `cluster-repo.ts` are each well over two thousand lines. Pre-existing, and `debt-freshness-state-scattered-across-coordinator-repo` already claims the coordinator split; not re-filed.

**Tickets filed:** none. Every finding was either fixed inline, recorded as a tripwire, or already claimed by an open ticket.
