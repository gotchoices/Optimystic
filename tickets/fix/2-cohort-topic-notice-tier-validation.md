description: The messages that announce a cohort growing or shrinking carry a routing-tree depth, but they are checked against a validator meant for a different, much smaller numbering — so once the network is deep enough these announcements are rejected as malformed and growth silently stops working.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts        # ~298-315 — validatePromotionNoticeV1 / validateDemotionNoticeV1 use tier() (0..3)
  - packages/db-core/src/cohort-topic/promotion.ts            # ~290-342 — promote()/demote() stamp tree tiers
difficulty: easy
----

# Promotion/demotion notices validate tree tiers with the 0..3 capacity-tier validator

## The problem

`PromotionNoticeV1.fromTier`/`toTier` (and `DemotionNoticeV1.tier`) carry **tree** tiers — the routing
depth `d`, which the design allows up to `d_max_cap` (60). But the notice validators
(`wire/validate.ts:298-315`) clamp them through the `tier()` helper, which is the **capacity-tier**
validator bounded 0..3. Any promotion at tree tier ≥ 3 emits `toTier = 4`, which every receiver rejects
as malformed. Promotion therefore silently breaks once the network is deep enough (`n ≥ F⁴`).

The gossip validator gets the same concept right: `validateCohortGossipV1` checks `treeTier` as a
non-negative integer (`wire/validate.ts:461-464`). The notice validators simply reused the wrong helper.

This is adjacent to complete ticket `cohort-topic-promote-notice-coord-disambiguation` (which touched the
same notice validators for the `cohortCoord` routing field) but is a distinct bug it did not address.

## Expected behavior

Validate notice tiers (`fromTier`, `toTier`, and demotion `tier`) as **non-negative integers**, not as
0..3 capacity tiers. Optionally additionally require `toTier === fromTier + 1` on a promotion notice, and
the analogous relation on demotion, since a promotion moves exactly one tree tier.

## Repro sketch

- Construct a promotion at tree tier ≥ 3 (`toTier: 4`) and round-trip it through
  `validatePromotionNoticeV1` → observe `CohortWireError`.
- With the fix, deep-tier notices validate and broadcast; a genuinely malformed (negative/non-integer)
  tier is still rejected.
