# Matchmaking seeker hang-out decision

description: seeker-side decision rule that uses cohort-topic `topicTraffic` to choose between hanging out at the current tier vs. continuing toward the root; the missing "am I in the right place, and for how long" feedback during a walk
prereq: cohort-topic-traffic-signal
files:
  - docs/matchmaking.md (new section "Hang-out vs. continue"; updated walk-reply table; `topicTraffic` field on QueryReplyV1)
  - docs/cohort-topic.md (substrate dependency; see prereq ticket)
----

Today a seeker walking from `d_max` toward the root knows whether each cohort is in the tree (`Accepted` / `NoState` / `Promoted` / `Unwilling*`) but not whether the tier it lands on is dense enough to satisfy `wantCount` within its patience budget. A deep tier holds only the seeker's prefix-shard; the root holds the union. With no flow signal the seeker has to commit blind — either always settle on the first `Accepted` (under-matches on cold topics) or always walk to the root (wastes log-many RPCs on hot topics and reintroduces the hotspot the tree exists to avoid).

The cohort-topic substrate now carries `topicTraffic` on every `Accepted` and `Promoted` reply (see prereq ticket). This ticket designs the matchmaking-specific layer on top: how a seeker turns that signal plus its own task parameters into a stay-or-walk decision, and what extensions matchmaking's own wire format needs.

## Decision inputs

From the substrate reply (`topicTraffic`): `directParticipants`, `arrivalsPerMin`, `queriesPerMin`, `childCohortCount`.

From the seeker (task-defined): `wantCount`, `patienceMs`, `filter`.

Derived on the seeker:

- `filterAcceptRatio` — local estimate of the fraction of returned providers passing `filter`. Starts at 1.0; refined from observed query yields across the walk.
- `meanWantCount` — used in the contention term; a small constant (e.g. 3) is sufficient absent better data.

## Decision rule (at tier d, after `Accepted`)

1. Issue `QueryV1` with the seeker's filter and `limit`.
2. If matching providers ≥ `wantCount`, done; dial and return.
3. Compute hang-out feasibility:
   ```
   expectedNewMatches ≈ arrivalsPerMin × filterAcceptRatio × (patienceMs / 60000)
   contentionFactor   ≈ 1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1)
   ```
   If `currentMatches + expectedNewMatches ≥ wantCount × contentionFactor`, keep the seeker registration alive (renew within TTL) and re-query periodically until satisfied or patience drains.
4. Else withdraw (`RenewV1` TTL=0; optional but polite), re-register at `d − 1`, decrement remaining patience, repeat.

At `d = 0` the seeker is terminal: hang out for whatever patience remains, return partial results if `wantCount` isn't met.

## Wire-format additions

`QueryReplyV1` gains a non-optional `topicTraffic` field (sourced from cohort-topic substrate; matchmaking just forwards the substrate's view, since the same cohort that holds the providers measures their arrival rate).

```
interface QueryReplyV1 {
  v:             1
  providers?:    ProviderEntryV1[]
  seekers?:      SeekerEntryV1[]
  truncated:     boolean
  cohortEpoch:   string
  topicTraffic:  TopicTrafficV1
  signature:     string
}
```

No other matchmaking wire types change. The seeker uses `topicTraffic` from the initial `RegisterReplyV1` (`Accepted`) on the first decision and from `QueryReplyV1` on subsequent re-queries while hanging out — `QueryReplyV1` gives a slightly fresher reading because the seeker is by definition asking again.

## Configuration additions

Add to matchmaking defaults:

| Parameter | Default | Description |
|---|---|---|
| `patience_default_ms` | 10 000 | Fallback when caller does not specify per-task |
| `patience_per_tier_fraction` | 1.0 | Fraction of remaining patience spent at one tier before considering escalation; 1.0 means "spend it all here before walking" |
| `filter_accept_ratio_initial` | 1.0 | Starting estimate, refined per walk |
| `contention_factor_cap` | 4.0 | Upper bound on the contention multiplier |
| `requery_interval_ms` | 1 000 | How often to re-issue `QueryV1` while hanging out |

Patience ranges per use case (illustrative; the layer does not dictate):

- Latency-sensitive task assignment: 1–5 s
- Interactive capability lookup: 5–30 s
- Voting-quorum assembly: 30–300 s
- Background work batching: minutes

## Edge cases

- **Topic traffic absent on reply.** Substrate guarantees `topicTraffic` on `Accepted` and `Promoted`. If absent (older peer), seeker treats the cohort as zero-rate and walks toward the root.
- **Stale `arrivalsPerMin = 0` immediately after cohort epoch change.** Counters reset on rotation; the first 60 s after rotation may under-report. Seeker tolerates by *not* withdrawing on a single zero reading — it issues one query first and only walks on if the query also yields nothing.
- **Cohort under T0 load returns `UnwillingCohort` before `topicTraffic` is computed.** Standard substrate back-off; the hang-out path is not entered.
- **Filter that matches almost nothing.** `filterAcceptRatio` falls toward zero across the walk; the seeker eventually walks all the way to the root. Acceptable — pathological filters are inherently expensive.
- **Many seekers competing simultaneously.** `queriesPerMin` rises and the contention factor pushes more seekers to walk toward the root, which is where aggregation lives. Self-balancing.

## Worked check

A seeker needs 8 `pdf-render` providers, `patienceMs = 10 s`. Tree depth 1 (200 providers in a 1M-peer network).

- `d_max ≈ 5`. `d = 5..2` all return `NoState`. `d = 1` returns `Accepted` with `topicTraffic = { directParticipants: 6, arrivalsPerMin: 90, queriesPerMin: 4 }`.
- Query returns 6, need 8. `expectedNewMatches ≈ 90 × 1.0 × (10/60) ≈ 15`. `contentionFactor ≈ 1 + (4 × 3 / 90) ≈ 1.13`. Threshold `8 × 1.13 ≈ 9.05`; have `6 + 15 = 21`. Hang out.
- After ~3 s, two more matchable providers have renewed. Re-query returns 8. Dial.

Contrast: the seeker's prefix lands in a thin shard, `topicTraffic = { directParticipants: 1, arrivalsPerMin: 8, queriesPerMin: 0 }`. `expectedNewMatches ≈ 1.3`. Below threshold. Walk to `d = 0`. Root reports `directParticipants: 200, arrivalsPerMin: 600`. Query returns 8 immediately.

## Out of scope

- Push-based notifications from the cohort to a hanging-out seeker when a new matchable provider arrives. The current design re-queries at `requery_interval_ms`. A push variant could be a separate ticket once base behavior is validated.
- Per-tier patience splitting strategies more sophisticated than `patience_per_tier_fraction = 1.0`. Sub-strategies (binary split, exponential decay) can be added later if behavior in the borderline regime warrants it.
- Voting-coordinator-specific hang-out tuning. The voting layer can ride on this rule as-is; specialized patience or contention budgets belong in the voting doc when it lands.

## TODO

- Decide whether the contention factor should incorporate `wantCount` of currently-registered seekers from `QueryV1{includeSeekers: true}` (the cohort already knows them) instead of estimating via `meanWantCount`. Trade-off: more accurate at the cost of a richer query.
- Confirm that re-querying every `requery_interval_ms` is acceptable cohort load. For 1 s default and ~10 s patience, that's ≤10 queries per seeker per match. Order-of-magnitude check against per-peer rate limits.
- Sketch tests: hot-topic seeker stops at first `Accepted`; cold-topic seeker walks to root; borderline seeker hangs out for full patience and returns partial; patience drains correctly across walked tiers; seeker withdraws cleanly on escalation.
- Cross-check that the rule does not introduce a new spatial-flood vector under adversarial `topicTraffic` reporting (a malicious cohort over-reporting arrival rate to encourage hang-out, or under-reporting to push seekers toward the root). Note: the rate is signed only as part of cohort-gossip envelopes, not as part of the registration reply; consider whether the reply needs additional attestation.
