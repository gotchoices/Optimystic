description: Built the in-process test harness and test suites that exercise the matchmaking peer-discovery layer end-to-end over a simulated network — provider registration, querying, capacity/withdrawal, the seeker's hang-out walk, and the multi-cohort sweep — and marked the doc claims that still need real multi-tier tree growth as not-yet-testable.
prereq: matchmaking-sweep-adversarial-module, cohort-topic-e2e-mock-tier
files:
  - packages/db-p2p/src/cohort-topic/host.ts (CoordEngine.records seam — new)
  - packages/db-p2p/src/testing/matchmaking-mesh-harness.ts (new)
  - packages/db-p2p/test/matchmaking/mesh-lifecycle.spec.ts (new)
  - packages/db-p2p/test/matchmaking/mesh-walk.spec.ts (new)
  - packages/db-p2p/test/matchmaking/mesh-sweep.spec.ts (new)
  - docs/matchmaking.md (§Test expectations + §Worked scenarios mock-tier mapping; §Overview callout)
  - docs/architecture.md (Doc Sync Status: matchmaking mock-tier e2e → done)
----

# Matchmaking — mock-transport e2e tier

## What landed

The mock-transport e2e tier for matchmaking: the **real** provider/seeker managers, the **real**
cohort-side `QueryV1` handler, the **real** seeker walk client, and the **real** multi-cohort sweep,
driven end-to-end over an in-process mesh of real-Ed25519-keyed cohort-topic hosts — no live libp2p, a
virtual clock, deterministic.

- **`src/testing/matchmaking-mesh-harness.ts`** (new) — `MatchmakingMesh`, layered on (not forking) the
  cohort-topic `cohort-topic-mesh-harness.ts`. Public surface:
  - `provide(node, kind, label, caps, budget)` → real `MatchmakingProviderManager` →
    `CohortTopicService.register` walk; the signed `ProviderAppPayloadV1` lands in the real tier-0 cohort
    store. Returns a `ProviderHandle` whose manager drives `renew`/`setCapacity`/`signalFull`/`withdraw`.
  - `seek(node, kind, label, want, opts)` → real `SeekerWalkClient` over a transport whose per-tier
    register probes route through the real cohort engines and whose queries are served by the real
    `handleMatchmakingQuery` over real records, on a virtual clock. Returns a `MatchResult` (+ walk trace).
  - `query` / `cohortRecords` / `cohortEpochFor` / `providerEntries` — real cohort-store reads.
  - `setTraffic(topicId, traffic)` — models the hang-out **regime** (`arrivalsPerMin`/`queriesPerMin`/…);
    `walkTrace(r)` → `{ tiersVisited, hungOutMs, matched }`; `sweepTopic` (TTL eviction), `verifyEntryFor`.
- **`CoordEngine.records(topicId)`** (new seam in `host.ts`) — exposes the cohort's local registration
  records `store.listByTopic(topicId)` so the matchmaking query path / aggregate producer can read what a
  cohort holds. Small, additive, sits beside the existing `holds`/`servesTopic` accessors.
- **`mesh-lifecycle.spec.ts`** (6 passing) — provider register → cohort store → query round-trip +
  real `registrationSig` re-validation; capability filter (`must`/`mustNot`/`minBudget`, pathological);
  `signalFull` (budget→0 re-register) + `setCapacity`; `withdraw` → record ages out by TTL sweep.
- **`mesh-walk.spec.ts`** (5 passing, 3 `it.skip`) — sparse/cold walk-to-root; sparse-very-large-network
  (`d_max+1 = 6` real hops); hot-at-root immediate-done + hotness signal; borderline full-patience
  hang-out → partial set; adversarial over-report bounded by `patienceMs` with no spatial flood. The 3
  skips are the doc expectations needing a *serving* promoted tier (deep-tier-suffices, tree-promotion
  depth, rotation primary-handoff) — see Gaps.
- **`mesh-sweep.spec.ts`** (4 passing) — `runMultiCohortSweep` bound to the real `buildAggregateCount`
  (depth-gated + log-bucketed + threshold-signed) and real shard records: union real providers + verify
  each; cold-root depth-gate → empty; log-bucket-rounds-down/over-provision; forged shard entry rejected.
- **Docs** — `architecture.md` Doc Sync Status row flipped (matchmaking mock-tier e2e → done with spec
  refs); `matchmaking.md` §Test expectations + §Worked scenarios now map each claim to a named test (or a
  tagged-unimplemented `it.skip`), §Overview callout updated.

## Validation (ran)

- `yarn build` — **clean (exit 0)** in both `db-core` and `db-p2p`.
- `db-p2p` `yarn test` — **707 passing / 17 pending / 0 failing** (was 692/14 at the cohort-topic-e2e
  baseline: +15 new mesh tests, +3 tagged-unimplemented; no regressions from the `records()` seam).
- `db-core` `yarn test` — **818 passing / 0 failing** (unchanged; Phase-1 matchmaking unit suites were
  already complete from tickets 11/11.5/11.8/12 — `seeker-walk.spec.ts` already pins the §Hang-out worked
  example + edge cases 2/4/5 + the `contention_factor_cap` clamp, so no new db-core tests were needed).

## Use cases to exercise (reviewer)

- **Register→discover round-trip:** a provider registered through the real manager is returned by a
  seeker's cohort query, and the forwarded `registrationSig` re-validates against the provider's real
  Ed25519 peer key (`verifyEntryFor`). The advisory trust model holds end-to-end (a tampered/forged entry
  is dropped — see the sweep forgery test).
- **Capability filter** over real records: `must`/`mustNot`/`minBudget`; a `minBudget≥1` seeker stops
  matching a `signalFull`'d (budget-0) provider.
- **Hang-out regimes** driven by `setTraffic` over the real walk: cold→root, hot→immediate, borderline→
  drain patience then partial; adversarial over-report bounded by `patienceMs`, no outward probing
  (`tiersVisited == d_max+1`).
- **Multi-cohort sweep** port-binding: producer↔consumer↔real-records, depth gate, log-bucket
  over-provision, forgery rejection.

## Gaps / what is modeled vs. real (be honest — treat tests as a floor)

1. **Traffic regimes are MODELED, not real rates.** `setTraffic` injects `arrivalsPerMin`/`queriesPerMin`
   into the cohort's `Accepted`/query `topicTraffic`; the provider/seeker **population** is real, but the
   arrival *rate* is not (generating 90 arrivals/min deterministically on a virtual clock is infeasible —
   the same posture the design simulator takes). The hang-out *decision math* against a regime is the
   db-core `seeker-walk.spec.ts` floor; the mesh tier proves the regime drives the **real** walk over
   **real** records. A reviewer should sanity-check that this seam is a faithful proxy and not papering
   over a behavior the real barometer would produce differently.
2. **Single-tier-0 substrate.** The harness pins `cap_promote = 1_000_000` to hold a stable tier-0 cohort
   (otherwise the test artifact of registering several providers within a few ms spikes the growth slope
   and trips pre-promotion, bouncing later registrations in a `promoted`→`no_state` walk loop — diagnosed
   and documented in the harness). Consequently three §Hang-out/§Worked doc expectations are
   `it.skip([… DOC EXPECTATION NOT YET IMPLEMENTED …])`, gated on cohort-topic follow-ons:
   **hot-topic-deep-tier-suffices** (an `Accepted` above the root → `cohort-topic-followon-derivation`),
   **tree-promotion-under-load depth tracking** (`cohort-topic-parent-child-link`), and
   **primary-handoff-on-rotation** (cohort-topic rotation handoff, itself skipped in the cohort-topic
   e2e). These match the cohort-topic e2e's own tagged gaps; no new ticket filed (filing one would
   duplicate those parking tickets). If the reviewer disagrees that pinning `cap_promote` is acceptable
   modeling, the alternative is a hand-seeded multi-tier topology — heavier and arguably less honest.
3. **Patience does not drain on hops in the mesh.** Register hops are instant on the virtual clock (it
   advances only on hang-out `sleep`), so the "patience drains across walked tiers" expectation stays the
   db-core `seeker-walk-client.spec.ts` claim (which injects `hopCostMs`) — not re-asserted in the mesh.
   Noted in the doc mapping.
4. **Sweep crypto + topology are modeled.** `mesh-sweep.spec.ts` uses a deterministic `thresholdSign`
   stand-in and a single modeled tier-1 shard backed by the real cohort store. The
   *consumer↔producer↔real-records* integration (the explicit port-binding the
   `matchmaking-sweep-adversarial-module` review deferred to this ticket) is real; real `k − x` threshold
   assembly over a promoted root and a true multi-shard tree are gated on the same cohort-topic
   promotion follow-ons.
5. **Walk transport shortcut.** The seeker walk transport drives per-tier register probes via direct
   `engine.handleRegister` at the recomputed served coord + nearest node (mirroring the host's
   `dispatchRegister`), not the async FRET `routeAct` facade. Faithful to the dispatch path but a
   shortcut a reviewer may want to cross-check against the live `routeAct` walk.
6. **`gossipReplicate` is provided but unexercised** by the current suites — the query path reads the
   routed-primary's store directly (records land there from `service.register`), so cohort replication is
   not needed for these tests; it exists for future sibling-read / primary-handoff suites.
7. **Doc churn:** the per-feature `matchmaking.md` callouts still read "(mock-tier e2e pending)" for the
   narrower slice each describes; only §Overview + §Test expectations + the two §Worked scenarios were
   re-pointed. A reviewer may sweep the remaining parentheticals if desired (deliberately left to avoid
   ~10 churny edits and the risk of mis-stating which slice each covers).

## Done-when status

- ✅ `yarn test` green in `db-core` (unit) and `db-p2p` (mesh); mock tier, no env gating, deterministic.
- ✅ `yarn build` passes for `db-core` and `db-p2p`.
- ✅ Every §Hang-out Test expectation and §Worked scenario maps to a named test or a tagged-unimplemented
  `it.skip` (mapping callout in `matchmaking.md` §Test expectations + the two §Worked scenarios).
- ✅ `architecture.md` Doc Sync Status reflects matchmaking mock-tier e2e complete (real-libp2p pending).
