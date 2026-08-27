description: A machine that copies a block to a newly joined machine used to mark the job done the moment it tried, so a failed copy was never retried and the block kept its single copy. The copy is now recorded only once the receiving machine confirms it, with a retry timer and a give-up bound.
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts, docs/internals.md, docs/arachnode-ring-handoff.md
difficulty: medium

----

# Review: growth push is recorded only after confirmation

## What changed and why

When peers join a block's cohort, `RebalanceMonitor.performRebalanceCheck` reports them in the
event's `grown` map and `BlockTransferCoordinator.replicateGrown` pushes the block to them. The bug:
the monitor added those peers to the block's seen set (`cohortPeers`) **at report time**, before
knowing whether any push landed. A push that failed — unreachable peer, receiver refused to persist,
partition mid-reaction — was therefore never retried, and the block kept its single copy until some
unrelated cohort change happened to evict and re-add that peer. In a founder deployment (one machine
commits, machines join later) that means the block stays permanently unreadable by anyone but its
holder, because the read-repair corroboration floor needs two distinct claimants.

The invariant now enforced: **a peer enters a block's seen set only once a replica is confirmed on
it, or once the block has otherwise reached its floor.**

Mechanism, in three parts:

- `handleRebalanceEvent` returns a new `growth: Map<string, GrowthOutcome>` where
  `GrowthOutcome = { satisfiedPeers: string[]; complete: boolean }`.
- `libp2p-node-base` feeds each entry to `RebalanceMonitor.recordGrowthOutcome(blockId, outcome)`.
- The monitor's per-block snapshot entry grew from `{ responsible, cohortPeers }` to
  `{ responsible, cohortPeers, pendingPeers, growthAttempts, abandonedPeers }`.

Load-bearing rule: a block the reaction had **no information** about (its `confirm:<id>` was deduped
against a confirm already in flight) gets **no map entry** at all, and the monitor leaves that
block's state untouched so the next check re-detects it. "No entry" is not the same as an empty
outcome — an empty outcome would count a give-up attempt against a block nothing was actually
attempted for.

Two new config knobs on `RebalanceMonitorConfig`:

- `growthMaxAttempts` (default 5) — consecutive `complete: false` outcomes before still-unsatisfied
  peers move to a per-block `abandonedPeers` set. Both `cohortPeers` and `abandonedPeers` are
  intersected against the current cohort on every check, so an abandoned peer that leaves and
  rejoins is retried from scratch.
- `growthRecheckIntervalMs` (default `minRebalanceIntervalMs`, `0` disables) — a self-re-arming,
  unref'd timer armed only while growth work is outstanding. Without it, checks fire only on libp2p
  connection events, so a failed push on a then-quiet network would never be retried. It calls
  `maybeRebalance()`, so `minRebalanceIntervalMs` still bounds the push rate; `stop()` clears it.

Also: `getGrowthDiagnostics()` returns `{ blocksAwaitingConfirmation, abandonedPairs, recheckArmed }`
and the node-base `cohort-growth:` log line carries the first two; the growth budget is now filled in
two passes (fresh candidates with `growthAttempts === 0` before retries) so a stuck retry set at the
front of tracked-block insertion order cannot starve peers that just joined.

## Per-block outcome rules (the four cases to check against `replicateGrown`)

| Case | `satisfiedPeers` | `complete` | Rationale |
|---|---|---|---|
| Floor met | ALL reported peers | `true` | Includes peers the confirm loop skipped once the floor was reached — the block is adequately replicated; re-pushing the remainder forever is a live loop. |
| No local data (`confirm:no-local-data`) | ALL reported peers | `true` | The first-observation case where a block is both gained and grown on the same check: nothing local to push, and those cohort peers are the pull's own source. Tripwire `NOTE:` sits at that branch. |
| Otherwise | only peers that confirmed | `false` | Counts an attempt; unsatisfied peers stay out of the seen set and are re-reported. |
| Confirm deduped in flight | *(no map entry)* | — | No information; monitor untouched. |

Partition detected mid-reaction mirrors `confirmReplicated`'s guard: every grown block gets
`{ satisfiedPeers: [], complete: false }`, so a partition is retried like any other failed push.

## Use cases for testing and validation

The headline scenario a reviewer should reproduce by hand or by reading
`cohort-growth-heals-single-holder.spec.ts`, test *re-reports a grown peer whose push failed, with
no further topology change*:

1. Block committed while the deployment is one machine (A). A is sole cohort member.
2. Machine B joins the cohort but is transiently unreachable — every dial to it throws.
3. Check reports B grown; `handleRebalanceEvent` returns `underReplicated: [BLOCK_ID]` and
   `growth: { BLOCK_ID -> { satisfiedPeers: [], complete: false } }`. B's repo holds nothing.
4. B becomes reachable. **Nothing else changes** — same cohort, no join, no departure.
5. The very next `checkNow()` must re-report B grown. This is the regression: before the fix it
   reported nothing, forever.
6. Second `handleRebalanceEvent` returns `replicated: [BLOCK_ID]`; B's repo holds
   `{ rev: 1, actionId: 'action-1' }` — the source's revision, which is what lets B corroborate A's
   claim in a read-repair vote.
7. Outcomes fed back, final `checkNow()` returns `null`. No re-push loop.

Other behaviors worth exercising:

- **Partial confirmation** — two grown peers, one accepts and one refuses to persist, floor clamps
  to 2, so the outcome is `complete: false` with only the accepting peer satisfied; the next check
  re-reports only the refusing peer.
- **Give-up and revival** — five consecutive incomplete outcomes abandon the peer (visible in
  `getGrowthDiagnostics().abandonedPairs`, and logged); it stops being reported. Remove it from the
  cohort and add it back, and it is reported again from scratch.
- **Counter reset** — a `complete: true` outcome resets `growthAttempts`, so intermittent failures
  never accumulate to a give-up.
- **Stale outcome after responsibility loss** — an outcome arriving for a block whose responsibility
  was lost since the report is ignored; recording it would survive the state clear and suppress the
  re-push that a regain is supposed to trigger.
- **Re-check timer** — arms while confirmation is outstanding, fires a check with no connection
  event at all, disarms once confirmed; `growthRecheckIntervalMs: 0` keeps it disarmed.

## Validation run

- `yarn typecheck` — clean.
- `yarn workspace @optimystic/db-p2p test` — **1967 passing, 44 pending, 0 failing**.
- The two growth specs run verbose (`cohort-growth-heals-single-holder.spec.ts` and
  `rebalance-monitor.spec.ts`) — 34 passing, including all six *confirmation-driven growth* cases
  and all three *growth re-check timer* cases.

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps and things to push on

These are honest weak spots, not rhetorical ones — the reviewer should decide whether any deserves
a follow-up ticket.

- **A throwing reaction is never bounded.** `libp2p-node-base`'s `.catch` path records nothing, by
  design (a missing outcome means "no information"). Consequence: if the reaction consistently
  throws, the re-check timer retries forever at `growthRecheckIntervalMs` and `growthMaxAttempts`
  never counts, because the bound only counts RECORDED incomplete outcomes. This was an accepted
  call — a throwing reaction is a bug to surface, not to silently abandon — but nobody has argued
  the other side.
- **A budget-deferred intervening check weakens the give-up bound.** `pendingPeers` is rebuilt from
  the latest report on each check. If a check defers a block on `growthBlockBudget`, that block's
  `pendingPeers` is cleared; a give-up landing right then abandons nothing and resets the counter.
  Rare and benign (the block is simply retried), and documented rather than complicating the state
  machine — but it means the bound is "at least `growthMaxAttempts`", not exactly it. Worth a second
  opinion on whether the honest fix is cheap.
- **The no-local-data to complete rule is a tripwire, not a proof.** The `NOTE:` at that branch in
  `block-transfer.ts` says it: reported peers are recorded satisfied so the case does not become a
  permanent retry loop. If the node later obtains the block by another route (a fresh local commit,
  a spread push), those peers stay recorded and are never pushed. Benign today because a gained
  block's data comes from those very peers — but that is an argument about the current call graph,
  not an invariant, and it is exactly the kind of thing that rots.
- **`confirmedPeers` is a cross-round union.** `executeConfirm` accumulates confirming peers across
  retry rounds (a peer that accepted a push holds a replica even if a later round's dial missed it),
  while the floor decision itself stays strictly per-round. That asymmetry is deliberate and leaves
  the release path unchanged, but it is the subtlest thing in the diff — worth re-deriving.
- **Timer tests are wall-clock.** The *growth re-check timer* suite uses real `setTimeout` plus
  `waitFor`, not fake timers. They pass consistently and are fast (the whole monitor spec is under
  400ms), but they are timing tests and could in principle flake on a very loaded CI box.
- **No test covers the give-up interacting with the re-check timer.** Each is tested alone. A block
  whose peers are all abandoned should stop counting as outstanding work and disarm the timer; that
  transition is implied by `hasOutstandingGrowthWork()` reading `pendingPeers`, but no test pins it.
- **Nothing exercises the real multi-process path.** All validation is in-process: the end-to-end
  spec uses a loopback `IPeerNetwork` that routes dials straight into the target's real
  `BlockTransferService.handlePush`. The protocol frames are real; the transport is not.
