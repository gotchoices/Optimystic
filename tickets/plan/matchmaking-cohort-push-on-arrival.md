description: Build matchmaking arrival push — a hanging-out seeker that set `pushOnArrival` is notified by its cohort primary when fresh matchable providers arrive, instead of polling QueryV1 every second. Specified doc-as-spec in docs/matchmaking.md §Arrival push on provider arrival; planned soon per the maintainer.
prereq:
files:
  - docs/matchmaking.md (§Arrival push on provider arrival and its subsections; §Hang-out vs. continue push path; §Configuration push_coalesce_ms / push_safety_poll_ms; test bullets under "Arrival-push behavior")
  - packages/db-core/src/matchmaking/wire.ts (SeekerAppPayloadV1.pushOnArrival exists; no ArrivalPushV1 / ArrivalPushAckV1 codecs yet)
  - packages/db-core/src/matchmaking/seeker.ts (carries pushOnArrival into the payload; "consumed by the next ticket")
  - packages/db-core/src/matchmaking/seeker-walk.ts (hang-out decision engine)
  - packages/db-p2p/src/matchmaking/seeker-walk-client.ts (poll-only hang-out loop; header says push is a separate slice)
  - packages/db-p2p/src/matchmaking/module.ts, protocols.ts, query-handler.ts, seeker-manager.ts
  - packages/db-p2p/src/cohort-topic/ (gossip delivery of provider RegistrationRecords; primary slot assignment)
----

# Matchmaking: push on provider arrival

Maintainer (2026-10-04), parking `feat-matchmaking-query-rate-limit`: "let's pull in push-on-arrival
soon though too." Pushes remove most of the polling that limit would bound.

## What the doc specifies

- Opt-in per seeker via `pushOnArrival`. The push is a pure optimization: the seeker always keeps a
  sparse safety poll (`push_safety_poll_ms`, 5 s) plus one mandatory final `QueryV1` before patience
  drains, so a lost push is never worse than baseline and no capability handshake is needed.
- Channel: the seeker's assigned cohort-topic primary (`primary(participantId, members)` slot hash)
  delivers over a new protocol `/optimystic/matchmaking/1.0.0/arrival-push` to the seeker's
  `contactHint`. Trigger: a provider `RegistrationRecord` for the topic going absent→present at this
  cohort (observed via existing cohort gossip within one round) — not renewals, not the arrivals
  counter. No cohort-topic protocol change.
- Fairness: notify the `min(capacityBudget, |matching push-opted seekers|)` seekers with the smallest
  `attachedAt`; poll-path seekers, filter misses and `minBudget` misses are excluded; `capacityBudget
  == 0` arrivals are skipped.
- Coalescing: per-seeker batch flushed on `push_coalesce_ms` (250 ms) or when it reaches the seeker's
  outstanding need; soft, non-gossiped state, lost on failover.
- `ArrivalPushV1` carries the provider batch plus a folded `topicTraffic` snapshot (so the seeker can
  re-run hang-out/descend math); single-member primary signature; seeker re-validates each entry's
  `registrationSig`. `ArrivalPushAckV1{ unknown_seeker }` when the echoed `correlationId` is stale —
  the primary drops the binding.
- Pushes do not count toward `queriesPerMin`. Seeker dedups providers by `participantId` across push
  and poll.
- Test bullets in the doc: fresh arrival pushes to longest waiters; poll-path seekers not targeted;
  renewal does not push; budget 0 does not push; coalescing; push/poll overlap deduped; push forgery
  rejected; stale push acked `unknown_seeker`; and the safety/final poll cases.

## What exists today

- `pushOnArrival` is on the seeker wire payload (`wire.ts`), set by `MatchmakingSeeker` and the db-p2p
  `MatchmakingSeekerSession` registration, and otherwise unused.
- No `ArrivalPushV1`/`ArrivalPushAckV1` codecs, no arrival-push protocol handler, no primary-side
  arrival detection or coalescing, and the walk client's hang-out is poll-only.
- Not in `tickets/.pruned-tickets.jsonl` — never built.

## Open design points

- Where absent→present detection hooks in on the primary: the cohort-topic gossip merge in the db-p2p
  host's per-coord engine, exposed to matchmaking as an application policy callback — the seam needs
  naming without leaking matchmaking into db-core's substrate.
- How the primary holds per-seeker push bindings (`contactHint`, `correlationId`, `attachedAt`,
  pushed-count) and keeps them consistent with renewals, epoch rotation and primary handoff.
- Push-path loop structure in `SeekerWalkClient` (event-driven wait with safety-poll timer and final
  poll) and how the folded `topicTraffic` re-enters `seeker-walk.ts`'s decision.
- Config placement for `push_coalesce_ms` / `push_safety_poll_ms` in `config.ts`.
- Delivery to relay-only seekers (`contactHint` reachability) and timeouts on the push RPC.
- Likely split: (1) wire codecs + config; (2) primary-side detection, fan-out and coalescing; (3)
  seeker push-path loop + dedup; (4) module wiring + mock-tier e2e and doc callouts.
