description: A slow node's outdated "this registration is gone" message could delete a registration the participant had already renewed; a freshness stamp now makes receivers ignore such stale removals.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts               # GossipRecordRefV1.lastPing (required) added
  - packages/db-core/src/cohort-topic/wire/validate.ts            # validateGossipRecordRefV1 validates lastPing
  - packages/db-core/src/cohort-topic/wire/payloads.ts            # gossip signing payload covers evicted lastPing
  - packages/db-core/src/cohort-topic/gossip/bus.ts               # mergeRecords eviction freshness guard
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts      # PendingDeltas.evicted stamps lastPing
  - packages/db-core/test/cohort-topic/gossip.spec.ts             # eviction guard tests
  - packages/db-core/test/cohort-topic/wire.spec.ts               # evicted-ref codec + signing tests
  - docs/cohort-topic.md                                          # wire-format table + prose updated
difficulty: medium
----

# Gossiped-eviction freshness guard — implemented

## What was wrong

Record *merges* over cohort gossip are last-writer-wins by `lastPing`. Record *evictions* were **not**:
the eviction reference (`GossipRecordRefV1`) carried only `(topicId, participantId)`, and the receiver
(`bus.mergeRecords`) deleted whatever it held **unconditionally**. So a slow member's stale eviction,
arriving *after* the participant re-registered, deleted the newer record — breaking the replication
invariant and causing spurious failovers under message reordering. It self-heals on the next renew, but
the reordering window was a real hole.

## What changed

The evicted record's `lastPing` now rides on the wire ref, and the delete is gated on it.

- **Wire shape** — `GossipRecordRefV1` gains a **required** `lastPing: number` (unix ms), mirroring
  `GossipRecordV1.lastPing`. Validator (`reqFiniteNumber`), signing payload, and round-trip tests follow.
- **Producer** (`cohort-gossip-driver.ts`, `PendingDeltas.evicted`) stamps `lastPing: rec.lastPing` from
  the held `RegistrationRecord` it already receives.
- **Consumer** (`bus.ts`, `mergeRecords` eviction loop) looks up the held record and deletes **only when
  `held.lastPing <= ref.lastPing`**. A stale eviction (`held.lastPing > ref.lastPing`) is skipped — and
  because nothing drained, the topic is **not** added to `evictedTopics`, so no `onRecordsEvicted` budget
  re-touch fires for a skipped eviction (a live participant keeps its slot).
- **Signing** (`payloads.ts`) — `lastPing` is included in the evicted tuple, so a MITM cannot strip/alter
  it to turn a stale eviction back into a wild-card delete.
- **Docs** (`docs/cohort-topic.md`) — the §Wire-formats `evicted?:` table row and the merge prose were
  updated to describe the required `lastPing` and the freshness rule.

## Boundary / design choices to sanity-check

- **`held.lastPing > ref.lastPing` uses strict `>`** — an eviction stamped **equal** to the held record
  still deletes (a genuine eviction of the same record). This matches merge LWW (`incoming.lastPing >=
  held.lastPing` puts). Confirm the equal-stamp case is intended to delete (it is: the normal
  TTL-sweep eviction stamps the record's own `lastPing`, which equals what a co-holder holds).
- **`lastPing` is required, not optional** (per the ticket's already-made decision). Consequence, and the
  one thing worth a reviewer's eye: **a peer still on old code that sends an eviction ref without
  `lastPing` fails validation for its *entire* gossip frame** (not just the eviction) — the frame is
  dropped. Deemed acceptable because the substrate is pre-production and deploys together. If that
  assumption is wrong for your rollout, this is the place it bites.
- **Absent-record case is unchanged**: when `held === undefined`, the delete is a harmless no-op and the
  topic still flows to `onRecordsEvicted` (budget re-touch), exactly as before. Only the genuinely-stale
  `held.lastPing > ref.lastPing` case is newly skipped.

## How it was validated

Build + both suites green (streamed):
- `yarn workspace @optimystic/db-core build` — clean (dist regenerated so db-p2p typechecks against it).
- `yarn workspace @optimystic/db-core test` — **1076 passing**.
- `yarn workspace @optimystic/db-p2p test` — **1102 passing, 36 pending, 0 failing**
  (the `cohort-topic cold-start: … failed` console lines are expected — those tests exercise failure
  paths and still pass).
- `yarn workspace @optimystic/db-p2p build` — clean (confirms the driver's `lastPing` stamp typechecks
  against the rebuilt db-core dist).

Tests added (these are the floor, not the ceiling — see gaps):
- `gossip.spec.ts`:
  - **stale eviction ignored** — hold R2 `lastPing=5_000`, deliver eviction stamped `1_000`, R2 survives.
  - **genuine eviction deletes** — held `lastPing=1_000`, eviction stamped `1_000` and `9_000` both delete.
  - **stale eviction fires no budget re-touch** — `onRecordsEvicted` not called when the delete is skipped;
    the live participant keeps its budget slot.
  - existing eviction tests updated to stamp `lastPing` via a new `evictionRef(rec, lastPing)` helper.
- `wire.spec.ts`:
  - evicted-ref **round-trips** with `lastPing`; **rejects** a missing `lastPing` and a non-finite one.
  - the **signing payload covers `lastPing`** — two refs differing only in `lastPing` sign distinct images.

## Known gaps / where to push (reviewer: treat tests as a floor)

- **No full end-to-end reorder test.** The consumer guard is tested directly via `bus.applyInbound`, and
  the producer stamp is tested via `PendingDeltas.drain`, but **nothing exercises the whole path**
  (renewal → `PendingDeltas.evicted` → `drain` → `buildCohortGossip` → encode → decode → `applyInbound`)
  with a genuine re-registration racing a delayed eviction frame across two real buses. A
  `gossip-cadence`/mesh-level test that reorders a re-register ahead of an in-flight eviction would prove
  the fix at the seam it actually protects. Consider it the highest-value follow-up if the reviewer wants
  more than unit coverage.
- **Cross-topic collision not re-examined.** The guard compares `lastPing` for the same
  `(topicId, participantId)`. If a participant id were ever reused across a rapid evict→re-register with a
  *lower* clock (clock skew / non-monotonic `now`), a genuine eviction could be skipped. Clocks here are
  server `Date.now()` on the holder; monotonicity is assumed elsewhere too, so this is not a new risk —
  but it is the one input that, if violated, degrades the guard from "ignores stale" to "ignores some
  genuine". Worth a sentence of reviewer judgment, not a code change.
- **Tripwire (already parked in code, not a ticket):** `bus.ts` — the guard adds one
  `getByParticipant` per eviction ref on top of the delete's own lookup. Evictions are low-volume, so
  it's fine now; a `NOTE:` at the site says to fold it into a single conditional-delete store op *if*
  that path ever shows as hot. No action unless profiling says so.

## Suggested review focus

1. The `>` vs `>=` boundary in `bus.ts` (equal-stamp deletes) — is that the intended semantics?
2. The required-`lastPing` back-compat consequence (whole-frame rejection for old peers) — acceptable for
   the intended rollout?
3. Whether to add the end-to-end reorder test before this is considered done.
