description: COMPLETE — simulator matchmaking hang-out-vs-continue decision engine + seeker-path tracer. Pure decision math (expectedNewMatches/contentionFactor with the contention_factor_cap clamp + four edge cases), a SeekerWalk over a modeled per-tier provider population (registration on ParticipantWalk + requery_interval_ms hang-out poll + walk-toward-root escalation), adversarial under/over-report bounds, and a measure-only refinement signal for fold-back. Build green; 134 tests pass (133 from implement + 1 review-added).
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

# Complete: simulator matchmaking hang-out-vs-continue + seeker-path tracer

The modeled mirror of `docs/matchmaking.md` §Hang-out vs. continue, layered on
`simulator-cohort-topic-tree` (`TopicTrafficV1`) and `simulator-participant-walk` (`ParticipantWalk`
for the registration leg). Synchronous on the seeded virtual clock — the `no-real-time` guard scans
the new src files green.

## What shipped

- **`matchmaking.ts` — pure decision engine.** `expectedNewMatches`, `contentionFactor` with the
  `contention_factor_cap = 4.0` clamp, and `decideHangOut(traffic, currentMatches, demand, config)`
  → `'matched' | 'hang-out' | 'escalate'` plus the terms that produced it. Four edge cases: missing
  traffic (conservative escalate, immediate-match check still fires), stale `arrivalsPerMin = 0`
  (query first, no over-reaction), pathological filter (`filterAcceptRatio → 0` collapses the
  estimate), and `filterAcceptRatio` decay via `FilterAcceptEstimator` (cumulative
  `Σ matchable / Σ returned`, seeded at 1.0). `CapabilityFilter` / `matchesFilter` / `countMatchable`
  model the §Capability filter. `DEFAULT_MATCHMAKING_CONFIG` carries the §Configuration defaults.
- **`seeker-walk.ts` — `SeekerWalk` + `TierProviderModel`.** Registration via `ParticipantWalk`
  (lands at a tier), then query → decision → hang out (re-query every `requery_interval_ms`) or
  escalate (one tier toward root, one modeled hop). Emits a `SeekerTrace`. `TierProviderModel` holds
  a per-tier modeled population (standing pool + deterministic fresh-arrival stream + a
  `truthfulTraffic` snapshot) with a pluggable `TrafficReporter` for honest / adversarial / absent
  reporting.
- **`refinement-signal.ts`.** `patienceSplittingWouldHelp` / `seekerPoolContentionWouldFlip` /
  `measureRefinementSignal` — **measure only**, recorded for fold-back; the refinements themselves
  are not implemented.
- **Docs.** `docs/matchmaking.md` §Worked example and §Adversarial cohort traffic reporting carry a
  simulator-validation forward note; README gains the sixth-layer paragraph.

## Validation

```
cd packages/substrate-simulator
yarn build      # tsc, strict, clean
yarn test       # 134 passing
```

## Review findings

**Scope reviewed.** Read the full implement-stage diff (`c56800f`) fresh against the original
implement ticket spec before reading the handoff summary. Re-derived the decision arithmetic, traced
every `SeekerWalk` state-machine path (registration → query → hang-out → escalate → finish) for
termination and double-count safety, audited resource cleanup (`done` guard on every scheduled
callback), type safety (no `any`; `yarn build` strict-clean), and confirmed `docs/matchmaking.md` +
`README.md` reflect the shipped behavior. Ran `yarn build` (green) and `yarn test` (green).

**Correctness — checked, no defects found.**
- Worked-example arithmetic reproduces exactly (`expectedNewMatches = 15`, `contentionFactor ≈
  1.1333`, threshold ≈ 9.07, hang-out). Edge cases (no-traffic, stale-zero, pathological filter,
  ratio decay) behave as the doc specifies.
- The walk always terminates: escalation is monotone toward the root, hang-out is bounded by the
  per-tier patience budget, and at the root an `escalate` decision degrades to a bounded final
  hang-out → partial. Verified by re-tracing the cold-walk, borderline, and both adversarial
  scenarios by hand against the asserted trace fields; all matched.
- Adversarial bounds hold as claimed: under-report → +1 register hop per under-reported tier (still
  terminates at the root); over-report → ≤ `patienceMs` of wasted drain, no spatial flood.
- No stray scheduled events survive `finish()` — every callback early-returns on `this.done`.

**Tests — one gap found and fixed inline (minor).**
- The `TrafficReporter` type advertises returning `undefined` to model the "`topicTraffic` absent on
  the reply" case (matchmaking.md §Edge cases item 1), but no `SeekerWalk`-level test exercised that
  path — only the pure `decideHangOut(undefined, …)` unit. **Added** an integration test
  (`absent topicTraffic on the reply …`) driving a reporter that returns `undefined` at every tier:
  the seeker escalates conservatively through the thin upper tiers (2 escalations, 3 tiers visited,
  0 requeries) yet still resolves at the root because the immediate-match check runs without a rate
  signal. Test count 133 → 134, all green.

**Observations — checked, no action taken (documented or out-of-scope).**
- `patienceDefaultMs`, `pushSafetyPollMs`, `seekerTtlMs` in `MatchmakingConfig` are carried as
  config-surface documentation (mirroring matchmaking.md §Configuration) but never read. The latter
  two belong to the push path, which the implement handoff explicitly scoped out (gap #5). Harmless;
  left as-is to keep the config surface aligned with the doc.
- The 100-seeker "fairness at scale" test runs 100 *independent* worlds sharing only a stateless
  provider model, so it asserts the capped-contention scenario 100× rather than demonstrating an
  emergent storm under shared contention. This is honestly disclosed as implement gap #2 and the
  closed-loop version is a noted downstream improvement — not a regression, no ticket filed.
- `patience_per_tier_fraction < 1.0` wires an escalate-after-hang-out branch in `onHangOutDrained`
  that is dead under the default 1.0. This is precisely the deferred
  `matchmaking-per-tier-patience-splitting` backlog ticket (gap #6); intentionally inactive here.
- Registration give-up (`landingTier < 0`) produces a terminal trace with `startTier = -1` /
  `finalTier = 0` / empty result. Semantically "never landed"; the `finalTier = 0` is a cosmetic
  artifact of `Math.max(0, -1)`, not a correctness issue. Left as-is (untested edge, low value).

**Major findings:** none. No new fix/plan/backlog tickets filed.

**Docs:** verified accurate. The matchmaking.md forward notes and README sixth-layer paragraph
correctly describe assertions that exist in the suite (worked example, §Test-expectations cases,
`contention_factor_cap` fairness, adversarial bounds, measured refinement signal).

## Refinement signal (recorded for fold-simulator-findings-into-design-docs)

Per the ticket, the deferred refinements were **measured, not implemented**. On the hand-built
borderline scenario both `patienceSplittingWouldHelp` and `seekerPoolContentionWouldHelp` come back
**true** (a deep-tier hang-out drained to partial while the root held `wantCount`; and the exact
`Σ wantCount` flips the borderline hang-out decision vs. the `meanWantCount × queriesPerMin`
approximation). This is a signal on a single scenario, not a population sweep — the fold-back ticket
(`fold-simulator-findings-into-design-docs`, `implement/7`) should decide whether it is strong enough
to promote either backlog refinement.

## Downstream

- `fold-simulator-findings-into-design-docs` (`implement/7`) — fold the measured figures into the
  matchmaking.md forward notes (currently prose-only) and weigh the refinement signal.
- `matchmaking-per-tier-patience-splitting`, `matchmaking-contention-from-seeker-pool` (`backlog/`) —
  the measured refinements; promote only if the fold-back ticket judges the signal material. A
  stronger, closed-loop fairness test (seekers feeding `recordQuery` into a shared cohort traffic
  signal) and the push-path model (`pushOnArrival` / coalescing / safety-poll) are natural follow-ons
  that were out of scope here.

## End
