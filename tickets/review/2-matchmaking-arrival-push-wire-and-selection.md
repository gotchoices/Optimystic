description: Review the message formats and the "which waiting seekers get told about a new provider" rule for matchmaking arrival pushes, which the cohort-side and seeker-side tickets build on.
prereq:
architecture: docs/matchmaking.md#arrival-push-on-provider-arrival
files:
  - packages/db-core/src/matchmaking/wire.ts (ArrivalPushV1 / ArrivalPushAckV1 + ARRIVAL_PUSH_RESULTS, validators, codecs, arrivalPushSigningPayload, topicTrafficImage helper; SeekerAppPayloadV1.correlationId + its validation)
  - packages/db-core/src/matchmaking/arrival-push.ts (NEW — selectArrivalPushTargets, ArrivalPushCandidate)
  - packages/db-core/src/matchmaking/seeker.ts (buildAppPayload emits correlationId when pushOnArrival)
  - packages/db-core/src/matchmaking/config.ts (HangOutConfig.pushSafetyPollMs; ArrivalPushConfig / DEFAULT_ARRIVAL_PUSH_CONFIG; header)
  - packages/db-core/src/matchmaking/index.ts (export arrival-push.js)
  - packages/db-core/src/cohort-topic/wire/primitives.ts (CORRELATION_BYTES moved here, exported)
  - packages/db-core/src/cohort-topic/wire/validate.ts (imports CORRELATION_BYTES instead of a private copy)
  - packages/db-core/test/matchmaking/wire.spec.ts, packages/db-core/test/matchmaking/arrival-push.spec.ts (NEW), packages/db-core/test/matchmaking/registration.spec.ts
  - packages/db-p2p/src/testing/matchmaking-mesh-harness.ts, packages/db-p2p/test/matchmaking/seeker-walk-client.spec.ts (literal HangOutConfig → spread DEFAULT_HANG_OUT_CONFIG)
  - docs/matchmaking.md (§Fairness, §Edge cases & interactions, seeker payload + arrival-push wire blocks, signing-scope note), docs/internals.md (matchmaking file list)
----
# Matchmaking arrival push — wire formats, config, and fan-out selection (db-core)

First of five tickets building matchmaking arrival push (`docs/matchmaking.md` §Arrival push on provider arrival). Downstream: `matchmaking-arrival-push-cohort-driver`, `matchmaking-arrival-push-seeker-loop`, `matchmaking-arrival-push-seeker-transport`, `matchmaking-arrival-push-wiring-and-e2e`. Everything here is pure db-core — no clock, no I/O.

## What landed

**Seeker binding id.** `SeekerAppPayloadV1.correlationId?: string` (base64url, exactly 16 bytes). Validation: present → width-checked; `pushOnArrival === true` without it → `CohortWireError`; present without `pushOnArrival` → accepted and kept (ignored by selection). Not in `seekerSigningPayload`. `MatchmakingSeeker.buildAppPayload` emits `bytesToB64url(this.correlationId)` only when `pushOnArrival === true`. Because it rides in `appPayload`, it is in the gossip-replicated record, so any cohort member can derive a seeker's push binding.

**Messages.** `ArrivalPushV1` (`topicId` and `cohortEpoch` pinned to 32 bytes, `correlationId` to 16, `providers` 1..`QUERY_LIMIT_MAX`, `topicTraffic`, `signature`) and `ArrivalPushAckV1` (`result` ∈ `ARRIVAL_PUSH_RESULTS` = `"ok" | "unknown_seeker"`, via `reqEnum`). Validators, length-framed codecs (`encodeArrivalPushV1` / `decodeArrivalPushV1` / `encodeArrivalPushAckV1` / `decodeArrivalPushAckV1`), and `arrivalPushSigningPayload` — ordered array `["ArrivalPushV1", v, topicId, cohortEpoch, correlationId, [traffic], providerIds]`. The traffic array is now built by one private `topicTrafficImage` helper shared with `queryReplySigningPayload` (same byte output as before for the query reply).

**Config.** `HangOutConfig.pushSafetyPollMs` (default `PUSH_SAFETY_POLL_MS` = 5000); `ArrivalPushConfig { coalesceMs }` with `DEFAULT_ARRIVAL_PUSH_CONFIG` (250). The two literal `HangOutConfig` objects in db-p2p now spread `DEFAULT_HANG_OUT_CONFIG`.

**Selection.** `selectArrivalPushTargets(provider, seekers)` in `arrival-push.ts`: `capacityBudget === 0` → `[]`; keep seekers with `pushOnArrival === true` AND a `correlationId`, whose filter the provider matches (`matchesFilter`, including `minBudget`), and with `provider.attachedAt >= seeker.attachedAt`; sort by `attachedAt` then `participantId` (code-unit compare, not `localeCompare`, so every member agrees); take the first `capacityBudget`. The accepted-tradeoff `NOTE:` (stale seekers hold slots until their record leaves; differing gossip views over/under-fill) is on the function, with a revisit condition.

## Deviations from the ticket text (check these)

- `ArrivalPushCandidate` is a **type alias for `LocalSeekerRegistration`** (identical shape) rather than a second interface, and `selectArrivalPushTargets` is **generic** — `<S extends ArrivalPushCandidate>(provider, seekers: readonly S[]): S[]` — so the cohort driver can pass richer objects (e.g. carrying the raw `RegistrationRecord`, whose byte `participantId` it needs for `assignSlots`) and get them back without re-mapping.
- The filter check passes `provider.payload` straight to `matchesFilter` (as `evaluateQuery` does) instead of building a `providerEntryOf(provider)` first; both satisfy `FilterableProvider`.
- `CORRELATION_BYTES` (16) was a private constant in `cohort-topic/wire/validate.ts`; it is now exported from `cohort-topic/wire/primitives.ts` next to `COORD_BYTES` and used by both wires.
- Docs went beyond the ticket's "docs" (left for ticket 5): §Fairness now states who computes the set vs. who sends, the `attachedAt` rule and the accepted tradeoff; the wire blocks carry the new field and widths; the signing-scope note explains why `correlationId` is unsigned yet authenticated. Ticket 5 still owns wiring/e2e docs.

## Tests added

- `wire.spec.ts`
  - *round-trips an ArrivalPush byte-stably* / *round-trips an ArrivalPushAck byte-stably* — encode → decode deep-equals, re-encode is byte-identical.
  - *rejects a push carrying no providers* / *…more than query_limit_max providers* — the 1..256 bound.
  - *rejects a wrong-length topicId* / *…correlationId* — the pinned widths (decode gate, framed via `encodeCohortMessage` to bypass the encode-side check).
  - *rejects an unknown ack result*.
  - *rejects a push-opted seeker payload without a correlationId*.
  - Existing seeker fixtures updated: `sampleSeeker` carries a `correlationId`; the "minimal" round-trip strips it too.
- `registration.spec.ts`: one added assertion in the existing push-opted seeker test — the emitted `correlationId` is the seeker's 16 bytes in base64url.
- `arrival-push.spec.ts` (new), one per doc bullet: *capacityBudget longest-waiting* (budget 2 of 5 → two smallest `attachedAt`), *poll-path seekers skipped and not counted* (two longest waiters are poll-path, one of them carrying a `correlationId` without `pushOnArrival`), *capacityBudget = 0 → []*, *filter misses (must and minBudget) excluded without spending a slot*, *provider attached before a seeker is not pushed to it*.

Not tested (inspection only, per ticket): tie-break order on equal `attachedAt`, `>=` at equal `attachedAt`, signing-image order sensitivity.

## Validation run

- `yarn workspace @optimystic/db-core build` — clean (build includes tests).
- db-core `yarn test` — 1879 passing, 0 failing. (Note: mocha's `--grep` needs a JS regex, so the ticket's `"matchmaking\|wire\|arrival"` matches nothing; use `"matchmaking|wire|arrival"` — 352 passing.)
- db-p2p `npx tsc --noEmit -p .` — clean; db-p2p `yarn test -- --grep "matchmaking|seeker|wire|arrival"` — 129 passing, 17 pending (env-gated), 0 failing.
- `yarn lint:docs` — all resolve; eslint over the changed files — clean.
- Not run: `yarn check` (full gate incl. integration and `check:rn`).

## Things a reviewer might push on

- Selection runs on every member with only replicated state; the "already pushed" set and coalescing are the next ticket's local state — this ticket does not dedup repeat arrivals of the same provider (the caller decides what counts as fresh: absent→present on the record set).
- `correlationId` is kept on a non-push payload when sent; nothing emits that shape today (`MatchmakingSeeker` only sends it with `pushOnArrival`).
