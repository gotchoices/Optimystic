description: Drive the cohort gossip layer from the host (gap 5) — a periodic timer that broadcasts each CoordEngine's willingness/load/traffic + registration-record deltas, plus wiring the renewal touch/evicted hooks to per-touch replication and running the TTL sweep and membership-cert refresh tick on the same driver.
prereq: cohort-topic-per-coord-scoping
files:
  - packages/db-p2p/src/cohort-topic/host.ts (periodic driver; touch/evicted hooks; sweep + cert tick)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (CohortGossipBus.broadcast / applyInbound / view)
  - packages/db-core/src/cohort-topic/registration/renewal.ts (RenewalGossip touch/evicted shape)
  - packages/db-core/src/cohort-topic/load/barometer.ts (loadBuckets / loadWilling)
  - packages/db-core/src/cohort-topic/traffic.ts (snapshot for topicSummaries)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts (broadcast / deliver / onMessage)
  - packages/db-core/src/cohort-topic/wire/types.ts (CohortGossipV1)
----

# Cohort-topic: gossip publishing cadence + per-touch replication

The cohort gossip bus (`createCohortGossipBus`) is fully built and db-core-unit-tested — merge,
last-writer-wins record replication, willingness/load/traffic view, eviction convergence. What is
absent is the **host-side driver**: nothing calls `bus.broadcast(...)` on a cadence, and the
renewal `touch`/`evicted` hooks are interim no-ops, so registration records never replicate across
cohort members and willingness/load/traffic never propagate. This ticket supplies the timer and the
hooks.

## Design

### Periodic driver

The host owns a single repeating timer (raw `setInterval`; db-core has no timer port — confirmed).
On each tick, for every live `CoordEngine`:

1. **Sweep** stale records: `engine.sweepStale(now)` (evicts `now − lastPing > ttl`, firing the
   `evicted` hook → queued for the next gossip round).
2. **Build + broadcast** a `CohortGossipV1` via `bus.broadcast(g)`:
   - `willingnessBits` packed from `profile.willingTiers ∧ barometer.loadWilling(tier)`,
   - `loadBuckets` from `barometer.loadBuckets()`,
   - `topicSummaries` from the traffic layer per resident topic (`directParticipants`,
     `arrivalsPerMin`, `queriesPerMin`, `promoted`, `childCohortCount`),
   - `records` / `evicted`: the **deltas accumulated since the last round** by the touch/evicted
     hooks (see below),
   - `timestamp`, `fromMember`, `cohortEpoch`, `signature`.
   The transport (`FretCohortGossipTransport.broadcast(servedCoord, frame)`) fans it to the cohort.
3. **Membership cert tick**: call the `CoordEngine`'s `pumpMembership(now)` (threshold-assembly
   ticket exposed it) so `MembershipCertPublisher.tick` re-publishes every `T_membership_refresh`
   (5 min) and `onStabilized` fires on a first-`k−x` change.
4. **Demotion tick**: call `promotion.maybeDemote(topicId, now)` per resident topic; broadcast any
   returned `DemotionNoticeV1` (promote-verify-apply ticket owns the broadcast path — reuse its
   `onNotice`).

Inbound gossip is already routed: the `cohort-gossip` protocol handler calls
`gossipTransport.deliver(from, frame)`; ensure each `CoordEngine`'s bus subscribes
(`bus.onGossip`/`applyInbound`) so deltas merge into its store. Route an inbound gossip frame to the
right `CoordEngine` by the `coord` it carries (the gossip transport broadcasts per served coord, so
the frame must identify its coord — include it in the envelope or key the delivery by the protocol
stream's coord context).

### Tick interval

There is no dedicated gossip-round constant; derive one. Use a `gossipIntervalMs` host option
(default ~ one gossip round; align with the traffic window / ping cadence — a few seconds, e.g.
`pingIntervalMs(DEFAULT_TTL_MS)/k`-ish, but keep it a simple injectable default such as 5_000 ms and
document it). The membership refresh (5 min) and `T_demote` (5 min) hysteresis are multiples checked
by elapsed-time inside their modules, so the driver can tick fast and let the modules gate.

### touch / evicted hooks → delta queue

Replace the no-op `RenewalGossip` hooks per `CoordEngine` with handlers that append to a
per-`CoordEngine` pending-delta set:

- `touch(rec)` → upsert `rec` into `pendingRecords` (keyed by `(topicId, participantId)`; last write
  wins on `lastPing`),
- `evicted(rec)` → add a ref to `pendingEvicted` and drop any pending record for it.

The next broadcast drains both into the `CohortGossipV1.records` / `.evicted` fields and clears them.
This is the per-touch replication the docs call for (§Registration mechanics, "gossips the touch to
the cohort"), batched to one round to avoid a broadcast per ping.

## Edge cases & interactions

- **Inbound coord routing:** a delivered gossip frame must reach the bus for its coord, not a random
  `CoordEngine`. Ensure the envelope carries the coord (or the transport keys delivery by it). Test
  a two-coord node: a gossip for coord A must not merge into coord B's store.
- **Epoch reset of counters:** the traffic layer resets per-topic counters on `cohortEpoch` change;
  the first post-rotation round under-reports (documented; consumers tolerate). Don't special-case.
- **Eviction vs late touch:** a record evicted locally but touched on a sibling re-appears via merge
  if its `lastPing` is fresher than the eviction — last-writer-wins by `lastPing`, with the TTL
  filter preventing resurrection of a record already past TTL. Verify the bus's existing merge rule
  holds end-to-end (it's unit-tested in db-core; add a host-level two-node replication test).
- **Timer lifecycle:** the driver `setInterval` must be cleared in `host.stop()` (store the handle);
  a tick after `stop()` must not throw (guard on a stopped flag). No tick should run before all four
  (now five) protocol handlers are live.
- **Broadcast to a one-member cohort:** with only self in the assembly, `broadcast` fans to nobody;
  the local store is already authoritative — no error.
- **Signature on gossip:** `CohortGossipV1.signature` — decide intra-cohort gossip authenticity.
  Default: sign the gossip envelope with the node peer key (`peer-sig.signPeer` from the
  peer-key-signing ticket) and have `applyInbound` drop frames from a non-cohort member or with a
  bad sig. If the bus already treats `signature` as opaque, keep it minimal but do not leave it
  trivially spoofable; document the choice. (This couples loosely to the peer-key-signing ticket; if
  that hasn't landed in this branch, leave the field as the bus currently expects and note the gap.)
- **Driver cost under many coords:** a node serving many coords broadcasts once per coord per tick;
  bound by the same per-coord registry the scoping ticket established. Document that idle empty
  engines are skipped (no records, no topics → no broadcast).

## TODO

- Add a `gossipIntervalMs` host option (default 5_000 ms; documented) and a single repeating driver
  that iterates live `CoordEngine`s.
- Per `CoordEngine`, replace the no-op `touch`/`evicted` with delta-queue handlers; drain into the
  broadcast.
- Build the `CohortGossipV1` per round (willingness/load/traffic/records/evicted) and `bus.broadcast`.
- Run `sweepStale`, `pumpMembership(now)`, and `maybeDemote` per tick; broadcast resulting demotion
  notices via the promote `onNotice` path.
- Ensure inbound gossip routes to the correct `CoordEngine` bus by coord; subscribe each bus.
- Clear the timer in `host.stop()`; guard ticks after stop.
- (If peer-key-signing has landed) sign the gossip envelope and drop spoofed/non-member frames.
- Tests: two in-process nodes in one cohort replicate a registration record via a gossip round;
  willingness/load propagate into the view; an evicted record converges; timer clears on stop;
  two-coord delivery isolation.
- Run `yarn test:db-core`, `yarn test:db-p2p` (stream with `tee`), and the type-check before handoff.
