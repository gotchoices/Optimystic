# Cohort-topic traffic signal — doc updates (review)

description: review the doc-only edits to docs/cohort-topic.md that lock in the per-(topic, cohort) traffic signal design — gossip schema extension, four prose clarifications in §Topic traffic signal, and a tighter RegisterReplyV1.topicTraffic comment. No code changes anywhere.
files:
  - docs/cohort-topic.md
  - docs/matchmaking.md (read-only — verified consistent, not edited)
----

## What was changed

All edits are confined to `docs/cohort-topic.md`. No source files, schemas, or tests were touched (the cohort-topic layer has no implementation code yet — see the plan ticket's note that this is design-only).

### 1. `CohortGossipV1` extended (§Wire formats → Cohort gossip)

- Added two exact-integer rate fields to each `topicSummaries[]` entry:
  - `arrivalsPerMin` — combined fresh + renewals over `windowSeconds`
  - `queriesPerMin` — application-level queries over `windowSeconds`
- Hoisted `windowSeconds` to envelope level (single cohort-wide configuration, not per-topic).

### 2. §Topic traffic signal tightened

Four short clarifications added below the `TopicTrafficV1` code block:

- **Combined-rate rationale.** Explains why `arrivalsPerMin` is one scalar rather than fresh/renewal split, with a forward reference to matchmaking.md.
- **Responder's gossip-derived view.** Explicit statement that the reply uses the responder's most-recent gossiped per-topic entry; the responder does not recompute from raw counters at reply time. Worst-case staleness: one gossip round.
- **Exact-integer wire note.** Contrasts with the log-bucketed load barometer; explains why bucketing the traffic counts would buy nothing (intra-cohort gossip is tiny, consumer formulas are numeric).
- **Epoch-reset semantics.** Counters reset to zero on `cohortEpoch` change; first post-rotation gossip round may under-report, but matchmaking's edge-case rule tolerates this.

### 3. `RegisterReplyV1.topicTraffic` comment sharpened

Old: `// present on accepted; also returned on promoted`
New: `// present on accepted and promoted; absent on no_state, unwilling_member, unwilling_cohort`

No schema change. The optionality already implied absence; the new comment just makes it explicit.

## How to verify

This is doc-only — no build/test run is meaningful. Reviewer should:

1. **Read the diff against `docs/cohort-topic.md`** end-to-end and check the design decisions for internal consistency:
   - `CohortGossipV1.topicSummaries` entries now contain the rate fields that `TopicTrafficV1` exposes on the wire — both shapes should be consistent (they are: cohort gossip carries the per-topic subset that the responder later returns as `TopicTrafficV1`).
   - `windowSeconds` appears once at envelope level in `CohortGossipV1` and once at the top of `TopicTrafficV1`. These are the same window value; the on-the-wire `TopicTrafficV1` re-emits it so consumers don't have to look up cohort gossip schema. Verify this is acceptable redundancy.
   - The four prose clarifications don't contradict each other or the surrounding sections.

2. **Verify the matchmaking.md sibling stays consistent.** Specifically:
   - `docs/matchmaking.md:186, 188, 202, 209-210, 221, 226-227, 251, 262, 266, 345` reference `topicTraffic`, `arrivalsPerMin`, `queriesPerMin`. These use exact integer arithmetic, matching the resolved "exact integers on the wire" decision. The `expectedNewMatches` and `contentionFactor` formulas at lines 226-227 do not require any bucketing logic.
   - The plan ticket's mention of the sibling `matchmaking-hangout-decision` ticket: not present in repo at review time. Out of scope here.

3. **Cross-references to verify resolve correctly:**
   - `[matchmaking.md §Hang-out vs. continue](matchmaking.md#hang-out-vs-continue)` — anchor must exist in matchmaking.md (it does, around `docs/matchmaking.md:200`).
   - `[Membership rotation and primary handoff](#membership-rotation-and-primary-handoff)` — anchor is at `docs/cohort-topic.md:295`.
   - `§Cohort gossip below` and `§Capacity barometer` references — both present.

## Use cases / test sketches (for future implement pass)

This ticket cannot ship runnable tests because there is no cohort-topic implementation yet. The original ticket spelled out what an eventual implementation should verify; reproduced here so the reviewer can sanity-check the design supports them:

- **Counter increments.** `RegisterV1` and `RenewV1` bump that member's local `arrivalsPerMin` accumulator. `QueryV1` (application-defined) bumps `queriesPerMin`. Other RPCs do not contribute.
- **Window roll-off.** Events older than `windowSeconds` no longer contribute. Steady 1/sec arrivals → `arrivalsPerMin` converges to ~60.
- **Gossip propagation.** After one gossip round, all members' `topicSummaries[topicId].arrivalsPerMin` agree.
- **Reply payload.** `RegisterReplyV1` with `result="accepted"` or `"promoted"` carries non-null `topicTraffic` matching the responder's most-recent gossip-derived view. The other three `result` values omit it.
- **Epoch reset.** Counters reset to zero when `cohortEpoch` changes. First reply after rotation reports zeros; gossip refills over the next window.
- **Advisory-only.** Injecting `arrivalsPerMin = 10^9` into a reply does not change admission, routing, promotion, or threshold-signing.

## Known gaps / honest flags for the reviewer

- **No runnable verification.** The cohort-topic layer is design-only at HEAD; the closest related code (FRET, transaction log) does not yet know about cohort-topic. The reviewer must judge the design on its own merits — there is no behavior to observe.
- **Redundant `windowSeconds`.** The field appears both in `CohortGossipV1` (envelope) and `TopicTrafficV1` (the reply payload). This is intentional — gossip is intra-cohort, replies are participant-facing — but it does mean the value is sent twice when a member packs a gossip-derived view into a reply. If the reviewer prefers the reply to omit `windowSeconds` and define it as a layer-wide constant, that's a defensible alternative; the current design chose explicit-on-wire for forward compat.
- **Matchmaking edge-case cross-reference.** The epoch-reset note claims "matchmaking's edge-case rule does not withdraw on a single zero reading without first issuing a query to confirm." This rule exists in spirit in matchmaking.md §Hang-out vs. continue but is not spelled out there as a literal "do not withdraw on single zero" sentence. If a reviewer pushes back on the claim, the matchmaking doc may need a small clarifying sentence — but that's a matchmaking-doc edit, not a cohort-topic-doc edit.
- **`childCohortCount` semantics on demoted cohorts.** Not touched here, but worth flagging: the existing comment says "0 if not promoted." A reviewer might wonder about a cohort that was promoted then demoted. This ticket did not change that behavior or comment.

## TODO

- [ ] Reviewer reads the doc diff for internal consistency.
- [ ] Reviewer confirms cross-references resolve to live anchors.
- [ ] Reviewer cross-checks `docs/matchmaking.md` lines 186-345 for any new inconsistency with the resolved semantics.
- [ ] Minor findings → fix inline. Major findings → spawn `fix/` or `plan/` ticket(s) and route the rest to `complete/` with a `## Review findings` section.
