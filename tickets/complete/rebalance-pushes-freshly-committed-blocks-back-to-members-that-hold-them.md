description: After a commit, a machine's background "make sure my group has copies" check used to treat every freshly written block as new: it fetched each block back from the other members and pushed it to them, although they had just stored it. Commits now tell that check who already holds each block, so a fully confirmed commit causes no follow-up transfers.
architecture: docs/internals.md
files:
  - packages/db-p2p/src/cluster/rebalance-monitor.ts (`CommittedHolders`, `recordCommittedHolders`, `commitEvidence`, `carryGrowthState`, `gained` suppression in `performRebalanceCheck`)
  - packages/db-p2p/src/cluster/cluster-repo.ts (`CommittedHoldersSink` type, `onCommittedHolders` component, `reportCommittedHolders` after the durable commit verdict)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`onCommittedHolders` component, `acknowledgeCommit(..., record?)`, `reportCommittedHolders`)
  - packages/db-p2p/src/libp2p-node-base.ts (late-bound `committedHoldersTarget`, set right after `rebalanceMonitor.start()`)
  - packages/db-p2p/src/testing/mesh-harness.ts (`MeshOptions.onCommittedHolders`)
  - packages/db-p2p/src/cluster/spread-on-churn.ts (NOTE tripwire only)
  - packages/db-p2p/test/rebalance-committed-holders.spec.ts (new, mesh-level)
  - packages/db-p2p/test/rebalance-monitor.spec.ts (new `commit evidence` group)
  - packages/db-p2p/test/rebalance-monitor-node-wiring.spec.ts (sink reaches the monitor)
  - docs/internals.md (§ RebalanceMonitor, "Commit evidence" paragraph)
----
# Rebalance no longer re-transfers freshly committed blocks

## The defect, as found in code

Every block a commit touches enters the node's owned-block set. `RebalanceMonitor` had no memory for such a block, so its next check (on `connection:open`, or the recheck timer) reported:

- the block **`gained`**. The reaction's `pullBlocks` → `RestorationCoordinator.restore` → `SyncClient.requestBlock` opens one `/db-p2p/sync` stream per ring peer it asks.
- the whole non-self cohort **`grown`**. The reaction pushes the block to each peer over `/db-p2p/block-transfer`.

Both happened on the coordinator and on every member. **Sync burst source:** the ticket suspected spread-on-churn or reconcile's archive fetches. By reading the code, the `gained` pull is the site that fires once per freshly committed block. The field counts (≈15 block-transfer and ≈32 sync streams per insert) fit one push plus about two sync queries per block, but that was **not re-measured in the field**. Spread-on-churn only pushes to peers *outside* the cohort, so a two-member pair spreads nothing. It is not this pattern.

## The fix

- `RebalanceMonitor.recordCommittedHolders({ blockIds, holders, unconfirmed? })` stores evidence per block until the next check. Only commits this node's own storage holds are reported. At the check, once the block's cohort lookup succeeds, the evidence is consumed: `holders` are added to `cohortPeers`, `unconfirmed` are removed from it, and the block is **not** reported `gained`. Evidence for untracked blocks is dropped at each check, on `untrackBlock`, and on `stop()`. It is ignored while the monitor is stopped. Later evidence about a peer overrides earlier evidence (holder ⇄ unconfirmed).
- **Member side** (`ClusterMember.reportCommittedHolders`): after a consensus commit whose post-reconcile durable verdict is success, the member reports the record's approving commit signers that are in `record.peers`.
- **Coordinator side** (`CoordinatorRepo.reportCommittedHolders`, called from `acknowledgeCommit` only when `localHolds` and a consensus `record` exist): it reports as holders the members that are durability-confirmed **and** signed approve, plus self, and it reports `durability.unconfirmed` as unconfirmed. The solo short-circuit passes no record and reports nothing, so the founder case still pushes. The tolerated-divergence arm has `localHolds` false and reports nothing, because this node is behind there.
- **Wiring:** `libp2p-node-base` hands both sites one forwarding sink whose target is set after the rebalance monitor starts. With rebalance or FRET off, reports go nowhere.

## Measured baseline and result (mesh, `rebalance-committed-holders.spec.ts`)

- Baseline (no reports), 2-member cohort, one commit of 3 blocks: **each** member's next check reports 3 pulls and 3 pushes, one of each per block toward the other member.
- With reports: 0 pulls and 0 pushes on both members, on the first check and on a later one.
- 3-member cohort, one member unreachable (a `majority` commit): both holders report 0 pulls and push only to the unreachable member.

## Validation run

- `npx tsc --noEmit` in `packages/db-p2p` (src + test): clean.
- Full db-p2p suite: 2954 passing, 63 pending, 0 failing. Log: `tickets/.logs/rebalance-committed-holders.test.log`.
- Mutation checks (reverted): disabling the member-side report fails the mesh spec on the non-coordinating member. Not setting `committedHoldersTarget` fails the node-wiring assertion.

## Known gaps and judgment calls for the reviewer

- **Field effect not re-measured.** The sereus headless relay run was not repeated. The sync-burst attribution is by code reading.
- **Member-side evidence trusts signers, not appliers** (as the ticket specified). A signer that then fails to apply is recorded as a holder on members that did not coordinate. It loses only the rebalance push; its own reconcile, read-repair, and the coordinator's report still reach it. On the coordinating node the coordinator's `unconfirmed` report corrects it. That correction path (signed, then failed to apply) is covered only by the monitor unit test for override order. The mesh `majority` test uses an unreachable member that never signed, so the end-to-end override is **not** exercised.
- **Behaviour extension:** `unconfirmed` withdraws a peer from `cohortPeers` even if an earlier push confirmed it (for an older revision). A coordinator's next check after a `majority` commit therefore pushes to the unconfirmed members. The under-replication drain may push the same block too. The receiver is idempotent, so the cost is a duplicate transfer.
- Growth memory, and so this evidence, is not revision-aware. A late growth outcome from a push already in flight can re-add a withdrawn peer. That is harmless: the push itself confirmed the peer holds the block.
- The node-wiring assertion reaches into private fields (`coordinatedRepo.onCommittedHolders`, `monitor.commitEvidence`), because a solo node's commits report nothing.
- The `ClusterMember` and `CoordinatorRepo` constructors each gained one trailing optional positional parameter. Existing callers are unaffected.

## Filed / parked

- `tickets/backlog/bug-rebalance-pulls-blocks-it-already-holds-and-discards-the-copy.md`: a `gained` pull never stores what it fetches, and every tracked block is already held locally, so the pull is always wasted (including one per stored block after a restart).
- `tickets/backlog/bug-a-received-replica-is-pushed-back-to-the-peer-that-sent-it.md`: replicas arriving by push, reconcile or read-repair still enter tracking with no holder evidence. It is the same class as this ticket, on a different entry site.
- Tripwire `NOTE:` in `spread-on-churn.ts` at the push site: spread keeps no memory of earlier spreads, which matters only on networks larger than one cohort.

## Review findings

Read the implement diff (`065b73bc`) first, then the handoff. Checked the monitor change, both report sites, the node wiring, the mesh harness, the docs paragraph, the tests, and the two filed backlog tickets.

- **Correctness (checked, no defect found).** Tracking comes before evidence: a block enters the owned-block set synchronously inside the storage commit (`storageRepo.onAnyCollectionChange`), and the member and coordinator reports come later. So the end-of-check sweep of evidence for untracked blocks does not throw away evidence for a commit that is still in flight. The coordinator's holder filter (`cohortPeerIds` minus `unconfirmed`, and signed approve or self) matches the documented meaning of `WriteDurability`. The divergence arm (`localHolds` false) and the solo arm (no record) report nothing. I confirmed this by reading all four `acknowledgeCommit` call sites. If a member's evidence is used up by a check before the coordinator's report arrives, the coordinator's report still corrects the stored state through `carryGrowthState`.
- **Race window, recorded as a tripwire.** A check can run between storage apply (block tracked) and the report (evidence recorded). The durable verdict can include a reconcile, so that gap is not tiny. A check in that gap still reports the block gained and grown, which is the old behaviour: one wasted pull and push, with no correctness impact. Recorded as a `NOTE:` in `rebalance-monitor.ts` at the point where the check reads the evidence.
- **Test coverage, one gap closed.** The solo short-circuit ("the founder case still pushes") had no end-to-end test. I added `a solo commit reports no holders…` to `rebalance-committed-holders.spec.ts`. Mutation check: letting `acknowledgeCommit` report when there is no record makes the test fail. I reverted the mutation and confirmed with `git diff`. The member that signed but then failed to apply is still covered only by the monitor unit test for override order, as the handoff says. Building that end to end needs a member that signs but fails storage, which the mesh harness cannot inject today. I accepted this gap because a wrongly recorded signer only misses one push, and its own reconcile still reaches it.
- **Error handling / resource cleanup.** Both sinks catch and log errors, so a throwing sink cannot break a commit. Evidence is cleared on `stop()`, on `untrackBlock`, when there are no tracked blocks, and by the per-check sweep. Evidence is ignored while the monitor is stopped. Memory is bounded by the number of tracked blocks between checks. No issue.
- **Type safety / modularity.** `CommittedHolders` lives in the monitor, and `CommittedHoldersSink` sits beside the other cluster sinks. The late-bound forwarding closure in node-base follows the existing late-binding style. The node-wiring test reads private fields, and the handoff already says so. Acceptable for a wiring assertion.
- **Source hygiene.** The comments explain why, not what. File sizes are large but were already large before this change (`coordinator-repo.ts` 3159 lines, `cluster-repo.ts` 2791 lines, measured with `wc -l`). This diff adds about 45 lines to each. Nothing new to file.
- **Docs.** The "Commit evidence" paragraph in `docs/internals.md` § RebalanceMonitor matches the code. No other doc describes the growth memory's entry points.
- **Filed tickets.** Both backlog tickets (`bug-rebalance-pulls-blocks-it-already-holds-and-discards-the-copy`, `bug-a-received-replica-is-pushed-back-to-the-peer-that-sent-it`) have severity, likelihood, repro and tradeoffs, and name distinct sites. No change.
- **Field effect.** Still not re-measured on the sereus relay, as the handoff says. This is outside what an agent can run.
- **Validation.** `npx tsc --noEmit` in `packages/db-p2p`: clean. Full db-p2p suite: 2955 passing, 63 pending, 0 failing (log `tickets/.logs/rebalance-committed-holders-review.test.log`).
