description: The matchmaking traffic barometer used to always report zero queries-per-minute because nothing recorded that a query happened; a served query now bumps the counter so the seeker's "keep waiting here or move on?" decision gets a real number. Review the wiring.
prereq:
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/test/matchmaking/query-transport.spec.ts
  - docs/matchmaking.md
difficulty: medium
----

# Review: matchmaking query-accounting seam (`topicTraffic.queriesPerMin` is now live)

## What was built

`TrafficCounters.recordQuery` in `packages/db-core/src/cohort-topic/traffic.ts` already existed and fed
`queriesPerMin`, but **no production code called it** — every served `queriesPerMin` was 0. This ticket
wired the missing call so a served matchmaking `QueryV1` bumps the counter for its topic.

Three source changes + tests + docs:

1. **`CoordEngine` gains a `recordQuery(topicId, now)` accessor** (`host.ts`):
   - Interface member added right after the `topicTraffic` declaration (~line 383), documented as a
     mutating accessor that is a pure passthrough to the engine's own `TrafficCounters`, lagging ≤ one
     gossip round exactly like the arrivals counter.
   - One-line impl in the return object next to `topicTraffic` (~line 2043):
     `recordQuery: (topicId, now) => traffic.recordQuery(topicId, now)`.
   - `topicTraffic` stays a **pure read** — the two are separate accessors, never overloaded.

2. **The serve handler bumps the counter** (`query-transport.ts` `createMatchmakingQueryHandler`):
   - New `clock?: () => number` on `MatchmakingQueryServeDeps` (default `Date.now`, injectable for tests).
   - `engine.recordQuery(topicId, (deps.clock ?? Date.now)())` placed **after** the `gate` check and
     **after** the `engine === undefined` no-reply guard, **before** the reply build. So a dropped,
     unserved, or malformed query never bumps the barometer; a query that resolved a serving engine is
     counted on serve even if signing later fails.

3. **A `// NOTE:` tripwire** at the `recordQuery` seam in `host.ts` pointing the future `AggregateCountV1`
   sweep RPC at the same accessor (no call site added for it now — out of scope).

Docs: `docs/matchmaking.md` §Decision inputs `queriesPerMin` bullet now says the field is fed live from
the `QueryV1` serve path (previously always 0), lags ≤ one round like `arrivalsPerMin`, and that pushes
do not inflate it (cross-refs the existing push-on-arrival contention note).

## The one-round-lag contract (verify this is understood, not a bug)

`recordQuery` pushes onto the raw sliding window; `topicTraffic`/`snapshot` read the **last-published**
frozen summary. So **the recording query does not see its own increment in its own reply** — the bump
surfaces only after the next `gossipRound` calls `traffic.publish`. This mirrors the arrivals counter and
is the documented contract, not a defect. The end-to-end test asserts both halves: snapshot before
publish reads 0, snapshot after publish reads 1.

## How to validate

- Build: `yarn workspace @optimystic/db-p2p build` → exit 0 (tsc, silent on success).
- Tests: `yarn workspace @optimystic/db-p2p test` → **1251 passing, 36 pending** at handoff.
- Targeted: `test/matchmaking/query-transport.spec.ts` → 14 passing (4 new accounting tests +
  updated `stubEngine` spy; the 9 pre-existing serve/gate/selection/sign-failure tests stay green).

### Test coverage added (`query-transport.spec.ts`)

- `stubEngine(records, calls?)` now carries a `recordQuery` spy pushing `{topicId, now}` onto `calls`.
- **Accounting happy path** — injected `clock: () => 12345`; asserts exactly one bump, keyed on the
  served `topicId`, stamped with the injected `now`.
- **End-to-end via a real `TrafficCounters`** — the handler's `recordQuery` delegates to a real
  `createTrafficCounters`; record → (snapshot still 0, self-increment lag) → `publish` →
  `snapshot(topicId).queriesPerMin === 1`. The `clock` and the `publish`/`snapshot` `now` are pinned to
  the same value (window-prune agreement; noted in the test comment).
- **No-engine records nothing** — `stubRegistry(undefined)` (whose `forCoord` throws) → no reply, seam
  never reached.
- **Gate rejection records nothing** — `gate: () => false` → no reply, spy count 0.
- **Malformed frame records nothing** — undecodable bytes → decode throws before `topicId` resolves →
  spy count 0.

## Acceptance (all met)

- A cohort that served a query for a topic in-window reports `queriesPerMin > 0` in a subsequent snapshot
  after a gossip round — covered by the end-to-end test.
- No-engine path records nothing / instantiates nothing (`forCoord` never called) — covered.
- Gate-rejected / malformed query records nothing — covered.
- `topicTraffic` remains a pure read; `recordQuery` is a separate mutating accessor.
- Build + db-p2p tests green.

## Known gaps / where to look hard (treat tests as a floor)

- **No live multi-node e2e for the accounting path.** The end-to-end test drives a real `TrafficCounters`
  but stubs the `CoordEngine` around it, and the happy-path bump test uses the spy stub. There is **no**
  test that stands up a real `createCohortTopicHost`, serves a `QueryV1` through the actual registered
  protocol handler, drives a real `gossipRound`, and reads `queriesPerMin` off the wire reply. The
  passthrough is one line and the pieces are each tested, but the *composition* (handler → real engine's
  `traffic` → `gossipRound` freeze → `QueryReplyV1.topicTraffic`) is asserted only by inspection. If the
  reviewer wants belt-and-suspenders, a `live-tier`-style test serving one query and asserting a later
  reply's `queriesPerMin` would close it.
- **Count-on-serve, not count-on-successful-build.** A query that resolves a serving engine but then fails
  to sign/encode the reply is still counted (the bump precedes the build). This is deliberate ("a query
  arriving at a cohort is the event"; sign failures are rare/transient) and documented at the call site,
  but it is a judgment call worth a second opinion — the alternative (count only after a successful
  build) would drop sign-failure queries from the barometer.
- **Clock/virtual-time coupling.** `recordQuery(topicId, now)` takes an explicit `now` and the handler's
  `clock` is injectable. A virtual-time host that drives `gossipRound` with synthetic timestamps must
  inject a matching `clock`, else the window prune at publish drops the real-`Date.now` query event. This
  is called out in the test comment; confirm any future virtual-time consumer honors it.
- **`createTrafficCounters` import in the spec** is from `@optimystic/db-core` (already exported; host.ts
  imports it) — not a new export.

## Review findings

- **Tripwire (parked, not a ticket):** the `recordQuery` seam in `host.ts` (~line 2043) carries a
  `// NOTE:` that the future `AggregateCountV1` sweep RPC should bump the same accessor. Recorded as a
  code comment at the site per tripwire policy; no call site added now (out of scope).
- **Coverage gap noted above:** no full-composition live e2e for the accounting path — flagged as a known
  gap, not filed as a ticket (the unit pieces cover the seam; escalate to a `debt-` ticket only if the
  reviewer judges the composition risk material).
