description: REVIEW — simulator matchmaking hang-out-vs-continue decision engine + seeker-path tracer. Models expectedNewMatches/contentionFactor with the contention_factor_cap clamp and four edge cases, a SeekerWalk (registration on ParticipantWalk + requery_interval_ms hang-out poll + walk-toward-root escalation) over a modeled per-tier provider population, adversarial under/over-report bounds, and a refinement-signal measurement for fold-back. Build green; 133 tests pass (114 prior + 19 new).
prereq:
files:
  - packages/substrate-simulator/src/matchmaking.ts
  - packages/substrate-simulator/src/seeker-walk.ts
  - packages/substrate-simulator/src/refinement-signal.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/matchmaking.spec.ts
  - packages/substrate-simulator/test/seeker-walk.spec.ts
  - docs/matchmaking.md
  - packages/substrate-simulator/README.md
----

# Review: simulator matchmaking hang-out-vs-continue + seeker-path tracer

Models the seeker hang-out decision under modeled load and traces seeker path length / success, the
modeled mirror of `docs/matchmaking.md` §Hang-out vs. continue. Layered on
`simulator-cohort-topic-tree` (`TopicTrafficV1`, `TopicTree`) and `simulator-participant-walk`
(`ParticipantWalk` for the registration leg). Synchronous on the seeded virtual clock — the
`no-real-time` guard scans the three new src files green.

## What shipped (as implemented)

- **`matchmaking.ts` — pure decision engine.** `expectedNewMatches(arrivalsPerMin, filterAcceptRatio,
  patienceMs)`, `contentionFactor(arrivalsPerMin, queriesPerMin, meanWantCount, cap)` with the
  `contention_factor_cap = 4.0` clamp, and `decideHangOut(traffic, currentMatches, demand, config)`
  returning `'matched' | 'hang-out' | 'escalate'` plus the terms that produced it. Handles the four
  edge cases: **missing traffic** (→ conservative escalate, but the immediate-match check still
  fires), **stale `arrivalsPerMin = 0`** (immediate-match check runs first → no over-reaction to a
  single zero), **pathological filter** (`filterAcceptRatio → 0` collapses the estimate), and
  **`filterAcceptRatio` decay** via `FilterAcceptEstimator` (cumulative `Σ matchable / Σ returned`,
  seeded at 1.0). `CapabilityFilter` / `matchesFilter` / `countMatchable` model the §Capability
  filter. `DEFAULT_MATCHMAKING_CONFIG` carries the matchmaking.md §Configuration defaults.
- **`seeker-walk.ts` — `SeekerWalk` + `TierProviderModel`.** `SeekerWalk` runs registration via a
  `ParticipantWalk` (lands at a tier), queries the cohort, runs the decision engine, then **hangs
  out** (re-query every `requery_interval_ms` until `wantCount` accrues or the tier patience budget
  drains) or **escalates** (walk one tier toward the root, modeled as one latency hop). Emits a
  `SeekerTrace { seeker, tiersVisited, hangOutDurationMs, matched, matchLatency, requeries, … }`.
  `TierProviderModel` holds a per-tier modeled provider population: a standing pool + a deterministic
  fresh-arrival stream + a `truthfulTraffic` snapshot; a pluggable `TrafficReporter` models honest /
  adversarial / absent reporting.
- **`refinement-signal.ts`.** `patienceSplittingWouldHelp` / `seekerPoolContentionWouldFlip` /
  `measureRefinementSignal` — **measure only**, do not implement, whether the two deferred backlog
  refinements would materially improve the borderline regime (recorded for fold-back).
- **Docs.** `docs/matchmaking.md` §Worked example and §Adversarial cohort traffic reporting carry a
  simulator-validation forward note; README gains the sixth-layer paragraph.

## How to validate

```
cd packages/substrate-simulator
yarn build      # tsc, strict, clean
yarn test       # 133 passing (114 prior + 19 new across matchmaking.spec.ts + seeker-walk.spec.ts)
```

Key use cases under test:
- **Worked example** (`matchmaking.spec.ts`): `expectedNewMatches = 15`, `contentionFactor ≈ 1.13`,
  threshold ≈ 9.07, decision = hang out — the docs §Worked example, reproduced as assertions.
- **Edge cases**: missing traffic → escalate (immediate-match still fires); stale-zero → query first;
  pathological filter → escalate; `filterAcceptRatio` settles near 0.1 after two 10%-yield cohorts.
- **§Test-expectations cases** (`seeker-walk.spec.ts`): hot deep-tier suffices (1 query, no walk);
  cold walks to root (queries tiers 2→1→0, 2 escalations, matches only at root); borderline hangs out
  for full patience (≈ 9 requeries, returns the partial set).
- **Fairness at scale**: 100 parallel seekers under `contention_factor_cap = 4.0` → zero escalations
  (no self-inflicted storm), all served at their landing tier.
- **Adversarial bounds**: under-report → ≤ +1 register hop per tier, still terminates at root;
  over-report → ≤ `patienceMs` of wasted drain.
- **Refinement signal**: the borderline run records that per-tier-patience-splitting and
  contention-from-seeker-pool would both have helped (booleans + a note string) for fold-back.

## Honest gaps / where the reviewer should dig

These are deliberate modeling simplifications or untested-either-way surfaces — treat the tests as a
floor, not a finish line:

1. **Escalation does not re-run a full `ParticipantWalk`.** `SeekerWalk` uses `ParticipantWalk` for
   the *initial* registration only; each escalation (`escalate`) is modeled as a single latency hop
   ("withdraw + re-register at d−1"), not a fresh inward walk with its own `NoState`/`UnwillingCohort`
   handling. Faithful to the doc's "withdraw, re-register at d−1" but it bypasses the walk's
   willingness/back-off machinery on the escalation legs. The landing tier in tests is fixed by a
   pre-seeded `TopicTree` (`tree.ensure`), **not** a FRET-grown tree — so the registration leg's
   realism is bounded (consistent with `simulator-participant-walk`'s own hop-test caveat).
2. **`queriesPerMin` is a static tier config, not dynamically driven by the live seeker pool.** The
   100-seeker fairness test feeds a representative high `queriesPerMin` and asserts zero escalations +
   the capped factor; it does **not** have each seeker's registration actually bump the cohort's
   query counter. The fairness claim is therefore asserted at two altitudes (decision-engine cap math
   + the 100-seeker run) rather than via a self-consistent closed loop. A closed-loop version (seekers
   feeding `recordQuery` into a shared cohort traffic signal) would be stronger.
3. **Provider arrivals are a deterministic fixed-cadence stream.** `freshArrivalIntervalMs` lands one
   matchable provider per interval; there is no stochastic/Poisson arrival model. The deliberate split
   between `reportedArrivalsPerMin` (drives the estimate) and `freshArrivalIntervalMs` (the realized
   stream) is what manufactures the borderline regime — realistic per the doc (arrivalsPerMin mixes
   fresh + renewals) but it is a knob the test author sets, not an emergent property.
4. **Cross-tier match accumulation is not modeled.** Each tier's query is a fresh slice;
   `matchedCount` reflects the resolving tier's pool only (the root subsumes the lower shards). A
   seeker does not carry partial matches collected at a deeper tier into the root query.
5. **Push path is entirely out of scope.** Only the poll path (`requery_interval_ms`) is modeled —
   `pushOnArrival` / `ArrivalPushV1` / coalescing / FCFS-by-`attachedAt` fan-out / the safety-poll +
   mandatory-final-poll (matchmaking.md §Arrival push on provider arrival) are **not** simulated. The
   ticket scoped the hang-out decision + poll cadence; the push optimization is a natural follow-on.
6. **`patience_per_tier_fraction < 1.0` is wired but unexercised.** `onHangOutDrained` has the
   escalate-after-hang-out branch for fraction < 1, but every test runs at the default 1.0 (spend all
   patience at the tier). The < 1.0 splitting strategy is precisely the deferred
   `matchmaking-per-tier-patience-splitting` refinement — intentionally not implemented/tested here,
   only measured.
7. **`filterAcceptRatio` decay is a cumulative ratio, not an EWMA.** `Σ matchable / Σ returned`
   reproduces the doc's "settles near 0.1" but weights old observations equally with recent ones; a
   real seeker might prefer a recency-weighted estimate.

## Refinement signal (recorded for `fold-simulator-findings-into-design-docs`)

Per the ticket, the deferred refinements were **measured, not implemented**. In the modeled
borderline regime both `patienceSplittingWouldHelp` and `seekerPoolContentionWouldHelp` come back
**true** (a deep-tier hang-out drained to partial while the root held `wantCount`; and the exact
`Σ wantCount` flips the borderline hang-out decision vs. the `meanWantCount × queriesPerMin`
approximation). This is a *signal on a hand-built scenario*, not a population sweep — the fold-back
ticket should decide whether that signal is strong enough to promote either backlog ticket.

## Downstream

- `fold-simulator-findings-into-design-docs` — fold the measured figures into the matchmaking.md
  forward notes (currently prose-only) and weigh the refinement signal.
- `matchmaking-per-tier-patience-splitting`, `matchmaking-contention-from-seeker-pool` (backlog) —
  the measured refinements; promote only if the fold-back ticket judges the signal material.

## End
