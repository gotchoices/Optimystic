# Cohort-topic traffic signal — doc updates

description: lock the per-(topic, cohort) traffic signal design in docs/cohort-topic.md by extending the gossip schema, resolving the open design questions from the plan, and codifying responder + epoch-reset semantics. Doc-only — no cohort-topic implementation code exists yet.
files:
  - docs/cohort-topic.md
----

## Context

The plan ticket left the bulk of the prose already landed in `docs/cohort-topic.md` (§Concepts bullet, §Topic traffic signal, the `topicTraffic?` field on `RegisterReplyV1`, and the `TopicTrafficV1` interface). Five open questions in the plan TODO need decisions, and the gossip schema (`CohortGossipV1.topicSummaries`) still needs the per-topic rate fields. This ticket is the doc PR that closes those gaps.

No cohort-topic source code exists in `packages/` yet; the layer is still in design. Tests are sketched here for a future implement pass — there is nothing runnable to wire them to.

## Design decisions (resolutions of plan TODOs)

1. **Gossip extension point — `CohortGossipV1.topicSummaries`.** Per-topic stock data already lives there; add the rate fields as sibling entries so a member's view of one topic is a single sub-record. No new envelope-level field.
2. **Combine fresh registrations and renewals into one `arrivalsPerMin` scalar.** Matchmaking's `expectedNewMatches` math uses only the combined value; splitting introduces a wire field with no current consumer. If a later consumer needs the split, revisit then.
3. **Exact integers on the wire.** Cohort gossip is intra-cohort and tiny; bucketing buys nothing and complicates the consumer-side formulas. The load barometer is bucketed because it is a coarse priority signal; traffic counts feed numeric formulas in the seeker's hang-out math.
4. **Reply uses the responder's gossip-derived view.** The responder reads its own most-recent `topicSummaries` entry for the topic (the same one it last gossiped). It does not recompute from raw counters at reply time. Worst-case staleness is one gossip round; consumers tolerate this.
5. **Epoch-reset semantics.** Counters reset to zero on `cohortEpoch` change. The first gossip round after rotation may under-report; matchmaking's edge-case rule already accounts for this (it does not withdraw on a single zero reading without first issuing a query).

## Doc edits

### 1. Extend `CohortGossipV1.topicSummaries` entries

Currently:

```
topicSummaries: {
  topicId:            string
  tier:               number
  directParticipants: number
  promoted:           boolean
  childCohortCount:   number
}[]
```

Becomes:

```
topicSummaries: {
  topicId:            string
  tier:               number
  directParticipants: number        // exact
  arrivalsPerMin:     number        // exact, combined fresh + renewals over windowSeconds
  queriesPerMin:      number        // exact, application-level queries over windowSeconds
  promoted:           boolean
  childCohortCount:   number
}[]
windowSeconds:        number        // observation window for the rate fields, cohort-wide
```

`windowSeconds` is hoisted to the envelope (not per-topic) because it is a single cohort-wide configuration.

### 2. Tighten §Topic traffic signal

In the existing section (around `docs/cohort-topic.md:220`):

- Replace the inline comment on `arrivalsPerMin` ("fresh registrations + renewals into this cohort for this topic") with a one-line note that this combines both intentionally — the seeker uses renewals as a proxy for active matchable supply, and a separate scalar is not currently needed.
- Add an explicit sentence stating the responder returns its own most-recent gossip-derived view (already implied; make it explicit and reference the gossip entry).
- Add an explicit sentence stating the counters reset on `cohortEpoch` change, with a forward reference to the §Primary and backup sharding membership-rotation discussion.
- Add a one-line note that the wire format uses exact integers (not log-bucketed like the load barometer).

### 3. Cross-references

- §Concepts bullet on "Topic traffic" (already present at `docs/cohort-topic.md:50`) — no change needed.
- §Wire formats, `RegisterReplyV1` — the existing optional `topicTraffic` field stays optional (absent on `no_state`, `unwilling_member`, `unwilling_cohort`; present on `accepted` and `promoted`). Confirm comment matches.
- §Promotion and demotion lifecycle — no change. The signal is advisory and explicitly does not feed promotion.

## Test sketches (for future implement pass once code lands)

These describe what an eventual cohort-topic implementation would verify; this ticket does not add tests because there is nothing to test against yet.

- **Counter increments.** `RegisterV1` and `RenewV1` for a topic on a cohort member each bump that member's local `arrivalsPerMin` accumulator. `QueryV1` bumps `queriesPerMin`. Other RPCs do not.
- **Window roll-off.** Events older than `windowSeconds` no longer contribute to the rate. With a steady 1/sec arrival rate, `arrivalsPerMin` converges to ~60.
- **Gossip propagation.** One member observes an arrival; after one gossip round, all members' `topicSummaries[topicId].arrivalsPerMin` reflect the same value.
- **Reply payload.** `RegisterReplyV1` with `result="accepted"` carries non-null `topicTraffic` matching the responder's local gossip-derived view. Same for `result="promoted"`. `no_state`, `unwilling_member`, and `unwilling_cohort` replies omit the field.
- **Epoch reset.** After a cohort membership rotation that changes `cohortEpoch`, all per-topic counters reset to zero; the first `topicTraffic` reply after rotation reports zeros and the gossip-derived view begins refilling.
- **Advisory-only.** Inject extreme values into `topicTraffic` (e.g. `arrivalsPerMin = 10^9`); verify that admission, routing, promotion, and threshold-signing decisions are unchanged.

## TODO

- Apply doc edit (1) in `docs/cohort-topic.md`: extend `CohortGossipV1.topicSummaries` entries with `arrivalsPerMin` and `queriesPerMin`; hoist `windowSeconds` to the envelope.
- Apply doc edit (2) in §Topic traffic signal: add the four short clarifications listed above (combined-rate rationale, responder's gossip-derived view, epoch-reset semantics, exact-integer wire note).
- Apply doc edit (3): confirm `RegisterReplyV1.topicTraffic` field comment is consistent with the resolved semantics; no schema change.
- Verify the matchmaking sibling doc (`docs/matchmaking.md`) and the sibling plan ticket (`matchmaking-hangout-decision`) still reference the substrate correctly — no edit needed unless an inconsistency surfaces.
