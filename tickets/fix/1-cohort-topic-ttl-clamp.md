description: A single registration can ask for an absurdly long lifetime, creating a record that never expires; a handful of these permanently fill up a cohort's limit on how many topics it will host, so it serves nothing new while appearing full.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/validate.ts        # ~line 178/194 — ttl validated only as finite number
  - packages/db-core/src/cohort-topic/member-engine.ts        # ~line 323 — accept() uses reg.ttl > 0 ? reg.ttl : DEFAULT_TTL
  - packages/db-core/src/cohort-topic/registration/store.ts   # ~line 65 — record TTL persisted
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts # coldestEvictable skips populated topics
difficulty: easy
----

# Unbounded `ttl` creates never-expiring records that wedge the topic budget

## The problem

`accept()` takes `reg.ttl > 0 ? reg.ttl : DEFAULT_TTL` with **no upper bound**
(`member-engine.ts:323`), and the wire validator (`wire/validate.ts:178/194`) accepts `ttl` as any
finite number. A single register with `ttl: 1e15` produces a record that effectively never expires. That
record keeps `store.directParticipants(topic) > 0` forever, so the topic is never evictable from the
per-cohort topic budget (`coldestEvictable` skips populated topics — see complete ticket
`cohort-topic-topic-budget-eviction-leak`, which fixed slot release *on drain* but a never-draining
record sidesteps entirely).

A handful of such registers wedge the cohort's `topics_max` while serving nothing, and gossip replicates
the poisoned TTL cohort-wide.

## Expected behavior

Clamp `ttl` to a sane range at validation/admission — e.g. `[10s, 10 × DEFAULT_TTL_MS]`. A register
asking for more is clamped down (or rejected) so no record can outlive the intended soft-state window,
and the topic budget stays reclaimable.

## Repro sketch

- Register with `ttl: 1e15` on enough distinct topics to fill `topics_max`.
- Observe the cohort refuse new topics (`unwilling_cohort`) while the wedged records never drain.
- With the fix, the oversized ttl is clamped, records expire on the normal window, and slots free up.
