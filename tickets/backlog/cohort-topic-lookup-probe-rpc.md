description: A dedicated read-only lookup probe RPC so CohortTopicService.lookup() stops sharing the registration walk and leaving TTL-expiring soft state behind on every cohort it touches.
files:
  - packages/db-core/src/cohort-topic/service.ts (lookup() — currently calls walk.register())
  - packages/db-core/src/cohort-topic/walk.ts (WalkEngine — a probe-only mode)
  - packages/db-core/src/cohort-topic/member-engine.ts (a read-only classify path that records nothing)
  - packages/db-core/src/cohort-topic/wire/types.ts (a LookupV1 probe message, or a flag on RegisterV1)
  - packages/db-p2p/src/cohort-topic/host.ts (route the probe; serve without admitting)
----

# Cohort-topic: read-only lookup probe RPC

`CohortTopicService.lookup(topicId, tier)` currently calls `walk.register(...)` and reads the cohort
fields off the `accepted` reply (`service.ts` documents this as interim). Every `lookup` therefore
performs a real registration — assigning a primary, persisting a soft-state record, counting an
arrival, and possibly triggering promotion — that then TTL-expires because the caller never renews.
For applications that resolve a cohort without attaching (capability discovery, hint refresh), this
is wasteful and pollutes traffic/promotion signals with phantom registrations.

## Requirement

A probe that walks to the responsible cohort and returns the same `CohortHint` (primary, backups,
`cohortEpoch`, `cohortMembers`, optional `topicTraffic`) **without** admitting: no record persisted,
no arrival counted, no promotion trigger. Either a dedicated `LookupV1` wire message + protocol path,
or a `probe: true` flag on the existing register path that short-circuits the member engine to a
read-only classify (return the cohort snapshot for a served topic; `no_state` for a cold one) before
admission.

The walk discipline (inward on `no_state`, follow `Promoted`, back-off on `unwilling_cohort`) is
unchanged; only the terminal action differs. The `lookup` doc note in `service.ts` references this as
the documented follow-on.

## End
