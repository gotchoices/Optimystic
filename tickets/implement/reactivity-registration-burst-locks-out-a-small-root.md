description: When a few machines start watching a collection at almost the same moment, the topic's root mistakes the burst for a flood, redirects all later watchers to a deeper tier that a small network can never form, and those watchers never get pushed changes. Stop the early-promotion rule from firing at tiny participant counts, and document a short delivery gap after a registration.
architecture: docs/cohort-topic.md#promotion-cohort-grows
files: packages/db-core/src/cohort-topic/promotion.ts, packages/db-core/test/cohort-topic/promotion.spec.ts, docs/cohort-topic.md, docs/reactivity.md, packages/substrate-simulator/src/topic-tree.ts
difficulty: easy
repro: verified
----
# A burst of registrations locks later watchers out of a small root

Reported from sereus (gotchoices/sereus, `packages/integration-tests/src/scenarios/strand-reactivity-wakes-watchers.integration.ts`, with `REGISTRATION_SPACING_MS = 0`): 3 machines, `clusterSize` 2, `cohortTopic: { enabled: true }`, one collection watched on every machine via the Quereus plugin's `optimystic.network_watch` tag, Optimystic 1.10.0. In 5 of 8 runs one machine never registered; its walk failed every 30 s with `CohortBackoffError: no willing primary right now`. Spacing registrations 1 s apart fixed it 20/20; 0 s spacing reproduced it 2/2.

## Root cause (reproduced here)

`slopePredictsCrossing` in `packages/db-core/src/cohort-topic/promotion.ts` extrapolates the direct-participant count linearly over the growth window (`DEFAULT_GROWTH_WINDOW_MS`, 10 s) and promotes if the line crosses `cap_promote` (64) within `T_promote_lookahead` (30 s). It has no lower bound on the count. With two samples — count 1, then count 2 Δ ms later — the prediction is `2 + 30 000 / Δ`, which reaches 64 for Δ ≤ 483 ms. So any two registrations landing under ~0.5 s apart promote the cohort.

Reproduced at the lowest layer with a scratch spec over `createPromotionLifecycle` (tier 0, count 1 → 2): Δ = 400 ms and 483 ms promote and return a signed notice; 485 ms and 1000 ms do not; `maybeDemote` at any later time returns `undefined` because `demotionTriggered` never demotes tree tier 0. (Scratch spec deleted.) The existing spec "promotes exactly at cap_promote with zero overshoot" already has to disable lookahead (`tPromoteLookaheadMs: 0`) to stop this from firing at count 2.

Why that locks a small network out: a reactivity root is root-placed (signed under `ceil(|root group| × quorumRatio)`, here 2 of 2), but every tier `d ≥ 1` is an ordinary cohort needing `minSigs` 14 of `wantK` 16. Once the root is promoted, `CohortMemberEngine.decideServed` answers every new register with `Promoted(1)`; on a 3-machine network the tier-1 cohort can never gather 14 signatures, so the walk's follow-on cold-start fails and the walk backs off (`RouterWalkEngine.register`, `no_state` after `followedPromoted`). The "gathered 3 of 14 required signatures" log line in sereus's runs is that tier-1 cohort trying to sign.

Static, not tested: the lock-out lasts until the tail rotates. Promotion state is per served coordinate (`CoordEngine` in `packages/db-p2p/src/cohort-topic/host.ts`, and the node-level transition record keyed `(cohortCoord, tier, topicId)`), and a reactivity root's coordinate is the tail block's, so the next tail block's root starts unpromoted. That takes `block_fill_size` (32) commits.

## Fix

**A slope pre-promotion fires only when the count is above `cap_demote`.** Rationale, to go in the code comment and in docs/cohort-topic.md §Promotion: pre-promotion exists to avoid overshooting `cap_promote` under gossip lag, which only matters near the cap. A promotion at a count at or below `cap_demote` (default 16) would put the cohort in a state the demotion rule already considers under-loaded, which contradicts the `cap_promote`/`cap_demote` hysteresis; and two or three samples in under a second are noise, not a growth rate. With the defaults, the slope trigger can then fire only at 17+ direct participants, the fast path at 32+ and the cap at 64+. Participants are distinct peers, so a 3-machine network can never promote.

Arms considered and not taken:

- **Let a root (tier 0) un-promote.** `docs/cohort-topic.md` §Demotion and `demotionTriggered` explicitly decide the root never demotes, and a `DemotionNoticeV1` needs a parent. Changing that is an architecture decision; with the floor, the root no longer promotes spuriously, and a reactivity root resets on every tail rotation anyway. Not needed for this bug.
- **Refuse to promote to a tier the network cannot form.** Would need the network-size estimate in `PromotionDeps`. Since every participant is a distinct peer, a count of 17+ already implies at least `wantK` peers on the network in the default configuration. Record it as a tripwire instead (TODO below): it becomes real only if participants can outnumber the peers willing to serve tier `d+1` (e.g. an edge-heavy network, where edge profiles keep T2/T3 willingness off), or if `cap_demote` is configured below `minSigs`.

## Second, smaller gap: a commit right after a registration can reach nobody

Verified by sereus (3 of 13 runs with the commit ~1 s after the last registration; 0 of 7 after a 10 s wait). On a storage group of 3 or fewer, only the commit's coordinating member holds a full certificate and announces (see "What still only the coordinator announces" in docs/reactivity.md §Origination point). A registration is admitted by one root-group member and reaches the others through cohort gossip, drained every `DEFAULT_GOSSIP_INTERVAL_MS` (5 s, `packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts`). If the announcing member is not the one holding the registration, its `hasDemand` check (`packages/db-p2p/src/reactivity/forwarder-host.ts`) finds no subscriber and the notification goes nowhere. The watch service's `moveThenRecheck` re-reads the tail once right after the registration lands, so only a commit after that re-read and before the gossip round is lost — and the next tick (30 s Core) catches it.

This is accepted behaviour, not a fix: document it. Forwarding the announcement to the member that holds the registration would close it, but is a design change for later; mention it in the doc line as the remedy if the window ever matters.

## Not addressed (observed once or twice by sereus, mechanism unknown)

Both were seen only in runs where the root had promoted, and may disappear with the fix. If either is seen again after it ships, file a fix ticket with a trace:

- A registered subscriber stopped receiving pushes ~90 s (one TTL) after registering, while others on the same root still did. Renewals at a promoted root are still served (`handleRenew` does not consult promotion), so the guess that renewals stop landing is unconfirmed.
- The never-registered machine's 30 s tail-read wakes stopped after its third failed walk — consistent with a step in the subscription's serial queue never settling (the `NOTE:` at `enqueue` in `packages/db-p2p/src/reactivity/collection-watch.ts`). A failed walk that went through a tier-1 follow-on cold-start mints proof-of-work (backlog `bug-first-registration-proof-of-work-freezes-the-node-for-seconds`), which is one candidate.

## Downstream

sereus works around this with `REGISTRATION_SPACING_MS` and `RECORD_GOSSIP_SETTLE_MS` in `strand-reactivity-wakes-watchers.integration.ts`. The complete/ ticket must say that the first release containing this fix lets sereus drop `REGISTRATION_SPACING_MS` (the gossip settle stays, since that gap is documented, not fixed).

## TODO

- In `CohortPromotionLifecycle.promotionTriggered` (or `slopePredictsCrossing`), return false from the slope trigger unless `count > this.capDemote`. Comment the reason (hysteresis + noise, above). The cap and fast-path triggers are unchanged.
- Add one spec to `packages/db-core/test/cohort-topic/promotion.spec.ts`: at tree tier 0, two arrivals (count 1 → 2) a few hundred ms apart do not promote and return no notice. This is the reproduction; it fails before the fix. Check the existing slope spec (10 → 40 over 1 s) still passes — 40 is above the floor.
- Add a `NOTE:` tripwire at the promote site: promotion assumes tier `d+1` can form a cohort that signs at `minSigs`; the participant floor implies enough peers only while participants are peers willing at that tier and `cap_demote ≥ minSigs`; if either stops holding, gate promotion on the network-size estimate.
- docs/cohort-topic.md §Promotion (cohort grows): state the floor on the slope trigger and why, in the paragraph on pre-promotion and in the implementation note under it.
- `packages/substrate-simulator/src/topic-tree.ts` `slopePredictsCrossing`: mirror the floor so the simulator models the same rule; confirm the simulator's tests are unchanged (its lookahead comparisons run near the cap, far above 16).
- docs/reactivity.md: add the post-registration delivery gap to "What a late subscriber gets" under §Forwarder-cohort state (per root served) — the window is up to one cohort gossip interval (5 s), the next tick catches it, and forwarding to the holding member is the remedy if it matters.
- Run `yarn test` in `packages/db-core` and `packages/substrate-simulator`, and `yarn lint:docs` from the root.
