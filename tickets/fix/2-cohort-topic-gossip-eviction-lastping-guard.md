description: When one node tells others "this registration is gone," the receivers delete their copy no matter what — so a slow node's outdated removal, arriving after the member has re-registered, wrongly deletes the fresh registration.
prereq:
files:
  - packages/db-core/src/cohort-topic/gossip/bus.ts           # ~201-203 — evicted refs deleted unconditionally
  - packages/db-core/src/cohort-topic/wire/validate.ts        # validateGossipRecordRefV1 — GossipRecordRefV1 shape
  - packages/db-core/src/cohort-topic/wire/types.ts           # GossipRecordRefV1
difficulty: medium
----

# Gossiped evictions delete unconditionally — stale eviction deltas kill fresh records

## The problem

Record *merges* over gossip are correctly last-writer-wins by `lastPing`. But record *evictions* are
not: `GossipRecordRefV1` carries only `(topicId, participantId)`, and `mergeRecords` deletes whatever is
held (`gossip/bus.ts:201-203`) with no freshness check.

So a slow member's stale eviction delta, arriving **after** the participant has re-registered, deletes
the newer record. It self-heals via the next renew → failover, but it breaks the replication invariant
(evictions are not LWW-ordered like merges are) and causes spurious failovers under message reordering.

## Expected behavior

An eviction should delete a record only when it is at least as new as the held record. Carry the evicted
record's `lastPing` in `GossipRecordRefV1`, and in `mergeRecords` delete only when
`held.lastPing <= ref.lastPing`. A stale eviction (`ref.lastPing < held.lastPing`) is ignored, so a
fresh re-registration survives.

## Repro sketch

- Hold record R1 for `(topic, participant)` with `lastPing = t1`.
- Re-register → newer record R2 with `lastPing = t2 > t1` now held.
- Deliver a stale eviction ref stamped from R1 (`lastPing = t1`).
- Current: R2 is deleted. With the fix: the stale eviction is ignored (`t1 < t2`) and R2 survives; a
  genuine eviction (`lastPing >= t2`) still deletes.

This changes the wire shape of `GossipRecordRefV1` (adds `lastPing`); update the validator and codec
round-trip tests accordingly.
