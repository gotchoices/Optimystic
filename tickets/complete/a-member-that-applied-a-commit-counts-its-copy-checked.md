description: When one machine of a group writes a block and the other machine stores that write as part of the group's agreement, the second machine used to treat its copy as unchecked and ask the first machine about it on its very next read. A write this machine just stored by group agreement now counts as a fresh check of its copy, the same way a write it coordinated itself already did.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/cluster/cluster-repo.ts (`CohortCommitApplied`, `CohortCommitAppliedSink`, `ClusterMemberComponents.onCohortCommitApplied`, `retainCommitVerdicts`, `reportBlockHolders`, `reportCohortCommitApplied`, `approvingCommitSigners`), packages/db-p2p/src/repo/coordinator-repo.ts (`noteCohortCommitApplied`, `markBlocksSeen`, the absence-memo NOTE in `get`), packages/db-p2p/src/libp2p-node-base.ts (`cohortCommitAppliedTarget`, the `coordinator` local), packages/db-p2p/src/testing/mesh-harness.ts (`buildMember`), packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/debugging.md, tickets/backlog/debt-freshness-state-scattered-across-coordinator-repo.md
----

# A member that applied a commit counts its copy checked

GitHub [#43](https://github.com/gotchoices/Optimystic/issues/43), arm 3 (split out of plan ticket `feat-a-cohort-consult-batches-blocks-per-peer`).

## What was built

The lazy read-repair window is a per-block timestamp in `CoordinatorRepo` (`lastSeenCommitMs`). While it is fresh, a read of a block this node holds is served without asking the cohort. Before this change only `CoordinatorRepo` wrote it, from its consult exits and from the commits it coordinated. A commit another machine coordinated reaches this node only through its cluster member (`ClusterMember.handleConsensus` → `applyConsensusCommits` → `StorageRepo`). So on a two-member group, every block the other machine wrote went unstamped here, and the first read of each started a background `sync` consult to the machine that had just written it, about 0.9 requests per read in #43.

What changed:

- `ClusterMember` has an optional sink `onCohortCommitApplied` (`CohortCommitApplied { blockIds, approvals, cohortSize }`). `retainCommitVerdicts` calls it next to `reportBlockHolders` for each commit operation that now succeeds and did not before: on a durable apply, and when `reconcileRefusedCommit` later lands a commit the member had applied while behind. It is never called on a refusal. The approving signers are computed once per record by `approvingCommitSigners` and shared with `reportBlockHolders`.
- `CoordinatorRepo.noteCohortCommitApplied` stamps the blocks when `commitQuorumRulesOutRivals(approvals, cohortSize)` holds. That is the same bar the coordinator's own commits stamp under. The stamp records no floor.
- Wiring: `libp2p-node-base.ts` binds the sink to the coordinator after the coordinator is built (the member is built first). The mesh harness wires it in `buildMember`, and reads `meshNode.coordinatorRepo` at call time.
- Docs: `docs/transactions.md` § Lazy read-repair window and `docs/debugging.md` were updated. The freshness-state debt ticket has a new line-count measurement.
- Test: in `coordinator-repo-read-repair.spec.ts`, "a member that applied a commit another machine coordinated reads it inside the window without a consult". It failed before the change and passes after.

## Review findings

I read the implement diff (`ticket(implement): a-member-that-applied-a-commit-counts-its-copy-checked`) before the handoff, then went through the member apply, reconcile, commit-broadcast retry, owed-record carrying and both recovery paths.

- **Correctness, happy path:** checked. The sink runs exactly where `reportBlockHolders` runs, so it fires once per operation that changed from not-held to held. A refusal never reports.
- **Reconcile path:** checked. `reconcileRefusedCommit` stamps only after `reconcileBlock` restored a revision the cohort corroborated at that moment, which is as good as a consult. No issue.
- **Restart recovery:** checked. `ClusterMember.recoverTransactions` restores participant state but does not re-apply anything, so it never reaches the sink. No issue.
- **Late delivery (tripwire, parked):** the stamp's "now" is the member's apply. That is the moment of the commit only for the delivery consensus made. A member that missed that delivery gets the record later, from the coordinator's commit-broadcast retry (about 8 s at the `commitBroadcastRetry*` defaults) or carried on a later request (`takeOwedRecords`). After a coordinator restart the resumed broadcast can deliver it as late as the record's expiration. In a cohort of four or more, a newer revision can commit without that member in the meantime. An unfloored read on the member then serves the older revision as checked for up to one window past the late apply. This needs a missed delivery, a newer commit inside the retry span, and a read without a floor (a reader that walked the log carries a floor and still consults), so it is conditional. Recorded as a `NOTE:` at `noteCohortCommitApplied` with its remedy (report only records the member received during its consensus round). I also corrected the doc sentence in `docs/transactions.md` that implied the member's stamp time is always the commit's moment.
- **Denominator asymmetry (the implementer flagged it):** the member counts approvals only from signers inside `record.peers`, over `|record.peers|`. The coordinator counts all approve votes over its own cohort lookup. Both are maxed with the declared `repairCorroborationClusterSize`, so the member's bar is never looser than the coordinator's, and its numerator is the stricter one. Accepted; I made no change.
- **Double stamp on the coordinating node:** harmless. Both stamps carry no floor and the later one wins. Even when the coordinator's durability gate then refuses (`commit-not-durable`), the member's stamp marks a copy that is the newest anywhere, so it is not stale.
- **Modes, floors, the unsettled-claim memo:** `markBlocksSeen` only writes the stamp. The `'paranoid'` and `'off'` modes are decided in `shouldReadRepair`. A floor above the local copy still consults through `floorDemandsConsult`. The unsettled-claim memo is untouched, so `unconfirmedAheadRev` doubt still stamps. No issue.
- **Type safety and wiring:** the new typed `coordinator` local in `libp2p-node-base.ts` removed two casts. The sink is late-bound behind an optional chain, so a commit applied before the coordinator exists is a no-op, which is correct. `tsc --noEmit -p packages/db-p2p` (including `test/`) is clean, and eslint is clean on every changed file.
- **Hygiene:** I reflowed one oddly wrapped doc-comment line in `noteCohortCommitApplied`. Comment density matches the file. `coordinator-repo.ts` is still covered by the existing debt ticket `debt-freshness-state-scattered-across-coordinator-repo`. Its new external writer is already noted there, so I filed nothing new.
- **Tests:** the one new spec reproduces #43 at the lowest layer that shows it (a two-node mesh) and pins the new contract, so I kept it. The below-majority branch has no test, because it is the same `commitQuorumRulesOutRivals` call the coordinator path relies on. I added no test for the late-delivery tripwire, since it is conditional and not fixed.
- **Docs:** I read `docs/transactions.md` § Lazy read-repair window, `docs/debugging.md` (background paragraph and the stamp table) and the `markBlocksSeen` mention in `docs/internals.md`. They match the code after the one correction above. `yarn lint:docs` is clean.
- **Not measured:** nobody re-ran the per-`get` request rate from #43 on real machines. The mesh spec pins the mechanism (zero consults on the next read), not the field figure.

## Validation

- `yarn workspace @optimystic/db-p2p test`: 3503 passing, 73 pending, 0 failing (after the review edits).
- `yarn lint:docs`: clean.
- `yarn test:integration`: not re-run in review. My edits are comments and docs only. The implementer ran it on the same code: 50 + 1060 passing.
