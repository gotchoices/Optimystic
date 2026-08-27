description: A machine that copies a block to a newly joined machine used to mark the job done the moment it tried, so a failed copy was never retried and the block kept its single copy. The copy is now recorded only once the receiving machine confirms it, with a retry timer and a give-up bound.
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts, docs/internals.md, docs/arachnode-ring-handoff.md

----

# Cohort growth: a push is recorded only after the receiver confirms it

## What shipped

When peers join a block's cohort, `RebalanceMonitor.performRebalanceCheck` reports them in the
event's `grown` map and `BlockTransferCoordinator.replicateGrown` pushes the block to them. The
monitor used to add those peers to the block's seen set at *report* time — before knowing whether
any push landed — so a push that failed was never retried and the block kept its single copy until
some unrelated cohort change happened to evict and re-add that peer. In a founder deployment (one
machine commits, machines join later) that left the block permanently unreadable by anyone but its
holder, because the read-repair corroboration floor needs two distinct claimants.

The invariant now enforced: **a peer enters a block's seen set only once a replica is confirmed on
it, or once the block has otherwise reached its floor.**

- `handleRebalanceEvent` returns `growth: Map<string, GrowthOutcome>` where
  `GrowthOutcome = { satisfiedPeers: string[]; complete: boolean }`.
- `libp2p-node-base` feeds each entry to `RebalanceMonitor.recordGrowthOutcome(blockId, outcome)`.
- The per-block snapshot entry grew from `{ responsible, cohortPeers }` to
  `{ responsible, cohortPeers, pendingPeers, growthAttempts, abandonedPeers }`.
- A block the reaction had **no information** about (its confirm was deduped against one already in
  flight) gets **no map entry**, and the monitor leaves that block's state untouched.

Two config knobs on `RebalanceMonitorConfig`, both reachable through the node's
`rebalance?: Partial<RebalanceMonitorConfig>` option:

- `growthMaxAttempts` (default 5) — consecutive `complete: false` outcomes before still-unsatisfied
  peers move to a per-block abandoned set. Both `cohortPeers` and `abandonedPeers` are intersected
  against the current cohort on every check, so an abandoned peer that leaves and rejoins is retried
  from scratch.
- `growthRecheckIntervalMs` (default `minRebalanceIntervalMs`, `0` disables) — a self-re-arming,
  unref'd timer armed only while growth work is outstanding. Without it, checks fire only on libp2p
  connection events, so a failed push on a then-quiet network would never be retried.

`getGrowthDiagnostics()` returns `{ blocksAwaitingConfirmation, abandonedPairs, recheckArmed }` and
the node-base `cohort-growth:` log line carries the first two. The growth budget fills in two passes
(fresh candidates before retries) so a stuck retry set cannot starve peers that just joined.

## Review findings

Read both implement commits (`990ba6f`, `f6eb3c5`) as a diff before the handoff summary.

### Fixed in this pass (minor)

- **The give-up counter carried across a stretch where the block owed nothing**
  (`rebalance-monitor.ts`). `growthAttempts` was carried from the prior snapshot unconditionally,
  including on checks where the block had no unconfirmed peers at all. So a block that failed three
  pushes to peer P, then had P leave the cohort, would spend those three leftovers on whichever peer
  joined next and abandon it after two tries instead of five. The counter now resets on any check
  where the block owes nothing, which is what "consecutive failures against outstanding growth"
  actually means. Pinned by a new test; verified non-vacuous by reverting the one-line fix and
  watching the test fail.
- **The re-check timer re-armed forever after every tracked block was untracked**
  (`rebalance-monitor.ts`). `lastGrowthDeferred` is the "blocks were deferred on budget" flag that
  keeps the timer armed, and the `trackedBlocks.size === 0` early return skipped both clearing it and
  updating the timer. A node that deferred blocks and then had them all untracked kept a 60s wakeup
  alive with nothing to do. Cleared on that path; pinned by a new test. (Unref'd, so this never held
  the process open — it was waste, not a leak.)
- **A dead clamp that contradicted its own doc comment** (`block-transfer.ts`). `replicateGrown`
  passed `Math.max(1, Math.min(floor, newPeers.length))` while the docblock above it said
  `min(event floor, new-peer count)`. Both operands are already ≥ 1 at that point (the caller clamps
  `floor`, and empty `newPeers` returns earlier), so the outer `max` could never fire. Removed, with
  the reason recorded inline.
- **Extracted `carryGrowthState` / `intersect`** out of the per-block loop in
  `performRebalanceCheck`, which had grown a five-field object literal inline. No behavior change;
  the loop body now reads as three named steps.

### New test coverage added

The implementer's tests were thorough on the happy path and the state machine. Three gaps:

- **The grown arm's partition guard had no test.** `replicateGrown` gained its own
  `detectPartition()` branch in this diff (it drives `executeConfirm` directly rather than going
  through `confirmReplicated`, so it does not inherit that guard). New test asserts it produces
  `{ satisfiedPeers: [], complete: false }` for every grown block and dials nobody.
- **Give-up and the re-check timer were tested only in isolation** — the handoff flagged this
  itself. New test: once the last unsatisfied peer is abandoned the block owes nothing, so
  `blocksAwaitingConfirmation` drops to 0 and the timer disarms.
- Plus the two tests pinning the fixes above.

Lint clean. `yarn typecheck` clean. Full monorepo `yarn test`: **0 failing** across all workspaces
(db-p2p 1971 passing / 44 pending, up from 1967 by the four added tests). No pre-existing failures
surfaced; `tickets/.pre-existing-error.md` was not written.

### Filed

One, appended as a second arm to the existing `backlog/debt-node-factory-wiring-steps-own-their-teardown`
rather than filed fresh (that ticket already owns `libp2p-node-base.ts` and the same root cause — a
factory function too large to test in pieces):

- **The node-base rebalance reaction handler is completely untested.** Its three hops — untrack the
  released blocks, mark them GC-eligible, feed each growth outcome back to `recordGrowthOutcome` —
  have no coverage. Every existing test either drives the coordinator directly or hand-rolls the
  feedback loop itself, so **deleting the growth-feedback loop from the factory leaves the entire
  suite green while restoring the exact defect this ticket fixed.** The node-wiring spec boots a
  *solo* node, so no peer ever joins a cohort and the growth path never runs there. Point-fixing it
  needs an expensive two-node real-libp2p test; the decomposition that ticket proposes makes it a
  plain unit test, so it is written up as part of that ticket's acceptance.

### Tripwires parked (conditional — not tickets)

- `growthMaxAttempts` is a *lower* bound on retries, not an exact count: a budget-deferred check
  clears `pendingPeers` (so a give-up landing right then abandons nobody but still resets the
  counter), and two racing checks can double-count one attempt. `NOTE:` at `recordGrowthOutcome`,
  with the fix to reach for if block counts ever make deferral common; also corrected the
  `docs/internals.md` bullet, which claimed an exact count.
- `allConfirmedPeers` in `executeConfirm` unions across retry rounds and never un-records a peer.
  Correct today because `handlePush` answers non-missing only after persisting; `NOTE:` at the site
  naming the receiver-side change that would invalidate it.

### Accepted tradeoff recorded

- **A throwing reaction is never bounded.** The `.catch` path in `libp2p-node-base` records nothing
  by design, so `growthMaxAttempts` — which only counts *recorded* incomplete outcomes — never fires
  and the re-check timer retries forever, logging each failure. The handoff flagged this as an
  unargued call. Reviewed and affirmed: per-peer errors are already caught inside the coordinator, so
  a throw out of `handleRebalanceEvent` is a coding bug, and a loud unbounded retry is the right way
  to surface one — silently abandoning the block would hide the bug *and* leave the block singly
  held. Recorded as an accepted-tradeoff `NOTE:` at the catch site with its revisit condition.

### Checked and clear

- **Timer vs. throttle.** The handoff worried that `growthRecheckIntervalMs` defaulting to
  `minRebalanceIntervalMs` could let the timer fire a hair early, get throttled away, and double the
  retry latency. It cannot: `lastRebalanceAt` is stamped *before* the timer is armed and `setTimeout`
  never fires early, so `elapsed >= minRebalanceIntervalMs` always holds at fire time.
- **The four `GrowthOutcome` cases against `replicateGrown`**, plus partition and confirm-dedup,
  re-derived against the code. All match the table in the handoff.
- **Stale-outcome handling.** `recordGrowthOutcome` re-reads the snapshot on every call and bails on
  a lost/absent entry, so an outcome that lands after a state rebuild or a responsibility loss cannot
  suppress a re-push.
- **Resource cleanup.** Both timers cleared in `stop()`; `updateRecheckTimer` no-ops when not
  running; `untrackBlock` deletes the snapshot entry; the recheck timer is unref'd.
- **The `no-local-data → complete` rule** already carries a `NOTE:` at its site stating the accepted
  reasoning. Its revisit condition (the node obtaining the block by a route other than the pull) has
  not tripped, so per the accepted-tradeoff rule it was left alone.
- **Docs.** Read every touched file plus the two the change should have touched. `docs/internals.md`
  and `docs/arachnode-ring-handoff.md` both accurately describe the new mechanism, including the
  config knobs, the diagnostics surface, and the two-pass budget fill. One correction applied (the
  exact-count claim above).
- **Source hygiene.** `rebalance-monitor.ts` 539 lines, `block-transfer.ts` 533 (`wc -l`) — far below
  this package's norms (`libp2p-node-base.ts` is 1708, `cohort-topic/host.ts` 2932). No size finding.
  Comment density is high but matches the surrounding file and every block earns its place.
- **Wall-clock timer tests.** The re-check suite uses real `setTimeout` plus `waitFor` rather than
  fake timers. Ran the monitor spec three times (isolated, package suite, full monorepo suite) with no
  flake and the whole spec under 400ms. Left as is — converting to fake timers would trade real
  coverage of the unref/re-arm behavior for determinism this suite has not needed.
