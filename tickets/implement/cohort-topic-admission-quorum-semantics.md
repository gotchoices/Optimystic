description: Pin the decided cohort admission-quorum default — strict majority ⌊k/2⌋+1, configurable — in docs/cohort-topic.md; the code already implements it.
prereq:
files:
  - docs/cohort-topic.md (§Tier ladder "requires a quorum of members willing", §Promotion/§Demotion, §Registration acceptance, §Configuration table, §Wire formats minSigs note)
  - packages/db-core/src/cohort-topic/willingness.ts (WillingnessConfig.quorum, defaultQuorum — reference only)
  - packages/db-core/test/cohort-topic/willingness.spec.ts (already asserts defaultQuorum(16) = 9, defaultQuorum(4) = 3)
----

# Pin the cohort admission quorum at strict majority

## Decision (maintainer, 2026-10-04)

"Majority is fine for now." The admission quorum the willingness check requires before a cohort takes
on a tier is **strict majority `⌊k/2⌋ + 1`** of the cohort (9 for k = 16), derived from the cohort size
as `defaultQuorum(cohortSize)` does today, overridable through `WillingnessConfig.quorum`. It is a
separate quantity from the threshold-signature `minSigs = k − x`. Revisit later (per-tier ratios, or
an Edge/Core-aware value) if heterogeneous cohorts show tiers being accepted while many members shed
them.

## Background

`createWillingnessCheck` returns `UnwillingCohort` (back off in time) rather than `UnwillingMember`
(retry a sibling) when fewer than `quorum` members are willing; the count is gossiped-willing siblings
plus self. `docs/cohort-topic.md` says "a quorum of members" in several places but pins no number; the
majority default was invented by the 9.3 implement ticket and survived only as a code default. A
root-placed engine already uses a majority of its storage group.

Options weighed: `k − x` (aligns with signing, but flips a cohort with a few Edge members to
`UnwillingCohort` while 10+ members would serve) and per-tier ratios (more knobs, no evidence yet).
Majority was chosen as the simplest default.

## Edge cases & interactions

- `minSigs` stays scoped to promotion/demotion signatures; the doc must say the two numbers differ on
  purpose, so nobody "fixes" them into one. Verified by inspection.
- Root-placed roots: majority of the group, not of `wantK` — keep the doc consistent with that.
- No code or test change: `defaultQuorum` and its spec already match the decision.

## TODO

- In `docs/cohort-topic.md` §Tier ladder, replace "a quorum of members" with the pinned rule
  (strict majority `⌊k/2⌋ + 1`, configurable via `WillingnessConfig.quorum`), citing `defaultQuorum`
  in `packages/db-core/src/cohort-topic/willingness.ts`.
- Add an admission-quorum row to the §Configuration table with the default and the rationale (why not
  `k − x`), and a revisit condition.
- Make §Promotion / §Demotion / §Registration acceptance refer to that one definition.
- Run `yarn lint:docs`.
