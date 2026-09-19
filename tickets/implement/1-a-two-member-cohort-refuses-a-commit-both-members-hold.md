description: When the machine coordinating a write is missing the previous version of a block, it checks whether it can fetch that block before the other machine has saved the write, so the write is refused as "not safely stored" even though both machines end up holding it. The coordinator should check again after the other members have saved.
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`broadcastMergedRecord` ~1030–1088 and its NOTE; the `localCluster` constructor shape ~198)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`applyConsensusOperation` commit arm ~2446–2491, `applyCommitToStorage`, `durableCommitVerdict`, `reconcileDivergentCommit`, `reportCommittedHolders`, `executedCommitResults`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`commit` local-executed arm ~2549–2590: unchanged, it reads the refreshed verdict)
  - packages/db-p2p/test/commit-durability-quorum.spec.ts (existing harness; add the mirrored case)
  - packages/quereus-plugin-optimystic/test/two-node-lagging-replica-multi-collection-commit.spec.ts (regression check only)
repro: verified
----

# Cause

The cause is deterministic, not a timing race. `ClusterCoordinator.broadcastMergedRecord` delivers the merged commit record to **this node's own member first, awaited**, and only then to the remote members. That order exists so that a *remote* member that is behind can reconcile from the coordinator's fresh copy (see the doc comment there, "Arm B" in `commit-durability-quorum.spec.ts`).

The mirror case is not covered. When the **coordinating** member is the one lacking the base (`StorageRepo.commit` → `missing-base-revision`) or the pend (the thrown "Pending action … not found"), `applyCommitToStorage` runs `reconcileDivergentCommit` during that first, local delivery. At that point no remote member has applied the commit yet, so every peer answers "behind" → `reconcile:no-rev-quorum { holders: 0, behind: N }`. `durableCommitVerdict` then keeps the refusal. The remote members apply a moment later and report success in `applyOutcomes`. `CoordinatorRepo.commit` counts `remoteHolders + (localDurable ? 1 : 0)`: 1 of 2 in a two-member cohort, which fails the majority check → `commit-not-durable (local-executed)`.

The existing NOTE on `broadcastMergedRecord` already predicts this ("when the coordinating member is ITSELF behind … reconcile it once more afterwards"). The sereus joiner case is exactly that shape: the joiner coordinates while holding no local copy of the log tail block. In a two-member cohort the refusal happens **every time** the coordinator lacks a base. Larger cohorts hide it only when the other members alone make a majority.

## Reproduction (verified 2026-09-18, HEAD `c4dca348`)

I used the `commit-durability-quorum.spec.ts` harness with the geometry mirrored: the block is seeded at rev 1 on the **remote** member only, and the **coordinating** member gets `reconcileBlock: createReconcileBlock(...)` with `fetchArchive` serving `serveBlockArchive(remoteStorage, …)` and `repairCorroborationClusterSize: 3` (the same `REPAIR_YARDSTICK`). The steps are `repo.pend(pendRequest)` followed by `repo.commit(await commitRequest())`. Result:

```
reconcile:no-rev-quorum { cohortPeers: 1, holders: 0, behind: 1, required: 2, ... }
RESULT {"success":false,"conflict":true,"reason":"commit-not-durable: 1 of 2 cohort member(s) report holding rev 2 of action a-update (local-executed)"}
REMOTE {"actionId":"a-update","rev":2}
COORD undefined
```

In the same run, calling the coordinating side's `createReconcileBlock(deps)(BLOCK, {actionId, rev: 2}, [remote])` **after** the commit returned logged `reconcile:certified-selected { claimants: 1 }` → `reconcile:restored`, and the coordinator then held rev 2 **with** the proof. So one more reconcile, run after the remote members apply, heals the block through the existing certified single-holder path, because the remote member's consensus apply persisted the cohort's commit proof. No new trust is needed.

# Fix

After the remote fan-out in `broadcastMergedRecord`, give this node's own member **one more reconcile** when all of these hold:

- the local delivery succeeded,
- the member's retained commit verdict (`getExecutedCommitResult(record.messageHash)`) is a refusal of the **behind** shape: a missing-base refusal, or the thrown missing-pend. It must not be the **ahead** shape, which carries `missing` and must never be reconciled downward (see the NOTE in `applyCommitToStorage`),
- at least one remote member reported `applyOutcomes[peer].commit.success === true`. If none did, nobody can serve the block and the extra round trip is wasted.

The member re-runs `reconcileDivergentCommit` for that record's commit. Its peers now include holders, and it keeps the same `withReconcileTimeout` bound. It then recomputes `durableCommitVerdict`, overwrites `executedCommitResults[messageHash]`, and calls `reportCommittedHolders` if the verdict is now a success. This finishes inside `executeTransaction`, before `executeClusterTransaction` reads `getExecutedCommitResult`, so `CoordinatorRepo.commit` needs no change: it simply sees `localDurable = true`.

Suggested shape (the implementer may adjust):

- `ClusterMember.reconcileRefusedCommit(record: ClusterRecord): Promise<void>`. It finds the commit operation in `record.message.operations` and does nothing unless the retained verdict for `record.messageHash` is a behind refusal. Record the behind shape explicitly: a small `Set<messageHash>` filled in the two behind branches of `applyCommitToStorage`, pruned with `executedCommitResults`. Don't infer it from the refusal's prose. It never throws, which matches `reconcileOneBlock`.
- Add the matching optional member to the `localCluster` parameter type in the `ClusterCoordinator` constructor (next to `getExecutedCommitResult`). The production assembly already passes the `ClusterMember` itself, so no wiring change should be needed. Verify with `find_references` on `new ClusterCoordinator`.
- Rewrite the NOTE on `broadcastMergedRecord` to describe the second reconcile instead of a residual.

Costs, stated honestly: only the refused-behind path pays anything, one extra reconcile fetch (bounded by `RECONCILE_TIMEOUT_MS`, 5 s) before the coordinator answers. Ordinary commits pay nothing. The scheduled-retry path (`retryCommits`) is out of scope. A remote member reached only by retry still applies after the gate has run, which is the documented residual on `executeClusterTransaction`.

Why this and not the alternatives in the fix ticket's open questions:

- *Let the member's reconcile wait and retry when peers answer "behind".* This delays every behind apply, including a remote one where nobody will ever apply (a hung wait up to the timeout). It would also hold the coordinator's own member inside the local-first delivery, so the remote members could not apply until the wait expired: a deadlock bounded only by the timeout.
- *Have the coordinator's durability gate re-read local holdings.* Re-reading finds nothing unless something fetches the block first, and the gate has no reconcile path of its own.

# Out of scope (note in the review handoff, don't fix here)

- **Why the joiner never stored the log tail block it read through the host** (sereus: `cluster-fetch:synced` for the leaf but not the tail). If reads through a remote coordinator never store a block locally, every first write by a new member takes this path. After this fix that costs one extra fetch instead of a retry round. It was not investigated here.
- The `1/2 approvals` shortfall through sereus's delaying relay proxy was never examined; nothing here suggests it is the same cause.

# TODO

- Add the reproduction as a test in `packages/db-p2p/test/commit-durability-quorum.spec.ts`: a mirrored `buildCohort` option where the remote member is seeded, the coordinating member is not, and the coordinating member reconciles from the remote via `serveBlockArchive`. Assert that the commit is acknowledged, the coordinating storage holds `{ actionId: ACTION, rev: COMMIT_REV }`, and `getBlockProof(BLOCK, COMMIT_REV)` is defined. Run it first and see it fail with `commit-not-durable … (local-executed)`.
- Add a negative case: neither member holds the block, so no remote member reports success. The commit is still refused `commit-not-durable`, and the second reconcile is **not** attempted (for example, count calls to `fetchArchive`, or check for the absence of a new log line).
- Add a guard case if feasible: an ahead-shaped local refusal (`missing` present) is never re-reconciled.
- Implement `ClusterMember.reconcileRefusedCommit` (or equivalent), including behind-shape tracking and pruning alongside `executedCommitResults`.
- Call it from `ClusterCoordinator.broadcastMergedRecord` after the remote results arrive, under the three conditions above. Extend the `localCluster` constructor type. Update the NOTE there and the `executeClusterTransaction` doc for `localCommitResult` if it mentions the pre-remote timing.
- Run `yarn workspace @optimystic/db-p2p test` and the plugin's `two-node-lagging-replica-multi-collection-commit.spec.ts` (its veil drops reconcile writes, so it should be unaffected; confirm it stays green). Also run `yarn build`/typecheck for db-p2p.
