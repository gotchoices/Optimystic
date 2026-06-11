description: 50–200 logical-node mesh-harness suites validating cohort-topic registration walks, tree growth, promotion/demotion, willingness gating, TTL/failover, anti-flood, rate limiting, topic-budget LRU, and bootstrap — fast, deterministic, many logical nodes.
prereq: cohort-topic-core-module-fret-integration, simulator-metrics-and-scenarios
files:
  - packages/db-p2p/src/testing/mesh-harness.ts
  - packages/db-p2p/test/cluster-consensus-divergence.spec.ts
  - packages/db-p2p/test/cohort-topic-*.spec.ts (new)
  - docs/cohort-topic.md
  - docs/architecture.md
effort: high
difficulty: hard
----

# E2E mock-transport suite for cohort-topic at scale

## Purpose

This is the **mock-transport e2e tier** for the cohort-topic substrate (`cohort-topic-core-module-fret-integration`). It exercises the real `CohortTopicService` and its FRET wiring over the in-process mock mesh so that many logical nodes (50–200) run fast and deterministically. The companion `substrate-e2e-real-libp2p-tier` ticket covers small-N high-fidelity validation over real TCP/libp2p; quantitative scale claims (O(log N) depth, jitter bounds, convergence latency) are owned by the simulator (`simulator-metrics-and-scenarios`).

The mock tier's job is **behavioral correctness at scale that the simulator's modeled tree cannot prove** — i.e. that the *actual implementation* (wire codecs, FRET RouteAndMaybeAct routing, threshold-signature verification, gossip-replicated state) produces the registration walks, promotions, and anti-flood behavior the design specifies. Where the simulator produces a validated number (e.g. expected hop p95, jitter-bounded accept rate, convergence depth), this suite **asserts against that simulator-derived bound** rather than re-deriving it — hence the simulator prereq.

## Test infrastructure

Extend `packages/db-p2p/src/testing/mesh-harness.ts` (today: N nodes, `MockMeshKeyNetwork` with direct in-process XOR-distance routing) rather than adding a parallel harness. The harness must gain cohort-topic-aware helpers so suites stay declarative:

```ts
// Additions to mesh-harness.ts (sketch — names indicative)
interface CohortTopicMeshOptions {
	nodeCount: number;                 // 50–200 for these suites
	profiles?: ('edge' | 'core')[];    // per-node tier profile; default all core
	clock?: VirtualClockHandle;        // advance TTLs/jitter without wall-clock sleeps
	seed?: number;                      // deterministic placement + tie-breaks
}

interface CohortTopicMeshHarness {
	nodes: CohortTopicNodeHandle[];
	cohortFor(topicId: Uint8Array, d: number): CohortHandle;   // resolve cohort at coord_d
	register(node: number, topicId: Uint8Array, opts?: RegisterOptions): Promise<RegisterReplyV1>;
	depthOf(topicId: Uint8Array): number;                       // current instantiated tree depth
	dropNode(node: number): void;                               // crash / churn
	advance(ms: number): Promise<void>;                         // drive clock for TTL/jitter
	rpcTrace(): RpcTraceEntry[];                                // per-walk hop accounting
}
```

The harness must drive TTL renewal, ping cadence (`ttl/3`), `T_rejoin_jitter`, and promotion lookahead via an injectable virtual clock so suites never sleep on wall-clock. Reuse the multi-node setup/teardown and health-assertion patterns from `cluster-consensus-divergence.spec.ts`.

## Scenario → claim mapping

Every suite maps to a concrete claim in `docs/cohort-topic.md`. Each test references the doc section it validates; any doc test-expectation that the current implementation does not yet satisfy is **tagged in the test name** (e.g. `it.skip('... [DOC EXPECTATION NOT YET IMPLEMENTED]')`) and noted in the doc, not silently omitted.

- **Single-topic register / renew** (§Registration mechanics, §TTL and renewal): a node registers, receives `accepted`, pings every `ttl/3`, record survives; stop pinging → record evicts after `ttl`.
- **Tree growth under load** (§Tree growth and lookup): drive `> cap_promote` registrations at one coordinate; assert promotion fires and steady-state depth matches the simulator-validated `ceil(log_F(N/cap_promote))` regime for the populations under test.
- **Tier transitions / promotion & demotion** (§Promotion and demotion lifecycle): assert `PromotionNoticeV1` is threshold-signed and accepted; assert demotion only when load falls past `cap_demote` for `T_demote` **and** no child cohorts exist; assert no flap within the sticky window when load bounces across the bucket boundary.
- **Membership rotation + primary failover** (§Membership rotation and primary handoff, §Primary and backup sharding): rotate membership → previous primary dual-serves until new primary acks, no record loss; crash a primary → `backup[0]` promotes within the renewal window; participant repoints via `RenewReplyV1.primary_moved`.
- **Anti-flood verification** (§Anti-flood properties) — one test per claim:
  - cold-start storm: a burst of registrations probes `d_max` first (assert via `rpcTrace`), no root pile-up;
  - re-registration jitter: a synchronized re-registration wave is spread over `T_rejoin_jitter`; accepted/sec stays within the simulator-validated cap-matched bound;
  - no speculative outward probe: walks only move outward via `Promoted` redirects;
  - inward retry restart at `d_max`: after `UnwillingCohort`+`retryAfter`, retry restarts at `d_max`.
- **Rate limiting** (§Anti-DoS): a single peer exceeding `register_rate_per_peer` (4/min) at one cohort is rejected; well-behaved peers unaffected.
- **Topic-budget LRU** (§Anti-DoS): driving a cohort past `topics_max` evicts the least-recently-used cold topic.
- **Bootstrap flow** (§Cold-start instantiation): `RegisterV1{bootstrap:true}` instantiates a root forwarder under quorum willingness; a `Promoted` redirect instantiates a child that registers with its tier-(d−1) parent on first opportunity.

## Parameter sourcing

`cap_promote`, `cap_promote_fast`, `T_promote_lookahead`, `T_demote`, `T_rejoin_jitter`, `d_max_cap`, `register_rate_per_peer`, `topics_max`, and the expected hop/accept/convergence bounds are taken from the values the simulator settled and `fold-simulator-findings-into-design-docs` recorded in `docs/cohort-topic.md` §Configuration. This suite imports the production config defaults — it must not hard-code numbers that drift from the doc.

## TODO

### Phase 1 — harness extension
- Add cohort-topic helpers to `mesh-harness.ts`: registration/renewal driving, virtual-clock advancement for TTL/jitter/lookahead, cohort/coordinate resolution, per-walk RPC tracing, deterministic seeded placement.
- Wire the real `CohortTopicService` (from `cohort-topic-core-module-fret-integration`) onto each mock-mesh node.

### Phase 2 — core lifecycle suites
- Register/renew/TTL-eviction; tree growth + promotion depth; promotion/demotion with hysteresis and no-flap; membership rotation + primary/backup failover.

### Phase 3 — anti-flood / anti-DoS suites
- Cold-start storm, re-registration jitter, no-speculative-probe, inward-retry-restart; per-peer rate limit; topic-budget LRU; bootstrap/cold-start instantiation.

### Phase 4 — claim mapping + doc sync
- Audit `docs/cohort-topic.md` §Anti-flood properties and §Worked scenarios; ensure every claim has a named test; tag any unimplemented doc expectation in both the test and the doc.
- Update `docs/architecture.md` master **Doc Sync Status** section: cohort-topic substrate → mock-tier e2e **done** (real-libp2p e2e still pending).

## Done when
- `yarn test` in `packages/db-p2p` is green (suites run on the mock tier without env gating; deterministic across seeds).
- `yarn build` passes for `db-p2p`.
- Every §Anti-flood and §Worked-scenario claim in `docs/cohort-topic.md` maps to a named test or a tagged-as-unimplemented placeholder.
- `docs/architecture.md` Doc Sync Status reflects cohort-topic mock-tier e2e complete.
