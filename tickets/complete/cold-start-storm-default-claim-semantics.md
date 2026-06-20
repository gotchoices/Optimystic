description: The simulator's cold-start-storm sanity check was red by design — its convenience entry point ran at a subscriber count where documented overload behavior tripped a failing claim; this lowered the default to a calm rate and reworded the claim to what is actually guaranteed, so the check passes out of the box while the overload case stays explicitly tested. Reviewed and accepted.
files: packages/substrate-simulator/src/scenarios.ts, packages/substrate-simulator/test/scenarios.spec.ts, docs/cohort-topic.md
----

# Cold-start-storm default + `root-not-overloaded` claim semantics (complete)

The implement stage applied the **Both** human decision: lowered `ColdStartStormScenario`'s default
`subscribers` `10_000 → 3_000` (so `runAllScenarios()` is green out of the box) and tightened the
`root-not-overloaded` claim from the loose instantaneous wording `tier-0 accepts ≤ cap_promote` to the
honest cumulative bound `cumulative tier-0 acceptance ≤ cap_promote + one round of arrivals`. New
`arrivalsPerRound = ⌈subscribers · GOSSIP_ROUND_MS / burstWindowMs⌉` field drives the bound. Docs
(`cohort-topic.md` §Anti-flood + §Simulator-scenarios) were resynced. `scenarios.spec.ts` now pins
both regimes (moderate ≤ cap; storm > cap and ≤ cap + one round).

## Review findings

**Scope checked:** the full implement diff (`040b867`) read first with fresh eyes, then the handoff;
`scenarios.ts` (constructor, `aggregate`, `validate`), `scenarios.spec.ts` (both new regime tests +
the shape test), `walk-metrics.ts` (`acceptedAtTier`), `docs/cohort-topic.md` §Anti-flood /
§Promotion / §Simulator-scenarios, `boundary-reference.ts`, and all 67 files referencing
`cold-start` / `root-not-overloaded` for stale consumers.

- **Correctness / semantics — OK.** `acceptedAtTier(traces, 0)` is the cumulative count of walks whose
  `landingTier === 0` over the whole burst, so the comments' "cumulative tier-0 acceptance" reading is
  accurate. The `cap_promote + arrivalsPerRound` bound is *analytically sound* (not coincidental): once
  a cohort hits `cap_promote` and promotes, the `Promoted(d+1)` redirect propagates within one gossip
  round, during which at most `arrivalsPerRound` further arrivals can still attach at tier 0 — so
  cumulative overshoot ≤ `arrivalsPerRound`. `GOSSIP_ROUND_MS = 1000` and `burstWindowMs = 5000` give
  default `arrivalsPerRound = 600` (bound 664) and storm `= 2000` (bound 2064), matching the test's
  literal `64 + 2_000`.
- **Doc cross-reference nuance — checked, acceptable.** The doc calls the cumulative bound "the same
  `peakOvershoot < arrivalsPerRound` bound" as §Promotion. §Promotion's `peakOvershoot` (lines ~615–630)
  is the *instantaneous* per-cohort `directParticipants` excess, whereas `rootDirect` is *cumulative*.
  These are distinct quantities, but both are driven by the identical gossip-lag mechanism and share the
  identical one-round numeric bound, so "the same effect, not a separate one" is defensible, not
  misleading. Left as written.
- **Loose-bound concern (flagged by implementer) — accepted, not vacuous.** The storm claim passes by a
  wide margin (122 ≤ 2064). It is *not* vacuous: it still fails on a total promotion breakdown (root
  accepting >20% of all subscribers directly). The tight, meaningful assertions live in the spec test
  (`> 64` proves the overshoot is real; `≤ 64 + 2000` proves it is bounded), so the regime behavior is
  visible, not hidden. No regime-aware claim rework warranted.
- **No stale / broken consumers.** `runAllScenarios()` is asserted nowhere (no snapshot to update). The
  shared `root-not-overloaded` claim-id in `VotingQuorumScenario` and `boundary-reference.ts` keys off
  their own drivers — unchanged. README `generatePeers(10_000, …)` and the db-p2p
  `cohort-topic-scale-antiflood.spec.ts` `capPromote: 10_000` are unrelated. No leftover
  "root accepts ≤ cap_promote" cold-start wording anywhere in `docs/`.
- **Tests — extended coverage already adequate.** Implementer replaced the single 3,000 test with two
  pinned regimes covering the happy path (moderate == cap), the documented overshoot edge (storm > cap),
  and the bounded-overshoot regression (storm ≤ cap + one round). The shape test (`subscribers: 200`)
  still exercises the default code path. No additional cases needed; no minor fixes applied (the literal
  `64`/`2_000` sentinels in the test are intentional regression pins, not duplication to refactor).
- **Major findings:** none — no new fix/plan/backlog tickets filed.

## Validation performed

- Typecheck: `node_modules/.bin/tsc --noEmit` (TS 5.9.3, the version the package scripts use) → exit 0,
  clean. (`npx tsc` resolving a newer global TS that errors `TS5101 downlevelIteration` is a
  pre-existing tooling quirk unrelated to this ticket, per the implement note — confirmed not
  reproduced with the local binary.)
- Focused: `mocha test/scenarios.spec.ts` → 7 passing (moderate 60 ms, storm 187 ms).
- Full package suite: `mocha "test/**/*.spec.ts"` → **258 passing**, exit 0.
- Lint: not configured (root `lint` is an `echo` no-op; no eslint config in `packages/substrate-simulator`).

## Out of scope (untouched, as intended)

- The gossip-lag overshoot mechanism itself (cohort-topic.md §Promotion) — model unchanged.
- The pre-existing `dMax` field naming (`expectedDepth + 2`, with the `lookup-is-log-cost` claim using
  `dMax + 2`) — not introduced by this ticket; the claim passes in both regimes.
