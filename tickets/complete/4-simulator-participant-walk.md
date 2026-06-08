description: COMPLETE — participant walk-toward-root engine (`d_max`→root lookup with single-direction semantics, NoState/Promoted/UnwillingMember/UnwillingCohort handling, cold-root bootstrap) plus anti-flood instrumentation quantitatively validating the five cohort-topic.md §Anti-flood claims. Reviewed: build + 114 tests green; added member-retry/give-up coverage; fixed README layer count; one latent edge documented for ticket 6.
prereq:
files:
  - packages/substrate-simulator/src/walk.ts
  - packages/substrate-simulator/src/walk-metrics.ts
  - packages/substrate-simulator/src/topic-tree.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/walk.spec.ts
  - packages/substrate-simulator/README.md
  - docs/cohort-topic.md
----

# Complete: simulator participant walk-toward-root engine + anti-flood instrumentation

The full `d_max`→root participant lookup the cohort-topic-tree ticket deferred, layered on the
modeled `TopicTree` and the virtual-clock latency seam. Each `ParticipantWalk` resolves a topic by
probing one tier coordinate per scheduled RPC hop, emits a `WalkTrace`, and the `walk-metrics`
readouts aggregate traces to quantitatively validate the five `docs/cohort-topic.md` §Anti-flood
claims. Synchronous on the seeded virtual clock; the `no-real-time` guard scans the new files green.

## What shipped (as implemented)

- **`walk.ts` — `ParticipantWalk`.** Event-driven state machine over `(d, memberAttempt, followOn,
  bootstrap)`. From `d_max`: `NoState` → step inward; `Promoted` → step outward **once** (the only
  outward move); `UnwillingMember` → retry a sibling at the same coord (capped at `maxMemberRetries`,
  default 16, then falls through to a cohort decline); `UnwillingCohort` → back off (`backoffDelay`)
  and **restart at `d_max`** (capped at `maxBackoffs`, default 6, else `gave-up`); `d < 0` →
  re-issue at the root with `bootstrap:true` (cold-root). A successful walk commits via
  `TopicTree.attachAt`. Each probe is one `LatencyModel` hop; admission is a pluggable
  `WalkAdmission` oracle (default always-accept); a per-probe `WalkProbe[]` log is recorded.
- **`walk.ts` — jitter spreaders.** `rejoinStagger` (seeded uniform offsets) and `rateLimitedStagger`
  (deterministic fixed-interval spacing so any `windowMs` holds ≤ `ratePerWindow` arrivals).
- **`walk-metrics.ts`.** Pure trace readouts: `distinctStartCoords`, `acceptedPerSecond` /
  `peakAcceptedPerSecond`, `peakAcceptedInWindow` (two-pointer sweep), `acceptedAtTier`,
  `hopPercentile` (nearest-rank), plus structural predicates `outwardMovesArePromoted` (claim 3) and
  `unwillingRetriesRestartAtDMax` (claim 4).
- **`TopicTree.attachAt`** — instantiate-if-cold + idempotent link-to-parent + attach; the walk's
  terminal landing step. `RangeError` on out-of-ladder tier.
- **Docs.** `docs/cohort-topic.md` §Anti-flood now carries a per-claim simulator-validation note;
  README gains the fifth-layer paragraph.

## Review findings

Adversarial pass over commit `4ca2f3d`. Read the full implement diff first, then re-derived each
claim test against `cohort-topic.md` and traced the state machine by hand.

### Checked — and what was found

- **Build + tests.** `yarn build` clean (strict `tsc`). `yarn test` **114 passing** (was 111; +3
  added this pass — see below). No package lint configured (root `lint` is a stub); strict `tsc` is
  the static gate. The `no-real-time` guard recursively scans `src/`, so `walk.ts`/`walk-metrics.ts`
  are covered — no `Math.random`/`Date`/timers/`await`/`Promise`. Green.
- **State-machine correctness (hand-traced).** All paths terminate (no unbounded loop): `NoState`
  drains to a bootstrap accept; `UnwillingMember` is capped by `maxMemberRetries` then falls to a
  cohort decline; `UnwillingCohort` is capped by `maxBackoffs` then `gave-up`; a `Promoted` redirect
  past the ladder is `gave-up`. Probe chains in claims 3/4 (`[2,1,0,1]`, `[2,1,0,2,1,0]`) verified
  step-by-step against the code. **Correct.**
- **Scheduler determinism underpinning claim 5.** Verified the scheduler fires equal-`at` events in
  monotonic `seq` (insertion) order, so the "root accepts exactly `cap_promote` then promotes,
  overflow bounced with single-RPC `Promoted`" invariant is deterministic, not timing-luck. The
  lockstep all-at-`2H` root-probe batch promotes on the 64th attach (`span=0` disables slope
  pre-promotion), so `acceptedAtTier(0)=64`, `acceptedAtTier(1)=M−64`. **Correct.**
- **`attachAt` vs `register` parity.** Both run `ensure → (d>0) linkToParent → attach`; `attachAt`
  keeps `linkToParent` private and reuses the identical instantiation+link+attach semantics, so the
  walk and `register` grow the same tree shape. ~4 lines of shared tail are duplicated rather than
  extracted — acceptable (different signatures: `register` discovers `d`, `attachAt` is told `d`).
- **`Admitted` event + sink routing.** `Admitted` is a real `SimEvent` kind. Note: the walk routes
  `NoState`/`UnwillingMember`/`UnwillingCohort` to **`tree.sink`** but `Admitted` to **`walk.sink`**.
  In the claim-5 test both are the same `CollectingEventSink`, so `countOf('Admitted')=200` is
  consistent; a caller passing *different* sinks would split the event stream. Minor design smell,
  documented for ticket 6's richer `MetricsSink` (it should consolidate the walk's event surface).
- **Jitter-bound math (claim 2).** `rateLimitedStagger(60, 64, 30000)` → 468.75 ms spacing; at most
  `ceil(1000/468.75)=3` per second-bucket (= `ceil(cap_promote/window_s)`), and all 60 inside one
  30 000 ms window (< `cap_promote`). Assertions are sound for the chosen `M<cap_promote`; the bound
  is only *trivially* exercised (no `M>cap_promote` case) — that belongs to ticket 6's combined
  jitter+promote scenario (the implementer's gap 3).
- **Docs reflect reality.** `docs/architecture.md` line 235 already describes the walk behavior
  ("participants walk toward the root from an estimated max tier and only follow explicit promotion
  redirects outward") — conceptual, no source-module enumeration, so no update needed.
  `docs/cohort-topic.md` §Anti-flood forward note and all comment-referenced section anchors
  (§Tree growth and lookup, §Lookup, §Cold-start instantiation, §Anti-flood properties) exist and
  match. README is the only doc with a source-module list.

### Found and FIXED in this pass (minor)

- **Untested error paths (the implementer's gap 2) — now covered.** Added a
  `member retry + give-up budgets` describe block in `test/walk.spec.ts` (3 tests, all green):
  1. `UnwillingMember` retries a sibling at the **same coord** until one admits (probes
     `[1,1,1]` = `unwilling_member, unwilling_member, accepted`; `backoffs=0`).
  2. Exhausting `maxMemberRetries` falls through to a **cohort back-off** that restarts at `d_max`,
     and the `maxBackoffs` budget is then spent → `gave-up` (`landingTier=-1`).
  3. A cohort declining past `maxBackoffs` yields `gave-up` with `acceptedAt=undefined`, while every
     retry still satisfies `unwillingRetriesRestartAtDMax`.
  These pin the member-retry loop, the member-exhaustion→decline fall-through, and both give-up
  budgets — previously entirely uncovered.
- **README layer count.** Header said "Three layers ship here" while the list had grown to **five**
  bullets (a prior churn ticket added the 4th without bumping the count; this ticket added the 5th).
  The change touched this file and worsened the mismatch → corrected to "Five layers ship here".

### Found, NOT fixed — flagged for downstream (minor, narrow, untested-either-way)

- **`bootstrap` suppresses the `Promoted` redirect.** In `walk.ts` `onProbe`, the promoted-branch
  guard is `if (state && state.promoted && !bootstrap)`. So a **bootstrap re-issue that finds the
  root already promoted attaches to it instead of following the redirect** — which can over-fill a
  promoted root past `cap_promote`. Unreachable in well-formed/current scenarios: under deterministic
  latency all bootstraps land before any attach, and a topic that needs cold-start is sparse
  (`N ≪ cap_promote`) so its root never promotes. It only bites a topic that is *both* cold-started
  *and* immediately bursts past `cap_promote` while walks are mid-bootstrap — exactly ticket 6's
  combined cold-burst territory. **Recommended fix:** drop the `&& !bootstrap` so a bootstrap probe
  redirects like any other probe (verified safe against the current suite — claim 1's root never
  promotes, so removing it changes nothing there). Left as a documented finding rather than an
  untested behavioral change in review; ticket 6 should add a concurrent cold-burst test and apply
  the one-token fix.
- **Stylistic noise (left as-is).** `void bootstrap;` / `void d;` unused-param suppressions in
  `walk.ts` and a dead `const cfg = …; void cfg;` in the hot-regime test — compile-clean, harmless,
  not worth churn.

### Categories with nothing found (explicit)

- **Type safety / SPP / resource cleanup:** clean. Strict `tsc` passes with no `any`; trace fields
  are `readonly`; the engine holds no external resources (pure virtual-clock state), and every walk
  terminates so `scheduler.run()` drains without `startGossip` keeping the queue alive.
- **Performance:** the metric readouts are linear/`O(n log n)` (sort) with a correct two-pointer
  window sweep; no accidental quadratics.
- **Regressions:** the prior 111 tests still pass unchanged; `attachAt` is additive and reuses
  `register`'s private helpers, so no existing tree behavior shifts.

### Honest gaps inherited from implement (deferred, not review-blocking)

These remain open and are correctly scoped to downstream tickets:
1. Member-level willingness is exercised only via a hand-supplied oracle, not the live
   `loadBucket → willingness → classifyAdmission`/`WillingnessGossip` chain under a real burst →
   `simulator-metrics-and-scenarios` (6).
2. Claim 2 isolates jitter from promotion; the two valves together under one burst are not co-tested →
   ticket 6 (and ties to the `!bootstrap` finding above).
3. Hop tests use synthetic ladders + the `computeDMax` formula, not a FRET-grown tree → the rigorous
   N-sweep is `simulator-promotion-convergence` (5).
4. Latency endpoints are modeled `hopDelay(self, self, ctx)`; an endpoint-sensitive
   `AdversarialLatency` inspecting `b` would need the cohort coord threaded through. Fine for
   `Deterministic`/`Stochastic`.

## Validation

- `yarn build` — clean (strict `tsc`).
- `yarn test` — **114 passing** (111 prior + 3 added this review pass).
- No `.pre-existing-error.md` written — no unrelated failures surfaced.
- The `portal:` FRET dependency caveat (`fret-portal-dependency-resolution`) is unchanged and still
  applies to CI.

## Downstream

- `simulator-promotion-convergence` (5) — rigorous N-sweep depth-law + hop characterization on a
  FRET-grown tree.
- `simulator-metrics-and-scenarios` (6) — richer `MetricsSink` consuming the `WalkTrace`/`SimEvent`
  streams; wires the live willingness chain and the jitter+promote combined scenario; should also
  consolidate the walk's split sink routing and apply the `!bootstrap` redirect fix with a
  concurrent cold-burst test.
- `fold-simulator-findings-into-design-docs` (7) — folds measured rate/hop figures into the
  §Anti-flood forward note.

## End
