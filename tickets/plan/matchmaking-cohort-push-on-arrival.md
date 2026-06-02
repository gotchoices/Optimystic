# Matchmaking cohort-push on provider arrival

description: Replace the polling `requery_interval_ms` mechanic with a push notification from the cohort to a hanging-out seeker when a new matchable provider arrives at that cohort. Eliminates per-seeker query cost during the hang-out window. Defer until polling shows observable cost in practice.
files:
  - docs/matchmaking.md (§Hang-out vs. continue — Decision rule, Out of scope)
  - docs/matchmaking.md (§Configuration — requery_interval_ms)
  - docs/cohort-topic.md (promotion: §First promotion ~L97, §Promotion threshold ~L350; likely additions: a notify channel or piggyback on cohort gossip)
----

Background: today, a hanging-out seeker re-issues `QueryV1` every `requery_interval_ms` (default 1 s) until `wantCount` is met or `patienceMs` drains. Up to ~10 redundant queries per match at default settings. The cohort already knows when a new provider lands; pushing the delta to interested seekers is strictly more efficient.

## Scope of the fan-out: one cohort, not the topic

The push channel is inherently **per-cohort**: when a provider lands at a cohort, the cohort notifies the seekers hanging out *at that cohort*. The number of seekers any single push touches is therefore bounded by the cohort-topic promotion cap, not by the topic-wide seeker population:

- A cohort's `directParticipants` count (providers **and** seekers both count — see cohort-topic.md:13, :138) cannot exceed `cap_promote` (64), or `cap_promote_fast` (32) when the tier is hot. Past that, the cohort promotes and bounces new registrations outward with `Promoted(d+1)` (cohort-topic.md:97, :350–357).
- The tree depth absorbs topic scale; per-cohort population stays roughly invariant. A topic with thousands of seekers spreads them across thousands of prefix-sharded leaf cohorts — tens per cohort, not thousands per cohort.
- Matchmaking is **T2**: on a hot topic where cohorts are busy with T0/T1 work, seeker registrations get `UnwillingCohort` and back off (matchmaking.md:449, :192), so seekers are turned away *before* they pile up.

So a single push fans to ≤ `cap_promote` (~64) local seekers. The earlier framing of "thousands of registered seekers → coalescing essential" conflated topic-wide scale with per-cohort scale; the substrate structurally prevents a topic-wide herd from landing on one cohort. Coalescing within a cohort is still worth designing, but as a *fairness* mechanism among ~tens of local waiters, not as absorption of a thundering herd.

## Design questions for the plan stage

- **Push channel.** Piggyback on existing cohort gossip out to seekers, or a new direct notification RPC? Weigh against the existing `/optimystic/cohort-topic/1.0.0/*` protocol surface.
- **Fairness among local waiters.** With ≤ `cap_promote` (~64) seekers at a cohort and 1 provider arriving, which seekers get notified — FCFS, random sample, or broadcast-and-let-seekers-race? (A provider with `capacityBudget > 1` admits more winners; factor that in.)
- **Coalescing.** Even at ~tens of seekers, batch a burst of arrivals into one push per seeker rather than one push per (arrival × seeker).
- **Failure mode.** If a push is missed, the seeker's `patienceMs` still drains — does the seeker fall back to one final poll before returning, or just accept the partial result? Define the degraded-but-correct behavior so the push remains a pure optimization over the polling baseline.

Cross-link: see `docs/matchmaking.md` §Hang-out vs. continue — Out of scope, which already flags this refinement as deferred until polling shows observable cost.
