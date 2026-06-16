description: A cohort's limit on how many topics it will host is only ever counted up, never down — so once a topic's last subscriber leaves, that topic permanently occupies a slot and can never be reclaimed, eventually causing the cohort to wrongly refuse brand-new topics.
files:
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts
  - packages/db-core/src/cohort-topic/registration/renewal.ts
  - packages/db-core/test/cohort-topic/ (add coverage for budget release on drain)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts (the `it()` LRU cold-eviction test is at the unit boundary today; promote to through-the-engine once fixed)
difficulty: medium
----

# Fix: per-cohort topic budget leaks slots for drained topics

## Symptom

The per-cohort topic budget (`antidos/topic-budget.ts`, `topics_max` default 2048) is the anti-DoS
ceiling on how many topics a cohort holds forwarder state for. It evicts **cold** (zero-participant)
topics to admit new ones, and refuses a new topic only when every resident still carries participants
(`coldestEvictable()` skips any resident with `participantCount > 0`).

The leak: the budget's `participantCount` is only ever updated **upward**. `member-engine.ts`
`accept()` calls `topicBudget.touch(topicId, store.directParticipants(topicId))` on admission
(member-engine.ts:228), but **nothing ever touches it back down**:

- `sweepStale(now)` (member-engine.ts:172) evicts TTL-expired registration records via the renewal
  sweep and returns them, but never re-`touch`es the budget with the now-lower participant count.
- Gossip-driven eviction (`gossip/bus.ts` `mergeRecords`, `store.delete`) likewise never re-touches.
- A tier-0 root never de-instantiates (root-never-demote), so its drained topics never leave the
  budget by demotion either.

Consequence: a topic whose participants all TTL-evict stays resident with a stale, positive
`participantCount` **forever**. It is never `coldestEvictable()`, so it permanently occupies a budget
slot. A cohort that serves many short-lived topics over time fills `topics_max` with ghost topics and
then **refuses every new topic instantiation** (`unwilling_cohort`) even though it is serving nothing —
a slow-burn availability failure, and an attacker who can churn topics can accelerate it.

This was surfaced by the cohort-topic mock-tier-at-scale review (ticket `cohort-topic-e2e-mock-tier`).
The §Anti-DoS LRU cold-eviction test in `cohort-topic-scale-antiflood.spec.ts` had to drive
`createTopicBudget` **directly** rather than through the engine precisely because a resident never
reaches `participantCount 0` over the wire — that test's own comment documents the gap.

## Expected behavior

When a topic's direct-participant count drops (TTL sweep, gossiped eviction, withdraw), the cohort's
topic budget for that topic must be re-`touch`ed with the new count, so a fully-drained topic becomes
`participantCount 0` and is once again the coldest-evictable / reclaimable resident. A cohort that is
serving no live participants for a topic must not refuse new topics on its behalf.

Decide the right seam: the cleanest is for the engine's `sweepStale` (and the gossip-merge eviction
path) to re-`touch(topicId, store.directParticipants(topicId))` for every affected topic after records
are removed — mirroring the up-touch on admission. Consider whether a topic that reaches zero direct
participants should be *dropped* from the budget entirely vs. left resident-but-cold for LRU reuse
(the doc's intent is LRU reuse, so leaving it cold and evictable is likely correct).

## Acceptance

- A through-the-engine test: register participants on a topic, let them all TTL-sweep, then confirm the
  budget reports that topic as cold (evictable) — a new topic instantiation succeeds by evicting it,
  and a populated topic is never evicted.
- Promote the `it()` LRU cold-eviction test in `cohort-topic-scale-antiflood.spec.ts` from the
  `createTopicBudget`-direct unit boundary to drive the cold-eviction **through the engine wire**, and
  drop the "engine TTL sweep does not re-touch the budget" caveat from its comment + from
  `docs/cohort-topic.md` §Validation's tagged-gap blockquote.
- `yarn build` + `yarn test` green in db-core and db-p2p.
