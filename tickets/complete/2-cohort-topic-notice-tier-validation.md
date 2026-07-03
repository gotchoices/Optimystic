description: Promotion/demotion notice validators now accept deep tree tiers (0..60) instead of wrongly capping at 0..3, so promotions below the third routing level are no longer rejected as malformed.
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/src/cohort-topic/promotion.ts
  - packages/db-core/test/cohort-topic/wire.spec.ts
----

## What shipped

The promotion/demotion notice validators in `validate.ts` were passing their tier fields
through the `tier()` helper (bounds 0..3, the capacity-tier range) when the fields actually
carry **tree** tiers — routing depth `d`, allowed up to `DEFAULT_D_MAX_CAP` (60). Any
promotion at tree depth ≥ 3 produced `toTier = 4`, which every receiver rejected as malformed.

Implement-stage change (commit `707a29b`):

1. `validatePromotionNoticeV1`: `tier(...)` → `treeTier(...)` for `fromTier` and `toTier`.
2. `validatePromotionNoticeV1`: added cross-field guard `toTier === fromTier + 1` (matches the
   producer invariant in `promote()`), which required reading both values before building the return.
3. `validateDemotionNoticeV1`: `tier(...)` → `treeTier(...)` for `tier`.

## Review findings

Adversarial pass over the implement diff, the touched file, the producer (`promotion.ts`), the
sig payload (`sig/payloads.ts`), and all `src` consumers.

**Checked — correctness.** The `treeTier` swap matches the producer: `promote()` stamps
`fromTier = treeTier(topicId)` and `toTier = fromTier + 1` (promotion.ts:290/303); `demote()`
stamps `tier = treeTier(topicId)` (promotion.ts:337). The cross-field guard exactly mirrors the
producer invariant. Both values pass through `treeTier` (0..60 integer) first, so an over-cap
`toTier` is rejected by the bound before the `+1` guard is reached. Correct.

**Checked — regressions / other consumers.** No `src` code assumes the old 0..3 bound for these
fields. The only other reference is `sig/payloads.ts`, which serializes `fromTier`/`toTier`
verbatim with no range assumption. The receiver path (`decodePromotionNoticeV1` /
`decodeDemotionNoticeV1` in `codec.ts`) is a thin wrapper over the validators. Existing
`samplePromotion` (1→2) and `sampleDemotion` (tier 2) fixtures remain valid, so no round-trip
regression. Loosening the bound is the intended fix — receivers previously rejected valid deep
notices.

**Checked — docs.** No markdown under `packages/db-core` references `fromTier`/`toTier`/promotion
notices; nothing to update.

**Fixed inline — test coverage (minor).** The implement handoff flagged the gap: no dedicated
boundary tests for the notice validators above tier 3. Added 7 tests to `wire.spec.ts`:
deep promotion (4→5) accepted; cap-boundary promotion (59→60) accepted; `toTier !== fromTier+1`
rejected; over-cap `toTier` (61) rejected; non-integer tree tier rejected; deep demotion (10)
accepted; over-cap demotion (61) rejected. Suite: **1083 passing, 0 failures** (was 1076). Build
(`tsc`) clean. No `lint` script exists in this workspace — typecheck is via `build`.

**Tripwire — promote() has no cap guard (conditional; parked as a `NOTE:`).** `promote()`
(promotion.ts:290) computes `toTier = fromTier + 1` with no check that `fromTier` is below the
cap. At `fromTier === DEFAULT_D_MAX_CAP` (60) it would stamp `toTier = 61`, which the validator —
and thus every receiver — rejects. This is unreachable today (tree tier 60 is pathological; the
substrate treats the cap as the ceiling on useful walk depth), so it is a conditional concern, not
a latent defect: recorded as a `NOTE:` at the site telling a future reader to gate promotion below
the cap if the tree can ever reach it. No ticket filed.

**No findings — error-ordering nit (accepted).** The tier guard now runs before `topicId` /
structural base64url validation, so a frame that is malformed in *both* tier and topicId reports
the tier error first. This is error-message priority only, not a correctness issue; acceptable.

**Major findings:** none — no new fix/plan/backlog tickets filed.
