description: A brand-new group of nodes serving a topic used to deadlock — it could never accept its first user because idle nodes never told each other they were willing to help. Idle-but-willing nodes now announce willingness on a heartbeat, and a neighbour's announcement wakes a node that hadn't joined the group yet, so a fresh group bootstraps on its own.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (CohortGossipV1 gained treeTier)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validates treeTier)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (cohortGossipSigningPayload covers treeTier)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (buildCohortGossip heartbeat branch; DEFAULT_WILLINGNESS_HEARTBEAT_MS)
  - packages/db-p2p/src/cohort-topic/host.ts (gossipRound heartbeat clock; maybeInstantiateColdSibling in /cohort-gossip handler; willingnessHeartbeatMs option)
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts (signedWillingness treeTier; new pumpMeshGossip helper)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (heartbeat unit + host-round coverage)
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (test 5b: cold-bootstrap end-to-end)
  - packages/db-core/test/cohort-topic/{wire,gossip}.spec.ts (treeTier in literals)
  - docs/cohort-topic.md (§Willingness, §Cold-start instantiation, §Configuration)
difficulty: hard
----

# Review: cold-start bootstrap — willingness heartbeat + cold-sibling engine instantiation

## What the deadlock was (one paragraph)

A "cohort" is the ~`k` FRET peers responsible for a topic coordinate. A brand-new multi-node cohort
where every member is freshly brought up and holds no registrations (**idle**) could never admit its
first registration. Admission needs a *willingness quorum* read from gossiped sibling willingness, but an
idle engine built no gossip frame at all — so nobody advertised willingness, the routed member counted
only itself, and the register was declined `unwilling_cohort` forever. FRET routes every register for one
coord to the *same* nearest member, so the siblings were never independently woken either; the group never
got off the ground. The test harness `setupTopic` hid this by hand-seeding both engines and willingness.

## What was built (the primary design — NOT the Option-B fallback)

The ticket offered a primary design (A + B) and a smaller admission-only fallback. **The primary design
was implemented in full; the fallback was not taken**, so `willingness.ts` / `member-engine.ts` are
untouched and the existing quorum gate is satisfied honestly (no admission-policy relaxation).

- **Change A — idle-but-willing willingness heartbeat.** An idle engine that is willing for at least one
  tier (`selfWillingnessBits ≠ 0`) now emits a willingness/load-only gossip frame (empty `topicSummaries`,
  no record/eviction deltas). It emits immediately on the first idle round after the engine is created,
  then throttles to `T_willingness_heartbeat` (new default 30 s). A record-carrying round already ships
  willingness every round and resets the clock, so the throttle governs only genuinely-idle engines. Seam:
  `buildCohortGossip` gained a `heartbeat` flag; `CoordEngine.gossipRound` owns a per-engine `lastGossipAt`
  clock and decides `heartbeat` from idle-state + that clock.

- **Change B — cold-sibling engine instantiation.** When a node receives a `/cohort-gossip` frame for a
  coord it holds **no engine** for, it instantiates that engine (so the fresh bus joins the gossip and the
  next heartbeat reciprocates). Gated on the **existing** `verifyGossip(g, coord)` co-member check
  (signature verifies for `fromMember` AND `fromMember ∈ cohortAround(coord).members`), run **before**
  `deliver` (so the freshly-subscribed bus merges the very frame that woke it), **live-signer mode only**,
  and **`treeTier === 0` only**. Seam: `maybeInstantiateColdSibling` in the host's `/cohort-gossip` handler.

- **Wire — carry `treeTier`.** `forCoord(coord, treeTier, …)` needs a tier a hash-coord can't be inverted
  to, so `CohortGossipV1` gained `treeTier: number`, validated in `validate.ts` and **included in
  `cohortGossipSigningPayload`** (signed, so it can't be spoofed independent of the signature).

Convergence is ≈ 2 rounds: routed member heartbeats → siblings instantiate + merge willingness → siblings
heartbeat → routed member's view reaches quorum → retried register is admitted → record replicates.

## How to validate / exercise

Build then run the suites (all pass at handoff):

```
yarn workspace @optimystic/db-core build && yarn workspace @optimystic/db-p2p build
# db-core (from packages/db-core): wire + willingness + gossip → 86 pass; whole cohort-topic dir → 332 pass
# db-p2p  (from packages/db-p2p):  gossip-cadence + live-tier → 22 pass; whole cohort-topic dir → 183 pass, 5 pending, 0 fail
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/**/*.spec.ts" --reporter min --timeout 60000
```

Key new/changed coverage:
- `gossip-cadence.spec.ts` — `buildCohortGossip` now: idle+no-heartbeat → no frame; idle+heartbeat+willing →
  willingness-only frame (carries `treeTier`, empty summaries/records); idle+heartbeat+**unwilling** → no
  frame. The host-round test asserts an idle-but-willing engine's first round now emits a heartbeat (this
  is the assertion that flipped from `undefined`).
- `live-tier.spec.ts` **test 5b (the headline)** — a cold N-node cohort with **no `setupTopic` seed**:
  first register is declined (`CohortBackoffError`), a sibling holds no engine; two `pumpMeshGossip` waves
  (change A + B) bring it to quorum; a sibling instantiates off the heartbeat (change B); register-once →
  `accepted`; the admitted record replicates to a sibling (real failover path, not the harness seed).
- New harness helper `pumpMeshGossip(mesh, now)` drives one gossip round on every live engine across every
  node — the cold-bootstrap counterpart to `setupTopic`'s manual seed.

The prior `setupTopic` seed is kept (still a valid explicit fast-path), so the existing e2e/scale suites are
unchanged.

## Where the reviewer should push (honest gaps — treat tests as a floor)

1. **`verifyGossip` does not check *self*-membership.** `cohortAround(coord)` prepends self
   unconditionally (pre-existing convention), so the co-member gate only checks `fromMember ∈ assembled`.
   In practice a heartbeat only *reaches* nodes in the sender's assembled cohort, and FRET two-sided
   symmetry makes that mutual, so change B fires only for genuine co-members — but the reviewer should
   confirm this is acceptable and that no asymmetric-assembly path lets a legit member's frame make a true
   non-member instantiate an engine it shouldn't. Worst case is a bounded idle engine (see tripwire below),
   not incorrect admission.

2. **Tier-`d > 0` bootstrap is deliberately out of scope.** Instantiation is gated to `treeTier === 0`; a
   tier-`d > 0` frame for an unknown coord falls through to today's drop. The dummy `participantCoord`
   passed to `forCoord` (self's bytes) is only ever read by the tier-`d > 0` parent-coord derivation, which
   a tier-0 engine never exercises (demotion is gated on `treeTier > 0`). Confirm this invariant holds — if
   a tier-0 engine ever reached the parent-coord path, the dummy would be wrong.

3. **Wire-compat break.** Adding `treeTier` to the signing payload changes the `CohortGossipV1` signed
   image — acceptable pre-release (the whole cohort-topic layer is unreleased), but any persisted/replayed
   old gossip would no longer verify. Nothing persists gossip today; confirm.

4. **Heartbeat throttle in virtual-time tests.** The mesh parks the periodic timer, so tests pump
   `gossipRound` with an explicit `now`; the "first idle round emits immediately" behavior is what makes a
   fixed-`now` two-wave pump converge. Production uses the real periodic driver (`gossipIntervalMs`) and the
   30 s throttle. The reviewer may want a test that advances `now` past `T_willingness_heartbeat` to assert
   the steady-state re-broadcast (not just the first-round emit) — not currently covered.

## Tripwires recorded (knowledge, not queued tickets)

Both are `NOTE:` comments at the sites plus a §Cost bullet in `docs/cohort-topic.md` §Cold-start
instantiation:

- **Gossip-instantiated engines are never reclaimed** (`createCoordRegistry` has no eviction) — a permanent
  per-co-member-coord engine cost, bounded by real FRET co-membership. `NOTE:` at
  `maybeInstantiateColdSibling`. If idle engines ever accumulate in practice, that becomes a real
  `debt-` ticket (LRU / idle-reclaim over gossip-instantiated engines).
- **Heartbeat re-broadcasts willingness for every idle willing cohort every `T_willingness_heartbeat`** —
  `NOTE:` at the `lastGossipAt` heartbeat site. The throttle + the willing-for-something gate are the
  mitigations; a node serving very many idle cohorts may need batching or a longer interval.

## No pre-existing failures

No `tickets/.pre-existing-error.md` was written — every suite run was green (or pre-existing pending). The
one `parent unreachable` line during the db-p2p run is an expected `log()` from
`host-antidos-coldstart.spec.ts`'s deliberate-unreachable fallback test, not a failure.
