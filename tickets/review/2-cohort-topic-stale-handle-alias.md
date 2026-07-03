description: Guard renew() and withdraw() so stale registration handles cannot clobber the live replacement registration.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts              # renew() line 233, withdraw() line 243
  - packages/db-core/test/cohort-topic/service.spec.ts        # new — stale handle isolation tests
difficulty: easy
----

## What was done

`CohortTopicService.renewals` is a `Map<string, RenewalParticipant>` keyed by `(topicId, participantId)`. Calling `register()` twice for the same pair replaced the map entry with the new renewal, but the old handle still referenced the old `RenewalParticipant` object. Both `renew()` and `withdraw()` used the map key only (presence/deletion), so a stale handle could:

- `withdraw(staleHandle)` — deleted the live registration's map entry and sent a tombstone for B's registration on behalf of A
- `renew(staleHandle)` — saw the key was still present (B's) and called `handle.renewal.pingLoop()` on the stale A renewal

**Fix (`service.ts`):**

- `renew()`: changed `this.renewals.has(key)` to `this.renewals.get(key) !== handle.renewal`. Only acts when the stored entry is exactly this handle's renewal object.
- `withdraw()`: guards before delete/tombstone: `if (renewal !== handle.renewal) return;`. Handles the idempotent second-withdraw case too (undefined ≠ any object).

**Tests (`test/cohort-topic/service.spec.ts`, new file):**

Two focused tests via a mock router that tracks `dialMember` calls:
1. `withdraw(staleHandle)` → 0 dial calls (no tombstone); `withdraw(liveHandle)` → 1 dial call.
2. `renew(staleHandle)` → 0 dial calls (no pingLoop); `renew(liveHandle)` → 1 dial call.

All 410 cohort-topic tests pass.

## Review findings

No tripwires or deferred concerns.
