description: When one machine claims a newer version of a block than the rest of the group agrees on, repair now asks that machine whether its history includes the group's version, and keeps the group's version when it does not — instead of adopting the lone machine's version just because its number is higher.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/solo-ahead.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/test/quorum-restore-certified.spec.ts, packages/db-p2p/test/solo-ahead.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts, docs/internals.md, docs/transactions.md, .release-notes.pending.md
difficulty: hard
----

# Repair asks a lone ahead claimant for its lineage — complete

## What landed

Landed in `ticket(implement): repair-asks-a-lone-ahead-claimant-for-its-lineage`, reviewed here. Both block-repair paths run a second, narrow round for the one shape the quorum selector cannot settle on the claim data: a single-signer certified claim strictly ahead of a pair backed by more than one machine. `soloAheadOfCohort` in `packages/db-p2p/src/cluster/quorum-restore.ts` names the shape by asking the selector twice (once as it stands, once with the lone pair set aside), so the group's pair it names is by construction the one that wins after the mark. `settleSoloAhead` in `packages/db-p2p/src/cluster/solo-ahead.ts` asks every distinct claimant of the lone pair, in parallel, whether its history contains that pair, folds the answers (`excludes` wins a mixed set; `contains` confirms the lagging-cohort repair; anything else, a throw included, leaves the lone pair winning), and on `fork` marks every claim at the lone pair `forkedFromCohort`, which `selectQuorumRev` and `certifiedEquivocation` set aside before weighing anything. The commit-path reconcile takes the question as `ReconcileBlockDeps.askLineage`; the read path takes it as `blockLineageCallback` on the coordinator repo factory, deadlines each ask under the per-peer consult budget, and records a forked claimant in the consult's `consulted` map as having served nothing, so the acquisition that follows neither re-asks nor adopts the fork. Both callbacks are optional and absent in production until `the-sync-consult-answers-a-lineage-question` supplies them over the sync protocol; without them every selection is byte-identical to before.

Docs: the *One-peer proofs* paragraph and the first bullet of *The certified exception* in `docs/internals.md`, and the corroboration bullet in `docs/transactions.md`, state the rule, the three shapes deliberately left to the partition-healing design, and the stalled-write cost the group pays instead of a silently lost write.

## Review findings

Read the implement diff first, then the selector, the reconcile's candidate filter and content gate, the read path's consult and acquisition, and the two documents. Ran `yarn workspace @optimystic/db-p2p build`, the full db-p2p unit suite (3629 passing, 75 pending, 0 failing), eslint over every changed source and spec file (clean), and `yarn lint:docs` (all resolve). `yarn check` as a whole was not run; the integration tier and the React Native bundle check are untouched by this change.

**Checked and found sound.**

- The shape detector and the selector cannot disagree: the cohort pair comes from the same selection the mark produces, pinned at the selector and in the `soloAheadOfCohort` describe. The ordering in both paths (certify, then ask, then select) is right, and marked claims are neither responders, corroborators, certified, contenders nor penalty targets.
- The read path's acquisition does not repeat the question or adopt the fork. On `excludes` the forked claimants are recorded as having served nothing, so the reconcile's candidate filter never sees the lone archive. On `contains` and `unknown` the acquisition targets the lone pair and the group's archives fall below it, so the reconcile sees one claim and no shape. The asker's own stand-in claim, when the asker is the lone machine, is covered by the same recording, because the claimant list includes it.
- The lone machine is never lowered: its own claim is excluded from its own consult, and when it reads through another coordinator the group's pair it is served is refused by its handle as `collection:context-not-lowered`, the documented behaviour.
- The reconcile's content gate takes only carriers of the selected pair, so a `fork` persists the group's bytes with no proof and reports only the group's supporters as holders, pinned in `reconcile-block.spec.ts`.
- Error paths: a throwing ask costs that claimant its answer and never the round; a callback that is absent costs nothing (the shape is not even computed). The reconcile path has no per-ask deadline, which the whole-pass bound already covers, as the implementer recorded at `settleSoloAhead`.
- Resource use: one request per claimant, only in the fork shape, under the existing consult rate limits.

**Minor, fixed inline.**

- `soloAheadOfCohort` judged "backed by more than one machine" by the selected pair's `supporters`, which for a certified selection lists only the certified claimants. The equal-revision rule it is meant to extend counts the whole corroborated group, so a lone machine certified alone at the lower revision whose replica a second peer holds was a group's side at an equal revision but not one revision below. The detector now counts every distinct claimant at the pair, and a case pins it in the `soloAheadOfCohort` describe.
- `.release-notes.pending.md` still listed the one-revision-ahead residual as open and tracked by the retired backlog ticket. The bullet now describes the lineage question and that it is unanswered in production until the wire ticket lands.

**Major: none.** The class-level concern here, repair that cannot distinguish a fork from lag, is the one this ticket addresses, and the residual shapes are already owned by `feat-replay-mode-collections-merge-divergent-histories` (its question 7 names them after this ticket's planning pass).

**Tripwires, recorded at their sites.** Two single-signer actions contending at the top still decline as certified equivocation before the detector runs, with the widening to make if it shows beside a group's side: the `NOTE:` at `soloAheadOfCohort`. The read path asks the question on every consult in which the shape persists, once per read-repair window per block in lazy mode and on every read in paranoid mode; the wire ticket already carries the remedy (ride the question on the first consult when the asker holds the group's pair) as a tripwire at its `serveLineageAnswer`.

**Tests.** The implementer's tests each pin a named branch (who is asked, the fold table, the mark, the absent-callback contract, each path's `excludes` outcome) rather than restating the implementation; none were cut. One case was added for the defect above. The coordinator-side spec covers only the `excludes` outcome; the `contains` and absent-callback outcomes on the read path are the pre-existing certified-selection cases, which pass unchanged.

**Docs.** `docs/internals.md` and `docs/transactions.md` reflect the code. `docs/debugging.md` does not yet list the four new log lines; the wire ticket's own docs step owns that, since the lines first fire in production when it lands. The wire ticket names the option (`blockLineageCallback`), the dep (`askLineage`) and the factory binding (`coordinatorRepoFactory` in `packages/db-p2p/src/libp2p-node-base.ts`) correctly.

**Not done.** No mesh end-to-end test, by design: it belongs with the wire ticket, which supplies the production callback. `tickets/.garden-report.md` showed as modified in the working tree during this review by a concurrent process and was left alone.
