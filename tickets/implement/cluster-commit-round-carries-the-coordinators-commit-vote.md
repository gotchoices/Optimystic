description: In a two- or three-machine group, every consensus operation currently costs three network round trips to each other machine. Have the coordinating machine sign its own commit vote before it asks the others, so they can apply the change as soon as they receive it and the third round trip is only needed when something went wrong.
architecture: docs/internals.md#commit-path-distributed-consensus
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`executeTransaction`, `commitTransaction`, `broadcastMergedRecord`, `reconcileLocalMemberAgain`, `retryCommits`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`processUpdate` phase loop, `getTransactionPhase`, `handleConsensus` early returns, `withOwnApplyOutcome`, `reconcileRefusedCommit`, `captureCommitCert`)
  - packages/db-core/src/cluster/structs.ts (`MemberApplyOutcome`, `ClusterRecord.applyOutcomes`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`commit` durability gate — reads `localCommitResult` / `cohortCommitOutcomes`; behaviour must not change)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshFailureConfig.onClusterDelivery`, for the delivery-count test)
  - packages/db-p2p/test/cluster-coordinator.spec.ts, cluster-repo.spec.ts, cluster-consensus-divergence.spec.ts, commit-durability-quorum.spec.ts, member-missed-commit-heals-at-commit.spec.ts, mesh-harness-restart-and-delivery-hook.spec.ts (existing specs that observe round order)
  - docs/internals.md (§Consensus Execution "A *behind* member actively reconciles" bullet), docs/correctness.md (§2 "Commit durability reporting", the "Second, what makes the gate pass" residual)
----
# The commit round carries the coordinator's own commit vote

## Why

Measured by sereus (two-machine group over a relay, 150 ms added each way): one inserted row opens 9 `/cluster` streams to the other machine and takes 9–10 s. Every consensus operation (`ClusterCoordinator.executeTransaction`) sends each remote member three `update()` calls in sequence:

1. `collectPromises` — the promise vote.
2. `commitTransaction` — the commit vote. The record sent carries promises but no commit signatures, so a member's own commit alone never reaches the strict commit majority (`count > peers / 2`) and nobody applies.
3. `broadcastMergedRecord` — the merged record with every commit signature; members reach consensus and apply here.

A single-collection write runs three consensus operations (pend, tail commit, sweep commit), so 3 × 3 = 9. The sibling ticket `single-coordinator-commit-sends-tail-and-blocks-in-one-round` removes one of the three operations; this ticket removes one call from each.

## Design

**The coordinator's own member votes to commit first, in-process, and its signature rides on the commit round.** In `commitTransaction`, before contacting remotes, deliver the promise-complete record to `localCluster` (no network cost). The local member is in `OurCommitNeeded` (super-majority of approved promises, no commit of its own yet), signs its commit, and returns. Merge that signature into the record, then send the record to the remote members in parallel as today.

A remote member receiving it adds its own commit. In a cohort of two, 2 of 2 commits is a majority; in a cohort of three, 2 of 3 is. The member's existing phase fixpoint loop (`processUpdate`) then moves on to `Consensus` in the same delivery, runs `handleConsensus`, applies to storage, and answers with its apply verdict stamped on (`withOwnApplyOutcome`). No new member-side acceptance rule is involved. In cohorts of four or more, the coordinator's commit plus one member's is still short of a majority, so nobody applies on receipt and the broadcast works exactly as it does today. The change costs nothing there and saves nothing.

**After the commit round**, if the merged commits reach the majority:

- Deliver the merged record to the local member first, awaited (in-process). The local member applies here.
- Then run the broadcast **only to the remote members that still need it**: a member whose commit-round call failed, a member whose response does not report that it executed the consensus apply, and a member whose retained commit verdict is a refusal (see *A remote member is behind* under the risk bullets below). In the common case that list is empty and the broadcast round makes no network call.
- Keep `reconcileLocalMemberAgain` for the case where the local member's apply refused and a remote reports holding the revision. With the new order the remote has usually applied before the local member, so the local member's first reconcile already finds a holder and this second reconcile seldom runs.

**"This member executed" is reported explicitly.** `MemberApplyOutcome` currently carries a pend verdict only when it is a conflict-shaped refusal, so a pend that applied cleanly leaves no trace on the response, and the coordinator cannot tell "applied" from "never reached consensus". Add an optional field meaning "this member has run the consensus apply for this record's `messageHash`", set in `withOwnApplyOutcome` from `executedTransactions`. Like the rest of `applyOutcomes` it is unsigned and advisory: a member that lies about having applied only skips its own broadcast. A member on an older build never sets it, so the coordinator broadcasts to it as it does today, which makes mixed versions safe.

Do not infer execution from the response record carrying a commit majority. That holds today only because of how the phase loop happens to be written, and it would silently stop holding if the loop changed.

## The two Risk bullets from the plan ticket, settled

- **"Members sign commit votes blind, so a member applying on receipt must verify the promise super-majority itself."** It already does, and this design adds no new path to applying. A member reaches `Consensus` only through `validateRecord`, which runs on every incoming record: `validateSignatures` verifies every promise and every commit signature against the key `record.peers` binds to that peer id. A member also reaches `Consensus` only when a strict majority of *verified* commit signatures is present, and an honest member signs a commit only after it has seen super-majority approved promises (`getTransactionPhase`, `OurCommitNeeded`). A record carrying the coordinator's commit plus the receiver's own is the same kind of record the broadcast delivers today. Only when those signatures arrive changes. The content check stays on the promise round, and the commit vote stays blind. Leave the phase machine's acceptance rules alone.
- **"Reconcile relies on the coordinator applying locally first."** This depends on which member is behind:
  - *The coordinating member is behind.* This case gets better. A remote applies during the commit round, so by the time the local member applies, a cohort peer already holds the revision and the local member's first reconcile succeeds.
  - *A remote member is behind* (it never saw the pend, or holds no base for the block). This case gets worse by one round: it applies on receipt, reconciles from `record.peers` minus itself before the coordinator has applied, finds no holder, and keeps a behind-shaped refusal. The fix is to send that member the merged record again after the local apply. That is why the broadcast list above includes members reporting a refused commit. On the member side, a redelivery of an already-executed record currently returns early in `handleConsensus` and does nothing. Change both early returns to also call `reconcileRefusedCommit(record)`, which does nothing unless the retained verdict for that `messageHash` is a behind refusal. The redelivery's response then carries the refreshed verdict, which the durability gate reads. The scheduled `retryCommits` path benefits from the same change.
- **"The durability gate needs every member's apply report, which must then come from the commit response."** `commitTransaction` already merges `applyOutcomes` from commit-round responses (`mergeApplyOutcomes(record, collectApplyOutcomes(...))`, commented "A member can reach consensus during THIS round"). The broadcast's copy still wins where both exist. `CoordinatorRepo.commit` reads `localCommitResult` after the local apply, and `cohortCommitOutcomes` after the (possibly empty) broadcast. The gate rule does not change.

## Expected effect

In a two-member cohort with a healthy member: 2 remote calls per consensus operation instead of 3. For today's single-collection write that is 6 streams instead of 9, and 4 once the sibling ticket lands. The saving applies to every `executeClusterTransaction` caller: pend, commit and cancel.

## Edge cases & interactions

- **The local member's pre-sign fails** (throws, e.g. expired, or `validateRecord` refuses), or `localCluster` is absent (some test wiring): log it and fall back to today's round, which sends to all members including local in parallel. Verify by inspection, plus the existing coordinator specs that run without a `localCluster`.
- **The local pre-sign returns without a commit signature** (defensive: the phase did not reach `OurCommitNeeded`): send the record as received. This leaves today's behaviour. Verify by inspection.
- **The local member reaches consensus from the pre-sign alone** is impossible for any cohort bigger than one, and one-peer cohorts take the solo path (`CoordinatorRepo.commitSolo`) and never reach here. Put an assertion or comment at the pre-sign site, not a test.
- **Commit majority not reached** (a remote was silent): the record carries only the local commit. `scheduleCommitRetry` / `retryCommits` then re-send a record that already carries commits, so a returning member applies on receipt. Is the local member ever re-delivered the merged record on that path? Today it is not, unless self is in the retry list. Make sure the local member ends up applying once the retry assembles a majority. The simplest way is to include self in the retry's delivery set whenever the local member has not executed, delivered first, as in `broadcastMergedRecord`. Verify by inspection, and by a test if an existing one does not already cover a silent-then-returning member in a two-member cohort.
- **A member missing from the promise round receives the commit round** (possible only in cohorts of four or more, since cohorts of up to three need every promise to reach super-majority at the 0.75 threshold): it adds its promise, which changes the commit hash the coordinator's signature was made over. That is a pre-existing defect that also affects today's flow, filed as backlog `bug-a-late-promise-invalidates-the-commit-signatures-already-collected`. This ticket does not fix it, but must not widen it. Apply-on-receipt happens only in cohorts of three or fewer, where every member promised.
- **Commit certificate for reactivity** (`captureCommitCert`, `minSigs = ceil(peers × superMajorityThreshold)`): in a three-member cohort, a remote that applies on receipt holds 2 commit signatures, below `minSigs = 3`. Check what `buildCommitCert` / `CommitCertStore` do with a sub-threshold cert. The acceptable outcome is that a member holding too few signatures retains no cert, and the bridge skips origination on that member (its documented "no retained cert → skip" behaviour), while the coordinating member, which applies with the fully merged record, originates. It must never retain a cert that downstream verification rejects as if it were valid. Verify by inspection. Leave a `NOTE:` at the capture site if the three-member case loses origination on some members.
- **Durable commit proof** (`buildBlockCommitProof` in `applyConsensusOperation`): an apply-on-receipt record in a cohort of two carries 2 of 2 commits; in a cohort of three, 2 of 3. Both pass the verifier's simple-majority commit threshold, and the promise round is complete in both. Verify by inspection. No test.
- **Pend verdicts** (`cohortPendRefusals`): a remote's conflict-shaped pend refusal now arrives on the commit-round response rather than the broadcast. It is already merged from there. Verify with the existing `cohort-pend-refusal-channel.spec.ts`, and keep it green.
- **`recoverTransactions`**: a coordinator restarting mid-'committing' discards the transaction, as today. Nothing changes.
- **Specs that pick a protocol step off the record's shape** (`onClusterDelivery` hooks in `member-missed-commit-heals-at-commit.spec.ts`, `member-leaves-and-returns.spec.ts`, `rival-superseded-only-by-a-writer-that-built-on-it.spec.ts`): the commit-round record now arrives carrying the coordinator's commit signature. Hooks that test `record.commits[target] === undefined` still match. Hooks that assume "no commits yet means the commit round" need re-reading. Re-read each one and keep it testing what its title says.

## Tests

- **One new test, the contract this ticket exists for:** on a two-node mesh (`createMesh(2, { responsibilityK: 2, clusterSize: 2 })`), count remote deliveries through `mesh.failures.onClusterDelivery` for one `coordinatorRepo.pend` plus one `coordinatorRepo.commit` of one block. Expected: 4 (2 per operation), down from 6. Put it beside the existing delivery-hook tests in `mesh-harness-restart-and-delivery-hook.spec.ts` or in its own small spec.
- **Remote-behind heal in a two-member cohort:** a remote that missed the pend still ends up holding the commit, and the commit is acknowledged, now through the re-delivery. First check whether `member-missed-commit-heals-at-commit.spec.ts` or `commit-durability-quorum.spec.ts` already pins this in a two-member shape. Add a test only if none does.
- Otherwise update the existing specs that assert round order. Add nothing else.

## TODO

- Add the "executed" marker to `MemberApplyOutcome` and set it in `withOwnApplyOutcome`.
- Make `handleConsensus`'s already-executed early returns call `reconcileRefusedCommit(record)`.
- In `commitTransaction`: local pre-sign, then the remote commit round with the local signature merged in, then merge commits and apply outcomes, then deliver to the local member (awaited), then broadcast only to members that need it, then `reconcileLocalMemberAgain` as today. Fall back to today's parallel round when the pre-sign is unavailable.
- Make `broadcastMergedRecord` take the list of members still needing delivery. Local delivery moves out of it, or stays first and is skipped when the local member has already executed. Keep a single place that decides delivery order.
- Check the retry path (`retryCommits`) delivers to the local member when it has not executed.
- Check the commit-cert behaviour for a three-member apply-on-receipt, and add a `NOTE:` if needed.
- Add the delivery-count test. Update the round-order specs.
- Update docs: `docs/internals.md` §Consensus Execution (the "*behind* member actively reconciles" bullet describes local-first delivery), and `docs/correctness.md` §2 "Commit durability reporting" (the "what makes the gate pass" residual). Update the long comment on `broadcastMergedRecord` to describe the new order and why.
- Run `yarn test` in `packages/db-p2p` and `yarn test:integration` from the root. Also run `db-core` tests if any shared type changed.
