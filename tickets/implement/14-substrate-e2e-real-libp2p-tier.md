description: Env-gated 3–16 real-TCP/libp2p node suites validating actual FRET cohort assembly + coordinate derivation, cohort-gossip membership rotation + primary handoff, MembershipCertV1 verification, reactivity notification delivery, and matchmaking hang-out under real network latency/jitter — small N, high fidelity.
prereq: cohort-topic-e2e-mock-tier, reactivity-e2e-mock-tier, matchmaking-e2e-mock-tier
files:
  - packages/db-p2p/test/real-libp2p.integration.spec.ts
  - packages/db-p2p/test/util/relay-topology.ts
  - packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (new)
  - docs/architecture.md
  - docs/cohort-topic.md
  - docs/reactivity.md
  - docs/matchmaking.md
effort: high
----

# E2E real-libp2p fidelity suite for cohort-topic, reactivity, and matchmaking

## Purpose

The **real-libp2p e2e tier**: the high-fidelity, small-N counterpart to the three mock-tier suites. The mock tier proves behavioral correctness at scale with deterministic in-process routing; this tier proves the substrate behaves correctly over **real TCP/libp2p transport, real FRET stabilization, and real latency/jitter** at small N (3–16 nodes). Scale is explicitly **out of scope** here — that is the mock tier's and the simulator's job.

These suites are **env-gated** exactly like `real-libp2p.integration.spec.ts` today (`OPTIMYSTIC_INTEGRATION=1` / `RUN_LONG_TESTS`): they must run when the gate is set and **skip cleanly** otherwise, so the default `yarn test` stays fast.

## Test infrastructure

Reuse the real-libp2p bring-up and topology patterns from `packages/db-p2p/test/real-libp2p.integration.spec.ts` and `packages/db-p2p/test/util/relay-topology.ts` (real TCP listeners, relay/dial topology, peer wiring). Add a new gated spec that stands up 3–16 real nodes running the production `CohortTopicService` + reactivity + matchmaking over real FRET, with a small fixed dialable topology.

```ts
// substrate-real-libp2p.integration.spec.ts (sketch)
const GATED = process.env.OPTIMYSTIC_INTEGRATION === '1' || process.env.RUN_LONG_TESTS === '1';
(GATED ? describe : describe.skip)('substrate over real libp2p', () => {
	// stand up N real nodes via relay-topology helpers; wait for FRET stabilization;
	// then exercise cohort-topic / reactivity / matchmaking against real cohorts.
});
```

Because real FRET stabilization and gossip are non-instant, assertions use bounded polling with generous timeouts (no fixed sleeps); tolerances reflect real network timing rather than the simulator's exact bounds.

## What this tier validates (fidelity, not scale)

- **FRET cohort assembly + coordinate derivation**: real FRET two-sided stabilization assembles the cohort at `coord_d`; assert the assembled membership and derived coordinate match what the substrate expects (the piece the mock mesh stubs).
- **Cohort-gossip membership rotation + primary handoff**: trigger a real membership change (node join/leave) → gossip propagates → primary handoff completes with no record loss over real RPC.
- **MembershipCertV1 verification**: a participant verifies a real threshold-signed promotion/membership cert end-to-end, including the one-fetch-and-retry path on a stale cached cert.
- **Reactivity notification delivery under real latency/jitter**: a commit on a real cohort member originates a `NotificationV1` (reusing the real commit certificate) that reaches a real subscriber, verified and contiguous; resume after a real disconnect uses backfill/checkpoint as appropriate.
- **Matchmaking hang-out under real network timing**: a seeker's hang-out vs. continue decision plays out against real `topicTraffic` and real RTTs; assert it converges to a match (regime-appropriate) rather than asserting an exact hop count.
- **Cluster-formation matching transaction clusters**: the cohort-topic cohort for a collection's tail matches the transaction cluster FRET forms for that key (consistency between the substrate and the transaction layer over the same ring).

## Doc sync

This is the **final** Doc Sync Status update for the program. After these suites pass under the gate:

- Flip `docs/architecture.md` master Doc Sync Status so all three subsystems read **simulator-validated + mock-tier e2e + real-libp2p e2e** complete.
- For each design doc (`docs/cohort-topic.md`, `docs/reactivity.md`, `docs/matchmaking.md`), update the §Worked scenarios with any **real-network observation that differs from the simulator** (e.g. real stabilization/handoff latency, real resume RTTs, real hang-out duration). Where real observations confirm the simulator, add a short "confirmed on real libp2p" note rather than restating numbers.

## TODO

### Phase 1 — gated harness
- Add `substrate-real-libp2p.integration.spec.ts` reusing `relay-topology.ts` + existing integration gating; stand up 3–16 real nodes running cohort-topic + reactivity + matchmaking; wait for FRET stabilization via bounded polling.

### Phase 2 — fidelity suites
- FRET cohort assembly + coordinate derivation; cohort-gossip membership rotation + primary handoff; MembershipCertV1 verification (incl. stale-cert refetch); reactivity notification delivery + resume under real latency; matchmaking hang-out under real timing; cluster-formation vs transaction-cluster consistency.

### Phase 3 — final doc sync
- Update `docs/architecture.md` Doc Sync Status to all-green (mock + real) for the three subsystems.
- Update §Worked scenarios in cohort-topic / reactivity / matchmaking with real-network observations that differ from the simulator; add "confirmed on real libp2p" notes where they match.

## Done when
- The new gated suites pass when `OPTIMYSTIC_INTEGRATION=1` (or `RUN_LONG_TESTS=1`) is set, and **skip cleanly** otherwise.
- Default `yarn test` in `db-p2p` remains green and fast (gated suites skipped).
- `yarn build` passes for `db-p2p`.
- `docs/architecture.md` Doc Sync Status shows all three subsystems validated at simulator, mock, and real-libp2p tiers; each design doc's §Worked scenarios reflect real-network observations.
