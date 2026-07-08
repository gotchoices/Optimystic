description: Add write-throughput and collection-sharding guidance to the application developer docs, and a trigger note to the CRDT migration path, so app authors know the ceiling exists and how to work around it.
prereq:
files:
  - docs/optimystic.md
  - docs/crdt-sync.md
  - packages/db-p2p/src/cluster/cluster-repo.ts
difficulty: easy
----

## Design

Every write to a collection is ordered by a single **log-tail cluster** — the K peers responsible for the tail block of the collection's transaction log.  Each write must clear a super-majority promise+commit round before it completes (`resolveRace`, `cluster-repo.ts:1142-1156`).  That consensus round is the hard throughput ceiling for the collection.  There is no way to raise the ceiling for a single collection; the only relief is to spread writes across more collections (each with its own log-tail cluster).

The HLC redesign in `crdt-sync.md` removes this bottleneck structurally, but it is entirely unimplemented.  Sharding is the current production path.

The staging in `crdt-sync.md §Migration Path` (Stage 1–5) already exists.  The missing piece is a clear trigger signal: when should an application team start turning those stages into implementation tickets?

## TODO

### docs/optimystic.md — add "Write Throughput and Collection Sharding" section

Insert a new section between "Operational Basics" and "See Also".  The section must cover:

**Per-collection throughput ceiling**
- Every write to a collection goes through a single log-tail cluster (K peers, typically `clusterSize`).  The ceiling is roughly `(super-majority round-trip latency)⁻¹` writes per second.
- This is a CP design choice: strong linearizability per collection, but a structural throughput cap.

**Recognizing a hot collection**
- OCC retry rate climbs (conflict-losers from `resolveRace` logged under `DEBUG='optimystic:db-p2p:cluster*'`, key `cluster-member:consensus-pend-diverged`).
- PEND/COMMIT latency on one collection grows while other collections are unaffected.
- Large transactions on the hot collection start losing to smaller ones — see the OCC starvation mitigations already in place (priority aging, structural read exclusion) but note those mitigations reduce starvation, not the ceiling itself.

**How to shard**
- Partition the logical key-space across N collections keyed by a stable attribute (e.g. `messages-<userId mod 8>`, `events-<isoWeek>`).  Each sub-collection has its own log-tail cluster, so write throughput scales with N.
- The partitioning key should distribute writes evenly.  Avoid time-based shards for near-real-time hot writes (all writes land in one shard until the bucket rotates).

**Tradeoff: cross-shard atomicity**
- A write that must touch two shards requires a multi-collection transaction (GATHER + supercluster, see [transactions.md](transactions.md) and correctness.md Theorem 3).  The guarantee is atomicity-of-intent with eventual, reported visibility — not literal all-or-nothing.
- Design writes to be shard-local wherever possible.  Cross-shard operations are safe but carry the GATHER overhead and reintroduce the cross-collection partial-landing possibility.
- See also: [architecture.md](architecture.md) §"Transactions Across Collections" for the formal guarantee.

**OCC starvation interaction**
- A hot collection is precisely where large transactions lose to smaller ones under OCC priority ordering.  Priority aging and structural read exclusion (already implemented) reduce starvation but do not remove the throughput ceiling.  Sharding addresses the ceiling; the starvation mitigations address fairness within a shard.  Use both together on a hot collection.

**Long-term fix**
- The HLC (hybrid logical clock) redesign in [crdt-sync.md](crdt-sync.md) removes the single-cluster ordering bottleneck by replacing consensus-based sequencing with deterministic replay over an HLC-ordered log.  It is unimplemented.  Sharding is the current production relief until the migration lands.

### docs/crdt-sync.md — add trigger note to §Migration Path

Insert a short paragraph at the top of the Migration Path section (before "A full rewrite is unnecessary"):

> **When to start.** The signal is observed contention on a hot collection that sharding cannot practically resolve — for example, the logical key-space resists even partitioning, or the number of sub-collections has grown large enough to make cross-shard writes routine.  At that point, turn Stage 1 through Stage 5 into sequenced implementation tickets (one ticket per stage), gated in order via `prereq:`.  Do not start Stage 2 or later until Stage 1 is shipped and measured.

## Edge cases & interactions

- Cross-shard atomicity must be called out explicitly in the guidance; leaving it implicit causes authors to believe sharding is purely additive.
- OCC starvation cross-reference must point to the already-implemented mitigations (priority aging, structural read exclusion) so authors don't repeat work.
- The crdt-sync trigger note must be conditional ("fine now; if contention is real enough that sharding hits limits") — it is a tripwire, not a call to action today.
- Do not alter the body of the Stage 1–5 descriptions in crdt-sync.md; only prepend the trigger paragraph.
