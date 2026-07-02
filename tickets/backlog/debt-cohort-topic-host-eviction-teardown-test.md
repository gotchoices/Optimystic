description: Add a full-host test that floods a cohort node past its topic limit and confirms the dropped topic's serving state is actually torn down at the host layer, not just in the engine unit test.
prereq:
files:
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts   # natural home; already has a topicsMax=1 full-host harness (~186)
  - packages/db-p2p/src/cohort-topic/host.ts                           # onEvict wiring under review (~1743)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts           # existing engine-layer end-to-end coverage of the same closure
difficulty: medium
----

# Add host-layer coverage for topic-budget eviction teardown

## Why

The `cohort-topic-coldstart-forwarder-reconcile` fix wires the topic budget's `onEvict` hook (in
`host.ts` at `createTopicBudget`, ~line 1743) to `coldStart.remove(topicId)` + `traffic.forget(topicId)`,
so that when a cohort node drops the coldest topic to make room for a new one, it also tears down that
topic's forwarder and traffic window. Without this, the node would keep reporting that it serves a topic
it no longer has a budget slot for, and the forwarder map would grow without bound.

The reconciliation logic is **fully covered end-to-end at the db-core engine layer**
(`member-engine.spec.ts`, "topic-budget eviction reconciles the forwarder set") — that test drives the
real engine over a real cold-start manager, traffic counters, and budget, with the *identical* `onEvict →
remove + forget` closure the host wires. The db-p2p `host.ts` wiring itself is only type-checked; no test
stands up a live host, floods `topicsMax + 1` topics through the real budget, and asserts the teardown at
the host layer.

This is belt-and-suspenders coverage, not a known defect — the wiring is four lines and its logic is
tested. Filed as debt so a future change to the host's budget/cold-start/traffic assembly can't silently
break the reconciliation without a failing host test.

## What to cover

A full-host test (natural home: `host-antidos-coldstart.spec.ts`, which already has a `topicsMax = 1`
full-host harness at ~line 186 for the budget-refusal case) that:

- Stands up a host with a small `antiDos.topicBudget.topicsMax`.
- Gets a **zero-participant, evictable** resident into the budget, then admits another topic that forces a
  genuine eviction of it. Producing an evictable (participantCount 0) resident at the host layer is the
  non-trivial part — the plain `makeReg` register path accepts a participant, which makes the topic
  *populated* and therefore never evictable. Two viable routes:
  - a willingness seam that declines the register (a forwarder instantiates via the cold path but no
    direct participant is added), or
  - an **accept → drain → evict** lifecycle: accept a participant, let its record TTL-drain (or withdraw)
    so the budget touches the slot back to count 0, then admit a new topic to evict the now-cold slot.
    This is the more realistic lifecycle a real topic follows and is the second coverage gap the
    implementer flagged; covering it here folds both gaps into one test file.
- After the eviction, asserts at the host layer: `ce.servesTopic(evicted) === false`, the forwarder is
  gone (`ce.forwarder(evicted) === undefined`), the budget no longer holds it (`ce.budgetHasTopic(evicted)
  === false`), and the survivor(s) still serve.

The engine-layer test is the reference for the shape of the assertions.
