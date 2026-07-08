description: The matchmaking traffic barometer always reports zero queries-per-minute because nothing in the live system ever records that a query happened; add the missing hook so a served query bumps the counter and the "should I keep waiting here?" decision gets a real number.
prereq:
files:
  - packages/db-p2p/src/matchmaking/query-transport.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-p2p/test/matchmaking/query-transport.spec.ts
  - packages/db-core/src/cohort-topic/traffic.ts
  - docs/matchmaking.md
difficulty: medium
----

# Matchmaking: wire a query-accounting seam so `topicTraffic.queriesPerMin` is real

## Problem (recap)

`TrafficCounters.recordQuery(topicId, now)` exists in `packages/db-core/src/cohort-topic/traffic.ts`
and feeds the `queriesPerMin` field of the gossip-derived `TopicTrafficV1` snapshot. **No production
code calls it** — only tests. So every `topicTraffic.queriesPerMin` served (including the one the
matchmaking `QueryReplyV1` attaches via `CoordEngine.topicTraffic` → `traffic.snapshot`) is **0**,
regardless of how hot a topic is. The seeker's hang-out-vs-continue heuristic
(`docs/matchmaking.md` §Hang-out vs. continue) consumes `queriesPerMin` as its contention input, so
today that input is dead and the decision degrades to arrivals-only.

An inbound matchmaking `QueryV1` arriving at a cohort **is** the event `recordQuery` counts. The
natural bump site is the serve handler in `packages/db-p2p/src/matchmaking/query-transport.ts`.

## Design (resolved — build this, no open options)

### The seam: engine-level, not registry-level

Add a mutating accessor to **`CoordEngine`** only:

```ts
// packages/db-p2p/src/cohort-topic/host.ts — CoordEngine interface
/**
 * Record that an application-level query (matchmaking QueryV1, and any future genuine cohort query
 * such as the AggregateCountV1 sweep) was served against `topicId` at `now`. Feeds queriesPerMin.
 * Pure passthrough to this engine's TrafficCounters — no store lookup, no instantiation. The counter
 * surfaces in `topicTraffic(topicId)` only after the next `gossipRound(now)` freezes it (lags ≤ one
 * round, exactly like the arrivals counter). Non-fatal / synchronous.
 */
recordQuery(topicId: Uint8Array, now: number): void;
```

Implementation is one line at the `CoordEngine` return object (next to `topicTraffic`):

```ts
recordQuery: (topicId: Uint8Array, now: number): void => traffic.recordQuery(topicId, now),
```

**Why engine-level and NOT a new `CoordRegistry.recordQuery`** (the ticket listed both as options):
the serve handler *already* resolves the served engine via
`registry.findServing(topicId, 0) ?? registry.findByCoord(coord0)` and holds it in hand. Calling
`recordQuery` on that exact resolved engine keys the increment on the served coord for free. A
registry-level method would re-run the same resolution and risk diverging from the handler's. So the
increment automatically satisfies the two hard constraints:
- **Keys on the served coord** — it's the very engine the handler built the reply from.
- **No engine → no record, no instantiation** — the handler returns `undefined` (no reply) *before*
  reaching the `recordQuery` call whenever the engine is `undefined`; it never calls `forCoord`.

Keep `topicTraffic(topicId)` a pure read — do **not** overload it. The two are separate accessors.

### The bump site + ordering in `createMatchmakingQueryHandler`

Thread an injectable clock and call `recordQuery` after the gate and after engine resolution, before
building the reply:

```ts
// MatchmakingQueryServeDeps — add:
/** Wall clock (unix ms) stamped on the query-accounting bump; default Date.now. Injectable for tests. */
readonly clock?: () => number;
```

```ts
// inside the returned handler, after `engine === undefined` guard returns undefined:
// Query accounting (matchmaking-query-accounting-seam): a served query bumps queriesPerMin for the
// topic on the served coord's TrafficCounters; surfaces in a later reply's snapshot (lags one round).
engine.recordQuery(topicId, (deps.clock ?? Date.now)());
```

Ordering is deliberate — the call sits:
- **after** the `deps.gate` check (a rate-limited / dropped query returns `undefined` earlier, so a
  dropped query never inflates the barometer — the ticket's explicit requirement), and
- **after** the `engine === undefined` no-reply guard (unserved topic records nothing, instantiates
  nothing), and
- **before** `handleMatchmakingQuery` (the reply build/sign). A query that resolved a serving engine
  has consumed the cohort's serve work and is counted even if signing later fails transiently.
  *Tradeoff:* the alternative (count only after a successful build) would drop sign-failure queries
  from the barometer; we count-on-serve because it's simpler, matches "a query arriving at a cohort is
  the event," and sign failures are rare/transient. Decode failures still never count (decode throws
  before `topicId` is resolved).

The wiring at the composition root (`libp2p-node-base.ts` `registerMatchmakingQueryHandler`) needs
**no change** — the default `Date.now` clock is correct for production (it matches the `Date.now`
the gossip-cadence driver stamps `gossipRound(now)` with, so the sliding window agrees). Tests inject
`clock` for determinism.

### One-round lag (name it in the reply)

`recordQuery` pushes onto the raw window; `topicTraffic` / `snapshot` read the **last-published**
frozen summary. So the query that records itself does **not** see its own increment in its own reply —
the bump surfaces only after the next `gossipRound` calls `traffic.publish`. This mirrors the arrivals
counter exactly and is the documented "lags ≤ one round" contract. Acceptance is stated accordingly
(N served queries + a gossip round → a *subsequent* query's reply shows `queriesPerMin > 0`).

## Edge cases & interactions

- **No serving engine (DoS guard).** Query for an unserved topic: handler returns `undefined` before
  `recordQuery`; records nothing, calls no `forCoord`. Assert the existing `stubRegistry(undefined)` +
  `forCoord`-throws harness still passes and `recordQuery` is never reached.
- **Gate rejection.** With a `gate` returning `false`, the handler returns `undefined` before the bump
  → no count. (Composes with backlog `matchmaking-query-rate-limit` whether or not it has landed: our
  call already sits after the existing `deps.gate` check, so no `prereq:` on it.)
- **Malformed / undecodable frame.** `decodeQueryV1` throws before `topicId` is resolved → `catch` →
  no reply, no count.
- **Self-increment lag.** The recording query's own reply shows the *pre-bump* `queriesPerMin`; the
  increment appears only on a reply built after the next `gossipRound`. Cover with a test.
- **Concurrent gossip round.** `recordQuery` is fully synchronous (no `await`) and pushes onto the
  same in-memory window array `traffic.publish` prunes during `gossipRound`. On the single JS event
  loop it cannot interleave mid-publish — no tearing. (The handler is async, but the `recordQuery`
  call itself completes atomically.)
- **Topic-budget eviction between record and publish.** If the topic is evicted (`traffic.forget`)
  before the next round, the recorded query is dropped with the topic — acceptable (topic no longer
  served); no crash.
- **cohortEpoch reset.** A `traffic.reset()` (epoch rotation) zeroes the just-recorded query; the
  existing "single post-rotation zero is a valid reading" tolerance covers it — no new handling.
- **Clock consistency (virtual-time hosts).** `recordQuery(topicId, now)` takes an explicit `now`, and
  the handler's `clock` is injectable, so a virtual-time test that drives `gossipRound` with synthetic
  timestamps must inject a matching `clock` — otherwise the window prune at publish drops the
  real-`Date.now` query event. Name this in the test comment.
- **Pushes must not count.** `ArrivalPushV1` is not a `QueryV1` and never reaches this handler, so
  `queriesPerMin` stays push-free (`docs/matchmaking.md` §556 already asserts this). No code needed;
  the invariant holds because *only* the `QueryV1` serve path calls `recordQuery`.
- **Future `AggregateCountV1` sweep.** When that RPC lands it is another genuine cohort query that
  should also bump — the same `engine.recordQuery` seam is reusable. Out of scope here; do **not** add
  a call site for it now. Leave a one-line `// NOTE:` at the seam so a future reader finds it (tripwire,
  not a task).

## Tests (db-p2p unit)

Run: `yarn workspace @optimystic/db-p2p test` (mocha over `test/**/*.spec.ts`). Extend
`packages/db-p2p/test/matchmaking/query-transport.spec.ts`:

- Update `stubEngine` to add a `recordQuery` spy (record `{ topicId, now }` calls). The stub is typed
  `CoordEngine`, so the new interface member must be present or the cast/test won't type-check.
- **Accounting happy path** (the acceptance test): serve a query through the handler with an injected
  `clock`; assert the spy recorded exactly one `(topicId, now)`. Then, driving the real
  `TrafficCounters` end-to-end (either a real `CoordEngine`/host serving the topic, or a small
  `createTrafficCounters` + `gossipRound`-style publish): record a query → `publish`/`gossipRound` →
  `topicTraffic(topicId).queriesPerMin` is `> 0`. Expected: `1` for one served query in-window.
- **No-engine records nothing.** `stubRegistry(undefined)` → no reply, spy never called, `forCoord`
  never called (existing harness already fails loudly on `forCoord`).
- **Gate rejection records nothing.** `gate: () => false` → no reply, spy never called.
- **Malformed frame records nothing.** Undecodable bytes → no reply, spy never called.
- Existing serve/limit/selection/sign-failure tests stay green (add the `recordQuery` no-op to their
  stub engines).

## Docs

`docs/matchmaking.md`: the query-rate input is now live. Add a short note near §Hang-out vs. continue
→ Decision inputs (line ~330, the `queriesPerMin` bullet) or §Topic traffic that `queriesPerMin` now
flows from the cohort's matchmaking `QueryV1` serve path (previously always 0), lagging ≤ one gossip
round like `arrivalsPerMin`, and cross-reference the existing §556 note that pushes do **not** inflate
it. Keep it to a sentence or two; don't restate the mechanism.

## Acceptance

- A cohort that served N matchmaking queries for a topic within the traffic window reports
  `queriesPerMin > 0` in a subsequent `QueryReplyV1.topicTraffic` snapshot (after a gossip round).
- The no-engine path records nothing and instantiates no engine (`forCoord` never called).
- A gate-rejected / malformed / dropped query records nothing.
- `topicTraffic(topicId)` remains a pure read; `recordQuery` is a separate mutating accessor.
- `yarn workspace @optimystic/db-p2p build` (tsc) and `yarn workspace @optimystic/db-p2p test` green;
  a unit test covers "serve a query → snapshot shows the increment."

## TODO

- Add `recordQuery(topicId, now)` to the `CoordEngine` interface + return object in
  `packages/db-p2p/src/cohort-topic/host.ts` (passthrough to `traffic.recordQuery`).
- Add `clock?: () => number` to `MatchmakingQueryServeDeps` and call
  `engine.recordQuery(topicId, (deps.clock ?? Date.now)())` after the gate + no-engine guards, before
  the reply build, in `createMatchmakingQueryHandler`.
- Add the `// NOTE:` tripwire at the seam for the future `AggregateCountV1` sweep call site.
- Update `stubEngine` in the query-transport spec + add the accounting / no-count tests above.
- Update `docs/matchmaking.md` (§Decision inputs / §Topic traffic) that `queriesPerMin` now flows.
- Run build + db-p2p tests; confirm green.
