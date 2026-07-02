description: A cohort node that hit its topic limit and dropped a topic used to keep serving it anyway, so the limit stopped bounding memory or the number of topics served. The drop now tears down the serving state with the slot; this ticket asks the reviewer to check that fix.
prereq:
files:
  - packages/db-core/src/cohort-topic/coldstart.ts             # NEW ColdStartManager.remove(topicId)
  - packages/db-core/src/cohort-topic/traffic.ts               # NEW TrafficCounters.forget(topicId)
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts  # NEW TopicBudgetConfig.onEvict; fires before slot delete
  - packages/db-p2p/src/cohort-topic/host.ts                   # wires onEvict → coldStart.remove + traffic.forget (~1737)
  - packages/db-core/src/cohort-topic/promotion.ts             # demotion tripwire NOTE at demote() (~344)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts   # RED→GREEN reproduction through the engine
  - packages/db-core/test/cohort-topic/antidos.spec.ts         # onEvict unit coverage
  - packages/db-core/test/cohort-topic/coldstart.spec.ts       # remove() unit coverage
  - packages/db-core/test/cohort-topic/traffic.spec.ts         # forget() unit coverage
difficulty: medium
----

# Review: reconcile the cold-start forwarder set with the topic budget on eviction

## What the bug was (plain language)

A cohort member caps how many topics it holds forwarder state for (`topics_max`, default 2048). When
that cap is full and a new topic needs room, the budget **evicts** the coldest hosted topic to free a
slot. Before this fix, eviction freed the *budget slot* but never tore down the *forwarder* for the
evicted topic. The node's "do I serve this topic?" check (`serves()`) answered `true` off the leftover
forwarder, so the node kept serving a topic it had no budget slot for — and every later register for it
took the hot path and never re-consulted the budget. The budget stopped bounding both memory (the
forwarder map grew without limit) and the set of topics actually served.

## What changed

Three new db-core surface additions plus one db-p2p wiring, mirroring the eviction-reconciliation
pattern (`onRecordsEvicted`) the earlier `cohort-topic-topic-budget-eviction-leak` ticket established:

- **`ColdStartManager.remove(topicId)`** (`coldstart.ts`) — drops the forwarder entry. Idempotent;
  no-op if absent. After it, `get()` returns `undefined`, so `serves()` no longer answers true off it.
- **`TrafficCounters.forget(topicId)`** (`traffic.ts`) — deletes the topic's windowed events and its
  last-published summary. Idempotent. Siblings' gossiped contributions are *not* cleared — they age out
  on their own as siblings stop naming the topic (asserted in the traffic test).
- **`TopicBudgetConfig.onEvict?(topicId)`** (`topic-budget.ts`) — fired with the evicted topic's real
  bytes **just before** its slot is deleted, and **only** for a genuine eviction (a zero-participant
  victim). `ResidentState` now also stores the original `Uint8Array` so the callback gets real bytes
  (residents key by string). Not fired on a plain admit, an already-resident re-admit, or a refusal.
- **host wiring** (`host.ts`, at `createTopicBudget`) — `onEvict: (id) => { coldStart.remove(id);
  traffic.forget(id); }`. `coldStart` and `traffic` are both declared above that call, so the closure
  captures live instances (no forward-const trick needed).

## Why eviction is the only path that needed a hook (reviewer: confirm this reasoning)

- **Budget eviction** — the live defect. Fixed here.
- **TTL drain / withdraw / sibling-drain** — no forwarder teardown needed. These down-`touch` the budget
  to `0` (existing behavior); the forwarder stays resident but so does its now-cold budget slot, so the
  two ledgers still **agree**. A re-register for a drained-but-resident topic takes the hot path and
  up-touches the still-resident slot back to 1. The forwarder is only removed when the budget later
  *evicts* that cold slot — which the new hook covers.
- **Demotion** — has no live teardown path today. `demote()` / `applyDemotionNotice()` only reset the
  promoted-bounce clocks; they do **not** stop the node serving. Recorded as a tripwire (below), not
  wired.

Safety of removing on eviction: `admit()` only ever evicts a zero-participant resident
(`coldestEvictable()` skips `participantCount > 0`), and `participantCount` is reconciled from
`store.directParticipants(...)`. So after removal `serves()` = `coldStart.get(X) === undefined &&
store.directParticipants(X) === 0` → cleanly false, with no orphaned records. A later register for X
re-enters the cold path and re-runs `topicBudget.admit`.

## Tests — what's covered (the floor, not the ceiling)

All new tests green. Counts below.

- **db-core** — `yarn build:db-core`, then `yarn test` (in `packages/db-core`): **1054 passing, 0 failing**.
- **db-p2p** — `yarn build:db-p2p`, then `yarn test` (in `packages/db-p2p`): **1097 passing, 36 pending,
  0 failing**. (The `parent registration for tier-1 forwarder failed` lines on stderr are intentional
  `console.warn`s from the pre-existing `host-antidos-coldstart.spec.ts` failure-path tests, not new.)

New tests (12), verified individually with the spec reporter:

- `member-engine.spec.ts` — **RED→GREEN through the engine**, as an in-file contrast pair:
  - *WITHOUT the onEvict hook* → asserts the evicted topic's forwarder **leaks** (`coldStart.get(A)`
    still defined) — this is the bug, and demonstrates the RED state directly (rather than via git stash).
  - *WITH onEvict → remove + forget* → asserts (a) evicted forwarder gone, (b) a re-register of the
    evicted topic re-enters the cold path and calls `topicBudget.admit` again (spied), (c) the forwarder
    set stays bounded by `topicsMax` (exactly the two survivors). The harness declines willingness so
    residents stay at participantCount 0 (evictable) without adding store participants.
- `antidos.spec.ts` — `onEvict` fires exactly once with the victim's bytes on a full-budget eviction;
  does NOT fire on a plain admit, an already-resident re-admit, or a refusal (full-of-populated).
- `coldstart.spec.ts` — `remove()` drops the entry, is idempotent / safe on an absent topic, and a
  re-instantiate after remove yields a fresh forwarder.
- `traffic.spec.ts` — `forget()` clears windowed + last-published counts, drops the local snapshot
  contribution (sibling contribution survives), and is idempotent on a never-observed topic.

## Known gaps / where to push (reviewer: treat tests as a floor)

- **No db-p2p host-level integration test drives a real eviction end-to-end.** The host `onEvict`
  wiring (`host.ts`) is type-checked (db-p2p builds against the rebuilt db-core) and the *identical*
  `onEvict → remove + forget` closure is exercised in the db-core engine test — but there is no test
  that stands up a live host, floods `topicsMax + 1` topics through the real budget, and asserts the
  forwarder + traffic teardown at the host layer. If the reviewer wants belt-and-suspenders, that's the
  gap to fill (`packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts` is the natural home).
- **The engine RED test declines willingness** to keep residents zero-participant. That's a valid way
  to produce evictable residents, but it's not the "accept then drain" lifecycle a real topic follows.
  The reconciliation logic is identical either way, but a reviewer may want an accept→drain→evict path
  too.
- **`forget()` clears only local traffic.** Sibling gossiped contributions persist in `snapshot()` until
  they age out. This is intended (documented in the `forget` doc-comment and asserted), but flagging it
  so it isn't mistaken for a leak.

## Review findings (index)

- **Tripwire — demotion teardown.** Added a `NOTE:` at `promotion.ts` `demote()` (~line 344): demotion
  today resets only the promoted-bounce clocks and does **not** stop local serving; if demotion is ever
  made to actually collapse the tier, it must reassign/drain the topic's records first, then
  `coldStart.remove` + release the budget slot + `traffic.forget`, in that order — removing the forwarder
  while records remain would re-introduce the exact off-budget-serving drift this ticket fixed. Parked as
  a code comment (the truest single site), not a ticket, because it is conditional on future work.
- **Narrow, pre-existing interleaving (not addressed, not introduced here).** A register that awaits
  `willingness.evaluate` between its `admit()` and `accept()` could in principle have its freshly-admitted
  count-0 topic evicted by a concurrent register — but the fresh topic carries the highest `seq`, so
  `coldestEvictable()` picks it last. Not reachable in practice; noted for the record only.
