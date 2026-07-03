description: A slow node's outdated "this registration is gone" message could delete a registration the participant had already renewed; a freshness stamp now makes receivers ignore such stale removals.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts               # GossipRecordRefV1.lastPing (required)
  - packages/db-core/src/cohort-topic/wire/validate.ts            # validateGossipRecordRefV1 validates lastPing
  - packages/db-core/src/cohort-topic/wire/payloads.ts            # signing payload covers evicted lastPing
  - packages/db-core/src/cohort-topic/gossip/bus.ts               # mergeRecords eviction freshness guard
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts      # PendingDeltas.evicted stamps lastPing
  - packages/db-core/test/cohort-topic/gossip.spec.ts             # consumer guard tests
  - packages/db-core/test/cohort-topic/wire.spec.ts               # evicted-ref codec + signing tests
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts      # producer stamp + e2e reorder tests (added in review)
  - docs/cohort-topic.md                                          # wire-format table + merge prose
difficulty: medium
----

# Gossiped-eviction freshness guard — complete

## What shipped

Gossiped record *evictions* were unconditional: `GossipRecordRefV1` carried only `(topicId,
participantId)` and the receiver (`bus.mergeRecords`) deleted whatever it held. A slow member's stale
eviction, arriving after the participant re-registered, deleted the fresher record. The fix carries the
evicted record's `lastPing` on the wire ref and gates the delete: the receiver skips a delete when
`held.lastPing > ref.lastPing`. Producer stamps it; validator requires it (`reqFiniteNumber`); signing
payload covers it; docs updated. Full implementation detail is in the implement commit
(`git show c12023f`).

## Review findings

**Verdict: sound. No major findings — no new tickets filed. Two inline improvements applied.**

### Checked — correctness
- **Consumer guard (`bus.ts:226-244`)** — strict `>` skip is right: equal-stamp (`held == ref`) deletes,
  matching a genuine TTL-sweep eviction where a co-holder holds the same `lastPing`, and matching merge
  LWW (`incoming >= held` puts). Skipped topic correctly not added to `evictedTopics`, so no
  `onRecordsEvicted` budget re-touch for a no-op. Absent-record case (`held === undefined`) unchanged.
- **Producer (`cohort-gossip-driver.ts:114-119`)** — stamps `rec.lastPing`; `touch` still supersedes a
  queued eviction and vice-versa (key-collision LWW intact).
- **Wire** — required field on `types.ts`, validated in `validate.ts`, and included in the
  `payloads.ts` signing tuple `[topicId, participantId, lastPing]` (MITM cannot strip it).
- **Stray refs** — grepped every `evicted: [` literal and `GossipRecordRefV1` construction across
  `db-core`/`db-p2p` src + tests: all are typed (required field ⇒ compiler-enforced) or the deliberate
  wire.spec negative cases. None omit `lastPing`.
- **Docs** — `docs/cohort-topic.md` §Wire-formats table row (1543) and merge prose (1560-1564) describe
  the required field and the freshness rule. No other doc spot still calls eviction unconditional.

### Found & fixed inline (minor)
- **Producer stamp was asserted only by count, not value** (`gossip-cadence.spec.ts` "a touch after an
  eviction supersedes it"). The handoff claimed the producer stamp was tested via `drain`, but the test
  only checked `evicted.length === 1`. Added `expect(d.evicted[0]!.lastPing).to.equal(1_000)` so a
  regression that dropped the stamp would fail.
- **Filled the handoff's top gap: the end-to-end reorder test.** The two-node harness (`twoNodeCohort`)
  with real sign→encode→decode→`applyInbound` already existed, so building it was cheap. Added *"a stale
  eviction reordered AFTER a re-registration does not delete the fresh record on a sibling"*: register R1
  on A → replicate to B → reattach R2 (newer `lastPing`) → replicate to B → deliver a slow member's
  eviction stamped at the OLD `lastPing`; B keeps R2. Positive control in the same test: a genuine
  eviction stamped at the held `lastPing` still converges the delete — proving the guard ignores only
  *stale* evictions, not all of them. This exercises the whole path the fix protects, not just the units.

### Conditional / not filed (tripwires — knowledge, not tasks)
- **Extra `getByParticipant` per eviction ref** — already parked as a `NOTE:` at `bus.ts:229`. Evictions
  are low-volume; fold into a single conditional-delete store op only if profiling flags it. No action.
- **Non-monotonic clock degrades the guard** — the guard compares server `Date.now()` `lastPing` for the
  same `(topicId, participantId)`. If a holder's clock ran backwards across an evict→re-register, a
  genuine eviction could be skipped. Monotonic `now` is already assumed throughout this subsystem (see
  the renew-freshness `timestamp <= lastPing` gate, docs §1420), so this is not a *new* risk — it is the
  one input that, if violated, degrades the guard from "ignores stale" to "ignores some genuine". Genuinely
  conditional on a broken clock; recorded here, no code change.

### Design decision confirmed (no change)
- **`lastPing` is required, not optional.** A peer on old code sending an eviction ref without it fails
  validation for its *entire* gossip frame. Accepted: the substrate is pre-production and deploys
  together (decision already made in the fix ticket). Flagged again only so the rollout owner meets it.

## Validation (this pass)
- `@optimystic/db-core` build — clean; `gossip.spec.ts` + `wire.spec.ts` — **99 passing**.
- `@optimystic/db-p2p` build — clean (typechecks against rebuilt db-core dist);
  `gossip-cadence.spec.ts` — **18 passing** (includes the new producer assertion + e2e reorder test).
- No lint script in the workspace (`db-core`/`db-p2p` expose only `build` + `test`); build is the
  typecheck gate and is clean.
