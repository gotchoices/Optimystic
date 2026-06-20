description: Reconsider the cold-start-storm scenario's default subscriber count (10,000) and the `root-not-overloaded` claim semantics — at the default, `runAllScenarios()` returns a failing `ClaimReport` for expected gossip-lag overshoot behavior, which is confusing for any caller using it as a sanity gate.
files: packages/substrate-simulator/src/scenarios.ts, packages/substrate-simulator/test/scenarios.spec.ts, docs/cohort-topic.md
----

# Cold-start-storm default makes `runAllScenarios()` red by design

## Observation

`ColdStartStormScenario` defaults to `subscribers = 10_000` (`scenarios.ts`). Its
`root-not-overloaded` claim asserts **cumulative tier-0 acceptance ≤ `cap_promote` (64)**. At
10,000 subscribers over a 5 s burst (~2,000/s) the cumulative tier-0 acceptance reaches **122
(~2× `cap_promote`)** — the same gossip-lag overshoot quantified in cohort-topic.md §Promotion and
§Anti-flood — so the claim evaluates **false**.

The committed `scenarios.spec.ts` sidesteps this by constructing the scenario with
`subscribers: 3_000` (where cumulative acceptance stays ≤ 64, claim passes). But the *default-arg*
path — `runAllScenarios()`, the public convenience entry point — runs at 10,000 and therefore
returns a `ClaimReport` with a red `root-not-overloaded` claim out of the box.

This was surfaced and documented honestly during `fold-simulator-findings-into-design-docs` (the doc
states the 122 overshoot and that it is gossip-lag, not a regression) but deliberately left as a
judgment call. It is **not a docs bug and not introduced by the docs fold-back** — it is a property
of the scenario's default + claim wording inherited from `simulator-metrics-and-scenarios`.

## Why it matters

A future caller (e.g. an e2e or CI sanity gate) that runs `runAllScenarios()` and asserts
`allClaimsPass` will fail on expected, documented behavior. The claim is also semantically loose: it
says "tier-0 accepts ≤ `cap_promote`" but measures the **cumulative** acceptance, which is bounded by
`cap_promote` only at moderate arrival rates — not an instantaneous ceiling under a storm.

## Decision needed (pick one, document the rationale)

- **Lower the default** `subscribers` to a rate where cumulative tier-0 acceptance stays ≤ `cap_promote`
  (≤ ~3,000 over 5 s), keeping `runAllScenarios()` green by default and pushing the high-rate overshoot
  into an explicit opt-in case; **or**
- **Reword / re-scope the claim** to what is actually bounded — e.g. assert cumulative tier-0 acceptance
  `≤ cap_promote + one_round_of_arrivals` (the documented `< arrivalsPerRound` overshoot bound), or
  split into a moderate-rate claim (≤ cap) and a storm-rate claim (≤ cap + overshoot); **or**
- **Both** — lower the default *and* tighten the claim wording.

Whichever is chosen, keep cohort-topic.md §Anti-flood in sync (it currently records the 122 figure
as the honest caveat) and keep a pinned test for both the moderate-rate (≤ cap) and storm-rate
(overshoot) regimes so the behavior stays visible rather than silently passing.

** Human Decision: **: Both

## Out of scope

- The gossip-lag overshoot mechanism itself (correct and intended; see §Promotion and demotion
  lifecycle). This is purely about the scenario *default* and *claim semantics*, not the model.
