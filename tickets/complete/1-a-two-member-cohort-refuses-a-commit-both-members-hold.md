description: When the machine coordinating a write was missing the previous version of a block, the write was refused as "not safely stored" even though both machines of a two-machine group ended up holding it. The coordinator now lets its own machine fetch the block once more after the other members have saved the write.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-p2p/test/commit-durability-quorum.spec.ts
  - packages/db-p2p/test/cluster-consensus-divergence.spec.ts
  - docs/internals.md
  - docs/correctness.md
----

# What was wrong

`ClusterCoordinator.broadcastMergedRecord` delivers the merged commit record to the coordinator's own member first and waits for it, then delivers to the remote members. When the coordinating member was the one missing the pend or the base, its reconcile therefore ran before anyone held the revision, and it kept a refusal. In a two-member cohort, `CoordinatorRepo.commit` then counted 1 of 2 holders and refused the write with `commit-not-durable`, even though both members ended up holding it.

# What was built

- `ClusterMember` records which retained refusals have the "behind" shape (`behindCommitRefusals`, set from the apply branch that ran, not from the refusal text). `retainCommitVerdict` is now the one place that writes the retained verdict. The new public `reconcileRefusedCommit(record)` re-runs the reconcile for a behind refusal only, recomputes the durable verdict, and doesn't restore a verdict that was pruned or rolled back while it ran. `behindCommitRefusals` is pruned in dispose, in the rollback, and in the TTL sweep.
- After the remote fan-out, `broadcastMergedRecord` calls that method, but only when the local delivery succeeded and at least one remote member reported holding the commit. The call is wrapped so it only logs on error. It finishes before the durability gate reads the local verdict.
- `CoordinatorRepo`'s constructor binds the new method into `localClusterRef`.

# Review findings

Read the implement diff (e6ab12c6) before the handoff.

- **Correctness:** Checked the behind/ahead split. An ahead (`missing`) refusal is marked `behind: false` and never reconciled downward, and the unit test covers this. The gate on the coordinator side is correct: a pend-only record has no `commit` outcome, so the new path never runs for it. The stale-entry guard (`executedCommitResults.get(...) !== refused`) covers pruning, rollback and dispose during the reconcile. `durableCommitVerdict` reads the revision index, so a member whose `latest` has since moved on still counts. No defects found.
- **Error handling / resource cleanup:** The member method never throws (reconcile is bounded by `withReconcileTimeout` and failures are logged inside), and the coordinator wraps the call anyway. The new set is cleared in all three places that clear `executedCommitResults`. No gaps.
- **Type safety / modularity / DRY:** The optional seam type is declared on both `ClusterCoordinator`'s constructor type and `LocalClusterWithExecutionTracking`, matching the three existing sibling seams. Verdict retention is consolidated into `retainCommitVerdict`. Nothing to change.
- **Performance:** The cost falls only on a behind coordinator, and only when at least one remote member reports holding the commit: one bounded reconcile round. Ordinary commits pay one async no-op call.
- **Tripwires parked** (NOTE comments at the call site in `broadcastMergedRecord`, `packages/db-p2p/src/repo/cluster-coordinator.ts`):
  - After a successful second reconcile, `applyOutcomes[self].commit` still shows the old refusal. Nothing reads the self entry today.
  - In a cohort of 3 or more, the second reconcile runs even when the remote holders already form a majority. That costs one extra fetch.
- **Docs:** The implement pass never updated `docs/internals.md` (the behind-member reconcile paragraph, which described only the remote-behind ordering) or `docs/correctness.md` (the "Second" residual on the durability gate). I fixed both in this pass to describe the mirror case and `reconcileRefusedCommit`. `yarn lint:docs` is clean.
- **Tests:** The implementer's tests cover the healing path end to end through production wiring. They also cover the negative case (no holder, one fetch, refusal stands), the ahead refusal, the success no-op, and the never-applied no-op. I found no missing case worth adding. The retry-timer path (a remote member reached only by `retryCommits`) is still a documented residual and out of scope.
- **Validation:** `tsc --noEmit` passes. eslint on the touched files passes. `yarn workspace @optimystic/db-p2p test` gives 3105 passing, 63 pending, 0 failing.
- **Not investigated (carried from the ticket, out of scope):** why the sereus joiner never stored the log tail block it read through the host, and the `1/2 approvals` shortfall through sereus's delaying relay proxy.
