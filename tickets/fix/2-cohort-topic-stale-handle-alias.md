description: Registering the same topic twice quietly replaces the first registration's bookkeeping, but the old handle still works — so calling "leave" or "renew" on the stale first handle kills the second, live registration, which then silently expires.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts              # ~233-254, 297 — renewals keyed by (topicId, participantId); renew()/withdraw()
difficulty: easy
----

# Stale registration handles alias the live one — `withdraw(oldHandle)` kills the new registration

## The problem

`CohortTopicService.renewals` is keyed by `(topicId, participantId)` (`service.ts:233-254`). A second
`register()` for the same pair silently replaces the map entry with the new registration's
`RenewalParticipant` — but the caller still holds the **old** handle. Then:

- `renew(oldHandle)` still drives the old `RenewalParticipant`, and
- `withdraw(oldHandle)` deletes the shared key (`service.ts:297`) — killing the **new** registration's
  renewal loop and (same key) evicting the new remote record.

The live registration then silently TTL-expires with no error to the caller.

## Expected behavior

Operations on a stale handle must no-op rather than clobber the live registration. In `renew` and
`withdraw`, act only if the current entry is still this handle's — i.e. guard with
`this.renewals.get(key) === handle.renewal` before renewing or deleting. A `withdraw`/`renew` on a
superseded handle then does nothing, and the live registration is unaffected.

## Repro sketch

- `register(topic, participant)` → handle A.
- `register(topic, participant)` again → handle B (replaces the entry).
- `withdraw(A)` → current: B's renewal loop stops and B's record is evicted; the live registration
  expires. With the fix: `withdraw(A)` no-ops (A is not the current entry) and B stays live.
