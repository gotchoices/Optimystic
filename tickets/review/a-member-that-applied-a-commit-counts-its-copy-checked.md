description: When one machine of a group writes a block and the other machine stores that write as part of the group's agreement, the second machine used to treat its copy as unchecked and ask the first machine about it on its very next read. A write this machine just stored by group agreement now counts as a fresh check of its copy, the same way a write it coordinated itself already did.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/cluster/cluster-repo.ts (`CohortCommitApplied`, `CohortCommitAppliedSink`, `ClusterMemberComponents.onCohortCommitApplied`, `retainCommitVerdicts`, `reportBlockHolders`, `reportCohortCommitApplied`, `approvingCommitSigners`), packages/db-p2p/src/repo/coordinator-repo.ts (`noteCohortCommitApplied`, `markBlocksSeen`, the absence-memo NOTE in `get`), packages/db-p2p/src/libp2p-node-base.ts (`cohortCommitAppliedTarget`, the `coordinator` local), packages/db-p2p/src/testing/mesh-harness.ts (`buildMember`), packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/debugging.md, tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md
----

# A member that applied a commit counts its copy checked

GitHub [#43](https://github.com/gotchoices/Optimystic/issues/43), arm 3 (split out of plan ticket `feat-a-cohort-consult-batches-blocks-per-peer`).

## What changed

The lazy read-repair window is a per-block timestamp (`lastSeenCommitMs` in `CoordinatorRepo`): inside it, a read of a block this node holds is served without asking the cohort. Before this change only `CoordinatorRepo` wrote that timestamp: its consult exits, and the commit paths it coordinates. A commit another machine coordinated reaches this node only through its cluster member (`ClusterMember.handleConsensus` → `applyConsensusCommits` → `StorageRepo`), so on a two-member group every block the other machine wrote was unstamped here, and the first read of each started a background `sync` consult to the machine that had just written it. #43 measured about 0.9 such requests per read.

Now:

- **`ClusterMember`** has an optional component `onCohortCommitApplied` (type `CohortCommitAppliedSink`, payload `CohortCommitApplied { blockIds, approvals, cohortSize }`). `retainCommitVerdicts` calls it beside `reportBlockHolders`, for each commit operation that now succeeds and did not before: on a durable apply, and on the later success of a behind-refused commit's reconcile (`reconcileRefusedCommit`). Never on a refusal. `approvals` is the number of approving commit signers in `record.peers`, computed once per record by the new module function `approvingCommitSigners` and shared with `reportBlockHolders` (whose signature changed to take the signer list). `cohortSize` is `Object.keys(record.peers).length`. A throwing sink is logged as `cluster-member:cohort-commit-applied-sink-error`.
- **`CoordinatorRepo.noteCohortCommitApplied`** marks the blocks seen when `commitQuorumRulesOutRivals(approvals, cohortSize)` holds, the same bar as the coordinator's own commits (declared `repairCorroborationClusterSize` maxed with the observed size). It records no floor, which clears a recorded `floorConsulted`, as the commit-path stamps do. Its doc says why a stamp written from outside the class is safe where an absence memo was not, and carries the accepted-tradeoff `NOTE:` for received pushes (not stamped).
- **Wiring**: `libp2p-node-base.ts` binds the member's sink late to the coordinator (member is built first), through a typed `coordinator` local; that local also replaced two `as import(...).CoordinatorRepo` casts just below it. The mesh harness wires the same sink in `buildMember`, reading `meshNode.coordinatorRepo` at call time so restarts reach the rebuilt coordinator.
- The absence-memo NOTE in `CoordinatorRepo.get` said cohort-member writes never reach this class; reworded to say their commits are now reported for the stamp only, and pushes not at all.
- **Docs**: `docs/transactions.md` § Lazy read-repair window has a new paragraph after "A node's own commit arms the window only when…", covering the member stamp, its bar, and why a push is not a stamp. `docs/debugging.md` (`cluster-tx:read-repair-triggered` background paragraph) lists the member apply among what stamps. `yarn lint:docs` passes.
- **Debt ticket**: `debt-freshness-state-scattered-across-coordinator-repo` has an eighteenth measurement: `wc -l packages/db-p2p/src/repo/coordinator-repo.ts` → 4028 lines (3997 at HEAD before this), plus the note that the stamp now has an external writer the extraction must own as an entry point.

## Test added

- `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts`, "a member that applied a commit another machine coordinated reads it inside the window without a consult": two-node mesh with `clusterPolicy.repairCorroborationClusterSize: 2`; node A pends and commits a block through its coordinator; node B reads it, waits for any background consult, and the spec asserts no `cluster-tx:read-repair-triggered` line and `mesh.consultRequests(B, A) === 0`. It failed before the change (the trigger fired) and passes after.

No test for the below-majority branch: it is the same `commitQuorumRulesOutRivals` call the coordinator's commits rely on, as the ticket planned.

## Validation run

- `yarn workspace @optimystic/db-p2p test`: 3503 passing, 73 pending, 0 failing. No existing mesh spec depended on the extra consult.
- `yarn test:integration` from root (after rebuilding db-p2p): 50 + 1060 passing, 0 failing.
- `npx tsc --noEmit -p packages/db-p2p` (includes `test/`) clean; eslint clean on every changed file; `yarn lint:docs` clean.

## For the reviewer: worth a look

- **Denominator asymmetry.** The member measures `approvals` over `record.peers` (signers outside `record.peers` excluded), with `cohortSize = |record.peers|`. The coordinator's commit path uses `countApprovingCommitVotes(record)` (all approve votes, unfiltered) over `cohort.peerIds.length` from its own cohort lookup. Both are maxed with `repairCorroborationClusterSize`, so the member is never looser than the declared yardstick. The member's numerator is the stricter of the two. I judged that fine, but it is a second spelling of "the approvals".
- **Double stamp on the coordinating node.** Its member's apply and its coordinator's commit path both stamp the same blocks moments apart. Harmless (the later stamp wins; both carry no floor).
- **Behind-then-reconciled stamping, refusals, batch records, `'paranoid'`/`'off'`, silent-consult holds, the unsettled-claim memo, floors**: checked by inspection only, as the ticket listed. All of them follow from the call sitting where `reportBlockHolders` already sat, plus `markBlocksSeen`'s existing floor-clearing behaviour.
- **Mesh restart edge.** A disposed member instance that applies a late delivery after `Mesh.restart` stamps the rebuilt coordinator (the closure reads `meshNode.coordinatorRepo`). The data lands in the same raw storage, so the stamp is true; noted only because it is a cross-instance effect.
- **Not measured.** I did not re-run the #43 per-`get` request rate on real machines; the mesh spec pins the mechanism (zero consults on the next read), not the field number.
