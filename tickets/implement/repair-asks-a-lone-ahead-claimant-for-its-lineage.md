description: When one machine claims a newer version of a block than the rest of the group agrees on, repair now asks that machine whether its history includes the group's version, and keeps the group's version when it does not — instead of adopting the lone machine's version just because its number is higher.
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/cluster/solo-ahead.ts (new), packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/storage/block-storage.ts (`lineageOf`, read only), packages/db-core/src/network/struct.ts (`BlockLineage`, read only), packages/db-p2p/test/quorum-restore-certified.spec.ts, packages/db-p2p/test/reconcile-block.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts, docs/internals.md, docs/transactions.md
difficulty: hard
----

# Repair asks a lone ahead claimant for its lineage

## The gap, restated

Both block-repair paths (`CoordinatorRepo.queryClusterForLatest` on reads, `createReconcileBlock` in `packages/db-p2p/src/cluster/reconcile-block.ts` after a commit) hand their peers' claims to `selectQuorumRev` in `packages/db-p2p/src/cluster/quorum-restore.ts`. A claim is one pair, the revision and the action that produced it, plus an optional verified commit proof. At an equal revision, a one-signer proof (the receipt a machine signs for its own solo commit) already loses to two or more distinct peers agreeing on a different action. One revision higher it still wins, because nothing in the claim says whether the claimant built on the group's revision or forked away from it. Pinned as `does NOT reach a solo fork one revision AHEAD` in `packages/db-p2p/test/quorum-restore-certified.spec.ts`, with a `NOTE:` at the selector.

Today's outcome in the fork case is worse than "the wrong side wins": every group member that reads the block acquires the lone machine's revision, its collection handle then adopts that lineage (`Collection.judgeAdoption` sees a different action at the held revision), and the group's own agreed write is dropped on every machine. The partition-healing design (backlog `feat-replay-mode-collections-merge-divergent-histories`) needs both sides to survive until a merge, and its maintainer notes say the fork is to be fixed by merging both writes, never by a rule at the write path. This ticket makes repair stop destroying one side. It does not merge anything.

## The evidence already exists: ask the claimant

The ticket that planned this weighed two shapes, carrying a predecessor in the commit proof or widening every consult answer with history, and chose neither. The block storage already answers exactly the question repair needs. `BlockStorage.lineageOf` in `packages/db-p2p/src/storage/block-storage.ts`, built for the torn-write case, answers for a given `(rev, actionId)` whether this node's current content for the block was built from it: `contains`, `excludes` (the node's revision index names another action at that revision, or its own derived history spans the revision without it), `behind`, or `unknown` (the content past that revision came from elsewhere, a replica, so the node cannot say). It is on the repo protocol already (`BlockGets.lineageOf` → `GetBlockResult.lineage`, `packages/db-core/src/network/struct.ts`) and `NetworkTransactor.getLineage` asks it per cohort member.

So the fix is a second, narrow round: when the claim set has the ambiguous shape, ask the claimants of the top pair whether their history contains the group's pair, and weigh the answer. Compared with the two rejected shapes: no commit-proof change (the proof is signed, so a new field is a preimage change plus a migration story, and a single predecessor cannot see a machine that committed twice alone); no wider consult answer on every read (the history is self-reported and would need the lineage floor rule re-implemented on the asker, which `lineageOf` already encodes); one extra request to one or a few peers, only in a shape that honestly arises only after a machine committed while cut off from a group that holds the block.

## The rule

Definitions, all computed over the claim set the selector already sees (the asking node's own revision excluded, as today):

- **The group's side** is the highest-revision pair backed by more than one machine: a pair whose group meets the quorum AND has at least `CORROBORATION_FLOOR` distinct supporters, or a pair certified by a multi-signer proof (two or more distinct signers). A quorum-meeting group of one supporter, which only a capacity-one cohort (a declared two-machine group) produces, is not a group's side.
- **A lone ahead pair** is the top certified revision when every certified claim there is single-signer, that revision is strictly above the group's side, and no corroborated pair sits at or above it (a corroborated pair strictly above every certified revision already wins, as today).

The shape fires only when both exist. When it does, each claimant of the lone ahead pair is asked `lineageOf(group's side)`. The fold over their answers: any `excludes` → **fork**; otherwise any `contains` → **same lineage**; otherwise (every claimant silent, absent, `behind`, or `unknown`) → **unknown**. A claimant that says `excludes` is reporting its own revision index naming another action at that revision; a claimant that says `contains` beside one that says `excludes` holds the same bytes under the same pair and so one of them is wrong, and the conservative direction is the group's.

Outcomes:

- **fork** → every claim at the lone ahead pair is marked `forkedFromCohort: true` (a new injected verdict on `RevClaim`, beside `certified` and `certifiedSignerCount`). `selectQuorumRev` sets a marked claim aside before grouping: it neither certifies nor corroborates, so a pair with no unmarked claim is never selected. The group's side then wins by the existing rules, exactly as it wins the equal-revision contest today. The content gate is untouched: candidates are the peers corroborating the selected pair, so the lone machine's bytes are never among them.
- **same lineage** → nothing is marked; the lone ahead pair wins as today. This is the ordinary lagging-cohort repair, and the one request bought the certainty that it is one.
- **unknown** → nothing is marked; today's behaviour, logged. The default stays on the side that keeps the lagging-cohort repair working, because the common honest way to reach `unknown` is a claimant that received the revision as a replica and cannot vouch for its derivation.

What this deliberately does not decide. A fork between two single-signer machines (a two-machine group, both sides written) has no group's side, so the shape never fires and the higher revision wins as today. A fork between two halves of a cohort that each kept two or more members produces a multi-signer proof on each side, so the shape never fires either. Both are the partition-healing ticket's. And a block the group has not touched since the fork point looks, at the block level, like a plain extension (the lone machine's revision was built on the pair the group also holds), so repair adopts it; the collection-level fork is still visible on the log tail, which every commit touches, and that is where the group's handle refuses the other lineage (`collection:context-not-lowered`).

## What the lone machine sees

Nothing changes for it. Its own claim is excluded from its own consult, the group's pair is at or below its revision, and the read path acquires only a revision strictly above the reader's own. It keeps its fork, its handle keeps refusing the group's lineage, and its next write either lands on the group (a cohort of four or more can pass without one member) or is refused. Repair never lowers anyone.

What the group's writers see is the tradeoff the equal-revision rule already accepted: in a cohort of three, the lone machine's member refuses the group's next write at the forked revision as stale (`latest.rev >= request.rev`), and super-majority at three needs all three, so the write ends in `SyncRevisionStalledError` until the lone machine writes (its write lands by the behind-reconcile, and the fork resolves toward it) or leaves. Before this ticket the same scenario cost the group its write silently instead. State this in the docs rather than hide it.

## Where it lives

- `packages/db-p2p/src/cluster/quorum-restore.ts`: `RevClaim.forkedFromCohort`; the pure shape detector `soloAheadOfCohort(claims, simpleMajorityThreshold, corroboratorCapacity)` returning `{ solo: { rev, actionId, claimants }, cohort: { rev, actionId } } | undefined` (it needs the quorum and the certified groups, so it belongs beside them); `selectQuorumRev` filtering marked claims first. Retire the `NOTE:` at the equal-revision tie, pointing at the new rule.
- `packages/db-p2p/src/cluster/solo-ahead.ts` (new, small): the async half, shared by both paths so they cannot drift. `settleSoloAhead(claims, thresholds, capacity, askLineage)` detects the shape, asks each claimant with `askLineage(peerId, blockId, cohortPair)`, folds, marks the claims in place, and returns a verdict object for the caller to log (`fork` | `same-lineage` | `unknown` | `not-asked`, with the pair, the claimants and each answer). The ask type: `BlockLineageAsk = (peerId: string, blockId: BlockId, target: ActionRev) => Promise<BlockLineage>`; a throw or rejection counts as `unknown`. The callback is OPTIONAL at both call sites; absent, the helper returns `not-asked` and marks nothing, so a caller without the wire behaves byte-for-byte as today. The sibling ticket `the-sync-consult-answers-a-lineage-question` supplies the production callback.
- `packages/db-p2p/src/cluster/reconcile-block.ts`: `ReconcileBlockDeps.askLineage?: BlockLineageAsk`; call the helper after `certifyCandidates` and before `selectQuorumRev`; log `reconcile:fork-declined` on `fork` (blockId, the two pairs, claimants, answers) and `reconcile:solo-ahead` for `same-lineage` / `unknown` with the verdict.
- `packages/db-p2p/src/repo/coordinator-repo.ts`: a `blockLineageCallback?: BlockLineageAsk` beside `clusterLatestCallback`; call the helper in `queryClusterForLatest` after the `certifyClaim` pass and before `selectQuorumRev`, each ask under `withDeadline(cohortQueryTimeoutMs)` like the consult; log `cluster-fetch:fork-declined` and `cluster-fetch:solo-ahead` likewise. The second round runs after the seat's first round has settled; it does not go through the seat.
- Docs: `docs/internals.md`, the *One-peer proofs* paragraph ("The weighing reaches exactly as far as an equal revision…") and the first bullet of *The certified exception* ("a fork that got a revision ahead while alone still wins…"), and `docs/transactions.md`, the bullet that begins "A claim needs a second, independent peer" (its sentence "That protection stops at an equal revision…"). Replace the residual with the rule above and the two things it does not decide. Both files cite this ticket's slug today; the citations go.

## Edge cases & interactions

- **Reader holds nothing (a joiner).** Shape fires, claimants asked, `fork` → the group's pair is selected and acquired from its supporters; the joiner lands on the group's lineage. Covered by the reconcile-block spec case below (the reconcile path has no local revision in its claim set either).
- **Reader is a group member at the group's pair.** `fork` → selection at or below local → the pass reports `cluster-fetch:local-current`, acquires nothing, and stamps no doubt: `unconfirmedAheadRev` is produced only on the no-quorum path (`uncorroboratedRev` in `queryClusterForLatest`), and the lone machine's higher claim is a successful selection's bystander, as an uncorroborated higher claim is today. Pin with the coordinator-repo spec case below.
- **Reader is the lone machine.** Its own claim is excluded, no certified claim sits above the group's pair, shape does not fire. By inspection.
- **Several claimants of the lone pair** (the lone machine pushed its revision to a peer, which stored the single-signer proof with it). All asked; the pushed receiver answers `unknown` (replica, floor above the asked revision) or `excludes`; the originator answers `excludes`; fold → `fork`; every claim at the pair is marked, so the pair cannot win as a two-supporter corroborated group either. Pin in the fold test.
- **A claimant answers `behind`**, contradicting its own claim → counts as `unknown`. Fold test.
- **A claimant is silent or the ask throws** → `unknown`; with no other answer the verdict is `unknown` and today's behaviour holds. Fold test.
- **A lying `excludes`.** Only claimants of the lone pair are asked, so a liar can only make its own pair lose to a pair two or more machines back. No reputation penalty is attached to any answer: the honest fork claimant is not penalized (`penalizeContradictingRevClaims` only looks at same-revision contradictions, unchanged), and a lineage answer is not evidence of lying. By inspection.
- **Multi-signer certified at the top** → not asked, never marked. Pure detector test.
- **Capacity-one cohort, one supporter below a single-signer claim** → no group's side, not asked. Pure detector test.
- **Corroborated pair strictly above every certified claim** → it wins before the shape is considered; the detector returns `undefined`. Pure detector test.
- **Group's side itself certified multi-signer, lone single-signer above it** → fires. Pure detector test.
- **`askLineage` absent** → `not-asked`, byte-identical selection; the existing suites pass unchanged. By inspection and by the unchanged tests.
- **Time budget.** The second round adds one per-peer deadline to a pass that is already bounded by `reconcilePassTimeoutMs` (commit path) and the read's own budget; a pass that hits the bound answers `unknown`, never throws. By inspection; note it at the helper.
- **Pass `claims` by reference.** The helper marks claims in place because the coordinator's later logging (`claimantsAtOrAbove`, penalties) reads the same objects; do not return a filtered copy.

## Tests

- `packages/db-p2p/test/quorum-restore-certified.spec.ts`: flip `does NOT reach a solo fork one revision AHEAD` into two cases: with `forkedFromCohort: true` on the lone claim the group's pair `(5, cohort)` is selected (uncertified, two supporters); without the mark the lone claim still wins, pinning the `unknown` default. Add the pure detector cases listed above in one `describe('soloAheadOfCohort')`.
- A small spec for `settleSoloAhead` (new file or a `describe` in the same spec): the fold table (excludes → fork; contains → same-lineage; behind / throw / unknown → unknown; contains beside excludes → fork), that every claim at the lone pair is marked on `fork`, and that an absent ask returns `not-asked`.
- `packages/db-p2p/test/reconcile-block.spec.ts`: three peers besides self, two serving `(5, cohort)` with the same bytes, one serving `(6, solo-fork)` with a minted one-peer proof (`mintSoloCommitProof` in `packages/db-p2p/src/cluster/commit-proof.ts`, as the certified-claims specs mint them); `askLineage` stand-in answering `excludes` → the `(5, cohort)` content is persisted and `reconcile:fork-declined` fires; the same with `contains` → the solo's content is persisted.
- `packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts`: the reader holds `(5, cohort)`, the consult returns the shape, the callback answers `excludes` → nothing acquired, no `unconfirmedAheadRev` on the answer.

No test for the mesh end to end here; that belongs with the wire ticket.

## TODO

- Add `RevClaim.forkedFromCohort` and the set-aside at the top of `selectQuorumRev`; retire the equal-revision `NOTE:` and the residual sentence in the file's header comment.
- Add `soloAheadOfCohort` to `quorum-restore.ts`, built on `certifiedGroups`, `certifiedContenders` and the quorum computation the selector already does (factor the corroborated-group computation so the detector and the selector share it rather than recompute it differently).
- Create `cluster/solo-ahead.ts` with `BlockLineageAsk`, `SoloAheadVerdict` and `settleSoloAhead`.
- Wire the helper into `createReconcileBlock` behind an optional `askLineage` dep, with the two log lines.
- Wire the helper into `queryClusterForLatest` behind an optional constructor callback, with the two log lines; thread the option through `coordinatorRepoFactory`'s init type so the sibling ticket only has to pass a function.
- Flip the pinned test and add the cases above.
- Update the three doc sites; run `yarn lint:docs`.
- Append one line to the partition-healing backlog ticket's question 7 (already done by the planning pass; confirm it still reads true after implementation).
- `yarn workspace @optimystic/db-p2p build && yarn workspace @optimystic/db-p2p test`.
