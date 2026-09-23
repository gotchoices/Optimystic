description: In a group of four or more machines, a machine that missed the first voting round of a change but answers the second can add a vote that makes the other machines' second-round signatures stop checking out, so the change may be refused everywhere even though enough machines agreed to it.
files: packages/db-p2p/src/cluster/cluster-repo.ts (`processUpdate` phase loop, `handlePromiseNeeded`, `handleCommitNeeded`, `validateSignatures`), packages/db-p2p/src/repo/cluster-coordinator.ts (`commitTransaction` merges only `commits` from responses), packages/db-core/src/cluster/membership.ts (`computeClusterCommitHash`)
repro: static
severity: wrong-result
likelihood: unusual
tradeoffs: It needs a cohort of four or more with a member that was silent for the promise round and reachable one round later, which small deployments never have; the fix touches signed-hash layout, where a mistake breaks every commit.
----
# A late promise invalidates the commit signatures already collected

## What happens (read from code at `38d75e7f`, not run)

A commit vote is a signature over `computeClusterCommitHash(messageHash, message, promises, digest)`, and `promises` is the record's whole promise map (`packages/db-core/src/cluster/membership.ts`). Every member verifies every commit signature against the commit hash of the record it holds (`ClusterMember.validateSignatures`).

Take a cohort where super-majority can be reached without every member. At the default 0.75 threshold that means four or more members, for example 3 of 4. Suppose member D was silent during `collectPromises` and answers the commit round:

1. The commit-round record carries promises from A, B and C. D's `validateRecord` passes.
2. D's phase loop runs `OurPromiseNeeded`, which adds D's promise and so changes the promise map. It then runs `OurCommitNeeded` and signs its commit over the hash of the *four*-promise map.
3. `ClusterCoordinator.commitTransaction` merges only `commits` from the responses (`record.commits = { ...record.commits, ...result.commits }`), never `promises`. The merged record therefore has A, B and C's promises and D's commit signed over a different promise set.
4. `broadcastMergedRecord` sends that record to everyone. Every member's `validateSignatures` throws `Invalid commit signature from D`, and may penalize D (`PenaltyReason.InvalidSignature`), even though D did nothing wrong.

Result: the broadcast fails at every member, nobody applies at consensus, and the commit falls to `scheduleCommitRetry`, which re-sends the same inconsistent record. The same inconsistency would reach any durable proof projected from D's own record.

## Expected

A member's late promise must never invalidate signatures already collected on the record. Two ways to get there:

- The coordinator merges `promises` from commit-round responses as well, so the broadcast record's promise map matches what D signed over. But then A, B and C's commits (signed over three promises) break instead. So this alone is not a fix.
- A member that must add its own promise to a record that already carries commit signatures does not also sign a commit in the same delivery. Alternatively, the commit hash covers only the promises that existed when super-majority was reached. Choosing between these is a design question about the signed-hash layout.

## To confirm

Write a four-member mesh test (`createMesh(4, { responsibilityK: 4, clusterSize: 4 })`). Use `mesh.failures.onClusterDelivery` to make D unreachable for its promise delivery only, then reachable. Then check whether the commit applies on A, B and C at consensus, or only through the retry timer, and whether `Invalid commit signature` is logged.

Found while planning `cluster-commit-round-carries-the-coordinators-commit-vote`, which does not change this: its apply-on-receipt path only applies in cohorts of three or fewer, where every member must promise.

## Update from `cluster-commit-round-carries-the-coordinators-commit-vote`

When the late member is the coordinating node itself, the defect no longer arises. Its own member now votes to commit in process before the commit round goes out (`ClusterCoordinator.presignLocalCommit`), and the coordinator merges that member's `promises` along with its commit before sending anything, so every remote member signs over the same promise map. A remote late member (D above) is unchanged: `collectCommits` still merges only `commits` from remote responses.

## Update from `every-member-votes-for-whichever-racing-write-reached-it-first`

The promise round now works the same way the commit round does: `ClusterCoordinator.prevoteLocalPromise` has this node's own member vote before the record fans out, and merges that member's `promises` into the record every remote member receives. That merge cannot reach this defect — at that point in the transaction no commit signature exists anywhere, because a member signs a commit only after it has seen a super-majority of approved promises, and the commit round has not run. The defect as described is unchanged: `collectCommits` still merges only `commits` from a remote member's answer, so a remote member that was silent for the promise round and answers the commit round still signs over a promise map nobody else has.
