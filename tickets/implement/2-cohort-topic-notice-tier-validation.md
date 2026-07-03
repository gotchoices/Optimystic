description: Fix promotion/demotion notice validators to accept deep tree tiers by switching from the 0..3 capacity-tier helper to the 0..60 tree-tier helper.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts
difficulty: easy
----

## What and why

`validatePromotionNoticeV1` and `validateDemotionNoticeV1` pass `fromTier`, `toTier`, and `tier` through
the `tier()` helper (line ~139), which bounds values to 0..3 (the capacity-tier range).  These fields carry
**tree** tiers — routing depth `d` — which the design allows up to `DEFAULT_D_MAX_CAP` (60).  Any
promotion at tree tier ≥ 3 produces `toTier = 4`, which every receiver immediately rejects as malformed.

The tree-tier validator already exists: `treeTier()` (line ~152) checks integer 0..60.  It is already used
by `validateCohortGossipV1` for its `treeTier` field and by `validateChildLinkV1` for `childTier`.  The
notice validators simply reused the wrong helper.

The bug is confirmed by tracing `promotion.ts`:
- `promote()` stamps `fromTier = this.deps.treeTier(topicId)` and `toTier = fromTier + 1` (line 294/303).
- `demote()` stamps `tier = this.deps.treeTier(topicId)` (line 337).
- Both use the substrate's `treeTier()`, so their values grow with network depth and can exceed 3.

## Fix

In `validatePromotionNoticeV1` (lines 330-331): replace both `tier(...)` calls with `treeTier(...)`.

In `validateDemotionNoticeV1` (line 347): replace `tier(...)` with `treeTier(...)`.

Optionally add a cross-field sanity check in `validatePromotionNoticeV1` after reading both values:

```typescript
if (result.toTier !== result.fromTier + 1) {
    fail(`${what}: toTier must equal fromTier + 1, got fromTier=${result.fromTier} toTier=${result.toTier}`);
}
```

This matches the invariant in `promote()` and cheaply catches malformed frames without breaking any valid
notice.

## TODO

- In `validatePromotionNoticeV1` (line 330): change `tier(reqFiniteNumber(obj, "fromTier", what), what)` → `treeTier(reqFiniteNumber(obj, "fromTier", what), what)`
- In `validatePromotionNoticeV1` (line 331): change `tier(reqFiniteNumber(obj, "toTier", what), what)` → `treeTier(reqFiniteNumber(obj, "toTier", what), what)`
- Add `toTier === fromTier + 1` cross-field check after both are read (restructure return to read first, then validate, then return)
- In `validateDemotionNoticeV1` (line 347): change `tier(reqFiniteNumber(obj, "tier", what), what)` → `treeTier(reqFiniteNumber(obj, "tier", what), what)`
- Run `yarn workspace @optimystic/db-core test` (or equivalent) to confirm no regressions; note if pre-existing failures appear
