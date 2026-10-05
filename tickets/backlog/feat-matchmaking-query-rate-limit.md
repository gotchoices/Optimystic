# Matchmaking per-peer QueryV1 rate limit

description: Decide whether `QueryV1` needs a per-peer rate ceiling parallel to the cohort-topic `register_rate_per_peer = 4 / min`, and if so set the default. Parked until push-on-arrival lands.
prereq: matchmaking-cohort-push-on-arrival
files:
  - docs/cohort-topic.md (rate-limit configuration if added)
  - docs/matchmaking.md (§Configuration prose around `requery_interval_ms`)
----

## Status: parked (maintainer, 2026-10-04)

"Yes park; let's pull in push-on-arrival soon though too." Push-on-arrival
(`matchmaking-cohort-push-on-arrival`, now in `plan/`) replaces the hanging-out seeker's 1 s poll with
cohort pushes plus a sparse 5 s safety poll, which removes most of the query load this limit would
bound. Re-evaluate once it lands: the ceiling (if still wanted) should be sized against the push-path
cadence, not the legacy poll.

Background: `docs/matchmaking.md` §Configuration notes that no `QueryV1` rate ceiling exists. At the
seeker's default cadence the cohort sees ~10 queries per match per seeker, which is fine in isolation
but unbounded under adversarial behavior or runaway client loops.

Design questions for when this is promoted:

- Ceiling value: a continuously hanging-out poll-path seeker issues ~60 queries/min; the limit must not
  throttle well-behaved seekers (push-path seekers issue ~12/min).
- Scope: per-peer per-cohort, or per-peer global? (Per-cohort is consistent with `register_rate_per_peer`.)
- Cohort-side enforcement vs. back-pressure response (a new `Throttled` reply or reuse of `UnwillingMember`).
