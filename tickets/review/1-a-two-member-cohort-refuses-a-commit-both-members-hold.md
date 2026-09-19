description: When the machine coordinating a write was missing the previous version of a block, the write was refused as "not safely stored" even though both machines of a two-machine group ended up holding it. The coordinator now lets its own machine fetch the block once more after the other members have saved the write; review that fix.
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (`behindCommitRefusals`, `applyCommitToStorage` now returns `{ applied, behind }`, new `retainCommitVerdict`, new public `reconcileRefusedCommit`; pruning in `dispose`, the `handleConsensus` rollback, and `queueExpiredTransactions`)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`broadcastMergedRecord` tail + new `reconcileLocalMemberAgain`; `localCluster` constructor type; rewritten doc/NOTE on `broadcastMergedRecord`; `localCommitResult` doc)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`LocalClusterWithExecutionTracking.reconcileRefusedCommit`; `localClusterRef` binding in the constructor)
  - packages/db-p2p/test/commit-durability-quorum.spec.ts (mirrored geometry + negative case; `buildCohort` gained `seedCoordinating`, `coordinatingReconcilesFromRemote`, `productionWiring`, `coordinatingFetches`)
  - packages/db-p2p/test/cluster-consensus-divergence.spec.ts (three `reconcileRefusedCommit` unit tests)
----

# What was wrong

`ClusterCoordinator.broadcastMergedRecord` delivers the merged commit record to this node's own cluster member first (awaited), then to the remote members. That order lets a behind *remote* member reconcile from the coordinator's fresh copy. In the mirror case, where the *coordinating* member is the one lacking the base (missing-base refusal) or the pend (thrown "Pending action … not found"), its reconcile ran before any remote member had applied. It found no holder (`reconcile:no-rev-quorum { holders: 0 }`) and kept a refusal. `CoordinatorRepo.commit` then counted 1 of 2 holders and answered `commit-not-durable … (local-executed)`. In a two-member cohort this happened every time the coordinator lacked a base.

# What changed

- **Member (`ClusterMember`)**:
  - `applyCommitToStorage` now reports whether a behind branch ran (`behind: true` for missing-pend and missing-base; `false` for success and for the ahead/`missing` shape). The behind shape is recorded from the branch itself, never inferred from the refusal's text.
  - `retainCommitVerdict` is the one place that writes `executedCommitResults`. It adds the messageHash to `behindCommitRefusals` for a behind refusal, clears it on success, and calls `reportCommittedHolders` on success. The consensus apply and the new method both use it.
  - `reconcileRefusedCommit(record)` does nothing unless the retained verdict is a refusal and the messageHash is in `behindCommitRefusals`. Otherwise it re-runs `reconcileDivergentCommit` (same `withReconcileTimeout` bound, never throws), recomputes `durableCommitVerdict`, and re-retains the verdict. It skips the re-retain if the original entry was pruned or rolled back while the reconcile was in flight.
  - `behindCommitRefusals` is pruned with `executedCommitResults` in all three places: dispose, rollback, and the TTL sweep.
- **Coordinator**: after the remote fan-out, `broadcastMergedRecord` calls `localCluster.reconcileRefusedCommit(record)` only when the local delivery succeeded **and** at least one *remote* member's `applyOutcomes[peer].commit.success === true`. The call is wrapped so a throwing seam only logs (`cluster-tx:local-reconcile-again-error`). It finishes before `executeClusterTransaction` reads `getExecutedCommitResult`, so `CoordinatorRepo.commit`'s gate code is unchanged.
- **Production wiring did need a change**, contrary to the ticket's expectation. `CoordinatorRepo`'s constructor builds `localClusterRef` field by field, so it now also binds `reconcileRefusedCommit`. The mirrored e2e test goes through that constructor (`productionWiring: true`). I checked that removing the binding makes the test fail with the original `commit-not-durable … (local-executed)` refusal.

# Tests (all green)

- `commit-durability-quorum.spec.ts`:
  - **Mirrored case**: the remote member is seeded, the coordinating member is not, and the coordinating member reconciles from the remote through `serveBlockArchive` with the same `REPAIR_YARDSTICK = 3`. It asserts the commit is acknowledged, the coordinator holds `{ a-update, rev 2 }` with `getBlockProof` defined (the certified single-holder path), and exactly 2 archive fetches were made. It failed before the fix with the ticket's exact message.
  - **Negative case**: neither member holds the block. The commit is still refused `commit-not-durable`, and there is exactly 1 fetch, so no second reconcile.
- `cluster-consensus-divergence.spec.ts`:
  - A behind refusal heals on the second call. The reconcile runs twice, the verdict becomes `{ success: true, durability: local }`, the holders sink fires once, and a further call is a no-op.
  - An **ahead**-shaped refusal (`missing`) is never reconciled: 0 reconcile calls, and the retained verdict object is unchanged.
  - A success verdict and a never-applied messageHash are both no-ops.
- Full `yarn workspace @optimystic/db-p2p test`: 3105 passing, 63 pending, 0 failing. `tsc --noEmit` is clean, and `yarn workspace @optimystic/db-p2p build` succeeds.
- Plugin: `two-node-lagging-replica-multi-collection-commit.spec.ts` passes, and the whole plugin mocha suite passes (997 passing, 13 pending). `npm run test:smoke` was not run.

# Known gaps / things for the reviewer to push on

- **The self entry in `record.applyOutcomes` goes stale.** After a successful second reconcile, `applyOutcomes[selfId].commit` on the returned record still says "refused". Nothing reads the self entry today: `executeClusterTransaction` skips self, and the gate reads `localCommitResult`. I left it rather than add a re-stamp. If anything starts reading the self entry, re-stamp it after `reconcileLocalMemberAgain`.
- **The scheduled retry path is out of scope, as the ticket said.** Take a remote member reached only by `retryCommits`: it applies after the gate has run, so the coordinator's second reconcile never sees it as a holder. That is the residual already documented on `executeClusterTransaction`.
- **Cost**: only a coordinator holding a behind refusal pays anything, and at least one remote member must report success first. That cost is one more reconcile round, bounded by `RECONCILE_TIMEOUT_MS` (5 s) per block, before the coordinator answers. Ordinary commits pay one async no-op call, and only when a remote member reports success.
- **Larger cohorts**: nothing cohort-size-specific was added. In a 3+ cohort the extra reconcile also runs whenever a behind coordinator sees a remote holder, even when the remote members already form a majority without it. It is harmless, and it heals the coordinator's copy, but it is an extra fetch on that path.
- **Not investigated (from the ticket, out of scope):** why the sereus joiner never stored the log tail block it read through the host. If reads through a remote coordinator never store a block locally, every first write by a new member takes this path; it now costs one extra fetch instead of a retry round. The `1/2 approvals` shortfall through sereus's delaying relay proxy was also never examined, and nothing here suggests it has the same cause.
