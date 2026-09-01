description: When a node drops its least-used topic to make room for a new one, we now test that the dropped topic actually stops being served, not just that its budget slot is freed.
files:
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts  # edited — new assertions + NOTE at end of "topic drained by the engine TTL sweep..." test, ~line 280-344
  - packages/db-p2p/src/cohort-topic/host.ts                                # unchanged (read-only during implement) — onEvict wiring under test (~2076), forwarder()/servesTopic() diagnostics (~440, 458)
difficulty: easy
----

# Review: cohort-topic host eviction teardown test

## What changed

Test-only change. `packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts`, describe
`§Anti-DoS — per-cohort topic budget`, test `'a topic drained by the engine TTL sweep releases its budget
slot, ...'`. That test already existed and covered the budget-slot side of eviction (freed slot gets
reused, still-populated topic never evicted). It did not check the teardown side — that the evicted
topic's serving state (`servesTopic`) and its cold-start forwarder entry (`forwarder()`) actually go away.

Added at the end of the existing test, after the pre-existing budget-slot assertions:

```ts
expect(decidingEngine.servesTopic(TOPIC_B), 'the evicted topic no longer serves — its forwarder was torn down').to.equal(false);
expect(decidingEngine.forwarder(TOPIC_B), 'the evicted topic\'s cold-start forwarder entry is gone').to.equal(undefined);

expect(decidingEngine.forwarder(TOPIC_A), 'the still-populated topic keeps its forwarder').to.not.equal(undefined);
expect(decidingEngine.servesTopic(TOPIC_C), 'the newly-admitted topic serves').to.equal(true);
expect(decidingEngine.forwarder(TOPIC_C), 'the newly-admitted topic has a forwarder').to.not.equal(undefined);
```

Plus a `NOTE:` comment (in the test file, right after) explaining why the third `onEvict` arm
(`traffic.forget()`) is deliberately not asserted here: `topicTraffic()`'s `arrivalsPerMin` is sourced
from `published()`, which is only frozen by a `gossipRound` — never driven in this test (it calls
`engine.handleRegister`/`engine.sweepStale` directly) — so it reads `0` whether or not `forget` ran.
`directParticipants` comes from the registration store, already `0` from the TTL sweep independent of
`onEvict`. Neither field can distinguish "torn down" from "never published" at this call depth, so an
assertion there would be vacuous. `traffic.spec.ts`'s own `forget()` tests (driving `publish()` directly)
already cover that unit at the layer where it's observable.

No production code changed. `host.ts` `onEvict` (~line 2076) was only read, not edited.

## How to validate

- `yarn workspace @optimystic/db-p2p test` — full suite: **2489 passing, 49 pending, 0 failing** (reran
  during this handoff, confirms implement-stage claim still holds).
- Sanity check performed during implement (not re-run here, but described for reviewer confidence): stub
  `onEvict` in `host.ts` to a no-op, rerun `--grep "topic drained by the engine TTL sweep"` alone — it
  should fail on the new `servesTopic(TOPIC_B) === false` assertion specifically (confirms the assertions
  are load-bearing, not vacuous, before reverting the stub).

## Known gaps / things to look at in review

- The `traffic.forget()` arm of `onEvict` is untested at this call depth by design — see the NOTE in the
  test file and the explanation above. Confirm the reasoning holds (i.e. that `traffic.spec.ts` really does
  cover `forget()` at a layer where it's observable) before accepting the gap as intentional rather than a
  missed assertion.
- This is a single test's assertions — no new test scenarios were added (e.g. multiple topics evicted in
  one sweep, eviction racing a concurrent registration). Ticket scope was narrowly "assert the teardown
  side of an eviction already under test," not broaden coverage; flag if broader coverage is wanted as a
  follow-up.

## Review findings

(none yet — first pass)
