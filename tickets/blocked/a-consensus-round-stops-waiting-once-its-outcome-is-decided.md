description: When a change is agreed among a group of machines, the coordinating machine waits for every member to answer each voting round, even after enough members have already agreed, so one connected-but-silent member (a sleeping phone, a background browser tab) delays every write it takes part in by its full timeout. A round should finish as soon as its outcome is decided and deliver to late members in the background.
architecture: docs/internals.md#both-consensus-rounds-carry-the-coordinators-own-members-vote
files: packages/db-p2p/src/repo/cluster-coordinator.ts (`collectPromises`, `executeClusterTransaction`, `commitTransaction`, `collectCommits`, `broadcastMergedRecord`, `updateMember`, the commit-broadcast retry), packages/db-p2p/src/cluster/cluster-repo.ts (`ClusterMember` record merge and signature validation), docs/correctness.md, packages/db-p2p/docs/cluster.md
----

**Blocked: a go/no-go question.** The change is well specified below, but it edits correctness-critical consensus code and helps only some cohort sizes. Unblocks when a maintainer decides whether to take it now; it then goes to `plan/` with backlog `bug-a-late-promise-invalidates-the-commit-signatures-already-collected` as its prereq.

## Proposal (recommended default)

Defer until the reporter's cohort sizes are known. At the default super-majority threshold of 0.75, a cohort of two or three needs every member's promise, so finishing the promise round early helps only cohorts of four or more (the commit round, a simple majority, from three). If the stalled control cohorts in GitHub #64 and sereus#63 have two or three members, this change does not fix them, and the fixes that do are keeping read-only or unresponsive machines out of cohorts (`plan/client-only-node`) or a liveness-based exclusion. Ask on GitHub #64 how many members the slow cohorts had. If four or more, take the change as specified, after closing the late-promise defect, which early completion would make much more likely.

## Alternatives

- **Take it now regardless.** Real gain for cohorts of four or more, at the cost of new interleavings in the promise and commit rounds (late promises, owed deliveries, reputation penalties) that the constraints below must all cover.
- **Decline.** Leaves one silent member able to stall every write it takes part in, by its full timeout.

## Reversibility

Moderate: the round logic can be reverted, but any record-format or signature-rule change made to support it would need care.

# A consensus round stops waiting once its outcome is decided

Reported as GitHub #64 (VoteTorrent, `@optimystic/db-p2p` 1.27.0).

## What happens

`ClusterCoordinator.collectPromises` sends the promise request to every remote cohort member and `await`s `Promise.all` over them; each request carries `promiseImmediateRetries` in-line retries. The super-majority count (`Math.ceil(peerCount × superMajorityThreshold)`) is computed by its caller only after every request has settled. `collectCommits` and `broadcastMergedRecord` likewise `Promise.all` over their members. So a member that is connected but does not answer costs each round its whole per-attempt deadline times its attempts, even when the rest approved in milliseconds. Verified by reading the code at HEAD.

Measured by the reporter on a real relay, the same election with and without one silent emulator phone in the control cohort: key release 1.5 s against 298 s, results publish 0.18 s against 77.6 s, median control write 0.47 s against 75 s. With logging on, none of 429 promise rounds had a failing member in the healthy run.

## Requirement

A round resolves as soon as the answers already in decide it: the promise round once approvals reach the super-majority, or once enough rejections arrive that it can no longer be reached; the commit round once a majority has signed (or once that is out of reach). Members that have not answered by then keep receiving the record in the background, as the commit broadcast's retry (`commitBroadcastRetry*`) already does for the commit round, and a late answer that arrives after the round resolved is neither merged into the record nor penalised as a timeout. A round still waits on stragglers whenever the answers it has could go either way.

## Constraints the plan must respect

- **Where it can help at all.** At the default threshold of 0.75 a cohort of two needs both promises and a cohort of three needs all three, so early completion of the promise round only helps from four members up; the commit round (a simple majority) can finish early from three. State this in the docs, since the reported cohort sizes decide whether this fixes their case.
- **Signed hashes.** A commit signature covers the whole promise map (`computeClusterCommitHash`). The promise map the record carries into the commit round must be fixed when the promise round resolves; merging a late promise afterwards invalidates signatures already collected — the defect in backlog `bug-a-late-promise-invalidates-the-commit-signatures-already-collected`, which early completion makes far more likely (it needs exactly a member that missed the promise round and answers later). The plan must either close that defect or show the early-resolved path cannot reach it.
- **The kept commit signature rule.** `collectPromises` keeps a member's commit signature only when it was signed over the final merged promise map (`keepCommitsSignedOverMergedPromises`); with an early finish "final" means the map at resolution.
- **Deferred pend delivery and owed records.** In a cohort of two the pend's decision is held back for the commit to carry (`deferPendDelivery`), and a member that missed a delivery is owed it on the next request (`takeOwedRecords`). A member left behind by an early resolution must end up owed the decision the same way.
- **Reputation.** A straggler should not be penalised as `ConsensusTimeout` for a round that never needed its answer, or every slow phone accumulates penalties.
- **Durability reporting.** `CoordinatorRepo.commit` acknowledges only when a strict majority reports holding the revision (`applyOutcomes`); finishing the commit round early must not shrink what that count can see below a majority.
