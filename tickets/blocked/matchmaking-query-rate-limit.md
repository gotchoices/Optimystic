# Matchmaking per-peer QueryV1 rate limit

description: Decide whether `QueryV1` needs a per-peer rate ceiling parallel to the cohort-topic `register_rate_per_peer = 4 / min`, and if so set the default. Today only `RegisterV1` is rate-limited; a hanging-out seeker issuing `QueryV1` every `requery_interval_ms = 1 s` over `patience_default_ms = 10 s` does ~10 queries per match, which is within current cohort budgets — but a malicious or buggy seeker has no documented ceiling.
files:
  - docs/cohort-topic.md (rate-limit configuration if added)
  - docs/matchmaking.md (§Configuration prose around `requery_interval_ms`)
----

Background: `docs/matchmaking.md` §Configuration currently notes that no `QueryV1` rate ceiling exists. At the seeker's default cadence the cohort sees ~10 queries per match per seeker, which is fine in isolation but unbounded under adversarial behavior or runaway client loops.

Design questions for the plan stage:

- Ceiling value: matchmaking's nominal cadence implies ~60 queries/min per seeker if the seeker is hanging out continuously; the limit must accommodate the hang-out polling without artificially throttling well-behaved seekers.
- Scope: per-peer per-cohort, or per-peer global? (Per-cohort is consistent with `register_rate_per_peer`.)
- Cohort-side enforcement vs. cohort-level back-pressure response (e.g., a new `Throttled` reply or reuse of `UnwillingMember`).
- Interaction with the future push-on-arrival mechanism (`matchmaking-cohort-push-on-arrival`): if pushes replace polling, the rate-limit pressure largely disappears.
