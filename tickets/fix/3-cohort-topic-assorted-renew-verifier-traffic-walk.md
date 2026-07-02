description: Four small cohort-topic defects — a renewal stamps the wrong id, three attacker-influenced maps have no size limit, a per-registration scan does far more work than needed at scale, and a retry counter permanently skips the best candidate in each fresh list.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts              # ~line 294 — RenewV1.correlationId stamped with cohort epoch
  - packages/db-core/src/cohort-topic/membership/verifier.ts  # ~142-216 — byCoord/lastFetchAt/staleGapStrikes unbounded
  - packages/db-core/src/cohort-topic/traffic.ts              # ~129-137 — snapshot() O(members × summaries)
  - packages/db-core/src/cohort-topic/walk.ts                 # ~260-268 — memberAttempts % candidates.length skips first candidate
difficulty: medium
----

# Assorted cohort-topic fixes: renew correlationId, unbounded verifier maps, traffic snapshot cost, walk retry skip

Four independent low-severity defects, groupable into one change (each is small; split only if needed):

## (a) Renew stamps the wrong correlation id

`service.ts:294` stamps `RenewV1.correlationId` with the **cohort epoch** instead of the original
register's correlation id (the docs say otherwise). Beyond being wrong, it poisons any future
renew-path replay guard (see the freshness/replay work) since the id no longer correlates to the
registration. Stamp the register's correlation id as documented.

## (b) Unbounded verifier maps keyed by attacker-derivable coords

`membership/verifier.ts:142-216`: `byCoord`, `lastFetchAt`, and `staleGapStrikes` are unbounded maps
keyed by coords an attacker can derive. LRU-cap them (mirroring the rate-limiter / promote-gate caps that
already landed).

## (c) Traffic snapshot is O(members × summaries)

`traffic.ts:129-137`: `snapshot()` does an O(members × summaries) linear `find` per register reply
(~32k comparisons at scale). Index the summaries by `topicId` at merge time so the snapshot is a lookup,
not a scan.

## (d) Walk retry skips the best candidate

`walk.ts:260-268`: `memberAttempts % candidates.length` persists across replies, so the counter
permanently skips the first (best) candidate of each fresh candidate list. Track tried members in a Set
per candidate list instead of a modulo counter, so each fresh list is tried from its best candidate.

## Expected behavior

- Renew carries the register's correlation id (matches docs; replay guard can correlate).
- The three verifier maps are size-bounded under attacker-chosen coords.
- `snapshot()` is O(members + summaries) via a topic-id index.
- The walk tries the best candidate of every fresh list; no candidate is permanently skipped.
