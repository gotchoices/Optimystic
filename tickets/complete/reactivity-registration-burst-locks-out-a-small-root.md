description: When a few machines start watching a collection at almost the same moment, the topic's root mistook the burst for a flood and redirected later watchers to a deeper tier a small network can never form. The early-promotion rule no longer fires at tiny participant counts, and a short delivery gap after a registration is now documented.
architecture: docs/cohort-topic.md#promotion-cohort-grows
files: packages/db-core/src/cohort-topic/promotion.ts, packages/db-core/test/cohort-topic/promotion.spec.ts, packages/substrate-simulator/src/topic-tree.ts, docs/cohort-topic.md, docs/reactivity.md
----
# Complete: a burst of registrations no longer locks later watchers out of a small root

Reported from sereus (`strand-reactivity-wakes-watchers.integration.ts` with `REGISTRATION_SPACING_MS = 0`, 3 machines, `clusterSize` 2). The slope pre-promotion rule extrapolated two samples (count 1 → 2, under ~483 ms apart) past `cap_promote` (64) within the 30 s lookahead and promoted tier 0. The root never demotes and tier 1 needs 14 of 16 signatures, so every later registration got `Promoted(1)` and failed.

## What shipped

- `CohortPromotionLifecycle.promotionTriggered` (`packages/db-core/src/cohort-topic/promotion.ts`): the slope trigger requires `count > capDemote` (default 16). Cap and hot fast-path triggers unchanged. `NOTE:` tripwire at `promote` on the assumption that tier d+1 can form a cohort signing at `minSigs`.
- `TopicTree.promotionTriggered` in `packages/substrate-simulator/src/topic-tree.ts` mirrors the floor.
- docs/cohort-topic.md §Promotion (cohort grows) documents the floor and its reason; docs/reactivity.md §Forwarder-cohort state documents the post-registration delivery gap (up to one 5 s gossip interval on groups of three or fewer; the next 30 s tick wakes the watcher). The gap is documented, not fixed.
- Test: `promotion.spec.ts` "a burst of two registrations at the root does not pre-promote on slope".

## Downstream (sereus)

The first release containing this fix lets sereus drop `REGISTRATION_SPACING_MS` in `strand-reactivity-wakes-watchers.integration.ts`. `RECORD_GOSSIP_SETTLE_MS` stays, because the post-registration delivery gap is documented, not fixed.

## Review findings

Reviewed the diff of `ticket(implement): reactivity-registration-burst-locks-out-a-small-root` before reading the handoff.

- **Correctness.** Checked the floor against `slopePredictsCrossing`. The arithmetic in the comment and the docs (`2 + 30000/Δ ≥ 64` ⇔ Δ ≤ 483 ms) matches the extrapolation. The floor only removes slope promotions at 16 or fewer participants. Above 16 the behaviour is unchanged, so the existing "10 → 40 over 1 s" slope spec still covers the early-promotion path. `capDemote` is the same configured field the demotion rule reads, so a custom `capDemote` moves both rules together, keeping the hysteresis consistent. The floor also applies to matchmaking topics, which share this lifecycle. That is intended: a matchmaking topic with 16 or fewer providers has no reason to promote. No issues found.
- **Simulator parity.** The simulator's `promotionTriggered` mirrors the floor with the same comparison (`>`). The 258 simulator specs pass, including the lookahead-overshoot measurements cited in docs/cohort-topic.md (`compareLookahead`). Those regimes cross the cap far above 16, so the measured numbers in the doc still hold.
- **Docs.** All touched docs were read. Citations (`DEFAULT_GOSSIP_INTERVAL_MS`, `moveThenRecheck`, the "What still only the coordinator announces" section) resolve. One gap was fixed inline: the default-parameter table row for `cap_demote` described it only as the demotion floor; it now also says the slope pre-promotion fires only above it.
- **Tests.** The one added spec reproduces the reported defect at the lowest layer (the lifecycle). It is not redundant with the existing slope spec, which sits above the floor. Kept. No other tests added or cut.
- **Source hygiene.** The comment in `promotionTriggered` explains why the floor exists rather than narrating code. Its last sentence records the field incident, which is useful context for anyone tempted to remove the floor. Kept.
- **Tripwires.** Two `NOTE:` comments sit at `promote`. The pre-existing one covers the tier-60 ceiling. The new one covers the promotion-assumes-a-formable-tier condition (edge-heavy network, or a lowered `cap_demote`). A related conditional case was left as parked: a config with `capPromoteFast ≤ capDemote` could still fast-path promote at small counts, but only on a hot load bucket. The new `NOTE:` already scopes its claim to "with the defaults", so no new ticket.
- **Not addressed (carried from the handoff, no ticket filed).** The once-promoted lock-out until tail rotation can no longer be reached on a small network. Two sereus observations, seen only after the root had promoted, were not investigated: a subscriber losing pushes about one TTL after registering, and tail-read wakes stopping after the third failed walk. If either recurs after this ships, file a fix ticket with a trace.
- **Validation.** `yarn test` passed in db-core (1861) and substrate-simulator (258). `yarn lint` and `yarn lint:docs` are clean. Not run: the sereus integration scenario (external repo) and the db-p2p integration tier. No end-to-end test in this repo reproduces the three-machine burst.
