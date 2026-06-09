description: Wire the anti-DoS guards (gap 6) and cold-start parent registration (gap 7) into the per-coord host. Constructs the rate limiter / replay guard / topic budget / bootstrap-evidence policy and injects them into each CoordEngine, and implements parentRegistrar.registerWithParent over the router.
prereq: cohort-topic-per-coord-scoping
files:
  - packages/db-p2p/src/cohort-topic/host.ts (construct + inject anti-DoS guards; parentRegistrar)
  - packages/db-core/src/cohort-topic/antidos/rate-limiter.ts (RegisterRateLimiter)
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts (CorrelationReplayGuard)
  - packages/db-core/src/cohort-topic/antidos/topic-budget.ts (TopicBudget)
  - packages/db-core/src/cohort-topic/antidos/bootstrap-evidence.ts (BootstrapEvidence)
  - packages/db-core/src/cohort-topic/member-engine.ts (optional guard injection points)
  - packages/db-core/src/cohort-topic/coldstart.ts (ColdStartManager / ParentRegistrar)
  - packages/db-p2p/src/cohort-topic/topic-router.ts (routeAndAct — parent registration walk)
----

# Cohort-topic: anti-DoS wiring + cold-start parent registration

Two host-wiring gaps over already-built db-core modules.

## Gap 6 — anti-DoS guards

`CohortMemberEngineDeps` declares four optional guards (`rateLimiter`, `replayGuard`, `topicBudget`,
`bootstrapEvidence`); the engine handles their absence (each gate is skipped). The host injects
`undefined` for all four, so a live node has no per-peer rate limit, no replay/freshness drop, no
forwarder-state budget, and no bootstrap-evidence check. The db-core modules
(`antidos/*`, all unit-tested) just need constructing and injecting.

**Ownership decision:** the **replay guard, rate limiter, and topic budget are per-`CoordEngine`**
(they key on `(peer, topic)` / per-cohort topic state, which is coord-scoped) — construct one set per
`CoordEngine`. The **bootstrap-evidence policy is node-level** (it's a tier→verifier policy with no
per-coord state) — construct once and share. Inject accordingly into each `CoordEngine`'s member
engine.

- `RegisterRateLimiter` — defaults (`register_rate_per_peer = 4/min`, sliding window 60 s,
  exponential `retryAfter` via the willingness back-off curve). No external deps.
- `CorrelationReplayGuard` — defaults (`maxAge = 60 s`, `futureSkew = 5 s`). Note the review fix:
  `correlationId` is now a fresh CSPRNG value per probe (`service.ts` `freshCorrelationId`), so the
  guard's per-id dedup is collision-free; no special handling needed, but the guard's `maxAge`
  window must exceed the participant's renewal interval so legitimate renewals (which carry the
  original `correlationId`) are not dropped as replays — confirm the renewal path uses a fresh id or
  the guard exempts renewals (it guards `RegisterV1`, not `RenewV1`; verify `onRenew` is not gated by
  the replay guard).
- `TopicBudget` — defaults (`topics_max = 2048`, LRU by participant count, zero-participant topics
  evicted first). This also bounds the per-coord-scoping registry's memory growth concern.
- `BootstrapEvidence` — db-core takes injected PoW / reputation / parent-reference verifiers (it
  embeds no scheme). For this milestone wire a **minimal but real** policy: T0/T1 require a valid
  signed parent-reference or committed-work reference (they correspond to committed work — the
  existing reputation service can supply the verifier); T2/T3 require the PoW/reputation/parent-ref
  per `docs §Anti-DoS`. If a production PoW scheme isn't available in this branch, inject a
  permissive-but-logged verifier for T2/T3 and **document the deferral** (a separate PoW ticket), but
  do NOT leave the gate `undefined` — an unset gate means cold-root bootstrap is unauthenticated.

## Gap 7 — cold-start parent registration

`coldStart.parentRegistrar.registerWithParent(topicId, parentCoord, tier)` is a no-op. A
freshly-instantiated forwarder at tier `d > 0` must register with its tier-`(d−1)` parent cohort so
the parent counts it as a child (drives `childCohortCount`, the demotion gate, and parent-involving
ops). Implement it over the router: build a `RegisterV1`-style forwarder-link message keyed at
`parentCoord` and `routeAndAct` it (or a dedicated child-link frame on the register protocol), so the
parent cohort records this cohort as a tier-`(d+1)` child for `topicId`. Until the ack lands the
`ColdStartManager` keeps the forwarder in `awaiting_parent` (accepts participants, holds
parent-involving ops) — that state machine already exists; this ticket only supplies the transport.

For the **single tier-0 cohort milestone** there is no parent (root serves immediately), so this path
is exercised by a unit test (a tier-1 forwarder links to its tier-0 parent), not the tier-0 e2e.
Still implement it fully — it's small and the per-coord-scoping ticket now gives a correct
`parentCoord`.

## Edge cases & interactions

- **Renewal not replay-gated:** confirm `onRenew` is outside the replay guard (renewals legitimately
  repeat a `correlationId`); only `RegisterV1` is guarded. Test a renewal after `maxAge` is accepted.
- **Rate limit vs legitimate re-register after eviction:** a participant whose record TTL-expired and
  re-registers must not be throttled into starvation; 4/min is generous, but test that a normal
  register→evict→re-register cycle isn't blocked.
- **Topic budget eviction races promotion:** evicting a topic with zero recent registrations while a
  late arrival lands — the engine's `admit`/`touch` ordering already guards this; verify a populated
  topic is never evicted for a new instantiation (the module enforces it; add a host-level test).
- **Bootstrap evidence missing on a cold root:** a `bootstrap:true` register with no/invalid evidence
  → `unwilling_cohort` (not silent accept). Test the cold-root denial path.
- **Parent registration failure:** if `registerWithParent` fails/times out, the forwarder stays
  `awaiting_parent` and retries on the next opportunity; it must not crash the instantiating register
  (the participant is still accepted). Test the failure path leaves the forwarder serving direct
  participants but holding parent ops.
- **Parent coord correctness:** depends on per-coord-scoping deriving `parentCoord =
  coord_{d−1}(P, topicId)` for the shard, not `selfCoord`. Assert the registration routes to the
  correct parent coordinate.
- **Guard scope leakage:** per-`CoordEngine` guards must not share state across coords (a rate-limit
  budget for topic T at coord A is independent of coord B). The bootstrap-evidence policy, being
  node-level, is shared by design. Test isolation.

## TODO

- Construct per-`CoordEngine` `RegisterRateLimiter`, `CorrelationReplayGuard`, `TopicBudget` with
  documented defaults; inject into each member engine.
- Construct a node-level `BootstrapEvidence` policy with real (or permissive-but-logged + documented)
  tier verifiers; inject into each member engine.
- Confirm `onRenew` is not replay-gated; add the renewal-after-maxAge test.
- Implement `parentRegistrar.registerWithParent` over `routeAndAct` to the parent coord; keep the
  `awaiting_parent` state machine intact.
- Tests: over-rate register → `unwilling_cohort`; replayed/stale register → `no_state`; topic-budget
  full → instantiation refused; cold-root bootstrap without evidence → denied; tier-1 forwarder links
  to tier-0 parent; parent-registration failure leaves forwarder serving + holding parent ops; guard
  state isolated per coord.
- Run `yarn test:db-core`, `yarn test:db-p2p` (stream with `tee`), and the type-check before handoff.
