description: Add the message formats and the pure "who gets told about this new provider" rule for matchmaking arrival pushes, so the cohort side and the seeker side can be built on one shared, tested definition.
prereq:
architecture: docs/matchmaking.md#arrival-push-on-provider-arrival
files:
  - packages/db-core/src/matchmaking/wire.ts (new ArrivalPushV1 / ArrivalPushAckV1 types, validators, codecs, signing image; SeekerAppPayloadV1.correlationId)
  - packages/db-core/src/matchmaking/seeker.ts (MatchmakingSeeker puts its correlationId in the payload when pushOnArrival)
  - packages/db-core/src/matchmaking/config.ts (pushSafetyPollMs on HangOutConfig; ArrivalPushConfig { coalesceMs })
  - packages/db-core/src/matchmaking/arrival-push.ts (NEW — pure fan-out selection)
  - packages/db-core/src/matchmaking/index.ts (exports)
  - packages/db-core/src/matchmaking/query-eval.ts (reuse providerEntryOf; LocalProviderRegistration / LocalSeekerRegistration shapes)
  - packages/db-core/src/matchmaking/capability-filter.ts (matchesFilter, already handles minBudget)
  - packages/db-core/src/cohort-topic/registration/sharding.ts (createSlotAssigner — the "primary" rule)
  - packages/db-core/src/cohort-topic/wire/primitives.ts (b64urlFixedLen, COORD_BYTES)
  - packages/db-core/test/matchmaking/ (wire.spec.ts, new arrival-push.spec.ts)
  - packages/db-p2p/test/matchmaking/seeker-walk-client.spec.ts and packages/db-p2p/src/testing/matchmaking-mesh-harness.ts (literal HangOutConfig objects that need the new field)
----
# Matchmaking arrival push — wire formats, config, and fan-out selection (db-core)

First of five tickets that build matchmaking arrival push (`docs/matchmaking.md` §Arrival push on provider arrival). The chain:

1. **this ticket** — db-core message formats, config, and the pure target-selection rule.
2. `matchmaking-arrival-push-cohort-driver` — the cohort member that notices a new provider and sends pushes.
3. `matchmaking-arrival-push-seeker-loop` — the seeker walk's push-path hang-out loop.
4. `matchmaking-arrival-push-seeker-transport` — the seeker's receiving end over libp2p, plus real renew/withdraw.
5. `matchmaking-arrival-push-wiring-and-e2e` — node wiring, mock-mesh end-to-end tests, docs.

Everything here is pure db-core: no clock, no I/O.

## Binding a push to a seeker registration: `SeekerAppPayloadV1.correlationId`

`ArrivalPushV1.correlationId` names "the seeker registration this push is bound to". Today nothing on the cohort side holds such an id: `RegistrationRecord` (`packages/db-core/src/cohort-topic/registration/types.ts`) has no correlation id, and `RegisterV1.correlationId` is per-probe and is not stored. `MatchmakingSeeker` already mints a 16-byte `correlationId` that it never sends.

Decision: add `correlationId?: string` (base64url, 16 bytes) to `SeekerAppPayloadV1`. It travels inside `appPayload`, so it lands in the record's `appState` and is replicated to every cohort member by ordinary gossip. Any member can therefore derive a seeker's push binding (contact hint, filter, wantCount, correlation id, `attachedAt`) from the replicated record alone. Only the per-seeker "already pushed" set and the coalescing batch are local soft state on the pushing member (next ticket). That is what makes failover work with no new replication.

- Validation: `pushOnArrival === true` without a `correlationId` is a wire error. A `correlationId` present without `pushOnArrival` is accepted and ignored.
- It is **not** part of `seekerSigningPayload` (same reasoning as the existing signing-scope note: a forwarded `SeekerEntryV1` does not carry it). It is still authenticated: the cohort admits `appPayload` only inside a `RegisterV1` the participant peer-key-signed (`registerSigningPayload` covers `appPayload`).
- `MatchmakingSeeker.buildAppPayload` emits `correlationId` (base64url of `this.correlationId`) whenever `pushOnArrival` is true.

## New messages

Exactly as `docs/matchmaking.md` §Wire formats → *Arrival push (cohort-primary → seeker)*:

```ts
interface ArrivalPushV1 {
	v: 1;
	topicId: string;          // base64url, 32 bytes — validate with b64urlFixedLen(COORD_BYTES) (see backlog debt-pin-remaining-hash-derived-wire-fields: new hash-derived fields start pinned)
	cohortEpoch: string;      // base64url, 32 bytes
	correlationId: string;    // base64url, 16 bytes — the seeker registration's id
	providers: ProviderEntryV1[];   // 1..QUERY_LIMIT_MAX entries
	topicTraffic: TopicTrafficV1;
	signature: string;        // pushing member's single peer-key signature, base64url
}
interface ArrivalPushAckV1 {
	v: 1;
	result: "ok" | "unknown_seeker";
}
```

- Validators `validateArrivalPushV1` / `validateArrivalPushAckV1`, length-framed codecs `encodeArrivalPushV1` / `decodeArrivalPushV1` / `encodeArrivalPushAckV1` / `decodeArrivalPushAckV1`, following the `QueryReplyV1` pattern in `wire.ts` (reuse the existing private `validateProviderEntryV1` / `validateTopicTrafficV1`).
- An empty `providers` array is invalid (a push always carries at least one provider). More than `QUERY_LIMIT_MAX` (256) is invalid; the sender caps its batch there.
- `arrivalPushSigningPayload(unsigned)`: an explicitly ordered JSON array, mirroring `queryReplySigningPayload`: `["ArrivalPushV1", v, topicId, cohortEpoch, correlationId, [traffic fields in the same order], providers.map(p => p.participantId)]`. Like the query reply, it binds the set of participant ids, not the per-entry signatures (those are re-validated per entry by the seeker).

## Config

In `packages/db-core/src/matchmaking/config.ts` (update the module header, which still says the push rows "are intentionally not modeled here"):

- `HangOutConfig` gains `readonly pushSafetyPollMs: number`; `DEFAULT_HANG_OUT_CONFIG` sets it to `PUSH_SAFETY_POLL_MS` (5 000). Fix the literal `HangOutConfig` objects in `seeker-walk-client.spec.ts` and `matchmaking-mesh-harness.ts` (spread `DEFAULT_HANG_OUT_CONFIG` rather than restating fields).
- New `ArrivalPushConfig { readonly coalesceMs: number }` and `DEFAULT_ARRIVAL_PUSH_CONFIG = { coalesceMs: PUSH_COALESCE_MS }` (250). This is the one cohort-side knob.

## Fan-out selection (`arrival-push.ts`)

One pure function decides which seekers a newly arrived provider should be pushed to. Every cohort member runs it over the same gossip-replicated records, and each member then delivers only to the selected seekers it is the slot primary for. The cohort as a whole therefore notifies about `capacityBudget` seekers, not `capacityBudget` per member. That matches the doc's intent ("fan-out only needs to fill the provider's real slots").

```ts
interface ArrivalPushCandidate {           // a decoded seeker record held at this cohort
	readonly participantId: string;        // peer-id string
	readonly attachedAt: number;
	readonly payload: SeekerAppPayloadV1;
}
/** Seekers to notify about `provider`, longest-waiting first. */
function selectArrivalPushTargets(
	provider: LocalProviderRegistration,
	seekers: readonly ArrivalPushCandidate[],
): ArrivalPushCandidate[];
```

The rule, in order:

1. `provider.payload.capacityBudget === 0` → `[]` (listed-but-full is not a new slot).
2. Keep a seeker only if `payload.pushOnArrival === true` and it carries a `correlationId` (poll-path seekers are never targets and never count toward fan-out).
3. Keep a seeker only if `matchesFilter(providerEntryOf(provider), payload.filter)` (a filter miss, including `minBudget > capacityBudget`, is excluded and does not count).
4. Keep a seeker only if `provider.attachedAt >= seeker.attachedAt`. Rationale: a provider that attached before the seeker was answerable by the seeker's own immediate `QueryV1`. Without this rule, a member that receives the whole record set at once (a new member catching up by gossip, or a rotation handoff pull) would push every existing provider to every seeker. A provider missed by this rule is still found by the seeker's safety poll.
5. Sort by `attachedAt` ascending, ties by `participantId` (string compare) so every member computes the same order. Take the first `min(capacityBudget, remaining)`.

Accepted tradeoff (record as a `NOTE:` on the function): the ranking reads only replicated state, so it does not know which seekers have already been satisfied, have finished their walk, or have answered `unknown_seeker` to their own primary. Such a seeker can hold a fan-out slot until its record leaves the cohort (it withdraws on finish, or its 10 s TTL expires), under-filling that arrival's fan-out. Excluding them would need per-seeker push state to be gossiped, and the safety poll covers what is missed. Members whose gossip views differ can also over- or under-fill by a few; also bounded and covered by the safety poll.

## Edge cases & interactions

- `pushOnArrival: true` with no `correlationId` → decode error (test).
- A seeker payload with `correlationId` but `pushOnArrival` unset → valid; not a push target (covered by the selection test for poll-path seekers).
- Equal `attachedAt` between seekers → deterministic order by participant id (inspection; the sort comparator).
- `capacityBudget` larger than the matching seeker count → every matching seeker selected (selection test).
- Provider whose `attachedAt` equals a seeker's → eligible (`>=`); inspection.
- `wantCount` / `filter` come from the seeker's own signed registration; the cohort is advisory and the seeker re-validates every entry, so a cohort that ignores this rule can only waste a push (no test).
- Signing image determinism: order-sensitive over providers, like the query reply (inspection).

## Tests (only these)

- `wire.spec.ts`: one round-trip test each for `ArrivalPushV1` and `ArrivalPushAckV1` (encode → decode → encode stable), plus the rejection cases with real branching: empty `providers`, more than 256 providers, a wrong-length `topicId` or `correlationId`, an unknown ack `result`, and `pushOnArrival: true` without `correlationId`.
- `arrival-push.spec.ts`, each pinning a doc bullet under "Arrival-push behavior":
  - *Fresh arrival pushes to longest waiters*: `capacityBudget = 2`, 5 matching push-opted seekers → exactly the 2 smallest-`attachedAt`.
  - *Poll-path seekers are not push targets*: the 2 longest waiters are poll-path → the 2 longest-waiting push-opted seekers are chosen instead.
  - *`capacityBudget = 0` does not push* → `[]`.
  - *Filter miss excluded*, including `minBudget`: excluded and does not use up a fan-out slot.
  - A provider attached before a seeker is not pushed to that seeker.

## TODO

- Add `correlationId` to `SeekerAppPayloadV1` (type, validator, the pushOnArrival-requires-it rule) and emit it from `MatchmakingSeeker.buildAppPayload` when `pushOnArrival`.
- Add `ArrivalPushV1` / `ArrivalPushAckV1` types, validators, codecs and `arrivalPushSigningPayload` to `wire.ts`.
- Extend `HangOutConfig` with `pushSafetyPollMs`; add `ArrivalPushConfig` / `DEFAULT_ARRIVAL_PUSH_CONFIG`; fix the literal config sites; update the `config.ts` header.
- Write `arrival-push.ts` (`ArrivalPushCandidate`, `selectArrivalPushTargets`) with the accepted-tradeoff `NOTE:`.
- Export the new symbols from `packages/db-core/src/matchmaking/index.ts`.
- Add the tests listed above.
- `yarn workspace @optimystic/db-core build` then run the db-core and db-p2p matchmaking specs (`yarn test -- --grep "matchmaking\|wire\|arrival"` in each package).
