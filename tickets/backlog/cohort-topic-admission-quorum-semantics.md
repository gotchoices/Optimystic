description: Pin the cohort admission-quorum semantics (how many willing members the willingness check requires before a cohort takes on a tier) — currently a code default of strict-majority that no doc pins.
prereq:
files:
  - packages/db-core/src/cohort-topic/willingness.ts (WillingnessConfig.quorum, defaultQuorum, GossipWillingnessCheck.evaluate)
  - packages/db-core/test/cohort-topic/willingness.spec.ts
  - docs/cohort-topic.md (§Tier ladder L221, §Promotion/§Demotion "for a quorum of members", §Configuration table, §Wire formats minSigs note L703)
  - packages/substrate-simulator/src/willingness.ts (classifyAdmission takes `quorum` as a free parameter)
----

# Decide the cohort admission-quorum number

## Context

`createWillingnessCheck` (db-core `willingness.ts`) gates admission with a **quorum**: when fewer
than `quorum` cohort members are willing to serve a tier, the routed member returns
`UnwillingCohort` (back off in time) instead of `UnwillingMember` (retry a sibling). The quorum count
is `gossiped-willing siblings + (self live-willing)`.

`docs/cohort-topic.md` repeatedly says "**a quorum** of members willing" (§Tier ladder L221,
§Promotion L476, §Demotion L487, §Registration acceptance L501) but **pins no number**. The 9.3
implement ticket therefore *invented* a default of **strict majority** `⌊k/2⌋ + 1` (= 9 for k=16),
exposed as `WillingnessConfig.quorum` and `defaultQuorum(cohortSize)`. The simulator's
`classifyAdmission` takes `quorum` as a free parameter, so it never pinned a value either.

This is a substantive policy decision, not a bug — the code is correct and configurable — but it is
currently unresolved and lives only as a code default plus a review note. It needs a human/design
decision before the integration ticket (`cohort-topic-core-module-fret-integration`) and the
reactivity Edge/Core policy/config ticket (`reactivity-rotation-backpressure-policy`) wire a concrete
value into the running cohort.

## The question

What is the admission quorum, and is it the same quantity as the cohort threshold-signature
threshold?

- The substrate already defines `minSigs = k − x = 14` (§Configuration / §Wire formats L703), but
  that is explicitly scoped to **promotion/demotion threshold *signatures*** — Byzantine-safe signing
  of state transitions. Admission willingness ("can the cohort collectively serve this tier right
  now?") is a different concern and need not share the number.
- **Strict majority (9/16)** — the current default. Cheaper to satisfy; a cohort keeps serving a
  tier as long as a bare majority is willing. Risk: a tier may be "accepted" by the cohort while up
  to 7 members are shedding it, concentrating load.
- **`k − x = 14`** — aligns admission with the signing threshold; a tier is only taken on when nearly
  the whole cohort is willing. Risk: under modest heterogeneity (e.g. a few Edge members that can't
  serve T2/T3) the cohort flips to `UnwillingCohort` and participants back off in time even though
  10+ members would happily serve.
- **Some other fraction** (e.g. a configurable ratio per tier — T0 high, T3 low).

## Expected outcome

- A decided default (and whether it varies per tier or per Edge/Core mix), recorded in
  `docs/cohort-topic.md` (§Tier ladder + §Configuration table) as a pinned value with rationale.
- Confirmation of whether `WillingnessConfig.quorum` should default from `cohortSize` (as today) or
  from the same `k − x` source as `minSigs`.
- If the decision changes the default, update `defaultQuorum` and the willingness specs accordingly.

## Notes

- No code change is *required* to unblock downstream wiring — callers can pass an explicit
  `config.quorum`. This ticket exists so the default isn't silently inherited from an invented value.
