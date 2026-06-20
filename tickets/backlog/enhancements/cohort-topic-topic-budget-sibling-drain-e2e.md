description: We fixed a bug where a cohort never reclaimed topic slots, but only the simpler of the two fix paths is proven end-to-end through the real network harness; add an integration test that proves the other path too.
prereq:
files:
  - packages/db-core/src/cohort-topic/gossip/bus.ts            # Seam 2: onRecordsEvicted fired from mergeRecords
  - packages/db-p2p/src/cohort-topic/host.ts                   # createCoordEngine wires onRecordsEvicted → topicBudget.touch
  - packages/db-p2p/test/cohort-topic/cohort-topic-scale-antiflood.spec.ts  # where the Seam-1 e2e lives; add the Seam-2 sibling-drain case here
  - packages/db-p2p/src/testing/cohort-topic-mesh-harness.js   # buildMesh / setupTopic / gossipRound / participantPrimaryAt helpers
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts        # reference: replicate-a-record-to-a-sibling-over-gossip pattern (test 4)
difficulty: medium
----

# Backlog: end-to-end mesh coverage for the gossip sibling-drain budget release (Seam 2)

## Background

The topic-budget eviction-leak fix (completed) releases a per-cohort budget slot when a topic's last
participant drains, via two seams:

- **Seam 1 — engine TTL sweep** (`member-engine.ts` `sweepStale`): the participants this member is itself
  slot-primary for. **This seam IS proven end-to-end** through the real engine wire by the
  `cohort-topic-scale-antiflood.spec.ts` "a topic drained by the engine TTL sweep releases its budget slot"
  test.
- **Seam 2 — gossip eviction** (`gossip/bus.ts` `mergeRecords` → `onRecordsEvicted` → `host.ts` re-touch):
  participants sharded onto a **sibling** primary, which drain into the budget-holding member's store as
  gossip evictions rather than its own TTL sweep. This seam is unit-covered on the bus-callback contract
  (`db-core/gossip.spec.ts`) and the host wiring closure is a thin reuse of the same `store`/`topicBudget`
  the e2e-tested Seam 1 uses — but **no test drives the full sibling-drain scenario through the host + mesh.**

## What to build

An integration test (in `cohort-topic-scale-antiflood.spec.ts`, alongside the Seam-1 e2e) that proves a
sibling drain releases the budget-holding member's slot end-to-end:

1. Build a mesh with `topicBudget: { topicsMax: ... }` small enough to observe reuse.
2. Pick a budget-holding member **M** that admits a topic **T** (a register arriving at M runs
   `accept()` → admits T into M's budget and up-touches it).
3. Ensure T has a participant whose **slot-primary is a sibling S, not M** (use the harness's
   `participantPrimaryAt`-style helper to choose a participant landing on S). Gossip that participant's
   record to M (`gossipRound` on S + delay), so M's `directParticipants(T)` counts it — mirror the
   "a record replicates into a sibling store over gossip" pattern in `live-tier.spec.ts` test 4.
4. Drain the sibling-primary participant **on S** (TTL `sweepStale` on S), then `gossipRound` on S so the
   `evicted` delta propagates. Apply it to M (mesh delivery / `gossipRound`).
5. Assert M's `mergeRecords` ran `store.delete` **and** fired `onRecordsEvicted`, dropping
   `M.budgetParticipantCount(T)` to 0 — and that a new topic then reuses T's freed slot on M while a
   still-populated topic on M is never evicted.

The mesh harness already exposes the needed primitives (`buildMesh`, `setupTopic`, `handleRegister` with
participants whose primaries differ, `gossipRound`, the `budgetHasTopic` / `budgetParticipantCount`
diagnostics on `CoordEngine`). Watch for gossip-timing flake — the existing live-tier tests use
`waitFor`/`delay` around `gossipRound`; follow that discipline.

## Why backlog (not fix)

The Seam-2 production code is correct and unit-covered; this is integration-test debt, not a defect. It
hardens confidence on the multi-member drain path specifically. Treat the Seam-1 e2e as the template.
