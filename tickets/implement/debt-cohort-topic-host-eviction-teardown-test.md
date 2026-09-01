description: When a node drops its least-used topic to make room for a new one, we test that the slot is freed but never that the dropped topic actually stops being served; add those missing checks to an existing test.
files:
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts  # edited — assertions added at the end of the "topic drained by the engine TTL sweep..." test (~line 280-340)
  - packages/db-p2p/src/cohort-topic/host.ts                                # unchanged — onEvict wiring under test (~2074), forwarder()/servesTopic() diagnostics (~2304-2307, ~440)
difficulty: easy
----

# Implement: assert the topic-eviction teardown at the host layer (DONE — verify + hand off)

## Status: implementation complete, validated

Planning found the target test already existed (`packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts`,
describe `§Anti-DoS — per-cohort topic budget`, the `it('a topic drained by the engine TTL sweep releases
its budget slot, ...')` test) — it just never asserted the teardown side of eviction, only the budget-slot
side. No production code needed to change; this was purely additive test assertions.

### What was added (end of that test, right after the existing budget/servesTopic assertions)

```ts
// The teardown side of eviction (the part this test previously never checked): dropping a topic
// from the budget must ALSO remove its cold-start forwarder, or `servesTopic` stays true off the
// leftover forwarder forever and the forwarder map grows unbounded (host.ts `onEvict`, ~line 2076).
// This is the load-bearing assertion — it fails if `coldStart.remove` is dropped from `onEvict`.
expect(decidingEngine.servesTopic(TOPIC_B), 'the evicted topic no longer serves — its forwarder was torn down').to.equal(false);
expect(decidingEngine.forwarder(TOPIC_B), 'the evicted topic\'s cold-start forwarder entry is gone').to.equal(undefined);

// Negative controls: teardown hit only the evicted topic, not everything.
expect(decidingEngine.forwarder(TOPIC_A), 'the still-populated topic keeps its forwarder').to.not.equal(undefined);
expect(decidingEngine.servesTopic(TOPIC_C), 'the newly-admitted topic serves').to.equal(true);
expect(decidingEngine.forwarder(TOPIC_C), 'the newly-admitted topic has a forwarder').to.not.equal(undefined);
```

A `traffic.forget()` assertion (the third `onEvict` arm) was deliberately **not** added — see the NOTE left
in the test right after the above. `topicTraffic()`'s `arrivalsPerMin` is sourced from `published()`,
which is only frozen by a `gossipRound` (never driven in this test — it calls `engine.handleRegister`/
`engine.sweepStale` directly), so it reads `0` whether or not `forget` ran. `directParticipants` comes
from the registration store, already `0` from the TTL sweep independent of `onEvict`. Neither field can
distinguish "torn down" from "never published" at this call depth, so asserting on them would be vacuous
(the plan ticket explicitly permitted skipping in this case). `traffic.spec.ts`'s own `forget()` tests
(which drive `publish()` directly) already cover that unit at the layer where it's observable.

### Validation performed

- `yarn workspace @optimystic/db-p2p test` — full suite green: 2489 passing, 49 pending (skips), 0 failing.
- Sanity check (per ticket requirement): temporarily stubbed `onEvict` in `host.ts` to a no-op, reran the
  single test (`--grep "topic drained by the engine TTL sweep"`) — it failed exactly on the new
  `servesTopic(TOPIC_B) === false` assertion (`expected true to equal false`). Reverted `host.ts` back to
  original (`git diff --stat` confirms zero diff on that file). Confirms the new assertions are load-bearing,
  not vacuous.

## TODO

- [x] Add the missing forwarder-teardown assertions to the existing drain→evict test.
- [x] Add negative controls (topic A and C unaffected).
- [x] Decide on the `traffic.forget()` assertion — investigated, determined vacuous at this layer, documented why in a code comment instead of asserting.
- [x] Run full `@optimystic/db-p2p` test suite — green.
- [x] Sanity-check: stub `onEvict`, confirm new assertions fail, revert.
- [ ] Review stage: confirm the comment explaining the skipped `traffic.forget()` assertion is clear enough, and that no further host.ts changes are warranted (none are expected — this is test-only).
