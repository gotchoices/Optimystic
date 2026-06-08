description: Review of the simulator metrics engine, scenario runner, and scale/sensitivity sweep — the gate that answers the design's quantitative claims. Verify the claim validators are genuinely adversarial (not tautological), the O(log N) / depth-law confirmation is sound, and the sensitivity report is a usable fold-back artifact.
files:
  - packages/substrate-simulator/src/metrics.ts
  - packages/substrate-simulator/src/scenarios.ts
  - packages/substrate-simulator/src/sweep.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/metrics.spec.ts
  - packages/substrate-simulator/test/scenarios.spec.ts
  - packages/substrate-simulator/test/sweep.spec.ts
  - docs/cohort-topic.md
  - docs/reactivity.md
  - docs/matchmaking.md
----

# Review: simulator metrics engine, scenario runner, and scale/sensitivity sweep

The capstone of the simulator phase. Three new modules fold metrics aggregation, scenario
orchestration, and the scale/sensitivity sweep into one pipeline on top of the sequence-4/5 model
tickets (walk, churn+willingness, promotion-convergence, reactivity-replay, matchmaking-hangout).
**This is the gate**: its outputs are the input artifact `fold-simulator-findings-into-design-docs`
consumes. `yarn build` is green; `yarn test` passes (194 tests, ~20s).

## What landed

### `metrics.ts` — `Metrics` engine (`MetricsSink` + `EventSink`)
- `counter(name, by?, tags?)`, `histogram(name, value, tags?)`, `timeline(name, t, value)` with
  stable, order-independent tag keying.
- Query surface for validators: `counterValue`, `counterTotal` (sum across all tag sets — used to
  count promotions across tiers), `histogramStats` (count/min/max/mean/p50/p95/p99), `percentile`
  (nearest-rank, mirrors `walk-metrics.hopPercentile`), `cdf`, `timelineOf`.
- `exportJson()` (counters + histogram summaries + raw values + timelines) and `exportCsv()`
  (flat `section,name,tags,stat,value` rows, RFC-4180 quoting). **Note:** timeline rows put virtual
  time in the `stat` column — a deliberate flattening; confirm it suits offline tooling.
- Implements `EventSink`: folds the model `SimEvent` stream into `event.<kind>` counters tagged by
  tier (Promoted tagged by `fromTier`). This is the "subscribe the engine to the event streams"
  wiring — the tree/walk/churn/registration models all emit onto it.

### `scenarios.ts` — `Scenario` / `ClaimReport` + five scenarios
`runScenario(make)` builds a world+metrics from the scenario seed, runs `setup → run → validate`, and
returns the `ClaimReport` + populated `Metrics`. `runAllScenarios()` runs all five. Each scenario
reuses the existing model drivers verbatim and records every validated quantity into the sink.
- **`ColdStartStormScenario`** — N `ParticipantWalk`s over a `TopicTree`; claims: root ≤ `cap_promote`,
  walks fan (distinct start coords == N), promotion fires, max hops ≤ `d_max + 2`, no give-ups.
- **`ChurnRecoveryScenario`** — `TopicCohort` + `ParticipantRenewal`, 20% member kill + partition
  `checkConvergence`; claims: no lost registrations, failover engaged, all participants re-converge.
- **`TailRotationScenario`** — `simulateRotationBurst` + `CohortPushState`; claims: peak root direct
  ≤ `cap_promote_fast`, completes within `T_drain`, revision stream gap-free.
- **`VotingQuorumScenario`** — eager `TopicTree.register` flash herd; claims: depth ==
  `⌈log_F(N/cap)⌉`, root ≤ `cap_promote`, promotion fires.
- **`AdversarialReportingScenario`** — honest vs under/over-reporting `SeekerWalk`s; claims:
  under-report ≤ +1 hop per tier and still terminates, over-report wastes ≤ `patienceMs`.

### `sweep.ts` — scale + sensitivity sweeps
- `runScaleSweep()` — N ∈ {100, 1k, 10k, 100k, **1M**}: depth law via `runConvergence` (observed ==
  `⌈log_F(N/cap)⌉`) + bounded walk-hop sampling. 1M runs on the virtual clock in ~10s.
- `runSensitivitySweep()` — sweeps `cap_promote`, `F`, `d_max_cap`, `W`, `W_checkpoint`,
  `contention_factor_cap`; records each parameter's effect (convergence depth/latency, cold-lookup
  hops, replay coverage seconds, hang-out threshold). This is the fold-back's input artifact.
- `samplesFor()` extracts a per-(parameter, metric) series for monotonicity checks.

## How to run / validate
```
cd packages/substrate-simulator
yarn build          # ES modules, no any, tabs — green
yarn test           # 194 passing (~20s)
# targeted:
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/{metrics,scenarios,sweep}.spec.ts" --reporter spec
```
Programmatic: `import { runAllScenarios, runScaleSweep, runSensitivitySweep } from '@optimystic/substrate-simulator'`.
`runAllScenarios()` returns `{ report, metrics }[]`; `metrics.exportJson()/exportCsv()` for offline analysis.

## Known gaps / things to scrutinize (treat tests as a floor)

1. **Some claims are weakly adversarial / structurally guaranteed, not stress-discovered.**
   - Churn `heal-convergence` is a model *invariant* (`checkConvergence` merges back to the same
     epoch), so it passes by construction — it confirms the model, not an emergent property.
   - Over-report `over-report-bounded-drain` is bounded by the seeker's own `deadline`, so the
     ≤ `patienceMs` bound is near-tautological. The genuinely interesting bound (under-report ≤ +1
     hop/tier) is the stronger check. Consider whether the reviewer wants harsher adversaries
     (e.g., reporters that flip per-query, or a churn scenario that kills members *during* renewal
     rather than all at t=0).

2. **Cold-start storm disables slope lookahead** (`tPromoteLookaheadMs: 0`), mirroring
   `simulateRotationBurst`'s documented decision. With lookahead **on**, the storm transiently
   over-deepens the tree (pre-promotion below `cap_promote`), pushing max hops past `d_max + 2`
   (observed 8 at N=3000, d_max=4) — still `O(log N)` but exceeds the tight cold bound. The current
   test validates the lookahead-off bound only. A reviewer may want a separate claim characterizing
   the lookahead-on transient hop bound (≈ `2·d_max`) so the lookahead path isn't left unvalidated.

3. **Voting scenario registers synchronously at `now = 0`** (so slope never fires; promotion is
   strictly at `cap_promote`). This validates the depth law + root bound cleanly but does **not**
   model the *timing* dynamics of a flash herd arriving over a real window. If the timing of the
   herd matters to the claim, this should arrive jittered on the clock instead.

4. **Scale-sweep walk-hop measurement is gated to N ≤ 10k** (`walkSampleMaxN`, because the grown-tree
   `register` loop is the cost). For 100k/1M only the depth law is measured directly; the `O(log N)`
   *lookup* claim at those N rests on the depth law + the `≤ d_max + 2` structural bound, not a
   direct hop measurement. Honest, but not a measured fact at the largest N.

5. **Sensitivity relationships are validated as monotonic, not against absolute targets.** The
   `cap_promote` / `F` sweeps assert observed depth is non-increasing (and the effect is real), not
   that observed == law for off-default `cap`/`F` (the depth law was only spec-validated at the
   defaults). The report is the artifact; absolute-number validation is the fold-back's job.

6. **Not every histogram the ticket enumerated has a dedicated metric.** The engine supports all of
   them, and the scenarios populate walk-hop / latency / coverage / threshold histograms, but e.g.
   "RPC-count and load histograms per tier" are realized as per-tier `event.*` counters rather than
   richer histograms. Confirm the realized aggregations are sufficient for the fold-back, or flag
   which are still missing.

7. **`Metrics` query methods are accessed via `metrics as Metrics`** inside validators (the
   `MetricsSink` interface intentionally exposes only the write surface). This cast is safe within
   the runner (it always constructs a concrete `Metrics`) but is worth a sanity check.

## Done when (status)
- [x] `yarn build` green; ES modules, no `any`, tabs.
- [x] `yarn test` passes; each of the five scenarios produces an all-passing `ClaimReport`.
- [x] Scale sweep confirms `observed == ⌈log_F(N/cap)⌉` across N ∈ {100, 1k, 10k, 100k, 1M} and
      bounded walk hops for the measured N.
- [x] Sensitivity sweep produces a JSON/CSV report quantifying each parameter's effect.
- [x] Doc-sync forward pointers added to cohort-topic.md (§Anti-flood), reactivity.md, matchmaking.md
      (§Worked scenarios). **Note:** cohort-topic.md has no §Worked scenarios section, so the pointer
      was placed in §Anti-flood properties, where the cold-start-storm and voting-quorum claims live.
- [x] Agent-runnable subset finishes well inside budget (~20s full suite; 1M scale point ~10s on the
      virtual clock, so it was kept in the default sweep rather than env-gated).
