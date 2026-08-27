description: When a machine copies its data to a machine that just joined and that copy fails, it is never tried again. The code change making the copy confirmation-driven, retry-bounded, and self-rechecking has landed; this continuation finishes the remaining regression test, the docs, and the validation run.
prereq:
files: packages/db-p2p/src/cluster/rebalance-monitor.ts, packages/db-p2p/src/cluster/block-transfer.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/rebalance-monitor.spec.ts, packages/db-p2p/test/block-transfer.spec.ts, packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts, docs/internals.md, docs/arachnode-ring-handoff.md
difficulty: medium
repro: verified

----

# Record a growth push as done only after it is confirmed — continuation

A prior agent run implemented most of this ticket and hit its token budget before validation.
**All production code changes are in the working tree and believed complete. Most test updates are
in. Nothing has been run yet — neither the test suite nor typecheck.** The full original
specification is preserved below under *Original specification*; read it for the invariant and the
per-case rules before touching the code.

## Already DONE (in working tree, unvalidated)

**`packages/db-p2p/src/cluster/rebalance-monitor.ts`** — complete per spec:
- `GrowthOutcome` interface exported (after `RebalanceEvent`).
- New config: `growthMaxAttempts` (default 5), `growthRecheckIntervalMs` (default
  `minRebalanceIntervalMs`, 0 disables).
- `responsibilitySnapshot` entries are now `BlockGrowthState` = `{ responsible, cohortPeers,
  pendingPeers, growthAttempts, abandonedPeers }`. Reported peers are NO longer added to
  `cohortPeers` at report time; seen/abandoned sets are intersected with the current cohort each
  check; responsibility loss resets to `emptyGrowthState(false)`.
- `recordGrowthOutcome(blockId, outcome)`: satisfied peers → seen; `complete:true` resets the
  attempt counter and clears pending; `complete:false` increments it and on reaching
  `growthMaxAttempts` moves still-pending peers to `abandonedPeers` (logged), resets counter.
  Ignores outcomes for blocks whose state is missing or no longer `responsible` (stale outcome
  after a loss must not survive the clear).
- Budget filled in two passes (fresh `growthAttempts === 0` candidates before retries).
- Self-arming, unref'd re-check timer: `updateRecheckTimer()` called at end of
  `performRebalanceCheck` and in `recordGrowthOutcome`; arms only while running AND outstanding
  work (pending peers or `lastGrowthDeferred > 0`); fires `maybeRebalance()` then re-arms via
  `.finally`; cleared in `stop()`. The superseded growth-budget `NOTE:` comment was replaced.
- `getGrowthDiagnostics(): { blocksAwaitingConfirmation, abandonedPairs, recheckArmed }`.

**`packages/db-p2p/src/cluster/block-transfer.ts`** — complete per spec:
- `RebalanceReactionResult.growth: Map<string, GrowthOutcome>`.
- `executeConfirm` refactored: no longer mutates caller arrays; returns
  `{ confirmed: boolean; confirmedPeers: Set<string>; noLocalData: boolean } | null` (null = confirm
  already in flight, i.e. no information). `confirmedPeers` is the UNION across retry rounds (a
  peer that accepted a push holds a replica even if a later round missed it); the floor decision
  itself stays per-round — unchanged behavior. `confirmReplicated` rebuilds its
  `{confirmed, unconfirmed}` arrays from the return value; lost-block release path behavior
  unchanged.
- `replicateGrown` now drives `executeConfirm` directly (own partition guard mirroring
  `confirmReplicated`'s, emitting `{satisfiedPeers: [], complete: false}` per block on partition)
  and populates `growth` per the four spec rules: floor-met → all reported peers, complete;
  no-local-data → all reported peers, complete (the tripwire `NOTE:` is at this branch); otherwise →
  confirmed peers only, incomplete; in-flight-deduped → NO entry.

**`packages/db-p2p/src/libp2p-node-base.ts`** — complete per spec: the `.then` handler feeds
`result.growth` into `rebalanceMonitor.recordGrowthOutcome` (after the `released` loop), the
`cohort-growth:` log line now includes `awaiting-confirmation` and `given-up-pairs` from
`getGrowthDiagnostics()`, the `.catch` path records nothing, and the surrounding comment block was
rewritten.

**`packages/db-p2p/test/rebalance-monitor.spec.ts`** — the four existing growth tests updated to
feed outcomes ("only the new peer", "a CONFIRMED cohort does not re-emit", budget-deferral,
regain-after-loss), plus new suites: *confirmation-driven growth* (incomplete-outcome retry
regression, partial outcome, no-outcome-leaves-state, give-up + leave/rejoin retry, counter reset
on complete, stale-outcome-after-loss ignored) and *growth re-check timer* (arm/disarm via
diagnostics, timer fires a re-check with no topology event using `waitFor`, `0` disables).

**`packages/db-p2p/test/block-transfer.spec.ts`** — growth cases now assert `result.growth`
(confirmed / refuses-to-persist / no-local-data), plus a new partial-confirmation test (one peer
confirms, one refuses, floor clamps to 2 → `complete:false`, only the confirming peer satisfied).

**`packages/db-p2p/test/cohort-growth-heals-single-holder.spec.ts`** — `LoopbackPeerNetwork` gained
an `unreachable` set (dial throws for members); the existing end-to-end test now feeds
`result.growth` back into the monitor before its closing `checkNow() === null` assertion.

## Remaining TODO

- **The headline regression test** in `cohort-growth-heals-single-holder.spec.ts` (spec under
  *Tests* below): reuse `build()`; sequence: `mockFret.setCohort([peerA])` → baseline check;
  `network.unreachable.add(peerB.toString())`; `setCohort([peerA, peerB])` → check reports B grown;
  `handleRebalanceEvent` → `underReplicated: [BLOCK_ID]`, feed `result.growth` back;
  `network.unreachable.delete(...)`; cohort UNCHANGED → next `checkNow()` must re-report B grown;
  second `handleRebalanceEvent` → `replicated: [BLOCK_ID]`; assert B's repo holds
  `{ rev: 1, actionId: 'action-1' }`; feed outcomes; final `checkNow()` null. (The build's
  coordinator uses `maxRetries: 0`, so each pass is one dial. `MockFret` has no `getDiagnostics`,
  so the event floor is 3 and `replicateGrown` clamps per block — fine.)
- **Docs**: `docs/internals.md` ~line 511-513 (growth push described as "happens once per detected
  growth … keeps its single copy until the cohort changes again" — precisely the removed behavior)
  and ~line 975 (the `grown` paragraph says the seen set is recorded at report time; rewrite for
  confirmation-driven seen set, `growthMaxAttempts` give-up, re-check timer, diagnostics). Also the
  §977 gated-release paragraph's `{ pulled, released, retained, replicated, underReplicated }`
  shape gains `growth`. `docs/arachnode-ring-handoff.md` ~line 248: same return-shape addition and
  a sentence that growth outcomes feed back to the monitor.
- **Run** `yarn workspace @optimystic/db-p2p test` and `yarn typecheck` (foreground, no
  redirection); fix fallout. Nothing has been compiled or executed yet — expect possible small
  type/assert slips. Known risk spots: the partial-confirmation test incurs one ~1s retry backoff
  (`maxRetries: 1` in that spec's `beforeEach`) — fine; the timer tests rely on
  `getGrowthDiagnostics().recheckArmed` and `waitFor` from `@optimystic/db-core/test`.
- Hand off to review/ with an honest summary (delete this ticket from implement/).

## Design learnings for the reviewer/finisher

- A check can re-report a block whose reaction is still in flight; the coordinator's `confirm:<id>`
  dedup then yields NO growth entry, so the monitor stays untouched — this is the load-bearing
  "no entry = no information" rule.
- If an intervening check re-reports a block before its outcome lands, `pendingPeers` is rebuilt
  from the latest report; a budget-DEFERRED intervening check clears `pendingPeers`, so a give-up
  landing right then abandons nothing and resets the counter — a deliberate, rare, benign
  weakening of the bound (documented here rather than complicating the state machine).
- The reaction throwing (`.catch` path) records nothing, so the re-check timer retries forever at
  `growthRecheckIntervalMs`; the give-up bound only counts RECORDED incomplete outcomes. Accepted:
  a throwing reaction is a bug to surface, not to silently abandon.

## Original specification

(unchanged from the fix-stage ticket — the invariant, per-case rules, and test list)

**The invariant**: a peer enters a block's seen set only once a replica is confirmed on it, or once
the block has otherwise reached its floor.

`GrowthOutcome { satisfiedPeers: string[]; complete: boolean }` per grown block:
- floor met → all reported peers, `complete: true` (includes peers `executeConfirm` skipped once
  the floor was reached — re-pushing the remainder forever would be a live loop).
- no local data (`confirm:no-local-data`, the gained∩grown first-observation case) → all reported
  peers, `complete: true`; tripwire `NOTE:` at that branch (recorded — see block-transfer.ts).
- otherwise → `{ satisfiedPeers: [...confirmedPeers], complete: false }`.
- block dropped by the in-flight `confirm:<id>` dedup → no map entry; monitor leaves state
  untouched.

Give-up: `growthMaxAttempts` (default 5) incomplete outcomes → still-unsatisfied reported peers
into per-block `abandonedPeers` (intersected with the cohort each check; cleared on responsibility
loss), counter reset, logged, visible in `getGrowthDiagnostics()`.

Re-check timer: `growthRecheckIntervalMs` (default `minRebalanceIntervalMs`, 0 disables), armed
only while outstanding work, fires `maybeRebalance()`, unref'd, cleared in `stop()`.

Fairness: budget filled fresh-growth-first, retries with the remainder.

Out of scope: the two-claimant read-repair corroboration floor
(`blocked/repair-floor-defends-a-door-the-push-path-leaves-open`).
