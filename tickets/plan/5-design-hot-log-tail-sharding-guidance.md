description: Every write to one collection funnels through a single group of nodes, so a heavily-written collection has a hard throughput ceiling and the only relief today is to split the data across more collections — but nobody has written down that guidance for application authors. Document the sharding guidance now and sketch the sequencing of the planned longer-term fix.
prereq:
files:
  - packages/db-p2p/src/cluster/cluster-repo.ts (resolveRace — conflict losers rejected ~1142-1156)
  - docs/crdt-sync.md (HLC redesign — currently unimplemented)
  - docs/architecture.md (throughput/scaling guidance home)
difficulty: easy
----

Every write to a collection funnels through one critical cluster, and conflict losers are rejected outright (`resolveRace`, `cluster-repo.ts:1142-1156`). This is a correct CP tradeoff, but it means a single collection has a structural per-collection throughput ceiling. The acknowledged longer-term fix — the `crdt-sync.md` HLC (hybrid logical clock) redesign — is entirely unimplemented, so today there is no throughput story for a hot collection beyond "shard the data into more collections."

This is a design limit, not a defect. The gap is that application authors have no written guidance telling them the ceiling exists or how to work around it.

## Expected behavior

- Write the **sharding guidance for application authors now**: state plainly that per-collection write throughput is bounded by a single cluster, how to recognize when a collection is hot, and how to shard a hot collection across multiple collections to scale writes. Put it where app authors will find it (architecture/usage docs).
- **Sketch the sequencing of the crdt-sync migration** so that when contention becomes real, the HLC redesign stages are already ordered and can be turned into implementation tickets. This is documentation/planning only — do not implement the HLC redesign here.

## Edge cases & interactions

- **Sharding vs. cross-shard atomicity** — splitting a hot collection interacts with multi-collection atomicity (design-multi-collection-atomicity); the guidance must note that spreading writes across collections may reintroduce the cross-collection atomicity concern, so authors know the tradeoff.
- **Interaction with OCC starvation** (design-occ-starvation-backoff) — a hot collection is exactly where large transactions starve; cross-reference so the two mitigations are read together.
- **When to migrate** — define the signal (observed contention) that should trigger sequencing the crdt-sync stages, so the deferral is conditional and not open-ended.
