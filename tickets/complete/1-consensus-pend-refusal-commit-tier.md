description: A write that raced another write could be acknowledged as saved and then silently lost; the fix makes losers get refused (and retried) instead of falsely acknowledged, at both stages of cluster agreement. Reviewed, verified green, docs brought up to date.
files:
  - packages/db-core/src/transactor/network-transactor.ts (staleFromBatches shared by the tail commit and the non-tail sweep; new orphan/duplicate NOTE at the sweep)
  - packages/db-core/src/transaction/coordinator.ts (comment: commit producers now set `conflict` on returned failures)
  - packages/db-p2p/src/cluster/cluster-repo.ts (validateCommitRevisions promise-round check; executedCommitResults retention + getExecutedCommitResult; apply 'ahead' NOTE)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (localCommitResult threaded out of executeClusterTransaction)
  - packages/db-p2p/src/repo/coordinator-repo.ts (ConflictRaceLostError to returned conflict; classifyCommitStaleRejection; confirmCommitRivalAgainstLocal; new fork-disagreement NOTE)
  - packages/db-p2p/src/storage/storage-repo.ts (IRevisionActionReader + StorageRepo.getRevisionAction)
  - docs/correctness.md (new "Commit revision staleness" definition)
  - packages/db-p2p/docs/cluster.md (promise-phase section: both conversion sites, and what evaluatePromise checks for a commit)
  - packages/db-core/test/network-transactor.spec.ts (3 tests, incl. the mixed-batch test added in review)
  - packages/db-p2p/test/coordinator-repo-commit-conflict.spec.ts, cluster-commit-staleness.spec.ts, cluster-consensus-divergence.spec.ts, concurrent-diary-append-acknowledgement.spec.ts
----

# Commit-tier acknowledgement fix — completed

## What landed

The bug: a write raced by a rival could return **acknowledged** while the rival's version won
agreement — the "successful" write was never durable and silently vanished. The fix makes a loser
**refused** (a returned conflict the client's retry loop re-drives against fresh state) rather than
falsely acknowledged, at both stages of cluster agreement.

**Reservation stage** (closed earlier in the seven-ticket chain): a reservation that can no longer
win is refused with a real verdict instead of approved into a doomed round.

**Commit stage** (this ticket's chain), five arms:

1. A lost commit race (`ConflictRaceLostError`) is **returned** as a conflict rather than thrown —
   a thrown commit error is retried verbatim by db-core, and the re-driven dead commit could
   assemble agreement no member would durably store.
2. New promise-round member check `validateCommitRevisions`: a member refuses a commit whose
   revision a rival already holds durably here. It abstains (votes as before) when it cannot judge —
   behind the revision, same action already holds it (idempotent redelivery), or its revision index
   cannot name the holder.
3. A signed member refusal (`ValidatorRejectionError`) is classified against local storage into a
   returned conflict carrying `staleAt`, instead of a generic failure.
4. Retained commit-verdict threading: the coordinating node's own member records its apply verdict
   (`executedCommitResults` → `localCommitResult` → `CoordinatorRepo.commit`), so a coordinator
   whose own member already applied a rival answers from the retained verdict. This is the arm that
   closes the *signed-but-not-yet-applied* window — members drop a commit's reservation when they
   SIGN it, which can precede applying it by a full propagation round, so on a fast cohort a rival's
   commit assembling agreement is the common case, not a corner.
5. db-core non-tail conflict surfacing: when the tail committed but a non-tail block's commit comes
   back as a returned conflict, `NetworkTransactor.commit` surfaces a merged `StaleFailure` (shared
   `staleFromBatches`) instead of tolerating it.

New node-local capability `IRevisionActionReader.getRevisionAction(blockId, rev)` answers "which
action committed revision N of this block?" — needed once local `latest` has moved past a contested
revision. Wire format, storage format, and signed reasons are unchanged.

## Review findings

**Method.** Read the five implement-stage commits' source diff first (`285b3bb7..314252e4`), then
the tests, then the handoff. Angles covered: single-responsibility and duplication (the two commit
conversion sites share one confirmation core, `confirmCommitRivalAgainstLocal`; the tail and
non-tail sweeps share one extraction, `staleFromBatches` — both duplicated-then-extracted
correctly), abstain/error paths (every new read is wrapped and abstains on fault; nothing new throws
out of a vote path), type safety, resource cleanup (the new retention map is cleared, TTL-pruned,
and rolled back alongside the executed marker), source hygiene, and doc accuracy.

**Fixed inline (minor).**

- *Doc drift caused by this chain.* `packages/db-p2p/docs/cluster.md` still said a lost race is
  "surfaced by `CoordinatorRepo.pend`" — it is now surfaced by `pend` **and** `commit`, which is the
  whole point of arm 1. Corrected, and the promise-phase section now states what `evaluatePromise`
  actually checks for a commit operation (the new revision-staleness check *and* the pre-existing
  content-digest check), which it previously did not say at all.
- *Undocumented safety rule.* `docs/correctness.md` documents the promise-round content-digest check
  in detail but had nothing on the new revision-staleness check. Added a "Commit revision staleness"
  definition beside it, stating the reject/abstain rule, why abstention is common rather than rare
  (the signed-but-not-yet-applied window), and the downstream retained-verdict backstop.
- *Test gap the handoff itself flagged.* Nothing pinned the mixed-batch ordering claim — one
  non-tail block returning a conflict while another throws a transport fault. Added
  `'surfaces the conflict, not the throw, when one non-tail block conflicts and another faults'`
  to `network-transactor.spec.ts`; the confirmed conflict wins, as claimed. db-core 1448 → 1449.

**Major (root-cause work).** One finding, filed as an **arm on an existing ticket** rather than a
new one, per the rule that the Nth instance of a class already ticketed is evidence:

- Arm 5 makes `commit()` return a stale failure *after* the header and tail already committed
  durably. Refusing is the right call — acknowledging a torn action is worse — but the writer then
  cancels and re-drives with its own content already in the collection, which either re-appends it
  (a **duplicate entry**) or meets its own orphan revision on re-pend (the **wedge** already
  captured). Same root class and same code site as
  `fix/2-all-lose-conflict-race-wedges-concurrent-first-appends`, so it is appended there as a
  second arm (`repro: static` — read from the code, not observed in a run) with the consequence
  spelled out: an own-action carve-out in the pend validator unwedges the retry but does **not**
  stop the duplicate; whichever direction that ticket takes must cover both producers.

**Tripwires (recorded at the code site, not filed).**

- `coordinator-repo.ts`, locally-executed commit branch: a *confirmed* local rival is trusted over
  the agreement outcome. Right in the window this closes, but it inverts under a forked lineage —
  refusing then tells a writer whose write did land to re-drive it. Members holding the rival reject
  at the promise round, so agreement and a local rival can only disagree after a fork
  (partition-healing scope). `NOTE:` at the site with the revisit condition.
- `network-transactor.ts`, non-tail sweep: `NOTE:` recording the durable-orphan consequence above
  and pointing at `fix/2` so the blanket tolerance is not restored here as a shortcut.

**Checked, nothing to report.**

- *Retained-verdict rollback ordering* (the handoff's top adversarial ask): the verdict is set only
  after the missing-pending throw path, and the fault-propagation catch deletes it alongside the
  executed marker, so a rolled-back apply leaves no verdict behind. Pinned by the rollback test in
  `cluster-consensus-divergence.spec.ts`.
- *Retention map keyed by messageHash* with one verdict per hash: `CoordinatorRepo.commit` builds
  `operations: [{ commit }]`, a single commit operation per message, so no last-write-wins hazard
  exists today. Not worth a `NOTE:` — the reachable shape is one operation.
- *Refuted-premise residual prose* (`validateCommitRevisions` doc block, apply-'ahead' `NOTE:`):
  re-read against the post-threading code; both still describe the code accurately.
- *Source size*: `cluster-repo.ts` measured at 2458 lines (`wc -l`) and `coordinator-repo.ts` at
  1819. Both are already claimed by open tickets (`debt-cluster-member-race-logic-has-no-home`,
  `debt-freshness-state-scattered-across-coordinator-repo`); no new size ticket.
- *No accepted-tradeoff `NOTE:` was overridden* — none of the findings landed at a site carrying one.

**Noted in passing, no action.** The prior chain ticket (`285b3bb7`) added the pend
pending-conflict classifier without updating `coordinator-repo-stale-classification.spec.ts`'s
read-count assertion; the following commit corrected it (0 → 1 confirmation read) with the reason
recorded in the test. The assertion is still exact, not loosened.

**Blocked / decision needed:** none. Nothing in this pass required a human choice.

## Verification (this review pass, 2026-08-31)

- `yarn lint` ✔ (clean), `yarn build` ✔, `yarn typecheck` ✔ (all workspaces).
- `yarn test` — every workspace green (db-core 1449, db-p2p 2380 + 49 pending, quereus-plugin 683)
  **except** the known-intermittent reference-peer "should handle concurrent writes from multiple
  nodes", which failed once in the sweep (all three writers refused, contested header never
  committed, zero holders) and **passed on a scoped re-run** (6 passing, 3/3 writes landed). That
  test is already listed in `tickets/.pre-existing-known.md` as intermittent and tracked by
  `fix/2-all-lose-conflict-race-wedges-concurrent-first-appends` — not re-reported, and nothing in
  this review pass changed runtime behavior (comments, docs, and one added test only).
- `yarn test:integration` ✔ (688 passing + 8 pending, plugin smoke ok).
- Log: `tickets/.logs/1-consensus-pend-refusal-commit-tier-review.test.log`.

## Residuals carried forward (deliberate, documented in code)

- Only the **coordinating** node's own member verdict is threaded back, at both stages. A
  non-coordinating member's refusal stays invisible when the coordinator's own member applied the
  rival successfully; that dissent surfaces only through the normal vote count.
- Storage without the revision-index capability, or with history truncated below the contested
  revision, **abstains** rather than judging — the conversion arms then fall back to the prior
  returned-success shape rather than inventing a conflict.
- A loser's committed private tail block is orphaned garbage. Benign when a winner exists; the
  all-lose case where it turns into poison is `fix/2`.
