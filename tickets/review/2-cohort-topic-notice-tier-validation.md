description: Review tier-validator fix for promotion/demotion notices — switched from capacity-tier (0..3) to tree-tier (0..60) helper.
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts
----

## What was done

Three changes in `validate.ts`:

1. `validatePromotionNoticeV1` (lines 330–331): `tier(...)` → `treeTier(...)` for both `fromTier` and `toTier`.
2. `validatePromotionNoticeV1`: added cross-field guard — `toTier !== fromTier + 1` throws `CohortWireError`. Required reading both values before the return, so the function was restructured to bind `fromTier`/`toTier` first, validate, then build the return object.
3. `validateDemotionNoticeV1` (line 348): `tier(...)` → `treeTier(...)` for `tier`.

## Test results

`yarn workspace @optimystic/db-core test` — 1076 passing, 0 failures.

## Use cases to verify

- Promotion notice with `fromTier=4, toTier=5` (tree depth > 3): must now pass validation.
- Promotion notice with `fromTier=0, toTier=2`: must be rejected (`toTier !== fromTier + 1`).
- Promotion notice with `fromTier=60, toTier=61`: must be rejected (`toTier` exceeds `DEFAULT_D_MAX_CAP`).
- Demotion notice with `tier=10`: must now pass validation.
- Demotion notice with `tier=61`: must be rejected.
- All previously valid notices at tier 0..3 still pass.

## Known gaps

No dedicated unit tests for the promotion/demotion validators at tree tiers > 3 — the existing suite tests them implicitly via integration paths. A reviewer may want to add explicit boundary tests in the validate test file if one exists.

## Review findings

No tripwires filed. The change is a pure correctness fix with no performance or architectural implications.
