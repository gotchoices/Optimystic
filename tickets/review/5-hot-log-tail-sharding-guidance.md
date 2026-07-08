description: Review documentation additions for write-throughput ceiling and collection sharding guidance in optimystic.md and crdt-sync.md.
prereq:
files:
  - docs/optimystic.md
  - docs/crdt-sync.md
difficulty: easy
----

## What was implemented

Added a new **"Write Throughput and Collection Sharding"** section to `docs/optimystic.md` (between "Operational Basics" and "See Also"), and a **trigger note** to the `§Migration Path` section of `docs/crdt-sync.md`.

## optimystic.md — new section covers

- **Per-collection throughput ceiling** — the log-tail cluster as the ordering bottleneck; why the ceiling is structural (CP design), not a tunable.
- **Recognizing a hot collection** — three signals: OCC retry rate (`cluster-member:consensus-pend-diverged` under `DEBUG='optimystic:db-p2p:cluster*'`), asymmetric PEND/COMMIT latency, large transactions losing to small ones.
- **How to shard** — partition by stable attribute (e.g. `userId mod 8`); each sub-collection has its own cluster; avoid time-based shards for near-real-time writes.
- **Cross-shard atomicity tradeoff** — uses `TransactionSession`, gives atomicity-of-intent with eventual reported visibility (correctness.md Theorem 3); cross-shard boundaries should align with domain ownership units.
- **OCC starvation interaction** — sharding and starvation mitigations are complementary; section explicitly says to use both together.
- **Long-term fix** — HLC CRDT redesign in crdt-sync.md removes the ceiling structurally; unimplemented; sharding is current production path.

## crdt-sync.md — trigger note

Prepended to `§Migration Path` (before "A full rewrite is unnecessary"). States: signal is contention on a hot collection where sharding isn't practical. Action: file Stage 1–5 as sequenced implementation tickets gated via `prereq:`. Do not advance stages without measuring.

## Use cases for reviewer to test

1. **Hot collection identification**: Does the guidance give a reader enough signal to diagnose a hot collection without already knowing the internals? Check against the three signals listed (OCC retry log, latency asymmetry, large-tx starvation).
2. **Sharding example**: Is the TypeScript snippet realistic and complete enough to follow? Is the modular arithmetic example clear?
3. **Cross-shard warning**: Is the atomicity tradeoff prominent enough? The partial-landing possibility is easy to miss if the warning is buried.
4. **crdt-sync trigger note**: Is it conditional enough? It should read as "if sharding fails you, then file these tickets" — not as an immediate call to action.
5. **Internal link accuracy**: All `[crdt-sync.md](crdt-sync.md)`, `[transactions.md](transactions.md)`, and `[correctness.md](correctness.md)` cross-references should point to existing files.

## Known gaps

- No mention of per-shard cluster-size tuning (lowering `clusterSize` per sub-collection can reduce round-trip latency further, but this interacts with Byzantine-fault thresholds). Left out to avoid scope creep; could be a follow-on paragraph if the reviewer thinks it belongs.
- The `cluster-member:consensus-pend-diverged` log key is the best observable signal available today; it is not a direct throughput metric. A future instrumentation ticket could add explicit per-collection ops/sec counters.

## Review findings

- Tripwire noted: `cluster-member:consensus-pend-diverged` is the best current observable for OCC contention, but it counts re-races not throughput. If observability tooling gets added to cluster-repo, a richer metric would replace this signal. Parked as a `// NOTE:` comment would be premature here (no single code site); noted here for the record.
