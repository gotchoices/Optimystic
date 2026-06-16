<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-16T06:39:00.569Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\cohort-topic-topic-budget-eviction-leak.implement.2026-06-16T06-39-00-569Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: A cohort's limit on how many topics it will host only ever counts up, never down, so emptied topics permanently hog slots and the cohort eventually refuses brand-new topics even when it is serving nothing. Fix it to release a slot when a topic drains.
prereq:
files:
  - packages/db-core/src/cohort-topic/member-engine.ts
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts
  - packages/db-core/src/cohort-topic/gossip/bus.ts
  - packages/db-core/src/cohort-topic/registration/renewal.ts
  - packages/db-core/src/cohort-topic/registration/types.ts
  - packages/db-core/src/cohort-topic/registration/store.ts
  - packages/db-p2p/src/cohort-topic/host.ts
  - packages/db-core/test/cohort-topic/antidos.spec.ts
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts
  - docs/cohort-topic.md
difficulty: medium
----

# Implement: release per-cohort topic-budget slots when a topic drains

## Problem (confirmed by code trace)

The per-cohort topic budget (`antidos/topic-budget.ts`, `topics_max` default 2048) is the anti-DoS
ceiling on how many topics a cohort holds forwarder state for. To keep room for live topics it evicts
**cold** (zero-participant) residents to admit new ones, and refuses a new topic only when *every*
resident still carries participants (`coldestEvictable()` skips any resident with `participantCount > 0`,
topic-budget.ts:120).

The bug: a resident's `participantCount` is only ever updated **upward**. The single writer is
`member-engine.ts` `accept()` (member-engine.ts:228), which after `store.put` calls
`topicBudget.touch(topicId, store.directParticipants(topicId))`. Nothing ever re-`touch`es it back down
when participants leave:

- **TTL sweep** — `member-engine.ts` `sweepStale` (member-engine.ts:172) delegates to
  `renewal.sweepStale` → `store.evictStale`, which removes the records and returns them, but the engine
  never re-`touch`es the budget with the now-lower count.
- **Gossip-driven eviction** — `gossip/bus.ts` `mergeRecords` (bus.ts:186) calls `store.delete(...)` for
  each gossiped eviction ref, never re-touching the budget.
- A tier-0 root never de-instantiates (root-never-demote), so drained topics never leave the budget by
  demotion either.

Consequence: a topic whose participants all leave stays resident with a stale, positive
`participantCount` forever. It never becomes `coldestEvictable()`, so it permanently occupies a budget
slot. A cohort that serves many short-lived topics over time fills `topics_max` with ghost topics and
then **refuses every new topic instantiation** (`unwilling_cohort`) even though it is serving nothing —
a slow-burn availability failure that a topic-churning attacker can accelerate.

### Both drain paths must be fixed (sharding insight)

The budget is touched *up* only in `accept()`, which runs on the member that handled the
register/instantiation (the one that called `admit()`). But participants of a topic are **sharded**
across cohort members as primaries (`slots.assignSlots`). The budget-holding member only TTL-sweeps the
participants it is *itself* primary for; participants whose primary is a **sibling** drain into the
budget-holder's store via **gossip eviction** (`store.delete` in `mergeRecords`), not via its own
`evictStale`. So re-touching in `sweepStale` alone leaves a residual leak whenever a topic's
participants are spread across more than one member — the gossip-merge path must re-touch too.

- `sweepStale` re-touch covers participants this member is primary for (its own TTL sweep).
- gossip-merge re-touch covers participants a sibling was primary for (drain arrives as gossip eviction).

Note `directParticipants(topicId)` (store.ts:57) counts **all** records held for the topic in this
member's store regardless of primary assignment, so re-touching from it after a delete yields the correct
post-drain count. `touch(...)` is already a no-op for a topic not resident in the budget
(topic-budget.ts:105), so re-touching on a member that does not hold the topic in its budget is safe.

## Design / chosen seam

Re-`touch(topicId, store.directParticipants(topicId))` for every affected topic **after** records are
removed, mirroring the up-touch on admission, at both drain points. A topic that reaches zero direct
participants is left **resident-but-cold** (`participantCount 0`), not dropped — the doc's intent is LRU
reuse, so a cold resident that is the coldest-evictable / reclaimable candidate is correct (a brand-new
topic evicts it; a still-populated topic is never evicted).

**Seam 1 — engine TTL sweep (`member-engine.ts` `sweepStale`).** After `renewal.sweepStale(now)`
returns the evicted set, re-touch the budget once per **distinct** affected topic with the
post-eviction `store.directParticipants(topicId)`:

```ts
sweepStale(now: number): readonly RegistrationRecord[] {
    const evicted = this.deps.renewal.sweepStale(now);
    const budget = this.deps.topicBudget;
    if (budget !== undefined && evicted.length > 0) {
        const seen = new Set<string>();
        for (const rec of evicted) {
            const key = bytesKey(rec.topicId);
            if (seen.has(key)) continue;
            seen.add(key);
            // Mirror the up-touch on admission: a drained topic falls to participantCount 0 and
            // becomes the coldest-evictable / reclaimable resident again (else its slot leaks).
            budget.touch(rec.topicId, this.deps.store.directParticipants(rec.topicId));
        }
    }
    return evicted;
}
```

`bytesKey` is already imported in member-engine.ts (line 27).

**Seam 2 — gossip-merge eviction (`gossip/bus.ts` `mergeRecords`).** After the `g.evicted` delete loop,
re-touch the budget once per distinct deleted topic. The gossip bus does not currently know about the
budget; wire it in. Two acceptable approaches — pick the one that reads cleanest against the existing
host composition (`createCoordEngine`, host.ts ~893 builds the bus, ~994 builds the budget, both over the
same `store`):

- **(preferred) decoupled callback:** add an optional `onRecordsEvicted?: (topicIds: readonly Uint8Array[]) => void`
  (or per-topic) to `CohortGossipBusDeps`; the host wires it to
  `(t) => topicBudget.touch(t, store.directParticipants(t))`. Keeps the gossip/replication module free of
  an anti-DoS dependency.
- **direct injection:** add an optional `topicBudget?: TopicBudget` to `CohortGossipBusDeps` and re-touch
  inline in `mergeRecords` (mirrors how the engine takes the budget). Simpler, but couples the bus to
  anti-DoS.

Either way: collect the distinct topic ids deleted in the `g.evicted` loop, then re-touch each from
`store.directParticipants`. Do it after the deletes so the count is post-drain.

## Acceptance

- **Through-the-engine TTL-drain test (db-p2p):** register participant(s) on a topic via the real engine,
  advance the clock past `ttl` and run the engine's TTL sweep, then confirm the budget releases the
  topic's slot — a new topic instantiation succeeds (by evicting the now-cold drained topic) while a
  still-populated topic is never evicted. The behavioral assertion (`servesTopic` + register reply
  `accepted` vs `unwilling_cohort`) avoids needing to expose the budget directly; if a finer assertion is
  wanted, expose a `budgetHasTopic(topicId)` / `budgetParticipantCount(topicId)` on the `CoordEngine`
  interface (host.ts:240) for tests.
- **Promote the existing `it()` LRU cold-eviction test** in
  `cohort-topic-scale-antiflood.spec.ts` (lines ~265-283) from the `createTopicBudget`-direct unit
  boundary to drive cold-eviction **through the engine wire**, and drop its
  "engine TTL sweep does not re-touch the budget" caveat from the test name + comment.
- **db-core coverage for budget release on drain:** add a focused test. Easiest placement is
  `test/cohort-topic/antidos.spec.ts` if the engine seam can be exercised with a minimal
  `createCohortMemberEngine` composition (real `store` + `renewal` + `topicBudget`, lightweight stubs for
  `willingness`/`slots`/`cohort`/`traffic`/`promotion`/`coldStart`); otherwise add a small
  `member-engine.spec.ts`. The point is to assert the new `sweepStale` re-touch contract at the db-core
  unit level (seed store + admit/up-touch budget → sweep past TTL → topic reports cold/evictable). If a
  deterministic gossip-merge re-touch test is feasible at this level, add it too; otherwise note the
  gossip-merge path is covered behaviorally and leave a comment.
- **Docs:** remove the `topic-budget LRU cold-eviction through the engine` tagged-gap blockquote bullet
  in `docs/cohort-topic.md` §Validation (lines ~913-915) — the gap is closed. Leave the surrounding
  §Validation prose ("topic-budget refusal", line ~891) intact.
- `yarn build` + `yarn test` green in **db-core** and **db-p2p**.

## Notes for the implementer

- Reproduction is by code trace (no committed failing test, to keep the tree green for concurrent
  tickets): the leak is unambiguous — `participantCount` has exactly one writer (`accept()` up-touch) and
  two un-mirrored drain paths (`sweepStale`, `mergeRecords`). The existing antiflood `it()`'s own comment
  already documents the gap. Write the failing test first (RED), then apply the fix (GREEN).
- The mesh harness (`packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts`) already drives the real
  engine deterministically via a virtual clock (`handleRegister(reg, ctx, now)`, `gossipRound(now)`,
  `sweepStale(now)`, `servesTopic`). The lifecycle spec's "stopping pings evicts it after ttl" test
  (`cohort-topic-scale-lifecycle.spec.ts`, §TTL and renewal) is the pattern for advancing past TTL and
  sweeping. `cohort-topic-scale-antiflood.spec.ts` §Anti-DoS per-cohort topic budget already drives a
  small `topicsMax` (2) through `decidingEngine.engine.handleRegister`.
- Keep the up-touch and down-touch symmetric: both read `store.directParticipants(topicId)` so the budget
  is always reconciled from the store (the source of truth), never tracked by deltas.

## TODO

- [ ] Add the RED through-the-engine TTL-drain test in `cohort-topic-scale-antiflood.spec.ts` (and/or the
      db-core unit test) demonstrating the leak: drained topic stays resident-and-positive → new topic
      refused.
- [ ] Seam 1: re-touch the budget per distinct affected topic in `member-engine.ts` `sweepStale` after
      `renewal.sweepStale`.
- [ ] Seam 2: wire the topic budget into the gossip-merge eviction path (`gossip/bus.ts` `mergeRecords`)
      via the chosen approach (callback wired in `host.ts createCoordEngine`, or direct injection) and
      re-touch per distinct deleted topic after the `g.evicted` deletes.
- [ ] Promote the existing antiflood `it()` LRU cold-eviction test to drive through the engine wire; drop
      its tagged-gap caveat from name + comment.
- [ ] Add db-core "budget release on drain" coverage (antidos.spec.ts or a new member-engine.spec.ts).
- [ ] Remove the `topic-budget LRU cold-eviction through the engine` tagged-gap blockquote bullet in
      `docs/cohort-topic.md` §Validation.
- [ ] (optional) Expose `budgetHasTopic` / `budgetParticipantCount` on the `CoordEngine` interface if the
      tests want a direct budget assertion.
- [ ] `yarn build` + `yarn test` green in db-core and db-p2p.
