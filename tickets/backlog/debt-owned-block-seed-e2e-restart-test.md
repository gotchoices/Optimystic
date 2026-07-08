description: Add a test that starts a real node on top of storage that already contains blocks, then confirms the node's resilience monitors actually learn about those on-disk blocks — proving the restart-protection wiring works end to end, not just its individual pieces.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/owned-block-seed.ts, packages/db-p2p/test/spread-on-churn-node-wiring.spec.ts, packages/db-p2p/test/rebalance-monitor-node-wiring.spec.ts, packages/db-p2p/test/unify-tracked-block-set.spec.ts
difficulty: medium
----

# Test debt: end-to-end restart-seed test over a pre-populated backend

## Background

A node's churn-spread and rebalance monitors share a "blocks this node owns" set. Startup now seeds
that set from durable storage (`seedOwnedBlocksFromStorage`, wired in `createLibp2pNodeBase`) so a
restarted node protects on-disk data immediately. See the completed ticket
`optimystic-owned-block-initial-scan-seed`.

Each piece is unit-tested in isolation:
- the scan loop, via the extracted helper against `MemoryRawStorage`,
- the subscribe/gate/teardown wiring, via the existing node-wiring specs,
- each backend's `listBlockIds`, in that backend's own spec.

## The gap

Nothing tests the **integration seam**: construct a node whose raw storage already contains committed
blocks, let the fire-and-forget startup scan settle, and assert the node's monitor set (e.g.
`spreadOnChurnMonitor` / `rebalanceMonitor` tracked blocks) contains the seeded ids. A regression that
reordered the gate, passed the wrong set, or broke the background dispatch would pass every current
test.

## What to build

A test that:
- constructs a real node (via `createLibp2pNodeBase` or the existing node-wiring test harness) over a
  raw storage **pre-populated** with a few committed blocks — either a `MemoryRawStorage` seeded
  before construction, or a real fs/sqlite backend pointed at a populated dir;
- ensures at least one monitor is enabled (so `offOwnedBlockFeed` gates the scan on);
- waits for the background scan to settle (the task is fire-and-forget — poll the monitor's tracked
  set with a bounded timeout, do NOT assume synchronous population);
- asserts the seeded ids are present, and that a pending-only block (no metadata) is NOT seeded.

## Notes

- The scan is deterministic when driven through the helper; the *only* thing this test adds over the
  helper tests is that `createLibp2pNodeBase` actually calls it with the shared set under the right
  gate. Keep it small.
- Prefer a `MemoryRawStorage`-backed node if the harness allows pre-population before construction —
  avoids disk fixtures and is fast. Fall back to a temp-dir fs backend if construction owns storage
  creation.
