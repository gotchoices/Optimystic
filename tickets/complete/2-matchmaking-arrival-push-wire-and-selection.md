description: The message formats and the "which waiting seekers get told about a new provider" rule for matchmaking arrival pushes, which the cohort-side and seeker-side tickets build on — reviewed and complete.
prereq:
architecture: docs/matchmaking.md#arrival-push-on-provider-arrival
files:
  - packages/db-core/src/matchmaking/wire.ts (ArrivalPushV1 / ArrivalPushAckV1 + ARRIVAL_PUSH_RESULTS, validators, codecs, arrivalPushSigningPayload, topicTrafficImage; SeekerAppPayloadV1.correlationId + its validation)
  - packages/db-core/src/matchmaking/arrival-push.ts (selectArrivalPushTargets, ArrivalPushCandidate)
  - packages/db-core/src/matchmaking/seeker.ts (buildAppPayload emits correlationId when pushOnArrival)
  - packages/db-core/src/matchmaking/config.ts (HangOutConfig.pushSafetyPollMs; ArrivalPushConfig / DEFAULT_ARRIVAL_PUSH_CONFIG)
  - packages/db-core/src/cohort-topic/wire/primitives.ts (CORRELATION_BYTES exported)
  - packages/db-core/test/matchmaking/wire.spec.ts, packages/db-core/test/matchmaking/arrival-push.spec.ts, packages/db-core/test/matchmaking/registration.spec.ts
  - docs/matchmaking.md, docs/internals.md
----
# Matchmaking arrival push — wire formats, config, and fan-out selection (db-core)

First of five tickets building matchmaking arrival push (`docs/matchmaking.md` §Arrival push on provider arrival). Downstream: `matchmaking-arrival-push-cohort-driver`, `matchmaking-arrival-push-seeker-loop`, `matchmaking-arrival-push-seeker-transport`, `matchmaking-arrival-push-wiring-and-e2e`. Pure db-core: no clock, no I/O.

## What landed (`ticket(implement): matchmaking-arrival-push-wire-and-selection`)

- **Seeker binding id.** `SeekerAppPayloadV1.correlationId?` (base64url, 16 bytes). Required when `pushOnArrival === true`, accepted and ignored otherwise, outside `seekerSigningPayload` (authenticated through the peer-key-signed `RegisterV1` that carries `appPayload`). `MatchmakingSeeker.buildAppPayload` emits it only for push-opted seekers. Riding in the payload puts it in the gossip-replicated record, so any member can derive a seeker's push binding.
- **Messages.** `ArrivalPushV1` (topicId/cohortEpoch 32 bytes, correlationId 16, providers 1..`QUERY_LIMIT_MAX`, `topicTraffic`, single-member `signature`) and `ArrivalPushAckV1` (`result` ∈ `"ok" | "unknown_seeker"`), with validators, length-framed codecs and `arrivalPushSigningPayload` (tagged ordered array; traffic image shared with `queryReplySigningPayload` via `topicTrafficImage`, byte-identical to before).
- **Config.** `HangOutConfig.pushSafetyPollMs` (5000), `ArrivalPushConfig { coalesceMs }` / `DEFAULT_ARRIVAL_PUSH_CONFIG` (250). db-p2p's two literal `HangOutConfig` objects spread the default.
- **Selection.** `selectArrivalPushTargets<S>(provider, seekers)` — budget 0 → `[]`; push-opted seekers with a correlationId, whose filter the provider matches (incl. `minBudget`), attached no later than the provider; ordered by `attachedAt` then code-unit `participantId`; first `capacityBudget`. Generic so the cohort driver gets its richer candidate objects back. Accepted-tradeoff `NOTE:` on the function (stale seekers hold slots; gossip-view skew over/under-fills).

## Review findings

**Read first:** the full implement diff (`git show` of the commit above), then `query-eval.ts`, `capability-filter.ts`, `cohort-topic/registration/types.ts` and `gossip/records.ts` (to confirm `attachedAt` is a cohort-stamped, gossip-replicated field, so every member computes the same selection), and every doc block the change touches.

**Correctness — checked, no defects.**
- Selection does not mutate its input (`filter` returns a new array before `sort`); comparator is a total order; budget-0 short-circuit matches §Fairness; `>=` on `attachedAt` matches the documented "attached at the same instant is eligible" edge case.
- `attachedAt` is stamped once by the cohort member on first attach (`member-engine.ts`) and replicated by gossip, so the `attachedAt` rule and ordering agree across members (the premise the "every member computes the same set" claim rests on).
- Validators: providers count bound, fixed widths, enum ack; push-opted seeker without `correlationId` rejected on both encode and decode (encode re-validates). A wrong-length injected `MatchmakingSeekerOptions.correlationId` on a push-opted seeker fails loudly at `appPayloadBytes` via the same validator — acceptable.
- Signing image is domain-tagged (`"ArrivalPushV1"`) so it cannot collide with a query reply's image; per-entry signatures correctly outside it.
- `CORRELATION_BYTES` move: no import cycle (`primitives.ts` is not a barrel; it imports only `codec.ts`).

**Minor — fixed in this pass.**
- `docs/matchmaking.md` §Fairness said the push binding including `attachedAt` "travels in its signed registration payload"; `attachedAt` is cohort-stamped record state, not payload. Reworded.
- `docs/matchmaking.md` §Seeker registration's earlier `SeekerAppPayloadV1` block lacked the new `correlationId` field (only the §Wire formats block had it). Added.
- The `NOTE:` on `selectArrivalPushTargets` hard-coded "its 10 s TTL"; seeker TTL is configurable (5–15 s). Now says `seeker_ttl` expiry.
- `MatchmakingSeeker` still minted its correlation id with a literal `16`; now uses the exported `CORRELATION_BYTES`.

**Major — none.** Nothing reached the filing bar.

**Tripwires — none new.** The one conditional concern (stale or already-satisfied seekers keep fan-out slots; gossip-view skew) is already parked as the accepted-tradeoff `NOTE:` on `selectArrivalPushTargets`, with a revisit condition; left as is.

**Tests.** Kept all implementer tests: each pins a named spec bullet (fan-out bound, poll-path exclusion, budget 0, filter/minBudget misses, attached-after rule) or a wire contract (round-trip byte stability, 1..256 bound, pinned widths, ack enum, required correlationId). None restate the implementation or test a mock. No tests added: tie-break and equal-`attachedAt` behaviour are one-line comparisons covered by inspection, and nothing found was a defect needing a reproduction.

**Docs.** `docs/matchmaking.md` and `docs/internals.md` (matchmaking file list) reflect the change after the fixes above; protocol-id / wiring docs remain ticket 5's.

**Validation.** `yarn workspace @optimystic/db-core build` clean; db-core `yarn test` 1879 passing, 0 failing; `yarn lint:docs` all resolve; eslint on the touched source files clean. Not run: `yarn check` (full gate) and db-p2p tests (the review edits are db-core-only and do not change any exported signature; the implementer ran db-p2p typecheck + matchmaking tests green).
