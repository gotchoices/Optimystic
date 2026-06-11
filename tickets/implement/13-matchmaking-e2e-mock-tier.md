description: Matchmaking unit + mesh-harness suites — wire round-trips, anchor derivation, capability filter, hang-out thresholds; plus sparse/hot/borderline topic regimes, multi-cohort sweep, provider lifecycle, and primary handoff — over the fast deterministic mock mesh.
prereq: matchmaking-sweep-adversarial-module, cohort-topic-e2e-mock-tier
files:
  - packages/db-p2p/src/testing/mesh-harness.ts
  - packages/db-core/test/matchmaking/*.spec.ts (new)
  - packages/db-p2p/test/matchmaking-*.spec.ts (new)
  - docs/matchmaking.md
  - docs/architecture.md
effort: high
difficulty: hard
----

# E2E mock-transport suite for matchmaking

## Purpose

The **mock-transport e2e tier** for matchmaking. It folds the matchmaking **unit-level** suites (in `db-core`, against the pure logic) and the **mesh integration** suites (in `db-p2p`, against the real provider/seeker managers over the in-process mock mesh). Real-network fidelity (hang-out under real latency/jitter) is the `substrate-e2e-real-libp2p-tier` ticket; the hang-out decision math under modeled load is validated by the simulator (`simulator-matchmaking-hangout`, folded into `docs/matchmaking.md`).

The implementation under test is `matchmaking-sweep-adversarial-module` and its prerequisites (`MatchmakingProvider`, `MatchmakingSeeker`, the hang-out engine, capability filter, multi-cohort sweep, adversarial bounds).

## Test infrastructure

Unit suites live in `packages/db-core/test/matchmaking/` and exercise pure logic with no network. Mesh suites build on the cohort-topic harness extensions from `cohort-topic-e2e-mock-tier` (do not fork it), adding matchmaking helpers:

```ts
// db-core unit surface (pure, no mesh)
// - wire round-trips: ProviderAppPayloadV1, SeekerAppPayloadV1, QueryV1, QueryReplyV1,
//   ProviderEntryV1, SeekerEntryV1, AggregateCountV1, CapabilityFilter
// - topicId(kind, label) determinism
// - capability filter: must[]/mustNot[]/minBudget eval
// - hang-out decision: expectedNewMatches, contentionFactor (cap=contention_factor_cap), threshold

interface MatchmakingMeshHarness extends CohortTopicMeshHarness {
	provide(node: number, kind: string, label: string, caps: CapabilityFilter, budget: number): Promise<ProviderHandle>;
	seek(node: number, kind: string, label: string, want: number, filter?: CapabilityFilter): Promise<MatchResult>;
	setTraffic(topicId: Uint8Array, arrivalsPerMin: number, queriesPerMin: number): void; // model regimes
	walkTrace(r: MatchResult): { tiersVisited: number; hungOutMs: number; matched: number };
}
```

The virtual clock drives provider TTL renewal (T2; Core 90s / Edge 60s), seeker short-TTL (5–15s), `requery_interval_ms` polling, and `patienceMs` drain.

## Scenario → claim mapping

### Unit (db-core)
- Wire codec round-trips for every matchmaking message type (base64url byte fidelity, reject malformed).
- `topicId(kind, label) = H(kind ‖ label ‖ "match")` deterministic per input; decorrelated across kinds/labels.
- Capability filter eval: `must[]` all-present, `mustNot[]` none-present, `minBudget` advisory; pathological filter matches ~nothing.
- Hang-out thresholds: the §Hang-out vs. continue **Test expectations** in `docs/matchmaking.md` become assertions — including the worked example (6 providers, arrivals=90, queries=4, wantCount=8, patience=10s ⇒ hang out) and the `contention_factor_cap=4.0` clamp.

### Mesh integration (db-p2p)
- **Sparse regime** (§Worked scenarios — sparse provider very large network): few providers ⇒ seeker walks all the way to root.
- **Hot regime** (§Hang-out — hot topic deep tier suffices): dense providers ⇒ a deep tier satisfies `wantCount` without escalation.
- **Borderline regime**: seeker hangs out for the full `patienceMs` at its landed tier, polling at `requery_interval_ms`, then resolves or escalates per the decision rule.
- **Tree promotion under load**: provider/seeker registrations grow the tree; assert depth tracks population per the simulator-validated regime.
- **Primary handoff on rotation** (§cohort-topic interaction): membership rotation hands off provider/seeker records with no loss; seeker repoints.
- **Provider lifecycle**: capacity tracking, `withdraw` (RenewV1 TTL=0), `signal-full` (capacityBudget=0) — assert seekers stop matching a full/withdrawn provider.
- **Multi-cohort sweep** (§Multi-cohort sweep): on a hot topic, seeker queries root for `AggregateCountV1` (log-bucketed per tier-1 shard, threshold-signed, returned only at depth ≥ `aggregate_count_minimum_tier`), then sweeps selected shards; assert counts correct per shard.
- **Adversarial traffic-report bounds** (§Failure modes — adversarial cohort traffic reporting): a single lying primary's over-report is bounded by `patienceMs` drain; under-report costs at most one extra hop per tier; assert harm stays within the documented worst case.

## Parameter sourcing

`patience_default_ms`, `patience_per_tier_fraction`, `filter_accept_ratio_initial`, `contention_factor_cap`, `requery_interval_ms`, `aggregate_count_minimum_tier`, provider/seeker TTLs, and the regime thresholds come from the simulator-validated values recorded in `docs/matchmaking.md` §Configuration. Import production config; do not hard-code drifting numbers. Do **not** implement the deferred refinements (`backlog/matchmaking-per-tier-patience-splitting`, `matchmaking-contention-from-seeker-pool`, `matchmaking-query-rate-limit`) — only reference them where a test reveals their motivating regime.

## TODO

### Phase 1 — unit suites (db-core)
- Wire round-trips; anchor derivation; capability filter eval; hang-out decision incl. worked example and contention cap.

### Phase 2 — harness extension
- Layer matchmaking helpers (provide/seek/setTraffic/walkTrace) onto the cohort-topic mesh harness; drive provider/seeker TTLs and `patienceMs`/`requery_interval_ms` via the virtual clock.

### Phase 3 — mesh suites
- Sparse/hot/borderline regimes; tree promotion under load; primary handoff; provider capacity/withdraw/signal-full lifecycle; multi-cohort sweep; adversarial traffic-report bounds.

### Phase 4 — claim mapping + doc sync
- Map every §Hang-out Test expectation and §Worked scenario in `docs/matchmaking.md` to a named test; tag unimplemented expectations.
- Update `docs/architecture.md` Doc Sync Status: matchmaking → mock-tier e2e **done** (real-libp2p e2e pending).

## Done when
- `yarn test` is green in both `packages/db-core` (unit) and `packages/db-p2p` (mesh); mock tier, no env gating, deterministic.
- `yarn build` passes for `db-core` and `db-p2p`.
- Every §Hang-out Test expectation and §Worked scenario in `docs/matchmaking.md` maps to a named or tagged-unimplemented test.
- `docs/architecture.md` Doc Sync Status reflects matchmaking mock-tier e2e complete.
