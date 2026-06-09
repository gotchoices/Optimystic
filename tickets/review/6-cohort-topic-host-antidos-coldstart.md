description: Review the host wiring of the cohort-topic anti-DoS guards (gap 6) and cold-start parent-registration transport (gap 7) — per-CoordEngine rate/replay/budget guards, a node-level bootstrap-evidence policy, and registerWithParent over the router.
prereq: cohort-topic-per-coord-scoping
files:
  - packages/db-p2p/src/cohort-topic/host.ts (guard construction + injection; bootstrap-evidence policy; registerForwarderWithParent; antiDos options; CoordEngine.forwarder)
  - packages/db-core/src/cohort-topic/coldstart.ts (opTier threaded through instantiate / registerWithParent)
  - packages/db-core/src/cohort-topic/member-engine.ts (passes reg.tier as opTier to coldStart.instantiate)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (new — all gap-6/7 host cases)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (timestamp alignment for the now-live replay guard)
  - docs/cohort-topic.md (§Anti-DoS + §Cold-start implementation notes)
  - tickets/backlog/cohort-topic-bootstrap-evidence-scheme.md, tickets/backlog/cohort-topic-parent-child-link.md (deferrals)
----

# Review: cohort-topic anti-DoS wiring + cold-start parent registration

Two host-wiring gaps over already-built (and unit-tested) db-core modules were closed. The db-core
`antidos/*` modules and the `ColdStartManager` were not reimplemented — they were **constructed and
injected** by the FRET host, plus the cold-start parent-registration **transport** was supplied.

## What changed

**Gap 6 — anti-DoS guards (`host.ts`).**
- Per-`CoordEngine` (coord-scoped state, one independent set each): `createRegisterRateLimiter`,
  `createCorrelationReplayGuard`, `createTopicBudget`, built in `createCoordEngine` from
  `ctx.antiDos.*` and injected into the member engine.
- Node-level (no per-coord state, shared): the `BootstrapEvidence` policy, built once via the new
  `createBootstrapEvidencePolicy` and shared across engines via `CoordEngineContext.bootstrapEvidence`.
- New `CohortTopicHostOptions.antiDos` (`CohortTopicAntiDosOptions`) exposes per-guard configs +
  bootstrap-evidence verifier overrides + a `reputation` view, so production/tests tune the guards.

**Gap 7 — cold-start parent registration (`host.ts` `registerForwarderWithParent`).**
- Replaced the no-op `parentRegistrar.registerWithParent` with a real transport: route a
  `RegisterV1`-style forwarder-link frame to `parentCoord` via `ITopicRouter.routeAndAct` (riding the
  parent's serving tier `d−1` with the engine's seed `participantCoord`, so the parent recomputes the
  parent coord). Resolution = ack (flip to `serving`); rejection leaves the forwarder
  `awaiting_parent` and never crashes the instantiating register.
- `router` added to `CoordEngineContext`; `CoordEngine.forwarder(topicId)` added to observe the
  forwarder lifecycle.

**db-core (`coldstart.ts`, `member-engine.ts`).** Threaded an optional `opTier` through
`ColdStartManager.instantiate` → `ParentRegistrar.registerWithParent` (trailing optional — existing
`coldstart.spec.ts` mocks ignore it) so the link frame carries the topic's real capacity tier. The
member engine passes `reg.tier`.

## How to validate

- `yarn build:db-core` (rebuild — db-p2p imports db-core's **dist**, so db-core changes are invisible
  to db-p2p until rebuilt), then `yarn test:db-core`, then `yarn build:db-p2p` (type-checks src +
  test), then `yarn test:db-p2p`.
- Result at handoff: db-core **541 passing**; db-p2p **563 passing / 0 failing / 9 pending**
  (the 9 pending are pre-existing, unrelated). Both `tsc` builds clean.
- The parent-registration-failure test deliberately makes `routeAct` reject; the resulting
  `console.warn("…parent registration for tier-1 forwarder failed…")` is the **expected surfaced**
  failure (cold-start surfaces, never swallows) — not a test failure.

## Use cases covered (new `host-antidos-coldstart.spec.ts`)

- Over-rate register (5th of `(peer,topic)` in the window) → `unwilling_cohort` with a back-off.
- Replayed `correlationId` → `no_state`; stale timestamp (> `maxAge`) → `no_state`.
- Topic budget full of a populated topic → new topic refused; the populated topic keeps serving
  (never evicted for a new instantiation).
- Cold-root bootstrap denied (reputation view bans the peer → `unwilling_cohort`) and admitted
  (non-banned peer → `accepted`).
- Renewal not replay-gated: a renew reusing the register's `correlationId`, evaluated a full freshness
  window later, is served `ok` (only `RegisterV1` is guarded, not `RenewV1`).
- Per-coord guard isolation: the same `(peer,topic)` saturated at coord A still admits at coord B.
- Tier-1 forwarder links to its tier-0 parent: routes to `coord_0(topic)` (not the served coord),
  rides treeTier `d−1`, and flips `awaiting_parent → serving` on the ack.
- Parent-registration failure: participant still `accepted`; forwarder stays `awaiting_parent`
  (serves direct participants, holds parent ops).

## Honest gaps / things to scrutinize (reviewer: treat tests as a floor)

- **Bootstrap evidence is permissive-but-logged by default.** The policy is real db-core logic and the
  gate is *never undefined* (the engine always runs it), but absent an injected `antiDos.reputation`
  view or `antiDos.bootstrapEvidence` verifier, T0–T3 cold-root bootstraps are admitted after a
  one-time warning. The production PoW + committed-work-reference schemes are **deferred** to
  `tickets/backlog/cohort-topic-bootstrap-evidence-scheme`. This was an explicit ticket allowance
  ("permissive-but-logged + documented deferral … do NOT leave the gate undefined"); confirm that
  reading is acceptable, since it means a default-configured live node does not cryptographically gate
  cold-root bootstrap. The existing tier-0 e2e tests rely on this permissive default to keep admitting.
- **Parent registration records nothing parent-side yet.** The transport round-trips and acks, but the
  interim link rides the participant-`RegisterV1` path (a real parent would treat it as a plain
  register), is **unsigned** (a live parent's `verifyRegisterSig` would reject it), and
  `childCohortCount` is still hardcoded `0`. The parent-side recording + a dedicated signed child-link
  frame are deferred to `tickets/backlog/cohort-topic-parent-child-link`. The success path is only
  exercised against a fake FRET, so the "ack" is "the route resolved", not "the parent confirmed the
  link". Scrutinize whether treating *any* resolved `routeAndAct` (including a `no_state` reply) as the
  parent ack is acceptable for the interim.
- **Replay-guard / existing-test coupling.** Making the replay guard live broke two `gossip-cadence`
  assertions that registered at real-clock `now` with a synthetic `timestamp: 1_000` (stale). Fixed by
  parametrizing `signedRegister`'s timestamp; verify no other real-clock-vs-synthetic-timestamp
  register paths exist that would silently start returning `no_state`.
- **`opTier` placeholder.** When `opTier` is absent the link frame stamps `tier: 0` (clamped). The
  member engine always supplies the real `reg.tier`, so this only bites a caller invoking
  `instantiate` without an op tier; confirm that's acceptable.
- The per-coord `TopicBudget` at tier 0 holds at most one topic (one topic ⇒ one `coord_0`), so its
  eviction logic is mostly exercised by the host test pushing two topics through one engine. Confirm
  the per-coord (vs node-level) placement matches the intended memory-bound semantics for tier ≥ 1.
