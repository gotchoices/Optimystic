# Matchmaking contention factor from seeker pool

description: Refine the `contentionFactor` term in matchmaking's hang-out decision so it uses the actual sum of in-flight `wantCount` reported by registered seekers, rather than the `meanWantCount × queriesPerMin` approximation currently in `docs/matchmaking.md`. Requires `QueryV1{includeSeekers: true}` and one extra summed field in `QueryReplyV1`. Trade-off: richer reply, more accurate contention term, slightly larger response. Defer until borderline-regime behavior is measured against the current approximation.
files:
  - docs/matchmaking.md (§Hang-out vs. continue — Decision rule, contentionFactor formula)
  - docs/matchmaking.md (§Wire formats — QueryReplyV1)
----

Background: the current decision rule estimates competition as `queriesPerMin × meanWantCount`, where `meanWantCount` is a small constant (default 3). A more accurate term is `Σ wantCount` across currently-registered seekers in the same cohort. The information already flows on the wire when `includeSeekers: true`; a summed scalar would avoid forcing the seeker to scan the full seeker list.

Design questions for the plan stage:

- Whether to add a new scalar (`seekerWantSum`) to `QueryReplyV1`/`TopicTrafficV1`, or compute client-side from the existing `seekers` array.
- How the sum decays / windows (seeker TTL is already short — possibly no decay needed).
- Whether the cohort gossips this aggregate the same way it gossips `arrivalsPerMin`.
