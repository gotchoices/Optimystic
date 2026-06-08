description: REVIEW — participant walk-toward-root engine (d_max→root lookup with single-direction semantics, NoState/Promoted/UnwillingMember/UnwillingCohort handling, cold-root bootstrap) plus anti-flood instrumentation that quantitatively validates all five cohort-topic.md §Anti-flood claims. Build + 111 tests green; honest gaps flagged below.
prereq:
files:
  - packages/substrate-simulator/src/walk.ts
  - packages/substrate-simulator/src/walk-metrics.ts
  - packages/substrate-simulator/src/topic-tree.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/walk.spec.ts
  - docs/cohort-topic.md
  - packages/substrate-simulator/README.md
----

# Review: simulator participant walk-toward-root engine + anti-flood instrumentation

The full `d_max`→root participant lookup the cohort-topic-tree ticket deferred, layered on the
modeled `TopicTree` and the virtual-clock latency seam. Each `ParticipantWalk` resolves a topic by
probing one tier coordinate per scheduled RPC hop and emits a `WalkTrace`; the `walk-metrics`
readouts aggregate traces to **quantitatively validate the five `docs/cohort-topic.md` §Anti-flood
claims**. Everything is synchronous on the seeded virtual clock — no async, no wall-clock, no
randomness outside the RNG (the `no-real-time` guard scans the new files and is green).

## What shipped

- **`walk.ts` — `ParticipantWalk`.** Event-driven state machine over `(d, memberAttempt, followOn,
  bootstrap)`. From `d_max`: `NoState` → step inward; `Promoted` → step outward **once** (the only
  outward move); `UnwillingMember` → retry a sibling at the same coord (capped at `maxMemberRetries`,
  default 16); `UnwillingCohort` → back off (`backoffDelay`) and **restart at `d_max`** (capped at
  `maxBackoffs`, default 6, else `gave-up`); `d < 0` → re-issue at the root with `bootstrap:true`
  (cold-root). A successful walk commits via the new `TopicTree.attachAt`, so the walk and the tree's
  `register` driver grow an identical tree shape. Each probe is one `LatencyModel` hop, so
  `WalkTrace.latency` is the summed RTT of the probe chain. Admission is a pluggable `WalkAdmission`
  oracle (default always-accept); a per-probe `WalkProbe[]` reply log is recorded for structural
  assertions.
- **`walk.ts` — jitter spreaders.** `rejoinStagger` (uniform-random offsets over `T_rejoin_jitter`,
  seeded) and `rateLimitedStagger` (deterministic fixed-interval spacing so any `windowMs` window
  holds ≤ `ratePerWindow` arrivals by construction).
- **`walk-metrics.ts`.** Pure trace readouts: `distinctStartCoords`, `acceptedPerSecond` /
  `peakAcceptedPerSecond`, `peakAcceptedInWindow` (two-pointer sweep), `acceptedAtTier`,
  `hopPercentile` (nearest-rank), and the two structural predicates `outwardMovesArePromoted`
  (claim 3) and `unwillingRetriesRestartAtDMax` (claim 4).
- **`TopicTree.attachAt`** (new public method) — instantiate-if-cold + link-to-parent (idempotent,
  private `linkToParent` reused) + attach, the walk's terminal landing step. `RangeError` on
  out-of-ladder tier.
- **Docs.** `docs/cohort-topic.md` §Anti-flood properties now carries a per-claim simulator-validation
  forward note (evidence folds back via `fold-simulator-findings-into-design-docs`); README gains the
  fifth-layer paragraph.

## Use cases to validate (tests are a floor — push on these)

The `test/walk.spec.ts` suite (8 tests) is organized one-block-per-claim. Re-derive each against
`cohort-topic.md` rather than trusting the assertions:

- **Claim 1 — sparse fan-out** (real FRET coords, `N=40`, `d_max=4`): distinct `coord_{d_max}` ≈ `N`,
  all land at the root, exactly one cold-root bootstrap. *Adversarial angle:* the lockstep
  `DeterministicLatency` makes all 40 bootstrap concurrently (1 instantiates, 39 find it) — confirm
  the "exactly one cold-root" invariant isn't an artifact of that timing; try `StochasticLatency`.
- **Hop count O(log N)** — two tests: hot regime resolves in 1 RPC (p50=1, p95≤2) across N; cold
  worst case is `d_max + 2` with `d_max = ⌊log_F N⌋ − 1` over N ∈ {100, 1k, 10k, 100k}.
- **Claim 2 — re-registration storm bound:** jittered peak accepted/sec ≤ `⌈cap_promote/T_rejoin_jitter⌉`
  and ≤ `cap_promote` per jitter window; an unstaggered burst spikes the whole set into one second.
- **Claim 5 — promotion-flap cap:** a bursting cohort accepts exactly `cap_promote`, promotes, and
  bounces the overflow (`M − cap_promote`) outward with single-RPC `Promoted`; none starved.
- **Claim 3 / Claim 4** — single-walk structural checks of the probe log (`[2,1,0,1]` outward-only-on-
  Promoted; `[2,1,0,2,1,0]` restart-at-`d_max` after a decline).
- **Determinism** — a 50-walk burst replays byte-identically.

## Honest gaps (not review-blocking; flag for the reviewer / downstream)

1. **Member-level willingness is not wired into the default walk.** `UnwillingMember` /
   `UnwillingCohort` are exercised only via a hand-supplied `WalkAdmission` oracle (claim 4), not the
   live `loadBucket → willingness → classifyAdmission`/`WillingnessGossip` chain under a real burst.
   Wiring that end-to-end is `simulator-metrics-and-scenarios` (6) territory. **Good reviewer
   target:** add a test driving the *real* willingness classifier as the oracle.
2. **`UnwillingMember` sibling-retry and the `maxBackoffs` `gave-up` outcome are implemented but not
   directly tested.** Claim 4 only exercises the `UnwillingCohort` → restart path; the member-retry
   loop and the give-up budget have no dedicated coverage. Low-risk but uncovered.
3. **Claim 2 isolates jitter from promotion** by disabling promotion on that tree (huge `cap_promote`,
   which also disables slope pre-promotion). The two valves *together* (jitter + promote under one
   burst) are not co-tested; claim 5 covers the promote valve separately. A combined scenario belongs
   to ticket 6.
4. **Hop tests use synthetic ladders + the pure `computeDMax` formula, not a FRET-grown tree.** The
   hot 1-hop test pre-seeds each participant's `d_max` cohort as a *1-participant* cohort (models
   "prefix tier exists," correct for hop count, not load-realistic); the cold O(log N) test runs a
   single synthetic walk per N. The rigorous N-sweep against a real grown tree is
   `simulator-promotion-convergence` (5).
5. **Latency endpoints are modeled as `hopDelay(self, self, ctx)`** — the cohort is not a placed peer
   here, so endpoint-sensitive latency strategies see the participant for both `a` and `b`. Fine for
   `Deterministic`/`Stochastic`; an `AdversarialLatency` that inspects `b` would need the cohort coord
   threaded through.
6. **A `Promoted` redirect beyond the prebuilt ladder yields `gave-up`.** `d_max` bounds tree depth so
   this should not fire in well-formed scenarios; surfaced rather than guessed. Confirm no scenario the
   walk is used in can legitimately exceed the ladder.

## Validation

- `yarn build` — clean (strict `tsc`; no `any`, ES modules, tabs).
- `yarn test` — **111 passing** (103 prior + 8 added). No lint configured for this package (root
  `lint` is a stub); strict `tsc` is the static gate.
- No `.pre-existing-error.md` written — no unrelated failures surfaced.
- The `portal:` FRET dependency caveat (`fret-portal-dependency-resolution`) is unchanged and still
  applies to CI.

## Downstream

- `simulator-promotion-convergence` (5) — rigorous N-sweep depth-law + hop characterization on a
  FRET-grown tree.
- `simulator-metrics-and-scenarios` (6) — richer `MetricsSink` consuming the `WalkTrace`/`SimEvent`
  streams; wires the live willingness chain and the jitter+promote combined scenario (gaps 1–3).
- `fold-simulator-findings-into-design-docs` (7) — folds measured rate/hop figures into the §Anti-flood
  forward note.
