description: Review the simulator promotion-depth tracer + convergence validator — depth-law sweep, overshoot bound, lookahead comparison, hysteresis-lock metrics over a gossip-lagged growth model.
prereq: simulator-cohort-topic-tree, simulator-participant-walk
files:
  - packages/substrate-simulator/src/promotion-convergence.ts
  - packages/substrate-simulator/src/topic-tree.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/promotion-convergence.spec.ts
  - docs/cohort-topic.md
----

# Review: simulator promotion-depth tracer and convergence validator

Implements the central cohort-topic scaling claim validator: records the depth-over-time timeline
for a topic and derives a `ConvergenceResult` (steady-state vs expected depth, convergence latency,
peak overshoot, oscillations). Builds on `topic-tree.ts` (promotion/demotion lifecycle) and the
`walk.ts` participant walk.

## What landed

**`src/promotion-convergence.ts`** (new):
- `DepthSample` / `ConvergenceResult` (exact ticket interfaces; `topicId` is hex per the rest of the modeled tree).
- `expectedDepth(N, F, capPromote)` — the law `⌈log_F(N/cap_promote)⌉`, clamped to 0 for `N ≤ cap`.
- `sampleDepth(tree, topicId, capPromote, now)` — snapshots `maxDepth` / `coordCount` / `overCapCount` from live cohort state.
- `PromotionTracer implements EventSink` — subscribes to the tree's `Promoted`/`Demoted` stream (samples on each), is also sampled once per round by the driver to catch the pre-promotion peak, and tracks running `peakOvershoot` (max `directParticipants − cap` across cohorts). `result(...)` derives the `ConvergenceResult`.
- `uniformLadder(index, dMax, F)` — synthetic, **idealized-uniform** prefix-shard ladder (`bucket = index mod F^d`, nesting correctly).
- `runConvergence(opts)` — the gossip-lagged growth driver + validator; `compareLookahead(opts)` — on/off arms.

**`src/topic-tree.ts`** (modified): extracted `walkToLanding` + `instantiateAndLink` private helpers (shared by `register`/`attachAt`); added public `routeArrival(topicId, ladder, now)` — root-outward walk + count bump **without** eager promotion, so the convergence driver can decide promotion on the gossip tick (the lag that makes overshoot observable). Behaviour of `register`/`attachAt` is unchanged (verified by the existing `topic-tree.spec` — all still pass).

**`src/index.ts`**: re-exports the new surface.

**`docs/cohort-topic.md`** §Tree growth and lookup: added the simulator-validation forward note (depth law, convergence latency, overshoot bound, oscillation count; numbers fold via `fold-simulator-findings-into-design-docs`).

## How to validate

```
cd packages/substrate-simulator && yarn build && yarn test
```

`yarn build` green; `yarn test` → **141 passing** (7 new in `promotion-convergence.spec.ts`). Done-when coverage:
- **Depth law:** `steadyStateDepth == ⌈log_F(N/cap_promote)⌉` for `N ∈ {10,100,1k,10k,100k}` (lookahead on *and* a subset off). Sweep runs in <1s.
- **Bounded overshoot:** with `R = 10` (chosen so `R ∤ cap_promote`), `0 < peakOvershoot < R` — a cohort accrues at most one gossip-round of arrivals before the lagged promotion lands.
- **Lookahead reduces overshoot:** `compareLookahead` shows lookahead-on `peakOvershoot` strictly below lookahead-off (and `== 0`), same population/parameters.
- **Hysteresis locks:** `oscillations == 0` (monotone depth convergence) across the sweep.

## Reviewer focus — known gaps / decisions to scrutinize

These are deliberate modeling choices; treat them as the starting point, not settled truth:

1. **Idealized-uniform sharding (biggest call).** The sweep uses `uniformLadder` (`index mod F^d`), *not* real sha256 addressing, so the depth law is **exact** rather than `±1`. Rationale: it isolates the promotion *law* from prefix-distribution noise, which is separately covered by `topic-addressing.spec` (collision rate) and the real-sha256 `±1` smoke check in `topic-tree.spec`. Trade-off: this validator never exercises real-prefix skew, so it cannot catch a depth-law deviation that only shows up under non-uniform load. A reviewer may want one real-sha256 convergence case (slower, `±1`) added for defense-in-depth — I judged it redundant given the smoke check, but flag it.

2. **Gossip-lagged overshoot model.** The tree promotes *eagerly* on `attach` (overshoot structurally 0). To make overshoot observable, the driver routes arrivals via the new `routeArrival` (no eager promote) and calls `evaluatePromotion` once per round on the *prior* round's counts. Lookahead-off ⇔ `tPromoteLookaheadMs: 0`; lookahead-on ⇔ `= gossipRoundMs` (one-round lookahead → promotes near the cap, not far below it, avoiding premature extra depth). The overshoot magnitude (`< R`) is therefore a function of the chosen ramp model, not a first-principles bound — verify the model faithfully represents the real gossip-lag race before trusting the absolute number.

3. **`convergenceLatency` semantics.** Defined as `max(0, lastDepthChange − peakLoadAt)`; it is frequently **0** because the deepest tier fills (depth stabilizes) at roughly the same round the last load arrives. That's a valid "converged before load peaked" reading but means the metric rarely carries a positive signal in these monotone-ramp scenarios. If a meaningful positive latency is wanted, a burstier load profile (or a defined post-peak settling window) would be needed.

4. **`oscillations` is trivially 0 under monotone load.** It counts observed-depth *decreases*; with arrivals-only (no churn/eviction) there are none. The genuine thrash-resistance proof (load barometer bouncing across `bucket_overload`, `4×` cap gap + `T_demote`) lives in `topic-tree.spec`, not here. This metric validates "depth locks during convergence," nothing stronger. A demotion-driven drain phase would exercise the down direction.

5. **`overCapCount` counts settled promoted-full cohorts.** After a cohort promotes it keeps `~cap+overshoot` participants (existing participants stay), so `overCapCount` stays ≥1 for the rest of the run in the lookahead-off case. It's a literal "coords above cap" count, but note it conflates transient overshoot with settled post-promotion load — `peakOvershoot` (the running max excess) is the cleaner overshoot signal.

6. **Phase 3 sweep hook.** `runConvergence`/`compareLookahead` are exported for `simulator-metrics-and-scenarios` to call across the N sweep, but no integration with that ticket's `MetricsSink` exists yet (it isn't implemented). The tracer is an `EventSink` so it composes via the forwarding `downstream` sink when that lands.
