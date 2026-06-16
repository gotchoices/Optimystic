description: A cohort's cap on how many topics it will host only ever counted up, so emptied topics kept their slots forever and the cohort eventually refused all new topics while serving nothing. Fixed and reviewed — a topic now releases its slot when its last participant drains, on both drain paths.
prereq:
files:
  - packages/db-core/src/cohort-topic/member-engine.ts        # Seam 1: sweepStale re-touch
  - packages/db-core/src/cohort-topic/gossip/bus.ts            # Seam 2: mergeRecords fires onRecordsEvicted
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts  # read-only participantCount(topicId)
  - packages/db-p2p/src/cohort-topic/host.ts                   # wires onRecordsEvicted; budgetHasTopic / budgetParticipantCount
  - packages/db-core/test/cohort-topic/member-engine.spec.ts   # Seam 1 unit coverage
  - packages/db-core/test/cohort-topic/gossip.spec.ts          # Seam 2 unit coverage (onRecordsEvicted)
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts  # promoted through-the-engine drain test
  - docs/cohort-topic.md                                       # removed the now-closed tagged-gap bullet
difficulty: medium
----

# Complete: release per-cohort topic-budget slots when a topic drains

## What was built

The per-cohort topic budget (`antidos/topic-budget.ts`, `topics_max` default 2048) had exactly **one
writer** of a resident's `participantCount` — `member-engine.ts` `accept()`, which up-touches on admission.
Nothing re-touched it **down** when participants left, so a drained topic kept a stale positive count
forever, never became `coldestEvictable()`, and permanently occupied a slot. A cohort serving many
short-lived topics filled `topics_max` with ghosts and then refused every new topic (`unwilling_cohort`)
while serving nothing.

The fix re-`touch(topicId, store.directParticipants(topicId))` **after** records are removed, once per
distinct affected topic, mirroring the `accept()` up-touch — always reconciling from the store as source of
truth, so up- and down-touch stay symmetric and idempotent. A drained topic is left resident-but-cold
(count 0), so the next new topic reuses its slot (LRU) while a still-populated topic is never evicted.

- **Seam 1 — `member-engine.ts` `sweepStale`**: after `renewal.sweepStale(now)`, re-touch the budget once
  per distinct evicted topic. Covers the participants this member is itself primary for.
- **Seam 2 — `gossip/bus.ts` `mergeRecords`**: collect the distinct topic ids the `g.evicted` loop deleted
  and fire a new optional `onRecordsEvicted?(topicIds)` callback (decoupled — the gossip module carries no
  anti-DoS dependency). `host.ts createCoordEngine` wires it to re-touch the budget. Covers participants
  sharded onto a **sibling** primary, which drain into this member's store as gossip evictions.

Supporting read-only accessors added: `TopicBudget.participantCount(topicId)`, and on `CoordEngine`
`budgetHasTopic` / `budgetParticipantCount` (test/diagnostic — distinct from `servesTopic`, which a
never-demoted tier-0 forwarder keeps `true` even after the budget slot is released).

## Review findings

Adversarial pass over the implement diff (`c06c01d` + Seam-1 SHA `4206e89`), read fresh before the handoff.

**Scope / completeness — checked, no defects.**
- **All record-removal paths covered.** Grepped every `store.delete` / `store.evictStale` /
  `renewal.sweepStale` / `directParticipants` site under `packages/db-core/src/cohort-topic`. Records leave
  the store via exactly two paths — `evictStale` (TTL sweep → Seam 1) and the gossip `g.evicted` loop
  (Seam 2). No direct deregister/withdraw path exists (`cohort-topic-withdraw-tombstone` is unimplemented
  backlog; when it lands it must add its own re-touch — noted there is no code to change today).
- **`touch` is genuinely a no-op for a non-resident topic** (`topic-budget.ts:115-117` early-returns when
  the key is absent), so firing `onRecordsEvicted` for a topic this member never admitted is safe — the
  re-touch reconciliation pattern is sound on both seams.
- **Up/down symmetry & idempotence.** Both seams reconcile the count from `store.directParticipants` rather
  than tracking deltas, matching `accept()`. A no-op `store.delete` (eviction for a participant already
  gone) leaves the count unchanged, so a re-touch is idempotent. Partial drains correctly re-touch to the
  surviving count (asserted by a dedicated unit test), not prematurely to 0.

**Type safety / correctness — checked, no defects.**
- The `onRecordsEvicted!` non-null assertion (`bus.ts:209`) is guarded — `evictedTopics` is only allocated
  inside the `this.deps.onRecordsEvicted !== undefined` branch, so it is non-null whenever the map exists.
- LRU semantics hold: a just-drained topic's `seq` bump makes it the *last* cold topic evicted, i.e. the
  topic that drained longest ago is dropped first — consistent with the doc's "zero recent registrations
  dropped first" (`docs/cohort-topic.md:727`).
- `servesTopic` vs `budgetHasTopic`: audited every `servesTopic` caller (host `findServing` dispatch,
  willingness gating, failover targeting, promotion observation, tests). None relies on it meaning
  "occupies a budget slot," so introducing the distinct budget accessors changes no existing behavior.

**Style — noted, accepted, not changed.**
- The `host.ts` `onRecordsEvicted` closure (~line 917) reads `topicBudget`, a `const` declared ~100 lines
  later (line 1017). This is a TDZ-safe forward reference — the closure only fires at gossip-merge time,
  long after `createCoordEngine` returns — and is explicitly documented at the site. Moving the budget
  creation up would split it from the grouped per-coord anti-DoS guards (`rateLimiter`/`replayGuard`/
  `topicBudget`); judged not worth the regrouping. Left as-is.
- New `CoordEngine`/`TopicBudget` methods are test/diagnostic-oriented pure getters, documented as such.
  Acceptable production surface.

**Docs — checked, accurate.** `docs/cohort-topic.md:727` already described the intended LRU-by-participant-
count behavior; the fix makes the implementation match it, and the now-closed "topic-budget LRU
cold-eviction through the engine" gap bullet was cleanly removed (no dangling references; the four
remaining tagged gaps are unrelated and still valid).

**Tests — run green, coverage strong.**
- `yarn build:db-core` and `yarn build:db-p2p`: exit 0.
- db-core `yarn test`: **824 passing**. db-p2p `yarn test`: **726 passing / 27 pending** (the
  `parent unreachable` line is the documented negative-path `log()` from `host-antidos-coldstart.spec.ts`,
  suite exits 0).
- Added/promoted coverage reviewed and judged adequate for both seams at the unit boundary: full drain,
  partial drain (re-touch to surviving count), multi-topic-per-sweep, no-budget no-op (Seam 1);
  fire-once-per-distinct-topic and no-fire-without-eviction (Seam 2); and the RED→GREEN through-the-engine
  e2e proving slot reuse after a TTL drain while a populated topic is never evicted (Seam 1).

**One gap — filed, not a defect.** Seam 2 (gossip sibling-drain) is unit-covered on the bus-callback
contract and the host wiring closure is verified by inspection (it reuses the same `store`/`topicBudget`
consts as the e2e-tested Seam 1), but **no test drives a real sibling-drained gossip eviction through the
host + mesh** to observe the budget-holding member release the slot. Production code is correct; this is
integration-test debt. Filed as `tickets/backlog/cohort-topic-topic-budget-sibling-drain-e2e.md`
(test hardening, future concern — not blocking).
