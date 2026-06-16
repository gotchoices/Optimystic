description: A cohort's cap on how many topics it will host only ever counted up, so emptied topics kept their slots forever and the cohort eventually refused all new topics while serving nothing. Now a topic releases its slot when its last participant drains, on both drain paths.
prereq:
files:
  - packages/db-core/src/cohort-topic/member-engine.ts        # Seam 1: sweepStale re-touch (committed in resume-note SHA 4206e89)
  - packages/db-core/src/cohort-topic/gossip/bus.ts            # Seam 2: mergeRecords fires onRecordsEvicted
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts  # new read-only participantCount(topicId)
  - packages/db-p2p/src/cohort-topic/host.ts                   # wires onRecordsEvicted; exposes budgetHasTopic / budgetParticipantCount on CoordEngine
  - packages/db-core/test/cohort-topic/member-engine.spec.ts   # NEW — Seam 1 unit coverage
  - packages/db-core/test/cohort-topic/gossip.spec.ts          # Seam 2 unit coverage (onRecordsEvicted)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts  # promoted through-the-engine drain test
  - docs/cohort-topic.md                                       # removed the now-closed tagged-gap bullet
difficulty: medium
----

# Review: release per-cohort topic-budget slots when a topic drains

## What was wrong

The per-cohort topic budget (`antidos/topic-budget.ts`, `topics_max` default 2048) is the anti-DoS
ceiling on how many topics a cohort holds forwarder state for. It evicts **cold** (zero-participant)
residents to admit new topics, and refuses a new topic only when *every* resident still carries
participants (`coldestEvictable()` skips any resident with `participantCount > 0`).

A resident's `participantCount` had exactly **one writer** — `member-engine.ts` `accept()`, which
up-touches `topicBudget.touch(topicId, store.directParticipants(topicId))` after admitting a register.
Nothing ever re-touched it **down** when participants left, on either drain path:

- **TTL sweep** (`member-engine.ts` `sweepStale` → `renewal.sweepStale` → `store.evictStale`) removed the
  records but never re-touched the budget.
- **Gossip-driven eviction** (`gossip/bus.ts` `mergeRecords`) `store.delete`'d each gossiped eviction ref
  but never re-touched the budget. This is the path a topic's participants take when they are sharded onto
  a **sibling** primary (the budget-holding member TTL-sweeps only the participants it is itself primary
  for; sibling-primary participants drain in as gossip evictions).

A tier-0 root never de-instantiates, so a drained topic kept a stale positive `participantCount` forever,
never became `coldestEvictable()`, and permanently occupied a budget slot. A cohort serving many
short-lived topics would fill `topics_max` with ghosts and then refuse **every** new topic
(`unwilling_cohort`) while serving nothing — a slow-burn availability failure a topic-churning attacker
can accelerate.

## The fix (two seams, both reconciling from the store as source of truth)

Both seams re-`touch(topicId, store.directParticipants(topicId))` **after** the records are removed, once
per distinct affected topic — mirroring the `accept()` up-touch. The budget is always reconciled from the
store (never tracked by deltas), so up-touch and down-touch stay symmetric. A drained topic is left
**resident-but-cold** (`participantCount 0`), not dropped — the doc's intent is LRU reuse, so the next
new topic evicts it while a still-populated topic never is. `touch(...)` is already a no-op for a
non-resident topic, so re-touching on a member that does not hold the topic in its budget is safe.

- **Seam 1 — `member-engine.ts` `sweepStale`** (committed in the resume-note SHA `4206e89`): after
  `renewal.sweepStale(now)` returns the evicted set, re-touch the budget once per distinct evicted topic.
- **Seam 2 — `gossip/bus.ts` `mergeRecords`**: collect the distinct topic ids the `g.evicted` loop
  deleted and fire a new optional `onRecordsEvicted?(topicIds)` callback on `CohortGossipBusDeps` (chose
  the **decoupled-callback** option from the ticket so the gossip/replication module carries no anti-DoS
  dependency). `host.ts createCoordEngine` wires it to
  `(topicIds) => topicIds.forEach(t => topicBudget.touch(t, store.directParticipants(t)))`.

### Supporting API added
- `TopicBudget.participantCount(topicId): number | undefined` — read-only introspection (the resident's
  eviction key, or `undefined` if not resident). Used by the new tests; eviction policy already read the
  same field internally.
- `CoordEngine.budgetHasTopic(topicId)` / `budgetParticipantCount(topicId)` — test/diagnostic
  introspection over the per-coord budget. **Why both exist:** `servesTopic` is NOT a usable signal for
  budget release here — a never-demoted tier-0 cold-start forwarder keeps `servesTopic(topic) === true`
  even after the topic fully drains and is evicted from the budget. The budget accessors observe the
  slot directly and unambiguously.

## Validation

- `yarn build` green: **db-core** and **db-p2p** (`tsc`; repo `lint` is a no-op echo, so `tsc` is the
  type floor).
- `yarn test` green: **db-core 824 passing**; **db-p2p 726 passing / 27 pending**. (The
  `parent unreachable` line in the db-p2p output is a deliberate negative-path `log()` from the
  pre-existing `host-antidos-coldstart.spec.ts`, not a failure — suite exits 0.)

### Tests added / promoted — use cases the reviewer should re-run and extend
- **db-p2p `cohort-topic-scale-antiflood.spec.ts`** — *promoted* the old `createTopicBudget`-direct
  unit-boundary LRU test to drive **through the real engine wire** (and dropped its "engine TTL sweep does
  not re-touch the budget" caveat). The new test: fills a `topicsMax: 2` budget with two populated topics
  (B at `T0`, A at `T0 + ttl/3` so one sweep drains B but not A); asserts a third topic is refused while
  full (control); `engine.sweepStale` past B's ttl drains B to `budgetParticipantCount 0`; then a new
  topic **is `accepted`** by reusing B's freed slot while A (`budgetParticipantCount 1`) is never evicted.
  This is the RED→GREEN behavioral proof — without the Seam 1 fix the final register stays
  `unwilling_cohort`.
- **db-core `member-engine.spec.ts` (NEW)** — Seam 1 unit contract over a minimal engine composition
  (real store + renewal + budget; willingness/promotion/cold-start/traffic are throwing Proxy stubs that
  fail loudly if `sweepStale` ever touches them): full drain → `participantCount 0`; **partial** drain
  (one of two participants swept) → re-touched to the surviving count `1`, *not* prematurely freed;
  one sweep draining several topics re-touches each distinct topic; and a no-budget engine `sweepStale`
  is a safe no-op (optional dependency).
- **db-core `gossip.spec.ts`** — Seam 2 unit contract: a gossiped eviction that drains a topic fires
  `onRecordsEvicted` and (wired to a real budget) drops it to `participantCount 0`; the hook fires
  **once per distinct topic** and **not at all** on an evictions-free merge.

## Honest gaps / things to scrutinize

- **Seam 2 is not covered end-to-end through the mesh.** The db-core test asserts the
  `onRecordsEvicted` callback contract, and the host wiring is a thin closure, but no test drives the full
  sibling-drain scenario through the real host + mesh (a topic sharded across ≥2 cohort members, one
  member's participants drained via a real gossiped eviction round, the budget-holding member's slot
  released). The mesh harness can express this (`handleRegister` with participants whose primaries differ,
  `gossipRound` to propagate the eviction). If the reviewer wants integration confidence on the
  sibling-drain path specifically, that e2e test is the gap to fill — consider it a floor, not a finish.
- **Forward-reference closure in `host.ts`.** `onRecordsEvicted` (defined at the bus-creation site, ~line
  900) reads `topicBudget`, a `const` declared ~90 lines later (~994). This compiles and is correct
  because the callback only fires at gossip-merge time, long after both initialize — but it is a
  read-before-declaration in source order; verify you're comfortable with it (the alternative is moving
  the `topicBudget` creation above the bus).
- **New methods on the production `CoordEngine` / `TopicBudget` interfaces are test/diagnostic-oriented.**
  They are documented as such and are pure read-only getters, but a reviewer may prefer a tighter
  production surface. Worth a judgment call.
- **`servesTopic` vs `budgetHasTopic` semantics** (see above) — confirm the distinction is intended and
  that no caller of `servesTopic` was relying on it to mean "occupies a budget slot."
- **Coverage placement.** The db-core Seam 1 test landed in a new `member-engine.spec.ts` rather than
  `antidos.spec.ts` (the ticket's "easiest placement" suggestion) because the minimal engine composition
  reads cleaner in its own file than embedded in the anti-DoS unit suite. Equivalent coverage, different
  home.
