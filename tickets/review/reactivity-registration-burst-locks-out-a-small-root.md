description: When a few machines start watching a collection at almost the same moment, the topic's root mistook the burst for a flood and redirected later watchers to a deeper tier a small network can never form. The early-promotion rule no longer fires at tiny participant counts, and a short delivery gap after a registration is now documented.
architecture: docs/cohort-topic.md#promotion-cohort-grows
files: packages/db-core/src/cohort-topic/promotion.ts, packages/db-core/test/cohort-topic/promotion.spec.ts, packages/substrate-simulator/src/topic-tree.ts, docs/cohort-topic.md, docs/reactivity.md
difficulty: easy
repro: verified
----
# Review: a burst of registrations no longer locks later watchers out of a small root

Reported from sereus (`strand-reactivity-wakes-watchers.integration.ts` with `REGISTRATION_SPACING_MS = 0`, 3 machines, `clusterSize` 2). Root cause: `slopePredictsCrossing` extrapolated two samples (count 1 → 2, Δ ≤ 483 ms) past `cap_promote` (64) within the 30 s lookahead, promoting tier 0. The root never demotes, and tier 1 needs 14 of 16 signatures, so every later registration got `Promoted(1)` and failed (`CohortBackoffError`) until the tail rotated.

## What changed

- `CohortPromotionLifecycle.promotionTriggered` (`packages/db-core/src/cohort-topic/promotion.ts`): the slope trigger now requires `count > capDemote` (default 16). Cap and fast-path triggers unchanged. Reason commented at the site and in the module header.
- `NOTE:` tripwire at `promote`: promotion assumes tier d+1 can form a cohort signing at `minSigs`; holds only while participants are peers willing at that tier and `cap_demote ≥ minSigs` — otherwise gate on the network-size estimate.
- `packages/substrate-simulator/src/topic-tree.ts` `promotionTriggered`: mirrors the floor. Simulator tests unchanged (258 passing).
- docs/cohort-topic.md §Promotion (cohort grows): floor and rationale in the pre-promotion paragraph and in the implementation note.
- docs/reactivity.md §Forwarder-cohort state, after "What a late subscriber gets": new paragraph on the post-registration delivery gap (up to one 5 s gossip interval on groups ≤ 3, next 30 s tick catches it, forwarding to the holding member is the remedy). Documented, not fixed — as the ticket asked.

## Test added

- `promotion.spec.ts` "a burst of two registrations at the root does not pre-promote on slope" — tier 0, count 1 → 2 at 400 ms, asserts no notice and not promoted. Verified it fails with the floor removed (returns a signed notice) and passes with it.
- Existing slope spec (10 → 40 over 1 s) still passes (40 > 16). The "zero overshoot" spec still disables lookahead; it still needs to, since per-ms arrivals past 16 would slope-fire before 64.

## Validation

- `yarn test` in db-core: 1861 passing. substrate-simulator: 258 passing. `yarn lint:docs`: clean.
- Not run: sereus's integration scenario (external repo), db-p2p integration tests. No end-to-end test here reproduces the 3-machine burst.

## Known gaps / for the reviewer

- Static, untested: once promoted, the lock-out lasts until tail rotation (per-coordinate state). With the floor that state is no longer reachable on a small network, so not addressed.
- The two "not addressed" observations from sereus (a subscriber losing pushes ~one TTL after registering; tail-read wakes stopping after the third failed walk) are not investigated. Both were seen only after the root promoted. If seen again after this ships, file a fix ticket with a trace.
- The `NOTE:` says "with the defaults" because `capPromote`/`capPromoteFast` are configurable; a config with `capPromoteFast ≤ capDemote` could still promote at small counts via the fast path (only when the load bucket is hot).

## Downstream

The complete/ ticket must say: the first release containing this fix lets sereus drop `REGISTRATION_SPACING_MS` in `strand-reactivity-wakes-watchers.integration.ts`; `RECORD_GOSSIP_SETTLE_MS` stays, since the post-registration gap is documented, not fixed.
