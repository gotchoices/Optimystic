description: Simulator cohort-topic tree — coord_d tier addressing, cap_promote/demote hysteresis, willingness vectors, load barometer, topic-traffic flow. The spec mirror the production substrate is checked against.
prereq: simulator-fret-cohort-model
files:
  - docs/cohort-topic.md
  - packages/db-p2p/src/testing/mesh-harness.ts
effort: high
----

# Simulator cohort-topic tree: tier addressing, promotion/demotion, willingness, load barometer

The modeled topic tree — the heart of the cohort-topic claims the simulator must validate. This is **modeled behaviour only**, not production code; it is the spec mirror that the later production `cohort-topic-*` tickets are checked against (and whose parameters the simulator settles via `fold-simulator-findings-into-design-docs`). It layers on `simulator-fret-cohort-model` for coordinate derivation, cohort assembly, and `d_max`, and schedules all state transitions (promotion, demotion, gossip, TTL decay) as virtual-clock events.

## Tier addressing

Per `docs/cohort-topic.md` §Tier addressing (~L43, L60) with `F = 16`:

```
coord_0(topicId)           = H(topicId)                                // root, special case
coord_d(P, topicId)        = H(d ‖ prefix(P, d·log₂F) ‖ topicId)       for d ≥ 1
```

`prefix(P, d·log₂F)` is the first `d·log₂F` bits of the peer ring position — F-ary prefix sharding. Coordinates must be deterministic and uncorrelated across tiers and topics (validated by the collision test below).

## Modeled tree node

```ts
interface TopicCohortState {
	topicId: TopicId;
	tier: number;                 // d
	coord: RingCoord;             // coord_d(...)
	directParticipants: number;   // count attached at this cohort for this topic
	promoted: boolean;            // serving Promoted(d+1) for new registrations
	childCohortCount: number;     // >0 blocks demotion
	loadBucket: number[];         // per-tier 3-bit barometer, 0..7
	willingness: number;          // 4-bit vector, one bit per tier T0..T3
	traffic: { arrivalsPerMin: number; queriesPerMin: number; participants: number };
	lastGrowthSamples: GrowthSample[]; // for slope-based pre-promotion
}
```

## Promotion / demotion (cohort-topic.md §Promotion and demotion lifecycle ~L346–381)

Promote when:
- `directParticipants ≥ cap_promote` (64), **OR**
- `loadBarometer[tier].bucket ≥ bucket_overload` (6) AND `directParticipants ≥ cap_promote_fast` (32).

Pre-promotion: if the slope of `directParticipants` over a gossip window predicts crossing `cap_promote` within `T_promote_lookahead` (30s), promote now (avoids the gossip-lag overshoot race).

Demote when ALL hold (with hysteresis):
- `directParticipants ≤ cap_demote` (= `cap_promote/4` = 16), AND
- the low-load condition has persisted for `T_demote` (5min), AND
- `childCohortCount == 0` (never demote while child cohorts exist).

`cap_promote` and `cap_demote` are intentionally 4× apart, plus `T_demote` temporal hysteresis, to prevent thrashing between depths. The simulator must reproduce that no-thrash property (see tests).

## Willingness + load barometer (§Willingness ~L170, §Capacity barometer ~L198)

- Per-member, per-tier willingness as a 4-bit vector (T0..T3), tied to device profile: **Edge** advertises T0+T1 only; **Core** advertises all tiers. Per-node overrides allowed.
- Per-tier load bucket: 3 bits (0..7). Willingness bit flips on a load-bucket threshold crossing; gossiped intra-cohort (model ~1 heartbeat staleness — the churn/willingness ticket exercises the staleness edge cases).
- Quorum-level willingness derived from the barometer determines `UnwillingCohort` vs `UnwillingMember`.

## Topic traffic (§Topic traffic signal ~L220–246)

`TopicTrafficV1{arrivalsPerMin, queriesPerMin, participants}` counters maintained per (topic, cohort) over a window, gossiped within the cohort, and surfaced on `accepted`/`promoted` replies (per the resolved design lock in `tickets/complete/cohort-topic-traffic-signal.md`). The matchmaking-hangout ticket consumes these.

## Emitted simulator events

The tree emits, onto the metrics stream (consumed by `simulator-metrics-and-scenarios`): `Promoted`, `NoState`, `UnwillingMember`, `UnwillingCohort`, `TopicTraffic`. (Demotion is also recorded for the convergence tracer.)

## Out of scope

Wire serialization and real threshold signatures. Assume one gossip round / signature assembly completes (per the event-clock ticket decision) and model only its latency.

## Doc sync

- `docs/cohort-topic.md` §Promotion and demotion lifecycle and §Tier addressing: add forward notes that the depth law, hysteresis bounds, and `coord_d` collision rate are simulator-validated (measured numbers fold back later via `fold-simulator-findings-into-design-docs`).

## TODO

### Phase 1 — addressing + node state
- Implement `coord_0`/`coord_d` over `RingModel` from `simulator-fret-cohort-model`; assert determinism and cross-tier/topic decorrelation.
- Implement `TopicCohortState` and the per-(topic,cohort) registry keyed by `(topicId, coord)`.

### Phase 2 — lifecycle
- Implement promotion (cap, fast+overload, slope lookahead) and demotion (cap_demote + T_demote + no-child) as scheduled events with the sticky/hysteresis windows.
- Implement the 3-bit load barometer and the 4-bit willingness vector with Edge/Core profiles and gossip refresh on threshold crossing.

### Phase 3 — traffic + events + doc sync
- Implement `TopicTrafficV1` counters and gossip; surface on accepted/promoted.
- Wire the emitted simulator events (`Promoted`/`NoState`/`UnwillingMember`/`UnwillingCohort`/`TopicTraffic`) to the metrics stream interface.
- Add the *Done when* tests; add the forward-note doc edits to `docs/cohort-topic.md`.

## Done when

- `yarn build` for the simulator package is green; ES modules, no `any`, tabs, small single-purpose functions.
- `yarn test` passes, including:
  - **Depth law:** under a stable population, steady-state tree depth converges to `⌈log_F(N/cap_promote)⌉` (smoke check here across a couple of N; the full N-sweep lives in `simulator-promotion-convergence`).
  - **No demotion with children:** a cohort with `childCohortCount > 0` never demotes even when `directParticipants ≤ cap_demote` for `> T_demote`.
  - **No promotion thrash:** a load barometer bouncing 5↔6 does not cause promotion flapping (the `cap_promote`/`cap_demote` 4× gap + `T_demote` hold absorbs it).
  - `coord_d` collision rate across tiers/topics stays within a documented bound (records the measurement for the fold-back ticket).
  - Edge profile never advertises willingness for T2/T3; Core advertises all.
