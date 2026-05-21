# Matchmaking cohort-push on provider arrival

description: Replace the polling `requery_interval_ms` mechanic with a push notification from the cohort to a hanging-out seeker when a new matchable provider arrives at that cohort. Eliminates per-seeker query cost during the hang-out window. Defer until polling shows observable cost in practice.
files:
  - docs/matchmaking.md (§Hang-out vs. continue — Decision rule, Out of scope)
  - docs/matchmaking.md (§Configuration — requery_interval_ms)
  - docs/cohort-topic.md (likely additions: a notify channel or piggyback on cohort gossip)
----

Background: today, a hanging-out seeker re-issues `QueryV1` every `requery_interval_ms` (default 1 s) until `wantCount` is met or `patienceMs` drains. Up to ~10 redundant queries per match at default settings. The cohort already knows when a new provider lands; pushing the delta to interested seekers is strictly more efficient.

Design questions for the plan stage:

- Push channel: piggyback on existing cohort gossip out to seekers, or a new direct notification RPC?
- Back-pressure: a popular topic can have thousands of registered seekers; coalescing pushes is essential.
- Fairness: if N seekers are waiting and 1 provider arrives, which seekers get notified? FCFS, random sample, or broadcast and let seekers race?
- Failure mode: if the push is missed, the seeker's `patienceMs` still drains — does the seeker fall back to one final poll, or just accept the partial result?

Cross-link: see `docs/matchmaking.md` §Hang-out vs. continue — Out of scope, which already flags this refinement.
