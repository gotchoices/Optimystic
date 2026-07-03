description: Guard renew() and withdraw() so stale registration handles cannot clobber the live replacement registration.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts
  - packages/db-core/test/cohort-topic/service.spec.ts
difficulty: easy
----

## What was done

`CohortTopicService.renewals` is a `Map<string, RenewalParticipant>` keyed by `(topicId, participantId)`. Calling `register()` twice for the same pair replaced the map entry with the new renewal, but the old handle still referenced the old `RenewalParticipant` object. Both `renew()` and `withdraw()` keyed off map presence/deletion only, so a stale handle could evict or ping on behalf of the live registration.

**Fix (`service.ts`):**

- `renew()`: acts only when `this.renewals.get(key) === handle.renewal` (identity, not presence).
- `withdraw()`: guards `if (renewal !== handle.renewal) return;` before delete/tombstone. Covers idempotent second-withdraw (undefined ≠ any object).

**Tests (`test/cohort-topic/service.spec.ts`):** mock-router tests counting `dialMember` calls.

## Review findings

Reviewed the implement diff (`b9ce227`) with fresh eyes, then the handoff.

**Correctness — confirmed sound.** Both guards use object identity on `handle.renewal`, which is the exact object `startRenewal()` stores in the map and returns on the handle. Superseded/withdrawn handles no-op; live handle acts. Verified `pingLoop()` (`registration/renewal.ts:102`) is a single ping driven by an external scheduler — not a self-perpetuating timer — so a superseded renewal (`renewal A`) holds no live timer and leaks nothing locally. The `withdraw()` "delete happens FIRST" ordering still holds (guard → delete → send), so a concurrent `renew()` still no-ops before the tombstone fires. Comments updated in the diff are accurate.

**Test coverage — starting point extended.** The two implementer tests (stale withdraw, stale renew) cover the core aliasing. Added two edge tests inline (**minor, fixed in this pass**):
- `withdraw` of the same live handle twice → idempotent, exactly one tombstone.
- `renew` after `withdraw` → no-op (handle left the live set).
All 1093 db-core tests pass (`yarn test`); `yarn build` (tsc) clean.

**Type safety / resource cleanup / error handling — no findings.** `withdraw` swallows transport failure by design (TTL fallback). No new `any`, no unhandled rejections.

**Tripwire (recorded, not ticketed):** a second `register()` for the same `(topicId, participantId)` overwrites the map entry and orphans the prior renewal; no tombstone is sent for the superseded cohort record, which is reclaimed by TTL expiry. Harmless for occasional re-registers, pre-existing behavior, and out of scope for this guard fix. Parked as a `NOTE:` comment at the `this.renewals.set(...)` site in `startRenewal()` (`service.ts`) — send a withdraw for the displaced renewal there only if callers ever churn-register the same pair.

**Major / new tickets:** none.

**Lint:** repo lint is an unconfigured `echo` stub; nothing to run.
