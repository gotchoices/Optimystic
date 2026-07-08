description: The matchmaking traffic barometer used to always report zero queries-per-minute because nothing recorded that a query happened; a served query now bumps the counter so the seeker's "keep waiting here or move on?" decision gets a real number.
prereq:
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-core/src/cohort-topic/traffic.ts
  - packages/db-p2p/test/matchmaking/query-transport.spec.ts
  - docs/matchmaking.md
----

# Complete: matchmaking query-accounting seam (`topicTraffic.queriesPerMin` is now live)

## What shipped

`TrafficCounters.recordQuery` (db-core) already fed `queriesPerMin`, but no production code called
it — every served `queriesPerMin` was 0. The implement stage wired the missing call so a served
matchmaking `QueryV1` bumps the counter for its topic:

1. **`CoordEngine.recordQuery(topicId, now)`** — a mutating accessor on the engine interface
   (`host.ts`), a pure passthrough to the engine's own `TrafficCounters.recordQuery`. `topicTraffic`
   stays a pure read; the two are never overloaded. Surfaces in `topicTraffic`/`snapshot` only after
   the next `gossipRound` calls `traffic.publish` (lags ≤ one round, exactly like `arrivalsPerMin`).
2. **The serve handler bumps it** (`query-transport.ts` `createMatchmakingQueryHandler`) — a new
   injectable `clock?: () => number` (default `Date.now`); the bump sits **after** the gate + no-engine
   guards and **before** the reply build, so a dropped/unserved/malformed query never counts, but a
   query that resolved a serving engine is counted on serve even if signing later fails.
3. **Docs** — `docs/matchmaking.md` §Decision inputs now states `queriesPerMin` is fed live from the
   `QueryV1` serve path (previously always 0), lags ≤ one round, and that pushes do not inflate it
   (cross-refs the existing push-on-arrival contention note at §Push-on-arrival, verified present).

## Review findings

Reviewed the implement diff (`fbe1e12`) with fresh eyes against every touched file plus `traffic.ts`
(which the change relies on but did not edit), then re-ran build + full db-p2p suite.

- **Correctness — bump placement (checked, correct).** The `recordQuery` call is inside the handler
  `try` but delegates to a trivial `array.push` that cannot throw, so it cannot convert a servable
  reply into a no-reply. Placement after gate + no-engine guards and before reply build matches the
  documented count-on-serve contract. No defect.
- **Type safety (checked, correct).** `recordQuery` is a **required** interface member; the only
  production implementer is `createCoordEngine` (verified — the mesh harnesses consume real engines
  from that factory, they don't construct `CoordEngine`s), so `tsc` stays green. Build exit 0.
- **One-round-lag contract (checked, correct).** `recordQuery` pushes onto the raw window; snapshot
  reads the last frozen summary — the recording query does not see its own increment until the next
  `gossipRound` freezes it. The end-to-end test asserts both halves (0 before publish, 1 after). This
  mirrors the arrivals counter and is the intended contract, not a bug.
- **Test coverage (floor raised inline).** The implementer's 4 accounting tests (happy-path bump,
  end-to-end lag via a real `TrafficCounters`, no-engine, gate-reject, malformed) are a solid floor. I
  **strengthened the pre-existing sign-failure test inline** to also assert the query is still counted
  when signing fails — locking the deliberate "count-on-serve, not count-on-successful-build" choice
  that was previously asserted only by inspection. Suite: **1251 passing, 36 pending** after the edit.
- **Tripwire (parked as a `// NOTE:`, not a ticket) — non-resident query-window prune.** `recordQuery`
  is the first caller that can push to a traffic window for a topic that never becomes **resident**
  (the recordless `findByCoord` serve fallback at `query-transport.ts:149`). `recordArrival` always
  creates a store record → resident → pruned by `publish` every round; a query recorded against a
  recordless topic is never in `residentTopics()`, so `gossipRound` never `publish`es it, and
  `traffic.forget` fires only on topic-budget eviction (which never admitted it). Its window therefore
  prunes only at epoch `reset()`. Harmless today — bounded by epoch lifetime and the serve gate, a few
  timestamps per query — so recorded as a `NOTE:` at the `recordQuery` seam in `host.ts` (~line 2055)
  per tripwire policy, not filed. Becomes work only if a node serves high-volume queries for topics it
  holds no records for; the NOTE names the fix (timer-prune non-resident windows or forget on engine idle).
- **Tripwire (already parked by the implementer).** The `recordQuery` seam carries a `// NOTE:` that
  the future `AggregateCountV1` sweep RPC should bump the same accessor. Left as-is (out of scope).
- **Coverage gap (noted, not filed).** No full-composition live e2e stands up a real
  `createCohortTopicHost`, serves a `QueryV1` through the registered protocol handler, drives a real
  `gossipRound`, and reads `queriesPerMin` off the wire reply. The seam is one line and each piece is
  unit-tested; the composition is asserted by inspection + the real-`TrafficCounters` end-to-end test.
  Not escalated to a `debt-` ticket — the unit pieces cover the seam and the composition risk is low.
  A future `live-tier`-style test would close it if a maintainer judges it worth the fixture cost.

**No major findings; no new tickets filed.** Build + db-p2p tests green.

## Validation

- Build: `yarn workspace @optimystic/db-p2p build` → exit 0.
- Tests: `yarn workspace @optimystic/db-p2p test` → 1251 passing, 36 pending (unchanged count; the
  sign-failure strengthening extended an existing test rather than adding one).
