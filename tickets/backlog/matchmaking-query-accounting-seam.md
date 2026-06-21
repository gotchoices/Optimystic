description: The matchmaking traffic barometer always reports zero queries-per-minute because nothing in the live system ever records that a query happened, so the "should I keep waiting here?" decision a seeker makes is fed a blind spot.
prereq:
files:
  - packages/db-core/src/cohort-topic/traffic.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - docs/matchmaking.md
difficulty: medium
----

# Matchmaking: wire a query-accounting seam so `topicTraffic.queriesPerMin` is real

## Problem

`TrafficCounters.recordQuery(topicId, now)` exists in `packages/db-core/src/cohort-topic/traffic.ts`
(line ~105) and feeds the `queriesPerMin` field of the `TopicTrafficV1` snapshot. **No production code
anywhere in the repo calls `recordQuery`** — it has only test callers. As a result, every
`topicTraffic.queriesPerMin` served (including the one the new matchmaking `QueryV1` reply attaches via
`CoordEngine.topicTraffic` → `traffic.snapshot`) reads **0**, regardless of how hot a topic actually is.

This was surfaced during review of `matchmaking-query-rpc-cohort-serve`. The matchmaking query RPC
(`packages/db-p2p/src/matchmaking/query-transport.ts`) is the natural place to bump the query counter —
a query arriving at a cohort *is* the event `recordQuery` is meant to count — but:

- `CoordEngine` (the public host surface the transport is wired against) exposes **no** `recordQuery`
  seam; it exposes only the **non-mutating** read `topicTraffic(topicId)`. The cohort-serve ticket
  deliberately scoped `topicTraffic` as a pure read and did not add a mutating seam.
- So the serve handler currently cannot increment the counter without a new host method.

## Why it matters

`docs/matchmaking.md` §Hang-out vs. continue describes the seeker's hang-out decision consuming the
cohort's `topicTraffic` barometer (arrival rate **and** query rate) to decide whether to keep waiting at
a cohort or walk on. With `queriesPerMin` pinned at 0, the query-rate input to that heuristic is dead —
the decision degrades to arrivals-only. If/when the hang-out tuning is shown to need real query rates,
this becomes a functional gap, not just cosmetic.

## What to build (spec, not a plan)

A query-accounting seam such that an inbound matchmaking query (and any other genuine cohort query, e.g.
the `AggregateCountV1` sweep when it lands) increments the served coord's `TrafficCounters` for the
topic, so a subsequent `topicTraffic` snapshot reflects a non-zero `queriesPerMin` within one gossip
window.

Design constraints to respect:

- Keep `topicTraffic(topicId)` a pure read; add a **separate** mutating accessor (e.g.
  `recordQuery(topicId)` on `CoordEngine`/`CoordRegistry`) rather than overloading the read.
- The increment must key on the **served coord** for `topicId` (same resolution the serve handler
  already does: `findServing(topicId, 0) ?? findByCoord(coord0)`), and must **not** instantiate an
  engine from an inbound query (the no-engine→no-reply DoS guard must hold — a query for an unserved
  topic records nothing).
- Coordinate with `matchmaking-query-rate-limit`: that ticket already touches the per-peer inbound query
  path, so the rate-limit gate and the accounting bump likely share the same hook point. Decide whether
  accounting happens before or after the gate (a rate-limited/dropped query arguably should not inflate
  the barometer).
- Update `docs/matchmaking.md` (the §Seeker query / barometer notes) once a real query rate flows.

## Acceptance

- A cohort that has served N matchmaking queries for a topic within the traffic window reports
  `queriesPerMin > 0` in the `QueryReplyV1.topicTraffic` snapshot.
- The no-engine path still records nothing and still instantiates no engine.
- Build + db-p2p unit tests green; a unit test covers "serve a query → snapshot shows the increment".
