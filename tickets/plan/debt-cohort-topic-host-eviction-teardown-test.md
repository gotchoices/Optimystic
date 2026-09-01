description: When a node drops its least-used topic to make room for a new one, we test that the slot is freed but never that the dropped topic actually stops being served; add those missing checks to an existing test.
files:
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts  # the existing drain→evict mesh test, lines 280-325 — extend here
  - packages/db-p2p/src/cohort-topic/host.ts                                # the onEvict wiring under test (~2074) and the CoordEngine diagnostics (~388-460)
  - packages/db-core/test/cohort-topic/member-engine.spec.ts                # reference: engine-layer version of the same assertions (~663)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts        # the topicsMax=1 single-host harness (~205); a fallback home, not the preferred one
difficulty: easy
----

# Plan: assert the topic-eviction teardown at the host layer

## Background in plain terms

A cohort node will only serve a bounded number of topics at once ("the topic budget"). When the budget
is full and a new topic arrives, the node drops the coldest topic it holds — one with zero remaining
participants — to make room. Dropping a topic has to do three things:

1. release its budget slot,
2. remove its *forwarder* (the object that makes the node answer "yes, I serve this topic"),
3. forget its traffic counters.

Only (1) is currently asserted at the host layer. If (2) regressed, the node would keep telling the
network it serves a topic it has no slot for, and the forwarder map would grow without bound.

The production wiring lives in `packages/db-p2p/src/cohort-topic/host.ts` at the `createTopicBudget`
call (~line 2074):

```ts
const topicBudget = createTopicBudget({
    ...ctx.antiDos.topicBudget,
    onEvict: (topicId: Uint8Array): void => {
        coldStart.remove(topicId);   // (2) drop the forwarder
        traffic.forget(topicId);     // (3) drop the traffic window
    },
});
```

## What the investigation found (this narrows the work a lot)

The original backlog ticket assumed the hard part was *producing an evictable zero-participant resident
at the host layer*, and proposed building a new full-host test for it. That test already exists.

`packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts` line 280, *"a topic drained by
the engine TTL sweep releases its budget slot, so a new topic reuses it while a still-populated topic is
never evicted"*, already runs the exact accept → drain → evict lifecycle over a real mesh of hosts
(`buildMesh` with `antiDos.topicBudget.topicsMax: 2`), through the real `CoordEngine` built by `host.ts`:

- registers topic B at `T0` and topic A at `T0 + ttl/3` (budget now full, both populated),
- controls that a third topic C is refused while both are populated,
- TTL-sweeps at `T0 + ttl + 1` so B drains to `budgetParticipantCount(B) === 0` and A survives,
- registers C, which evicts the cold B — firing the real `onEvict`,
- asserts `budgetHasTopic(B) === false`, `budgetHasTopic(C) === true`, and that A is untouched.

So the eviction genuinely fires at the host layer today; the test simply never looks at the teardown
side of it. `servesTopic(B)` and `forwarder(B)` are never checked, and both would still pass if
`onEvict` were deleted entirely.

## Scope

Extend the host-layer coverage so the teardown is pinned. Preferred shape: add the missing assertions to
the existing test at line 280 (and/or a sibling `it(...)` right after it in the same
`§Anti-DoS — per-cohort topic budget` describe block, if the existing test's narrative gets crowded).
Do **not** build a new full-host harness in `host-antidos-coldstart.spec.ts` — that was the original
ticket's plan and it is now redundant work.

After the eviction of the drained topic B, assert on the deciding engine:

- `servesTopic(B) === false` — the forwarder was removed, so the node no longer claims to serve B.
  This is the load-bearing assertion; it is the one that fails if `coldStart.remove` is dropped.
- `forwarder(B) === undefined` — the cold-start forwarder map entry is gone (no unbounded growth).
- The traffic window was forgotten: `topicTraffic(B)` reports zeroed counts. Confirm which field on
  `TopicTrafficV1` actually drops before asserting on it — `topicTraffic` blends the store's
  `directParticipants` with the last-published own counts and siblings' gossiped summaries, so pick a
  field that is genuinely sourced from the per-topic window `traffic.forget` clears, and skip this
  assertion rather than assert something vacuous.
- Negative controls, so the test can distinguish "teardown happened" from "everything is gone":
  the surviving populated topic A still has `servesTopic(A) === true` and a live `forwarder(A)`, and
  the newly-admitted C serves.

The engine-layer test in `packages/db-core/test/cohort-topic/member-engine.spec.ts` (~line 663,
*"topic-budget eviction reconciles the forwarder set"*) is the reference for assertion shape — it drives
the identical `onEvict` closure one layer down and is where the two-arm (with/without `onEvict`)
comparison already lives.

## Explicitly out of scope

- Any change to `host.ts`. This is test-only work; no defect is known or expected.
- The **gossip sibling-drain** path — a topic whose participants are sharded onto a *sibling* member and
  drain there as gossip evictions rather than this member's own TTL sweep. That is a different seam
  (`onRecordsEvicted` → `topicBudget.touch`, `host.ts` ~line 1835) and has its own backlog ticket,
  `cohort-topic-topic-budget-sibling-drain-e2e`, which also targets this same spec file. The two are
  independent; whichever lands second should just avoid stepping on the other's test names. No `prereq:`
  relationship.
- The "willingness seam that declines the register" route the original ticket floated as an alternative
  way to manufacture a zero-participant resident. The TTL-drain route already works at this layer; the
  willingness route is unnecessary.

## Validation

```
yarn workspace @optimystic/db-p2p test
```

(or the narrower mocha invocation this package uses for a single spec file). The added assertions must
fail if the `onEvict` body in `host.ts` is stubbed out — sanity-check that locally before handing off,
since a test that passes either way is exactly the failure mode this ticket exists to prevent.
