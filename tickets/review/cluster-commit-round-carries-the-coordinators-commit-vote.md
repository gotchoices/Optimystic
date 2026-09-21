description: In a two- or three-machine group, every consensus operation used to cost three network round trips to each other machine. The coordinating machine now signs its own commit vote before asking the others, so they apply the change as soon as they receive it and the third round trip happens only when something went wrong. Review the implementation.
architecture: docs/internals.md#commit-path-distributed-consensus
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`commitTransaction`, `presignLocalCommit`, `collectCommits`, `broadcastMergedRecord`, `deliverToLocalMember`, `retryCommits`, module functions `mergeCommits` and `membersAwaitingConsensus`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`withOwnApplyOutcome`, `handleConsensus` → `handleAlreadyExecuted`, `reconcileRefusedCommit` doc, `captureCommitCert`)
  - packages/db-core/src/cluster/structs.ts (`MemberApplyOutcome.executed`)
  - packages/db-p2p/test/commit-round-carries-coordinator-commit-vote.spec.ts (new)
  - packages/db-p2p/test/cluster-coordinator.spec.ts, packages/db-p2p/test/commit-durability-quorum.spec.ts (updated)
  - docs/internals.md (§Consensus Execution, "A *behind* member actively reconciles"), docs/correctness.md (§2 "Commit durability reporting", and the pend-refusal paragraph above it), packages/db-p2p/docs/cluster.md (Phase 2, commit retry loop, latency)
  - tickets/backlog/bug-a-late-promise-invalidates-the-commit-signatures-already-collected.md (appended update)
----
# The commit round carries the coordinator's own commit vote — review handoff

## What changed

**Coordinator (`ClusterCoordinator.commitTransaction`).** Before the commit round, the coordinating node's own member is handed the promise-complete record in process (`presignLocalCommit`). It signs its commit, and the coordinator merges that member's `promises` and `commits` into the record. The commit round then goes to the remote members only. A remote member adds its commit; in a cohort of two (2 of 2) or three (2 of 3) that is a strict majority, so its existing phase loop reaches `Consensus`, applies, and answers with its apply report. Cohorts of four or more: nobody applies on receipt, and the rest proceeds as before.

If the pre-sign throws, or there is no local member in the cohort (test wiring without `localCluster`), the round runs as before: every member in parallel, local included.

After the round, if the merged commits reach the majority, `broadcastMergedRecord(record, remoteTargets)`:
- delivers to this node's own member first, awaited, unless it already executed (`deliverToLocalMember`);
- then delivers only to `remoteTargets`, computed by `membersAwaitingConsensus`: a member whose round call failed, a member whose response does not report `executed`, or a member reporting a refused commit;
- runs `reconcileLocalMemberAgain` when this node's member has applied and any remote member (this delivery or the commit round) reports holding the revision.

The whole decision about who is delivered to, and in what order, lives in `broadcastMergedRecord`. The commit round's `applyOutcomes` are merged before the broadcast, and the broadcast's copy wins where both exist.

**Retry (`retryCommits`).** It sends the record to the pending remote members, merges their commits and apply outcomes, and, when the record then carries a majority, runs the same `broadcastMergedRecord`. So the local member now applies when a retry completes the majority. The case: a two-member cohort whose other member missed the commit round. The record holds only the local commit, nobody applies, and before this change the local member never applied at all. A remote member that reports a refused commit is also re-sent the record in that pass.

**Member (`ClusterMember`).**
- `MemberApplyOutcome.executed` is set in `withOwnApplyOutcome` from `executedTransactions`. It is unsigned and advisory; an older build never sets it, so the coordinator broadcasts to such a member as before.
- Both early returns in `handleConsensus` (already executed) now go through `handleAlreadyExecuted`. It logs and calls `reconcileRefusedCommit(record)`, which does nothing unless the retained verdict is a behind-shaped refusal. This is how a behind remote member heals: it applied on receipt before anyone held the revision, and the coordinator re-sends it the record once its own member holds it.
- `captureCommitCert` retains no cert when the approving commit signatures number fewer than `minSigs` (log `cluster-member:commit-cert-below-threshold`). A `NOTE:` at the site says what this costs in three-member cohorts (below).

**Late-promise side effect.** The pre-sign merges the local member's `promises` as well as its commit. If this node's own promise-round delivery failed (possible only in cohorts of four or more), its commit is signed over a promise map that includes its late promise. The round therefore carries that promise, and remote members' signature checks pass. This closes the self case of backlog `bug-a-late-promise-invalidates-the-commit-signatures-already-collected`, and the ticket now says so. It is not tested.

## Tests

Added, both in `packages/db-p2p/test/commit-round-carries-coordinator-commit-vote.spec.ts`, on a two-node mesh (`createMesh(2, { responsibilityK: 2, clusterSize: 2 })`):
- "a consensus operation costs the other member two calls, and it applies on the second". One `pend` plus one `commit` of one block make exactly 4 remote deliveries (it was 6), and both members' storage holds rev 1. This is the ticket's contract.
- "a member that missed the commit round applies when the retry reaches it, and the coordinating member then applies too". The other member's commit-round delivery is failed through `onClusterDelivery`. The commit is refused as not durable, and the coordinating member has not applied. Within 5 s (the first retry fires at 250 ms), both hold rev 1. I checked that it fails without the retry's broadcast: with that block disabled, it timed out.

Updated:
- `cluster-coordinator.spec.ts`: the mock member now reports `applyOutcomes[self].executed` once the commits it answers with make a majority, as a real member does. The call counts the retry tests pin are unchanged; without this, "retry succeeds when peer recovers" would count one more delivery.
- `commit-durability-quorum.spec.ts`: the mirror test (coordinating member behind) now expects **1** archive fetch, not 2. The remote member applied during the commit round, so the coordinating member's first reconcile finds it. The Arm B test's witness still holds, but it now catches the redelivery rather than the first consensus delivery. Header and comments are rewritten to match.

The existing specs that pick a protocol step from the record's shape still test what their titles say: `member-missed-commit-heals-at-commit`, `member-leaves-and-returns`, `rival-superseded-only-by-a-writer-that-built-on-it`. I re-read their hooks and they pass unchanged. `cohort-pend-refusal-channel.spec.ts` also passes.

## Validation run

- `yarn test` in `packages/db-p2p`: 3107 passing, 63 pending, 0 failing.
- `yarn test` in `packages/db-core` (the shared type changed): 1832 passing.
- `yarn test:integration` from the root: db-p2p 44 passing, 2 pending; quereus-plugin-optimystic 1002 passing, 8 pending (its integration script runs its whole suite).
- `yarn test` in `packages/reference-peer`: 6 passing.
- `yarn lint:docs` clean; `eslint` on the changed files clean; `tsc --noEmit` in db-p2p clean.

## Known gaps and things to weigh

- **`reconcileLocalMemberAgain` now has no test.** The mirror test in `commit-durability-quorum.spec.ts` used to exercise it, and it no longer reaches it. In cohorts of three or fewer the remote members apply first, so the local member's first reconcile finds them. The path is still live for cohorts of four or more, where nobody applies on receipt. A four-member version of the mirror test would cover it.
- **Three-member cohorts lose reactivity origination on the remote members.** A remote member that applies on receipt holds 2 commit signatures against `minSigs` = ceil(3 × 0.75) = 3, so it now retains no commit cert, and it is not sent the full set afterwards. Only the coordinating member originates. If that node is not in the reactivity topic's cohort, nothing originates for that commit. Before this change every member got the full set in the broadcast. Reactivity is opt-in (`cohortTopic.enabled`). The `NOTE:` on `captureCommitCert` names the fix if this matters: deliver the merged record to them too. The threshold check also applies generally: a three-member commit that reached consensus with one member unreachable used to retain a 2-signer cert and now retains none.
- **The measured saving is per consensus operation.** 4 deliveries for pend plus commit instead of 6. The "6 streams per single-collection write instead of 9" figure (three operations) is inferred, not measured end to end.
- **Extra deliveries in two rare shapes.** A remote member reporting an *ahead*-shaped commit refusal (`missing`) is re-sent the record once; its `reconcileRefusedCommit` does nothing. And in the retry path, a member on an older build (no `executed`) is re-sent once per retry pass that reaches it. Both are bounded.
- **`executed` is read from `executedTransactions`, which is set before the apply finishes.** A response built while the same member's apply for the same record is still in flight would say `executed` with no verdict yet. `ClusterMember.update` serializes deliveries per `messageHash`, and the coordinator never sends two at once to one member, so I found no path that reaches this.
- **Log tags changed** in `cluster-tx:*`. Removed: `commit-response`, `commit-merge-begin`, `commit-merge-input`, `commit-merge-result`, `commit-merge-after`, `commit-merge-end`, `consensus-broadcast-error`. Added: `commit-presign`, `commit-presign-error`, and `member-delivery-error` (with a `phase` field). `commit-merge` now carries `presigned`, and `retry-complete` carries `stillPending`. No doc or test referenced the removed tags.
