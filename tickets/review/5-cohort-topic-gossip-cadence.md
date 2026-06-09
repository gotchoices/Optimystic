description: Review the cohort gossip-cadence driver (gap 5) — host periodic timer that broadcasts each CoordEngine's willingness/load/traffic + registration-record deltas, per-touch replication via the renewal touch/evicted hooks, per-coord inbound routing, signed gossip, plus sweep/membership-refresh/demotion on the same tick.
files:
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (NEW — pending-delta queue + buildCohortGossip + DEFAULT_GOSSIP_INTERVAL_MS)
  - packages/db-p2p/src/cohort-topic/host.ts (driver timer, signGossip/verifyGossip, per-coord delta hooks, gossipRound/demotionTick/cohortView, gossipIntervalMs option, stop() teardown)
  - packages/db-core/src/cohort-topic/wire/types.ts (CohortGossipV1.coord)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validate coord)
  - packages/db-core/src/cohort-topic/wire/payloads.ts (cohortGossipSigningPayload)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (coord routing + verifyInbound auth gate)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (NEW)
  - packages/db-core/test/cohort-topic/gossip.spec.ts (coord routing + verifyInbound tests; helper fix)
  - packages/db-core/test/cohort-topic/wire.spec.ts (sampleGossip coord)
  - docs/cohort-topic.md, docs/internals.md (gossip cadence + per-coord routing)
----

# Review: cohort-topic gossip publishing cadence + per-touch replication

## What landed

The cohort gossip bus existed and was db-core-unit-tested, but nothing drove it on a cadence and the
renewal `touch`/`evicted` hooks were no-ops, so records never replicated and willingness/load/traffic
never propagated. This change supplies the host-side driver and closes the routing/auth gap.

### db-core
- **`CohortGossipV1.coord`** (new required field, `wire/types.ts` + `wire/validate.ts`): the cohort coord
  a gossip is for — the inbound routing key.
- **`cohortGossipSigningPayload`** (`wire/payloads.ts`): canonical signed image of a gossip envelope
  (every field except `signature`), nested records/summaries/evictions emitted as fixed ordered tuples
  so signer and receiver agree byte-for-byte (mirrors the register/renew/notice payload helpers).
- **Gossip bus** (`gossip/bus.ts`): (a) **coord routing** — a frame fanned to every coord engine's bus
  merges only when its `coord` matches the bus's coord (epoch alone can't isolate two cohorts that share
  a member set); (b) optional **`verifyInbound`** auth gate on the transport-delivery path (db-p2p binds
  peer-sig + cohort membership), dropping forged/non-member gossip before any merge. Direct
  `applyInbound` (the trusted test/internal path) keeps the coord-routing guard but skips auth.

### db-p2p
- **`cohort-gossip-driver.ts`** (new): `createPendingDeltas()` (per-coord touch/evicted queue,
  last-writer-wins by `lastPing`, drain), `buildCohortGossip()` (assembles one round's frame or returns
  `undefined` when idle), and `DEFAULT_GOSSIP_INTERVAL_MS = 5_000`.
- **`host.ts`**:
  - `gossipIntervalMs` option (default 5 s); a single `setInterval` driver (`unref`'d) that, per live
    `CoordEngine`, runs `gossipRound` → `pumpMembership` → `demotionTick`. Re-entrancy guard (`ticking`)
    + `stopped` flag; `stop()` sets `stopped`, `clearInterval`s, then tears down. Timer is created
    **after** all five protocol handlers + the activity handler are live.
  - Per-`CoordEngine`: the `RenewalGossip` no-ops are replaced with delta-queue handlers; `gossipRound`
    sweeps stale → freezes traffic summaries → drains deltas → builds → **signs** → broadcasts (idle
    engines skip); `demotionTick` runs `maybeDemote` per resident topic and broadcasts notices via the
    existing `onNotice`/`broadcastNotice` path; new read-only `cohortView()` accessor.
  - `signGossip`/`verifyGossip` closures (live-signer mode): sign the envelope with the node peer key;
    on inbound, verify `fromMember`'s signature **and** that `fromMember` is in the cohort around the
    served coord. Wired into each coord engine's bus (and the participant bus) as `verifyInbound`.

## How to validate (use cases / tests)

`yarn test:db-core` (541 passing) and `yarn test:db-p2p` (552 passing) are green; both `tsc` builds are
clean. New/changed coverage:

- **`packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts`** (7 tests):
  - pending-delta queue: touch last-writer-wins; touch-after-evict and evict-after-touch supersession.
  - `buildCohortGossip` idle-skip + willingness packing + signature slot left empty.
  - host gossip round drains a touched record into a **signed, coord-scoped** frame; the signature
    verifies against the node key; a second round (no fresh deltas) still advertises the resident topic.
  - **two-coord inbound routing isolation**: a self-only node serves two coords with the *same* epoch; a
    gossip for coord A merges only into coord A's store — proving routing isolates by coord, not epoch.
  - **two-node replication via a gossip round**: node A (after a seeded willingness quorum + a re-attach
    touch) broadcasts; node B replicates the record in one round, B's view gains A's willingness/load,
    and a later **eviction converges** (B drops the swept record).
  - **timer lifecycle**: the driver broadcasts on a fast cadence and fires **no** further rounds after
    `stop()`.
- **`packages/db-core/test/cohort-topic/gossip.spec.ts`**: coord-routing drop + `verifyInbound`
  drop/pass on the transport path.

Manual sanity: a node serving many cohorts broadcasts once per non-idle coord per tick; idle empty
engines are skipped; `gossipIntervalMs` injects the cadence.

## Known gaps / things to scrutinize (treat tests as a floor)

1. **Fresh-record replication latency.** The member-engine `accept()` path (db-core) does *not* fire
   `gossip.touch`, so a freshly *admitted* record only enters the delta queue on its **first renewal
   touch** (≤ `ttl/3` ≈ 30 s). A primary that accepts then crashes before that first ping leaves no
   replica. Closing this means an `accept()`-time gossip hook in db-core's `member-engine.ts` — out of
   this ticket's stated scope (renewal hooks). Reviewer: decide whether to spawn a fix ticket. The
   two-node test deliberately uses a re-attach to exercise the working per-touch path.

2. **Cold-cohort willingness bootstrap.** Idle engines (no resident topics) skip gossip, and admission
   in a multi-member cohort needs a quorum of *gossiped* sibling willingness. So a brand-new multi-node
   cohort cannot admit its first registration until some sibling has a topic to gossip about —
   a chicken-and-egg the per-coord-scoping ticket already flagged ("multi-member admission awaits the
   willingness-gossip wiring"). This ticket wires the cadence but does **not** resolve the cold-start
   bootstrap; the tests seed sibling willingness explicitly. Likely needs a deliberate "willingness
   heartbeat even when idle" or an admission-policy adjustment — candidate follow-on.

3. **Driver `pumpMembership`/`demotionTick` over a real network.** The driver merely calls methods the
   threshold-assembly and promote-verify-apply tickets already test directly. `demotionTick` is a no-op
   for the tier-0 single-cohort milestone (root never demotes). `pumpMembership` for a multi-member
   keyed cohort dials `/sign` over libp2p; the gossip-cadence tests park the timer or avoid that path,
   so the **driver-driven** membership/demotion broadcast is not exercised end-to-end here.

4. **Test harness fidelity.** The two-node test delivers A's real gossip frame to B by invoking B's
   actual `/cohort-gossip` handler (→ `transport.deliver` → bus) directly; A's *outbound* dial is a
   no-op fake (`dialProtocol` rejects, swallowed). So the full libp2p stream round-trip
   (`sendOneWay`→`dialProtocol`→muxer→`readAllBounded`) is **not** exercised by these tests — only the
   handler + transport + bus path. The wire path is covered indirectly by other protocols' tests.

5. **Timer test timing.** Uses real `setTimeout` (interval 25 ms, 120 ms windows). Robust assertions
   (`>1` dial; stable after stop) but mildly wall-clock-sensitive on a heavily loaded CI box.

6. **`windowSeconds` constant.** `buildCohortGossip` passes `DEFAULT_TRAFFIC_WINDOW_SECONDS` (60),
   matching the engines' default-windowed traffic counters. If a later ticket makes the traffic window
   per-engine configurable, thread it from the same source rather than this constant.

7. **Wire compat.** `coord` is now a **required** field on `CohortGossipV1` (per AGENTS.md "don't worry
   about backwards compatibility yet"). Any out-of-tree gossip producer must add it.
