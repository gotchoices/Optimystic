description: Review the modeled cohort-topic tree — tier addressing (coord_d), promotion/demotion hysteresis, willingness + load barometer, topic-traffic flow, and the metrics-stream events. Spec mirror for the later production cohort-topic-* tickets. Build + 81 tests green at implement handoff.
prereq: simulator-fret-cohort-model
files:
  - packages/substrate-simulator/src/topic-addressing.ts
  - packages/substrate-simulator/src/willingness.ts
  - packages/substrate-simulator/src/topic-events.ts
  - packages/substrate-simulator/src/topic-tree.ts
  - packages/substrate-simulator/src/hex.ts
  - packages/substrate-simulator/src/index.ts
  - packages/substrate-simulator/test/topic-addressing.spec.ts
  - packages/substrate-simulator/test/willingness.spec.ts
  - packages/substrate-simulator/test/topic-tree.spec.ts
  - packages/substrate-simulator/test/no-real-time.spec.ts
  - docs/cohort-topic.md
  - packages/substrate-simulator/README.md
----

# Review: simulator cohort-topic tree

The modeled topic tree — the spec mirror the production `cohort-topic-*` substrate is checked
against. **Modeled behaviour only**, layered on `simulator-fret-cohort-model`'s `RingModel`. All
state transitions (promotion, demotion, gossip, traffic refresh) are scheduled as virtual-clock
events. Treat this implementation as a starting point and the tests as a floor.

## What shipped

**Phase 1 — addressing + node state** (`topic-addressing.ts`, async-allowed):
- `coordForTier(ring, P, topicId, d)` = `H(d ‖ prefix(P, d·log₂F) ‖ topicId)` over FRET `hashKey`
  (sha256). `coord0` falls out of the general form at `d = 0` (empty prefix, tier byte `0x00`)
  → `H(0x00 ‖ topicId)`, matching the doc exactly — no special-case path.
- `prefixBits(P, nBits)` — top `nBits` MSBs packed big-endian, partial byte's low bits zeroed
  (deterministic, prefix-grouping). `buildCoordLadder` pre-derives `ladder[d]` so the sync
  lifecycle never hashes. `deriveTopicId(label)` is a sim convenience (FNV→32 bytes).
- This is the **only** new async file; added to `no-real-time.spec.ts` `ASYNC_ALLOWED`. Every
  other new file is fully synchronous (the guard scans them and passes).

**Phase 2 — lifecycle + barometer + willingness** (`topic-tree.ts`, `willingness.ts`):
- `TopicCohortState` + per-`(topicId, coord)` registry (keyed `${topicHex}:${coordHex}`).
- Promotion: cap (`≥64`), fast+overload (`bucket≥6 ∧ ≥32`), and slope lookahead (linear
  extrapolation over the growth window crossing `cap_promote` within `T_promote_lookahead`).
  Demotion: `≤cap_demote` ∧ held `T_demote` ∧ `T_promote_sticky` floor ∧ `childCohortCount==0`.
- 3-bit load barometer (`setLoadBucket` flips the cohort willingness bit on the overload
  crossing, then re-evaluates promotion). 4-bit per-member willingness with Edge (T0+T1) / Core
  (all) profiles; Edge T2/T3 are permanently off even under override. `classifyAdmission` →
  accepted / unwilling_member / unwilling_cohort with a quorum gate.

**Phase 3 — traffic + events** (`topic-events.ts`, `topic-tree.ts`):
- `TopicTrafficV1` counters over a window; `refreshTraffic` rolls raw counters to per-minute
  rates into the gossiped view (`state.traffic`), so `trafficSignal()` (the accepted/promoted
  reply surface) lags raw counters by one gossip round — the documented staleness.
- `EventSink` + typed `SimEvent` union; the tree emits `Promoted`/`Demoted`/`TopicTraffic`
  directly and exposes `recordNoState`/`recordAdmission` so the walk model (ticket 4) routes
  `NoState`/`UnwillingMember`/`UnwillingCohort` through the same stream. `CollectingEventSink`
  for tests; ticket 6's richer `MetricsSink` will consume these events.

## Validation — what the tests prove (the floor)

`yarn build` clean; `yarn test` **81 passing** (was 59 before this ticket; +22). All five
`Done when` tests are present and green:
- **Depth law** (`topic-tree.spec.ts`): promotion-driven `maxOccupiedTier` vs
  `⌈log_F(N/cap_promote)⌉` within ±1, for N ∈ {1024, 16000}. Measured: observed = **law + 1** in
  both cases (1024→law 1/obs 2; 16000→law 2/obs 3) because dense prefixes promote one tier
  deeper at power-of-F boundaries (the doc's "dense regions go deeper"). The ±1 tolerance covers
  this; the rigorous per-N characterization is `simulator-promotion-convergence`.
- **No demotion with children** — held promoted past `sticky + T_demote` with `childCohortCount=1`;
  demotes exactly once after the child is dropped.
- **No promotion thrash** — barometer bouncing 5↔6 at `directParticipants=33` promotes once,
  never demotes (33 > cap_demote 16; the 4× gap absorbs it). Plus a temporal-hysteresis test
  (low-load cohort waits `T_demote` before demoting).
- **`coord_d` collision rate** — 0 collisions across 64 positions × 4 topics × tiers 0–5
  (cross-(tier,prefix,topic) tagged); documented bound ~0 for 256-bit sha256. Recorded for
  fold-back.
- **Willingness** — Edge never advertises T2/T3 (even with override + zero load); Core all four;
  load-bucket shed/recover; cohort-quorum aggregation; admission classification.

Doc forward-notes added to `docs/cohort-topic.md` §Tier addressing (collision rate) and
§Hysteresis (depth law, thrash absorption, no-demote-with-children, parameter fold-back).
README gains a third "cohort-topic tree" layer section + quick-start snippet.

## Known gaps / reviewer attention (tests are a floor, not a finish line)

- **The registration/growth driver is simplified.** `TopicTree.register` walks **root-outward**
  following `Promoted` redirects to grow the tree by load — it is *not* the doc's `d_max`→root
  walk (NoState back-off, `UnwillingMember`/`UnwillingCohort` redirects, latency, bootstrap
  evidence). That full walk is `simulator-participant-walk` (ticket 4). `register` exists only to
  produce the promotion-driven shape the depth-law smoke check needs. Verify the simplification
  doesn't bake in assumptions ticket 4 must contradict.
- **Depth-law +1 bias** (above) — confirm this is the right reading of "tree depth" (deepest
  occupied tier *index* vs. tier *count*). If the convergence ticket wants the law to track the
  index exactly, the measurement definition may need pinning before fold-back.
- **State-level vs member-level willingness are two surfaces.** `TopicCohortState.willingness`
  (cohort aggregate, flipped by `setLoadBucket`) and `willingness.ts`'s per-member model
  (`classifyAdmission`) are not yet wired together inside `TopicTree` — admission classification
  is tested standalone, and the tree only emits the verdict via `recordAdmission`. The churn/
  willingness ticket (4) is expected to connect them; check the seam is adequate.
- **Slope pre-promotion** uses a last-vs-first linear fit over the growth window with same-time
  samples short-circuited (span ≤ 0 → no trigger). It has unit coverage only indirectly (the
  depth-law driver registers all at `now=0`, so slope never fires there). A dedicated slope test
  with timed arrivals would strengthen the floor — not added this pass.
- **Gossip staleness** is modeled as a single one-round lag on `state.traffic`; the multi-round
  / rotation-epoch reset edge cases (counters→0 on `cohortEpoch` change) are explicitly the
  churn/willingness ticket's job and are **not** modeled here.
- **Traffic on accepted/promoted replies** is modeled as `trafficSignal()` returning a
  `TopicTrafficV1`; the actual reply struct (`RegisterReplyV1.topicTraffic`) is wire-formats
  (ticket 8). No wire serialization or threshold signatures here (out of scope per ticket).

## How to exercise

```
cd packages/substrate-simulator
yarn build && yarn test                 # 81 passing
yarn test:verbose                       # per-spec names
```

No `.pre-existing-error.md` written — no unrelated failures surfaced. Only the
`substrate-simulator` package was exercised (db-p2p/FRET unaffected by these additions, per the
`simulator-fret-cohort-model` precedent). The `portal:` FRET dep caveat
(`fret-portal-dependency-resolution`) is unchanged and still applies to CI.
