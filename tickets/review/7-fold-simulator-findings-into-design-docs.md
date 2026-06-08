description: Review the fold-back of simulator-measured results into cohort-topic.md, reactivity.md, matchmaking.md, and architecture.md — every quantitative claim is now confirmed-with-evidence or explicitly revised. Docs-only; verify the numbers against the simulator and the honesty of the revised/caveated claims.
prereq: simulator-metrics-and-scenarios
files: docs/cohort-topic.md, docs/reactivity.md, docs/matchmaking.md, docs/architecture.md, packages/substrate-simulator/src/scenarios.ts, packages/substrate-simulator/src/sweep.ts, packages/substrate-simulator/src/reactivity.ts, packages/substrate-simulator/src/promotion-convergence.ts, packages/substrate-simulator/src/matchmaking.ts, tickets/fix/reactivity-resume-classifier-layered-bound.md
----

# Fold simulator findings into design docs — review handoff

Docs-only change. The simulator phase is complete (`simulator-metrics-and-scenarios`, reviewed);
this ticket folded its measured results back into the three design docs and flipped the architecture
Doc Sync Status. No code changed in this ticket. One follow-up **fix** ticket was filed (see below).

## How the evidence was obtained (reproduce this)

The simulator emits its reports **at runtime** — there are no checked-in JSON/CSV artifacts. The
numbers in the docs were produced by running the package's own entry points against the committed
model code (build + suite green at **195 passing**). To reproduce, run a throwaway script through the
package's ts-node loader (`node --import ./register.mjs <script>.mts`) calling:

- `runAllScenarios()` — the five `ClaimReport`s
- `runScaleSweep({ Ns: [100, 1_000, 10_000, 100_000, 1_000_000] })` — depth law + overshoot incl. 1M
- `runSensitivitySweep()` — one-knob-at-a-time effect rows
- `compareLookahead({ N, arrivalsPerRound: 64 })` — lookahead on/off overshoot
- `measureCoverage(cps)` / `assessAdaptiveW(cps, 60)` — reactivity coverage + adaptive-W
- `classifyResume` / `traceResume` — resume RPC counts/latency
- `expectedNewMatches` / `contentionFactor` / `decideHangOut` — matchmaking traces

(The committed `test/*.spec.ts` assert the same model behavior; e.g. `scenarios.spec.ts` runs
cold-start at 3,000 subscribers, `topic-addressing.spec.ts` records the coord_d collision count.)

## Headline measured numbers folded in (validate these)

- **Depth law** `⌈log_F(N/cap_promote)⌉` exact at N ∈ {100,1k,10k,100k,1M} → depth 1,1,2,3,4;
  **0 oscillations**; **convergence latency 0** (depth stabilizes within the load ramp on the virtual
  clock — see "watch-outs").
- **Promotion overshoot** `< arrivalsPerRound`: peakOvershoot 0,0,36,436,4936 under the `⌈N/200⌉`
  ramp. `T_promote_lookahead` removes overshoot only when the per-round increment ≈ `cap_promote`
  (compareLookahead at arrivalsPerRound=64 → 0 both ways); under a steep storm it does not.
- **coord_d collision rate**: 0 over 1,536 coords (64 positions × 4 topics × tiers 0–5).
- **cold-start storm**: walks fan to distinct start coords (= N), promotion fires, max hops = d_max+2
  (=6 in storm), 0 give-ups. Cumulative tier-0 acceptance ≤ cap_promote only at moderate arrival rate
  (≤ 64 at 3,000/5s; **reaches 122 ≈ 2× cap at 10,000/5s** — the same gossip-lag overshoot, stated
  honestly in §Anti-flood).
- **tail-rotation burst**: peak new-tail root = `cap_promote_fast` = 32; last arrival 29,995 ms ≤
  `T_drain` = 60 s; 1,000-revision stream monotone & gap-free.
- **Reactivity coverage** (coverageSeconds): W=256 → 256 s @1cps / 25.6 s @10cps / 2.56 s @100cps;
  W_checkpoint=4096 → 4096 s @1cps. **W+W_checkpoint = 4352** revisions recoverable in 1 RPC.
  **Adaptive-W: REVISED guidance** — fixed W=256 drops below a 60 s floor at ≥10 cps (recommend W≈600
  @10cps, ≈6000 @100cps); keep 256 as the low-rate default, make W per-collection-adaptive on hot
  collections. Default value unchanged; downstream `reactivity-backfill-resume-checkpoints` must treat
  W as computed, not constant.
- **Resume layered semantics: REVISED/clarified** — checkpoint stacks *below* the replay ring
  (`[ringLow − W_checkpoint, ringLow − 1]`), so the in-window bounds are `lag<W` → Backfill,
  `W ≤ lag < W+W_checkpoint` → CheckpointWindow, else OutOfWindow. Resume RPC/latency: Backfill /
  CheckpointWindow = 1 RPC ≈ 100 ms, OutOfWindow = 2 RPC ≈ 500 ms, TailRotated = 3 RPC ≈ 300 ms.
- **contention_factor_cap = 4.0 — confirmed, kept global**: on a thin hot-queried tier the uncapped
  factor is 31 (threshold 93, would pin every seeker to the root); capped → factor 4, threshold 12.
  Sensitivity thresholds 3/6/12/24 for cap 1/2/4/8. Per-tier split buys nothing (refinement only
  flips decisions in the un-capped regime).
- **Hang-out worked example confirmed to 2 d.p.**: expectedNewMatches=15.00, contentionFactor=1.13,
  threshold=9.07 → hang out.
- **Back-off** (DEFAULT_BACKOFF_CONFIG): base=1s, factor=2, cap=60s — O(log(window/base)) rejections.
- **All other cohort-topic defaults** (F=16, cap_promote=64, cap_promote_fast=32, T_demote=5min,
  d_max_cap=60) confirmed unchanged with measured bases.

## What changed in each doc

- **cohort-topic.md** — §Tier addressing (collision rate), §Why this distributes naturally + §Promotion
  and demotion lifecycle (convergence/overshoot, lookahead caveat), §Anti-flood (per-claim measured
  evidence + lookup-cost + the 122 overshoot caveat), §Willingness (settled back-off params),
  §Recovery time bounds (churn-recovery numbers), §Configuration ("Defaults validated by simulator"
  callout). All forward-pointers to this ticket converted to recorded evidence.
- **reactivity.md** — §Parent checkpoint summaries (authoritative layered semantics, W+W_checkpoint),
  §Failure modes "wakes after long sleep" (stacked bounds), §Configuration (validated callout +
  adaptive-W revision), §Worked scenarios (measured RPC/latency on 90 s / 20 min wake; tail-rotation
  burst numbers).
- **matchmaking.md** — §Hang-out (worked trace + contention_factor_cap justification, global-vs-tier),
  §Configuration (validated callout), §Worked scenarios (adversarial bounds + confirmations on the
  three examples).
- **architecture.md** — Doc Sync Status "Simulator validation" flipped to `done` for all three
  subsystems.

## Watch-outs for the reviewer (treat my work as a floor)

1. **`runAllScenarios()` cold-start FAILS by default.** It uses the 10,000-subscriber default, whose
   cumulative tier-0 acceptance is 122 > cap_promote=64 → a red `root-not-overloaded` claim. This is
   **not a regression** — the committed `scenarios.spec.ts` runs cold-start at 3,000 (passes), and the
   overshoot is exactly the documented gossip-lag effect. If you reproduce via `runAllScenarios`,
   expect that one red claim. Verify the doc states this honestly (it does, in §Anti-flood) and decide
   whether the scenario's *default* should be lowered or the claim reworded to "cumulative ≤ cap at
   moderate arrival rate" — judgment call, flagged not fixed.
2. **`convergenceLatency = 0` everywhere.** This is a property of the convergence model (depth's last
   change coincides with/precedes peak load on the virtual clock), not a claim that real convergence is
   instantaneous. I described it as "stabilizes within the load ramp." Sanity-check that framing reads
   honestly to you.
3. **Resume classifier inconsistency is documented but NOT fixed in code.** The doc is now
   authoritative on the layered bound (`lag < W + W_checkpoint`); the simulator's `classifyResume`
   still uses the single bound (`lag < W_checkpoint`), one W shallower than its own
   `RollingCheckpoint.covers`. Filed as **`tickets/fix/reactivity-resume-classifier-layered-bound.md`**
   (a minor, well-scoped 1-line + test change). Confirm the doc/code split is called out clearly in
   both reactivity.md and the fix ticket.
4. **Back-off params** were taken from `DEFAULT_BACKOFF_CONFIG` constants + the churn scenario
   exercising the gate, not a dedicated back-off-curve measurement run. If you want a measured curve,
   `backoff.ts` `backoffDelay` is pure and trivial to sweep — optional.
5. **d_max = ⌊log_F(n_est)⌋−1 / confidence_min clamp** note (cohort-topic §Maximum useful depth) was
   left as a structural FRET-model validation note (size-model wraps FRET's estimateSizeAndConfidence);
   I did not re-run the n_est sweep. No numeric claim was changed there. Confirm that's acceptable.
6. **Sensitivity sweep validates relationships, not absolute targets** (per the prior review). The
   absolute numbers I folded come from the scale sweep, scenarios, and the pure coverage/decision
   functions — not the monotonicity-only sensitivity rows. The sensitivity rows are cited only for
   directional/threshold evidence.

## Done-when (all met)

- Every quantitative claim in the three docs is confirmed-with-evidence or explicitly revised
  (adaptive-W; resume layered bound).
- Changed defaults are unambiguous for downstream tickets: **no default *value* changed**; the two
  *guidance* revisions (adaptive-W; layered resume bound) are stated with the corrected behavior so
  `reactivity-backfill-resume-checkpoints`, `cohort-topic-wire-formats`,
  `cohort-topic-tier-addressing-dmax` build to them.
- architecture.md Doc Sync Status shows simulator validation `done` for all three subsystems.
- No build/test impact (docs-only). Simulator suite remains green (195 passing) — unchanged by this
  ticket.
