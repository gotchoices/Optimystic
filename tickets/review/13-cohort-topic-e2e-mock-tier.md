description: A new in-process test harness spins up 48–64 simulated nodes to check that the shared "find-the-peers-for-a-topic" layer actually behaves the way its design doc promises — registration, renewal, promotion, failover, and flood resistance — at realistic cohort sizes.
prereq: cohort-topic-core-module-fret-integration, simulator-metrics-and-scenarios
files:
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (new — extracted + scaled harness)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (refactored to consume the harness)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-lifecycle.spec.ts (new)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (new)
  - docs/cohort-topic.md (§Validation — mock-tier-at-scale coverage + tagged gaps)
  - docs/architecture.md (Doc Sync Status row)
difficulty: hard
----

# Review: cohort-topic mock-tier e2e at scale

## What this milestone delivered

The **mock-transport e2e tier** for the cohort-topic substrate, exercising the *real* `CohortTopicService`
/ `CohortMemberEngine` + FRET host over the in-process mock mesh at production-shaped cohort size
(`k = 16`, `minSigs = 14`) inside 48–64-node rings. Fast, deterministic, virtual-clock-driven (no
wall-clock sleeps).

Three pieces:

1. **`src/testing/cohort-topic-mesh-harness.ts`** — the cohort-topic mock harness, *extracted* from the
   inline machinery in `live-tier.spec.ts` (`CohortMesh`, `MockNode`/`MockStreamEnd` in-process duplex,
   the shared-FRET facade, real-Ed25519 `Member`s, signed-frame builders, `setupTopic` willingness seed)
   and generalized: `wantK < N` cohorts, per-node Edge/Core `profiles`, `antiDos` passthrough,
   `crashNode`, a `(key, result)` `routeTrace`, and `coordTierMap`/`walkTraceFrom` walk-trace
   reconstruction that feeds the db-core anti-flood predicates. `live-tier.spec.ts` now imports it (proves
   the extraction is faithful — its 6 tests stay green).
   - **Why a sibling of `mesh-harness.ts`, not folded in:** the ticket said "extend `mesh-harness.ts`," but
     that file is the *cluster* harness (`ClusterMember` / coordinator-repo / `NetworkTransactor`) and
     shares zero infrastructure with cohort-topic. They also collide on the `MeshOptions` export, so the
     `testing/` barrel can't `export *` both. The cohort-topic harness is a new sibling module under the
     same `src/testing/` dir; specs import it by path (the barrel still only re-exports the cluster one).

2. **`cohort-topic-scale-lifecycle.spec.ts`** (7 passing, 3 skip) — register / `ttl/3` renewal / TTL
   eviction; per-tier willingness gating (Edge refuses T3, Core admits); promotion at `cap_promote` +
   `Promoted(d+1)` redirect; sticky no-flap; root-never-demote; crash failover via signed `reattach`;
   gossip replication + eviction convergence across the whole `k`-member cohort.

3. **`cohort-topic-scale-antiflood.spec.ts`** (8 passing, 2 skip) — §Anti-flood claims 1 (walk
   discipline), 3, 4 asserted on *real* walks via `outwardMovesArePromoted` / `inwardStepsFollowNoState` /
   `retriesRestartAtDMax`; claim 2 `RejoinJitter` rate bound; §Anti-DoS per-peer rate limit, topic-budget
   refusal + LRU cold-eviction, and `bootstrap: true` root instantiation.

Doc sync: `docs/cohort-topic.md` §Validation gained a "Mock-tier e2e at scale" subsection enumerating the
mapped claims and a blockquote of every tagged gap with its parking ticket; `docs/architecture.md` Doc Sync
Status cohort-topic row updated.

## Verification done

- `yarn build` (db-p2p, `tsc` over src + test): **clean** (exit 0).
- `yarn test` (db-p2p, full suite, integration specs self-skip without `OPTIMYSTIC_INTEGRATION`):
  **692 passing, 14 pending, 0 failing** (~33 s). The `cohort-topic cold-start: parent registration … parent
  unreachable` line in the output is an expected `log()` from the pre-existing `host-antidos-coldstart`
  negative test, not a failure.
- Determinism: re-ran the new suites multiple times during development; no flakes observed. `participantPrimaryAt`
  generates keys until the slot lands (bounded ~16–240 tries); `waitFor` polls for the fire-and-forget
  promotion sign.

## Honest gaps — the reviewer should treat these as the floor, not the ceiling

**Tagged `it.skip([… DOC EXPECTATION NOT YET IMPLEMENTED …])` (5 total), each citing its parking ticket:**

- **Cold-start fan (claim-1 *distinct* `coord_{d_max}`).** My first cut asserted the fan and it failed:
  *all* walkers computed the **same** `coord_d` for `d ≥ 1`. Root cause is real and worth the reviewer
  confirming — `participantCoord` is carried as the **dialable peer-id**, and every Ed25519 libp2p id
  base58-encodes to a constant `"12D3KooW…"` prefix, so `prefix(P, d·log₂F)` is identical across all
  participants and `coord_d` collapses. This is exactly `cohort-topic-participant-coord-routing-key-mismatch`
  (already in backlog). The walk *discipline* underlying claim 1 IS asserted; only the fan is blocked.
- **Multi-tier depth / live `followOn` child instantiation** (`cohort-topic-followon-derivation`): host
  hardcodes `followOn: false`, so a `Promoted(1)` redirect never instantiates a tier-1 cohort over a live
  walk → the `⌈log_F(N/cap_promote)⌉` depth law is unreachable at this tier (it is simulator-owned).
- **tier-(d>0) demotion-notice broadcast** (`cohort-topic-parent-child-link`): no parent-side
  `childCohortCount` to observe. Hysteresis is unit-covered in db-core `promotion.spec.ts`.
- **Membership-rotation primary handoff** (`registration/handoff.ts` not wired into the host): no host-level
  rotation to observe. Crash failover is the wired path I *did* test.

**Other things to scrutinize:**

- **Virtual-clock base is `Date.now()`**, not a synthetic constant. Reason discovered the hard way: the
  inbound gossip bus's TTL-death guard (`gossip/bus.ts` `mergeRecords`) compares the *real* clock to a
  replicated record's `lastPing` — the host injects no virtual clock into the bus — so a record stamped far
  in the past is dropped as dead on replication. Relative TTL math stays deterministic; only the absolute
  base tracks wall time. **Latent flake risk:** if the whole suite ever runs > `ttl` (90 s) between a
  record's stamp and its replication merge, replication would spuriously fail. Current suite is ~3 s. A
  cleaner fix is a host seam to inject the bus clock — out of scope here, worth a follow-on if the bus clock
  bites again.
- **Topic-budget LRU cold-eviction is tested at the unit boundary** (`createTopicBudget` directly), not
  through the engine, because the engine touches the budget *up* on admission but the TTL sweep never
  touches it *down* on eviction, so a resident never reaches zero participants via the wire. That gap
  (sweep should re-touch the budget) may itself deserve a fix ticket — flagging, not filing.
- **`setupTopic` seeds the willingness quorum manually** (hand-injected signed willingness frames), rather
  than letting the live gossip cadence converge it — a deliberate harness shortcut mirroring the existing
  gossip-cadence tests. The reviewer may want one suite that lets the periodic driver converge willingness
  end-to-end instead.
- **Crash failover asserts the cohort side** (`reattach` lands on `backups[0]` → `ok` + override serves
  subsequent pings), not the participant-side `RenewalParticipant` 3-fail loop (which uses the real clock
  and a live dial). The participant loop is unit-covered in db-core; an e2e of the full
  ping-fail→reattach round-trip over the mock dial would strengthen this.
- **`walkOnce` returns `firstKey`** that is no longer consumed after the claim-1 rewrite (harmless dead
  return field).

## Suggested review focus

1. Confirm the `participantCoord` prefix-collision finding is real and that
   `cohort-topic-participant-coord-routing-key-mismatch` is the right home (it blocks the claim-1 fan *and*
   any meaningful multi-tier sharding).
2. Sanity-check the walk-trace reconstruction (`coordTierMap` + `walkTraceFrom`) faithfully represents what
   the real `WalkEngine` did — it underpins the claims 1/3/4 assertions.
3. Decide whether the two latent gaps surfaced here (bus-clock injection; budget re-touch on TTL eviction)
   warrant their own fix tickets now or ride the existing follow-ons.
