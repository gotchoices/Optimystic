description: Simulator metrics engine, scenario runner, and scale/sensitivity sweep — the gate that produces the quantitative artifacts `fold-simulator-findings-into-design-docs` consumes. Reviewed and completed.
files:
  - packages/substrate-simulator/src/metrics.ts
  - packages/substrate-simulator/src/scenarios.ts
  - packages/substrate-simulator/src/sweep.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/metrics.spec.ts
  - packages/substrate-simulator/test/scenarios.spec.ts
  - packages/substrate-simulator/test/sweep.spec.ts
  - packages/substrate-simulator/README.md
  - docs/cohort-topic.md
  - docs/reactivity.md
  - docs/matchmaking.md
----

# Simulator metrics engine, scenario runner, and scale/sensitivity sweep

The capstone of the simulator phase. Three modules fold metrics aggregation (`metrics.ts`), scenario
orchestration (`scenarios.ts`), and the scale/sensitivity sweep (`sweep.ts`) into one pipeline on top
of the sequence-4/5 model drivers. This is the gate whose outputs feed
`fold-simulator-findings-into-design-docs` (sequence 7, already queued in `implement/`).

## What landed (implement stage)

- **`metrics.ts`** — `Metrics` (`MetricsSink` + `EventSink`): counters/histograms/timelines with
  order-independent tag keying; query surface (`counterValue`, `counterTotal`, `histogramStats`,
  `percentile`, `cdf`, `timelineOf`); `exportJson()` / `exportCsv()`. Folds the model `SimEvent`
  stream into `event.<kind>` counters tagged by tier.
- **`scenarios.ts`** — `Scenario`/`ClaimReport` + five scenarios (cold-start storm, churn recovery,
  tail rotation, voting-quorum herd, adversarial reporting), each reusing the existing drivers and
  emitting a pass/fail `ClaimReport`. `runAllScenarios()` runs all five.
- **`sweep.ts`** — `runScaleSweep()` (depth law `⌈log_F(N/cap)⌉` + bounded walk hops across
  N ∈ {100 … 1M}) and `runSensitivitySweep()` (one-knob-at-a-time effect on convergence depth/latency,
  cold-lookup hops, replay coverage, hang-out threshold), both exporting via `Metrics`.

## Review findings

**Read first:** the full implement diff (`git show d7097e5`) for all three modules + tests, then the
supporting model layers each scenario/sweep leans on (`topic-tree.ts`, `promotion-convergence.ts`,
`walk-metrics.ts`, `registration.ts`, `partition.ts`, `reactivity.ts`, `matchmaking.ts`,
`seeker-walk.ts`). Build (`tsc`, strict) and the full suite were run before and after every change.

### Correctness / SPP / type safety
- **No correctness bugs found in the new code.** Traced the load-bearing non-vacuity risks: the
  voting/cold-start `root-not-overloaded` claims read a *real* root cohort (`tree.get` key ==
  `bytesToHex(uniformLadder(…)[0])` matches what `register` stores), not an `undefined → 0` that would
  trivially pass; eager `register` promotes the root at exactly `cap_promote`, so `64 ≤ 64` is a true
  measurement. The `walks-fan` distinct-coord claim is robust (since `F^d_max ≈ 4N > N` for the
  defaults, `index % F^d_max == index`, so distinct == N always). Metrics CSV/JSON, RFC-4180 quoting,
  nearest-rank percentiles, CDF dedup, and the `EventSink` tier-tagging all check out.
- **Fixed (minor): removed 5 unsafe `metrics as Metrics` casts** (implement gap #7). `Scenario.validate`
  now takes the concrete `Metrics` (read+write surface) instead of the write-only `MetricsSink` and
  casting back inside every validator. `runScenario` already constructs and passes a concrete
  `Metrics`, so this is strictly more honest and removes the downcast. Dropped the now-unused
  `MetricsSink` import. (`validate` is an interface method ⇒ bivariant params under
  `strictFunctionTypes`, so widening the parameter is safe; build confirms.)

### Test coverage (treated implementer tests as a floor)
- **Added (minor): a `counterTotal` test** in `metrics.spec.ts`. `counterTotal` (sum across all tag
  sets) is the method every `promotion-fires` claim relies on to count `event.Promoted` across tiers,
  and it had **no** direct test. New test pins cross-tag summation, per-tag isolation, no leakage from
  a same-tier different-named counter, and the unknown-name → 0 (not NaN) path. Suite: 194 → 195.

### Docs (treated as out-of-date until read)
- **Fixed (minor): `packages/substrate-simulator/README.md` was stale.** It described "Six layers"
  and its quick-start example referenced the metrics engine as a *future* "(ticket 6)". Added the
  seventh layer (metrics engine + scenario runner + scale/sensitivity sweep) and updated the
  forward-pointer to the now-landed `Metrics`/`runScenario`/`runScaleSweep` surface.
- The three forward-pointer doc edits (cohort-topic.md §Anti-flood, reactivity.md §Worked scenarios,
  matchmaking.md §Worked scenarios) were verified accurate — they reference real modules and the
  placement note (cohort-topic.md has no §Worked scenarios section) is correct.
- **Observation (pre-existing, not fixed):** the README also omits the sequence-5 `reactivity.ts`
  model as its own layer. That omission predates this ticket (ticket 5's review) and is out of scope
  here; left as-is. Flagging so it isn't lost.

### Adversariality of the claims (the gate's whole point) — MAJOR, filed
The implementer honestly flagged that some claims pass by construction. Confirmed, and found a third:
- `churn-recovery / heal-convergence` is a pure-function tautology (`checkConvergence`: merged epoch
  == pre epoch by definition).
- `adversarial / over-report-bounded-drain` is bounded by the seeker's own deadline (near-tautology).
- **Newly found:** `tail-rotation / completes-within-drain` can never fail — arrivals jitter over
  `T_rejoin_jitter` (30 s) which is hardcoded **smaller** than `T_drain` (60 s), so the bound holds
  regardless of system behavior.
- The slope-lookahead-ON promotion path is exercised by **no** scenario (both the storm and the
  rotation burst disable it deliberately), leaving the lookahead-on transient hop bound (≈ `2·d_max`)
  unvalidated.

These are validation-coverage gaps in the gate itself, requiring new scenario code + thought — too
large to fix inline without risking the (correct) existing bounds. Filed as
**`tickets/backlog/simulator-strengthen-scenario-adversariality.md`**. Not a blocker for the
fold-back: the current scenarios are correct, pass, and are honestly caveated; this raises the
confidence the gate provides. Deliberately **not** marked a `prereq:` of
`fold-simulator-findings-into-design-docs` — that ticket can proceed against the current artifacts.

### Accepted as-is (documented, no action)
- Walk-hop measurement gated to N ≤ 10k (implement gap #4) — the 100k/1M lookup claim rests on the
  depth law + the `≤ d_max + 2` structural bound, honestly stated. Acceptable; the depth law *is*
  measured at 1M (~10 s on the virtual clock).
- Sensitivity sweep validates monotonic *relationships*, not absolute targets (gap #5) — intentional;
  absolute-number validation is the fold-back's job.
- Voting scenario registers synchronously at `now = 0` (gap #3) — validates the depth law + root bound
  cleanly; herd-timing dynamics are out of scope for this claim.

## Status
- `yarn build` (strict `tsc`, no `any`, tabs) green. No separate lint in this package; `tsc` is the
  type-check.
- `yarn test` green: **195 passing (~20 s)**, including all five scenarios' all-passing `ClaimReport`s
  and the N ∈ {100 … 1M} scale sweep.
- Minor findings fixed inline (cast removal, README sync, `counterTotal` test). One major finding filed
  to `backlog/`.
