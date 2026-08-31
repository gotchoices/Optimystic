description: A write that raced another write could be acknowledged as saved and then silently lost; the fix makes losers get refused (and retried) instead of falsely acknowledged, across both the reservation and the commit tiers of cluster consensus. All unit suites, the mesh regression spec, the original reproducer, and the full repo gate are green.
files:
  - packages/db-core/src/transactor/network-transactor.ts (non-tail commit conflicts surface as StaleFailure; staleFromBatches shared with commitBlock)
  - packages/db-p2p/src/cluster/cluster-repo.ts (member promise-round validateCommitRevisions; executedCommitResults retention + getExecutedCommitResult; residual docs and the apply 'ahead' NOTE)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (localCommitResult threaded out of executeClusterTransaction)
  - packages/db-p2p/src/repo/coordinator-repo.ts (locally-executed consensus consults the retained member verdict; confirmCommitRivalAgainstLocal shared core; classifyStaleRejection)
  - packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts (mesh exit-criterion spec — GREEN, 2 tests; do not weaken)
  - packages/db-p2p/test/coordinator-repo-commit-conflict.spec.ts (17 green — 7 for retained-verdict threading)
  - packages/db-p2p/test/cluster-consensus-divergence.spec.ts (17 green — 4 for member-side verdict retention/rollback)
  - packages/db-p2p/test/coordinator-repo-pend-divergence.spec.ts (8 green — pend tier)
  - packages/db-core/test/network-transactor.spec.ts ("commit non-tail conflict surfacing" describe — 2 green)
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (original reproducer — passes; residual intermittent failure has its own fix ticket)
----

# Commit-tier acknowledgement fix — review handoff

Seven-ticket chain (`consensus-pend-refusal-*`). The bug: a diary append raced by a rival
could come back **acknowledged** while the rival's version of the world won consensus — the
"successful" write was never durable and silently vanished. The fix closes this at both
consensus tiers so a loser is **refused** (a returned conflict the client's sync loop retries
against fresh state) instead of falsely acknowledged. "Acknowledged means durable" is the
invariant; treat it as binding when reviewing.

## What was fixed

**Pend tier (reservation round) — closed earlier in the chain.** A pend that can no longer
win is refused with a real verdict instead of approved into a doomed consensus round.
Pinned by the 8 green tests in `coordinator-repo-pend-divergence.spec.ts` plus the retained
pend-verdict wiring (`getExecutedPendResult`).

**Commit tier — closed this chain, five arms.** Exit criterion was the mesh spec
`concurrent-diary-append-acknowledgement.spec.ts` going green (it is — both tests):

1. `ConflictRaceLostError` is returned to the client as a conflict rather than escaping as a
   transport-shaped throw (which the client would have retried verbatim, or worse, swallowed).
2. Member promise-round `validateCommitRevisions` — members refuse a commit whose revision a
   durable rival already holds.
3. Coordinator classification of a commit `ValidatorRejectionError` — a signed member refusal
   is classified into a returned conflict (with `staleAt` when the coordinator's own re-read
   can confirm the number) instead of a generic failure.
4. Retained commit-verdict threading — the coordinating node's own member records its apply
   verdict (`executedCommitResults` in cluster-repo, threaded through
   `executeClusterTransaction` → `localCommitResult` → coordinator-repo's locally-executed
   branch), so a coordinator whose own member already applied a rival answers from the
   retained verdict with zero re-classification reads. Direct unit coverage: the 7 new tests
   in `coordinator-repo-commit-conflict.spec.ts` (rival-at-rev → conflict with `staleAt`;
   rival-via-capability → conflict; own-action-durable → success; behind/unconfirmed →
   success; capability-absent → success; retained success → success with zero reads; no
   retained verdict → prior shape preserved) and the 4 in `cluster-consensus-divergence.spec.ts`
   (success verdict retained; ahead-shaped refusal retained with `missing`; missing-pend
   behind path deliberately retains nothing; propagated fault rolls the verdict back with the
   executed marker).
5. db-core non-tail conflict surfacing — when the tail block committed but a non-tail block's
   commit comes back as a returned conflict, `NetworkTransactor.commit` surfaces a merged
   `StaleFailure` (shared `staleFromBatches`) instead of tolerating it, because proceeding
   would acknowledge a torn action. Direct unit coverage: the "commit non-tail conflict
   surfacing" describe in `network-transactor.spec.ts` (returned conflict → merged
   StaleFailure; thrown transport-shaped failure → still tolerated, overall success).

## The refuted premise (important context for reviewing the residual docs)

The chain began assuming a rival's commit reaching consensus while ours is in flight was a
narrow window. That was refuted: members drop a commit's reservation when they SIGN it, which
can precede applying it by a full propagation round; on a fast cohort every member sits in
that window simultaneously, so a rival's commit assembling consensus is the COMMON case. The
residual doc on `validateCommitRevisions` and the NOTE at the apply 'ahead' tolerance both
describe this and name the retained-verdict backstop (arm 4) as the mechanism that answers
when the promise-round check is too early to see the rival.

## Deliberate deviations and non-changes

- **Pend-tier `missing` shape:** a pend refusal whose `missing` names the requested rev means
  that rev is already committed and the pend can never win — deliberately treated as a
  conflict (refusal), not as a fetch-and-catch-up signal.
- **db-core's verbatim commit retry unchanged:** with all returned-conflict arms in place,
  anything still THROWN out of commit is transport-shaped (network fault, not a confirmed
  loss), and retrying verbatim is correct for those. Confirmed-loss paths all return.
- Wire format, storage format, and signed reasons unchanged — `IRevisionActionReader` and the
  retained verdicts are node-local. Signed rejection reasons stay plain prose (see the
  comment at cluster-repo.ts:1271 for why).

## Verification (all green, 2026-08-31)

- Full repo gate, run in stages (≡ `yarn check`): lint ✔, build ✔, typecheck ✔, full test
  sweep ✔ (all workspaces — db-core 1448, db-p2p 2380 + 49 pending, quereus-plugin 683,
  reference-peer included), integration sweep ✔ (30 + 688). Logs:
  `tickets/.logs/1-consensus-pend-refusal-commit-tier-verify3.test.log` / `.integration.log`.
- Original reproducer (reference-peer "should handle concurrent writes from multiple nodes"):
  PASSES — in the sweep and in a scoped re-run (3/3 writes acknowledged and landed, ~2.6s).
  The acknowledged-but-lost shape is gone in every observed run.
- Mesh spec under full DEBUG shows the intended dynamics: one writer wins the shared block at
  rev 1, losers surface conflicts and re-drive cleanly at rev 2 and 3
  (`tickets/.logs/1-consensus-pend-refusal-commit-tier-verify3.meshspec.log`).

## New finding from this verification run (filed, not chased)

Under heavy DEBUG logging the reproducer intermittently fails a DIFFERENT way: all three
writers can lose the first-append conflict race (no winner), after which each writer's own
half-committed first attempt (its private chain-node block, committed durable before the
shared header commit lost) permanently blocks its retries — `stale revision … requested rev 1`
from the writer's OWN orphan, ten times, then `SyncRetryExhaustedError`. Zero entries, zero
false acknowledgements — a liveness bug, not a durability bug; the invariant this chain fixed
held in both outcomes. Diagnosed to site level and filed as
`fix/2-all-lose-conflict-race-wedges-concurrent-first-appends` (evidence log:
`tickets/.logs/1-consensus-pend-refusal-commit-tier-verify3.refpeer.log`).
`tickets/.pre-existing-known.md` retargets the reference-peer entry at that ticket.

## Fork-window observation (inherited question — answered)

Checked whether two actions can still both reach `storage-repo commit … rev=1` for the SAME
block on disjoint member subsets (per-member apply order of two consensus-passing commits is
not globally coordinated). **Not observed** in either DEBUG capture: in the mesh run the
shared block advances a clean rev 1 → 2 → 3 lineage; in the wedge run the contested header is
never committed at all, and each private block is committed exactly once. The multiple
`rev=1` commit lines in both logs are different writers' DISTINCT private blocks, not a fork.
The theoretical window (apply-order divergence) remains partition-healing scope — nothing new
to file.

## Residuals a reviewer should weigh (known, documented, deliberate)

- Only the COORDINATING node's own member verdict is threaded back (pend and commit alike).
  A non-coordinating member's refusal is invisible when the coordinator's own member happened
  to apply the rival first-and-successfully — the coordinator then answers success from its
  retained verdict and the rival's dissent surfaces only via the normal consensus vote count.
- Capability-less or history-truncated storage abstains/unconfirms rather than judging — the
  conversion arms then fall back to the prior (returned-success) shape rather than fabricating
  a conflict.
- The loser's committed private tail block is orphaned garbage: nothing references it (the
  re-driven action appends into the winner's chain). Garbage is benign in the winner-exists
  case; the all-lose case where it turns into poison is exactly the new fix ticket above.

## Suggested review focus

- Arm 4's zero-read claim: the retained-verdict path must not silently mask a verdict the
  member later rolled back — the rollback test exists (`cluster-consensus-divergence`), but
  adversarial eyes on the fault-propagation ordering are welcome.
- The `staleFromBatches` merge in db-core: confirm a mixed batch (one returned conflict + one
  transport throw) surfaces the conflict rather than the throw.
- The refuted-premise residual docs (`validateCommitRevisions`, apply 'ahead' NOTE): check the
  prose still matches the code after the retained-verdict threading.
- `fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` and the new fix ticket
  both touch `validatePendOperations` — sequencing/conflict awareness, not a review blocker.
