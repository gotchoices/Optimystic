description: Reactivity replay-buffer (W) / checkpoint (W_checkpoint) / dedupe coverage model, resume classification, rotation-burst, and coverage-window measurements added to substrate-simulator. Reviewed and completed.
files:
  - packages/substrate-simulator/src/reactivity.ts
  - packages/substrate-simulator/test/reactivity.spec.ts
  - packages/substrate-simulator/src/index.ts
  - docs/reactivity.md
  - tickets/implement/7-fold-simulator-findings-into-design-docs.md
----

# Complete: simulator reactivity replay-buffer & checkpoint coverage model

Adversarial review of the reactivity timing model under `packages/substrate-simulator/src/reactivity.ts`
(replay ring `W=256`, rolling parent checkpoint `W_checkpoint=4096`, sliding dedupe window 64,
resume classification, tail-rotation re-registration burst, coverage-window math). Implement commit
`e65b12f`. Build (`tsc`) and the package test suite (168 specs) are green after the review fixes below.

## What was implemented (carried from implement stage)

- `ReplayRing` — W-entry ring; retires oldest past capacity.
- `RollingCheckpoint` — W_checkpoint-span window sitting immediately below the ring.
- `DedupeWindow` — sliding `(revision, sigDigest)` set, evicted by revision age.
- `CohortPushState` — wires ring + checkpoint + dedupe; `ingest()` → `'forwarded'|'duplicate'`.
- Resume classification (`classifyResume`/`traceResume`/`ResumeKind`) + per-kind RPC/latency cost model.
- Coverage math (`coverageSeconds`/`measureCoverage`/`assessAdaptiveW`).
- `measureRepeatedWakeThrash` (no-thrash check) and `simulateRotationBurst` (re-registration wave).
- Full re-export via `src/index.ts`; doc callout in `docs/reactivity.md §Configuration`.

## Review findings

### Scrutinized
Read the full implement diff (`git show e65b12f`) with fresh eyes before the handoff summary, then
checked `reactivity.ts`, `reactivity.spec.ts`, `index.ts`, and `docs/reactivity.md` against the
`TopicTree`/`promotion-convergence`/`rng` modules they build on. Angles covered: SPP/DRY/modularity
(clean — each state machine is its own class, cost model isolated), type safety (tsc clean), error
handling (RangeError guards on every constructor + `coverageSeconds`/`subscriberCount`, all tested),
resource cleanup (N/A — pure synchronous state machines + a bounded `scheduler.run(T_drain)`),
determinism (rng `fork` seeded, asserted), and the boundary/edge behaviour of every exported function.

### Major — fixed inline (mechanism was untested, not just mislabeled)
- **Rotation-burst test was vacuous: the `cap_promote_fast = 32` fast-promote path was never
  exercised.** `simulateRotationBurst` ran with the default lifecycle, whose slope-based
  pre-promotion (`tPromoteLookaheadMs = 30000`) fires after the *second* arrival under the steep
  re-registration ramp and promotes the root at `directParticipants = 2`. Measured `peakRootDirect`
  was **2**, not the 32 the handoff (note #3) claimed "exactly regardless of jitter." The headline
  assertion `peakRootDirect ≤ cap_promote_fast` therefore passed vacuously (`2 ≤ 32`) and the
  hot-bucket fast-promote the burst exists to validate (reactivity.md §Failure modes: sudden interest
  spike) never engaged.
  **Fix:** disabled slope lookahead in the burst lifecycle (`tPromoteLookaheadMs: 0`, the same
  pattern `runConvergence` uses for its lagged arm), so the root fills to exactly `cap_promote_fast`
  and fast-promotes there. `peakRootDirect` is now `32` for all populations `> 32`. Tightened the test
  from `at.most(cap)` to `equal(cap)` so a re-enabled lookahead (or any sub-cap promotion) is caught
  rather than silently passing. Updated the now-correct docstring. (168 specs still green.)

### Minor — fixed inline
- **`measureRepeatedWakeThrash` off-by-one vs its own comment.** `fromRevision = current - lag + 1`
  yielded a classify-lag of `lag − 1` (254 instead of the intended `W − 1 = 255`), so the no-thrash
  test exercised `W − 2`, one shy of the deepest-Backfill boundary it documents ("fromRevision tracks
  the head minus lag"). Changed to `current - opts.lag`; now tests the true `W − 1` boundary (still
  Backfill, zero transitions — assertions unchanged and passing).

### Major — filed (not fixed here; doc-only, owned by existing ticket)
- **Resume-lag bound is documented two inconsistent ways and the model is internally split.**
  reactivity.md §Failure modes treats the checkpoint as an *absolute* lag bound (`< W_checkpoint` →
  CheckpointWindow), while §Parent checkpoint summaries + the "20 min wake" worked scenario layer the
  checkpoint *below* the ring (recoverable ≈ `W + W_checkpoint`). The simulator's `classifyResume`
  follows the §Failure-modes single-bound form — so its own `RollingCheckpoint.covers` reaches one `W`
  deeper than `classifyResume` will report as in-window. This is the implementer's flagged reviewer
  focus #1, confirmed. Difference (`256` vs `4096+256`) is in the noise of the ratio question the
  model informs, so no code change now; **added an explicit reconciliation checklist item to
  `7-fold-simulator-findings-into-design-docs` (Phase 3)** — the mandated doc-bridge ticket — to pick
  one semantics, make the three doc sections agree, and retune the classifier in a follow-up if the
  layered form wins. Did not file a duplicate ticket since that ticket already owns reactivity §Worked
  scenarios / §Configuration fold-back.

### Acknowledged, no action (correct as designed)
- **`rpcCount`/`latency` are a stipulated per-kind cost model, not measured through the
  `LatencyModel`/scheduler** (handoff note #2). Deliberate; the deterministic per-kind costs are what
  the tests assert. Riding resume traces through the real latency model for RPC-count *distributions*
  is a clean extension point, left open — no defect.
- **`queue_max` backpressure and ring/checkpoint gossip lag are out of scope** (handoff note #4).
  `queue_max` is carried in `ReactivityConfig` but unused; the ring is assumed cohort-converged. The
  drop-oldest → backfill path (reactivity.md §Slow-subscriber backpressure) is genuinely separate
  modeling work — fine to defer, no silent truncation in what *is* modeled.
- **Adaptive-`W` recommended number is a function of the chosen recovery floor** (handoff note #5).
  `assessAdaptiveW` parameterizes `minCoverageSeconds`; the test's `recommendedW = 6000` at 100 cps
  follows from the 60 s floor. The *finding* (fixed `W` too shallow at hot cps) is floor-independent;
  the specific number is correctly presented as floor-dependent. No action.
- **`DedupeWindow` age-based eviction, `RollingCheckpoint` boundary math, ring retirement** — traced
  by hand against the boundary specs; correct (e.g. `evictBelow` parses the revision off the first
  `:`, robust to colons in `sigDigest`; `classifyResume`'s `lag < W` is the correct one-RPC-backfill
  capacity boundary — needs `lag + 1 ≤ W` entries).

### Empty categories
- **Regressions:** none — this is a new, self-contained module; no existing simulator surface changed
  except the additive `index.ts` re-exports (verified the export list compiles and matches the
  module's public symbols).
- **Error-path gaps:** none found — every constructor and the two numeric-domain functions guard
  their inputs with `RangeError` and have negative tests.

## Validation

```
cd packages/substrate-simulator
yarn build   # tsc, green
yarn test    # 168 passing
```
