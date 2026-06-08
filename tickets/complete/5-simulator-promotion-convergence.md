description: COMPLETE — promotion-depth tracer + convergence validator (depth-law sweep, bounded-overshoot, lookahead comparison, hysteresis-lock metrics over a gossip-lagged growth model). Reviewed: build + 147 tests green; +6 tests (input-validation, sparse/N=0 guards, boundary characterization); removed a dead import; corrected an overstated "depth is exactly ⌈log_F⌉" comment after the model was shown to diverge ±1 from the law at the cap·F^k boundaries.
prereq: simulator-cohort-topic-tree, simulator-participant-walk
files:
  - packages/substrate-simulator/src/promotion-convergence.ts
  - packages/substrate-simulator/src/topic-tree.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/promotion-convergence.spec.ts
  - docs/cohort-topic.md
----

# Complete: simulator promotion-depth tracer and convergence validator

Validates the central cohort-topic scaling claim — a topic's tree settles at steady-state depth
`⌈log_F(N / cap_promote)⌉` — and quantifies the *quality* of that convergence (promotion-window
overshoot, convergence latency, depth oscillations) over a gossip-lagged growth model. Builds on
`topic-tree.ts` (promotion/demotion lifecycle) and the virtual-clock scheduler.

## What shipped (as implemented)

- **`promotion-convergence.ts`** — `DepthSample` / `ConvergenceResult` interfaces; `expectedDepth`
  (the closed-form law oracle, clamped to 0 in the sparse regime); `sampleDepth` (snapshot
  `maxDepth`/`coordCount`/`overCapCount` from live cohort state); `PromotionTracer implements
  EventSink` (samples on every `Promoted`/`Demoted` event plus once per gossip round, tracks running
  `peakOvershoot`, derives the `ConvergenceResult`); `uniformLadder` (idealized-uniform prefix-shard
  ladder, `bucket = index mod F^d`, nesting correctly); `runConvergence` (the gossip-lagged growth
  driver + validator) and `compareLookahead` (lookahead on/off arms).
- **`topic-tree.ts`** — extracted shared `walkToLanding` + `instantiateAndLink` private helpers
  (now used by `register`/`attachAt`/`routeArrival`, identical tree shape); added public
  `routeArrival` (root-outward walk + count bump *without* eager promotion, so the driver can defer
  the promotion decision to the gossip tick — the lag that makes overshoot observable). `register`
  and `attachAt` behaviour unchanged (existing `topic-tree.spec` still green).
- **`index.ts`** — re-exports the new surface.
- **`docs/cohort-topic.md`** §Tree growth and lookup — simulator-validation forward note (numbers
  fold via `fold-simulator-findings-into-design-docs`).

## How to validate

```
cd packages/substrate-simulator && yarn build && yarn test
```

`yarn build` green; `yarn test` → **147 passing** (13 in `promotion-convergence.spec.ts`).

## Review findings

Adversarial pass over the implement diff (commit `9e019c1`). Read the diff with fresh eyes before
the handoff summary, then scrutinized for correctness, the depth-law convergence behaviour across
the full N range (not just the sweep points), DRY/modularity of the `topic-tree` refactor, type
safety, resource cleanup, and doc/comment accuracy. Lint: no lint step is configured for this
package; `tsc` (strict) **is** the type-check gate and is green.

**Checked — and OK:**
- *`topic-tree.ts` refactor.* `walkToLanding` + `instantiateAndLink` are a faithful extraction;
  `register`/`attachAt` reduce to the same instantiate→link→attach sequence as before, and
  `routeArrival` is exactly `attach` minus `evaluatePromotion`. Idempotent linking via
  `linkedToParent` holds. No behaviour change — confirmed by the unchanged `topic-tree.spec`.
- *Mutually-referential tracer/sink cycle.* `let tracer; const sink = { record: e => tracer.record(e) }`
  is safe: events fire only inside `scheduler.run()`, after `tracer` is assigned.
- *`uniformLadder` coord packing.* Distinct `(d, bucket)` ⇒ distinct coord; nesting
  (`bucket_d mod F^(d-1) = bucket_{d-1}`) is correct since `F^(d-1) | F^d`. Bucket-field overflow is
  guarded.
- *Bounded-overshoot / lookahead claims.* Verified the mechanism by hand: lookahead-off, the root
  caps at `⌈cap/R⌉·R` (overshoot `< R`); lookahead-on (window = one gossip round) pre-promotes one
  round early so the root never exceeds the cap (overshoot 0). Tests assert both.
- *Resource cleanup / unbounded loops.* `totalRounds` is finite; the driver does not start the
  tree's recurring gossip tick, so `scheduler.run()` drains cleanly.

**Found & fixed inline (minor):**
1. **Dead import.** `bytesToHex` was imported in `promotion-convergence.ts` but never used (slipped
   through because `noUnusedLocals` is off in this package's tsconfig). Removed.
2. **Overstated comment.** The `uniformLadder` doc claimed idealized-uniform sharding makes "the
   steady-state depth **exactly** `⌈log_F(N/cap_promote)⌉`." This is false: probing N values off the
   sweep shows the *model* and the *closed-form law* diverge by ±1 near the `N = cap·F^k`
   boundaries — and that divergence is **not** prefix-distribution noise (which uniform sharding does
   remove). Two distinct causes, now documented in the comment and pinned by tests:
   - At `N ≈ cap_promote` (e.g. N = 64), slope-based **lookahead pre-promotes a still-ramping root**,
     giving observed depth 1 where the law clamps to 0 (lookahead-off correctly stays at 0).
   - At `N = cap·F + 1` (1025), the law rounds up to 2, but **promoted ancestors retain their
     participants**, so `cap·F` participants already fit across the F tier-1 cohorts (plus the
     retained root) and the tree settles at depth 1 — the model is *tighter* than the law.
   Rewrote the comment to say observed depth *tracks* the law without sharding skew, while noting the
   law is itself a ±1 approximation at those boundaries.

**Test coverage added (+6 tests, all green):**
- `uniformLadder` input validation — negative/non-integer `index` and `dMax`, non-power-of-two `F`,
  and `F^dMax` bucket-field overflow (previously zero coverage on these error paths); `dMax = 0`
  root-only ladder accepted.
- `runConvergence` guards — negative / non-integer `N` throw; `N = 0` yields an empty depth-0,
  overshoot-free, oscillation-free run.
- Sparse regime — `N ∈ {1, cap−1, cap}` with lookahead off stays at the root (depth 0), the faithful
  structural measure.
- Boundary characterization — pins the two ±1 divergences above so they stay *visible* (a passing,
  documented edge) rather than silently lurking just outside the sweep's cherry-picked N values.

**Noted — not actioned (no ticket filed; these are documented modeling decisions, not defects):**
- *Idealized-uniform sharding vs real sha256.* The validator isolates the promotion *law* from
  prefix skew by design; real-prefix `±1` behaviour is covered by `topic-addressing.spec` and the
  sha256 smoke check in `topic-tree.spec`. A real-sha256 convergence case remains optional
  defence-in-depth, as the implementer flagged.
- *The law is a ±1 approximation even under perfect sharding* (the boundary finding above). This is a
  genuine, useful observation about the *design's* closed-form depth claim — the law ignores
  promoted-ancestor retention. It is now characterized and tested; if the design docs want the
  refined statement, it can ride the existing `fold-simulator-findings-into-design-docs` hook. Not a
  code defect, so no fix ticket.
- *`convergenceLatency` is frequently 0* and *`oscillations` is trivially 0* under the monotone
  arrivals-only ramp (no churn/eviction/demotion drain). The down-direction thrash-resistance proof
  lives in `topic-tree.spec`; a burstier or demotion-driven profile would give these metrics positive
  signal. The implementer documented both; they are real limitations of the scenario, not bugs.
- *`overCapCount` conflates transient overshoot with settled post-promotion load*; `peakOvershoot`
  (running max excess) is the clean overshoot signal and is what the assertions use.
- *Minor perf:* `PromotionTracer.sample` scans `tree.all()` twice per sample (once via `sampleDepth`,
  once for `peakExcess`), each allocating a fresh array. Acceptable for a synchronous simulator at the
  sweep sizes (100k N completes in ~1s); left as-is to avoid churn.
- *Phase-3 sweep hook.* `runConvergence`/`compareLookahead` are exported for
  `simulator-metrics-and-scenarios`; the `MetricsSink` integration lands with that ticket (the tracer
  composes via its forwarding `downstream` sink).
