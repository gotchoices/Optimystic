description: Implemented per-served-coord scoping in the cohort-topic FRET host — a lazy `servedCoord → CoordEngine` registry replaces the single node-level engine, so each topic/tier cohort is served by an engine bound to the FRET cohort around the topic's coord (not the node's own ring position). Build + tests green (db-core 534, db-p2p 519/9 pending). Honest gaps below are owned by the named downstream tickets.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (the refactor — CoordEngine, CoordRegistry, dispatchRegister, resolveRenew, createCoordEngine)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (new "per-served-coord scoping" describe: cohort-coord + renewal-resolution)
  - packages/db-core/test/cohort-topic/walk.spec.ts (new single-cohort promoted-childless termination test + SingleCohortRouter)
  - docs/internals.md (§Cohort-Topic Port Boundary → Service composition: per-served-coord host paragraph)
----

# Review: cohort-topic per-served-coord scoping

## What changed

`createCohortTopicHost` no longer composes **one** node-level `CohortMemberEngine` whose cohort is the
FRET assembly around the node's own `selfCoord`. It now keeps a lazy **`CoordRegistry`** — a
`Map<bytesToB64url(servedCoord), CoordEngine>` with synchronous compute-if-absent `forCoord` — and one
**`CoordEngine`** per coord FRET routes to this node. Each `CoordEngine` owns the per-coord slice of
state (its own `RegistrationStore`, `CohortGossipBus` bound to the served coord, willingness / traffic
/ renewal / cold-start, a `PromotionLifecycle` with coord-derived tier inputs, and a
`CohortMemberEngine`) and threshold-signs / shards with the FRET cohort **around the served coord**.
The node-wide collaborators (`hash`, `slots`, `barometer`, the threshold `signer`, the FRET ports, and
the participant-facing `CohortTopicService`) stay singletons, injected via `CoordEngineContext`.

Dispatch:
- **Register** (activity callback **and** the direct `register`-protocol handler) recomputes the served
  coord from the decoded frame — `servedCoord = addressing.coord(reg.treeTier, reg.participantCoord, reg.topicId)`
  — and runs the decision on `registry.forCoord(servedCoord).engine`. FRET's `ActivityHandler` does not
  carry the routed key, hence the recompute.
- **Renew** (`RenewV1` carries no `treeTier`) is resolved by the **held record**: `resolveRenew` →
  `registry.findHolder(topicId, participantId)`; no holder ⇒ `unknown_registration` (drives the
  participant's failover → re-lookup), never a throw.
- The FRET-passed `cohort` member list is **cross-checked** against `assembleCohort(servedCoord)` (warn
  on mismatch; the recomputed assembly is trusted so renewal/gossip/signing stay consistent).
- `stop()` closes every `CoordEngine`'s gossip bus plus the participant bus, then unhandles the protocols.

Coord-derived promotion inputs per engine: `treeTier` fixed at instantiation; `parentCoord =
coord_{d−1}(participantCoord, topicId)` (any participant routed to a coord shares the prefix, so the
parent is the same — captured once at creation); `childCohortCount = 0` (single-cohort milestone).

**Interface change:** `CohortTopicHost.engine` (single engine) was **removed**; it is replaced by
`CohortTopicHost.registry: CoordRegistry`. `resolveRenew(registry, renew, now)` is exported (used by the
register handler and the renewal test). No external caller referenced `host.engine` (only the test, now
updated). The participant `CohortTopicService` is unchanged in behaviour — it gets a node-level gossip
handle bound to `selfCoord`.

## Validation — what to exercise

Build/type-check floor (`lint` is a no-op echo in this repo, so `tsc` is the floor):
- `yarn build:db-core` ✅ and `yarn build:db-p2p` ✅ (clean).

Tests (streamed):
- `yarn test:db-core` → **534 passing**.
- `yarn test:db-p2p` → **519 passing, 9 pending**.

New tests added (the suite is a **floor**, not a ceiling — see gaps):
- **db-p2p `service.spec.ts` › per-served-coord scoping**
  - *cohort-coord*: a `CoordEngine` for `coord_0(topic)` assembles its cohort around that coord
    (`['topic-cohort-member']` + self), and **excludes** the node's ring-position neighbour
    (`'ring-neighbour'`, returned by the fake FRET for `selfCoord` and every non-topic coord). This is
    the core bug the ticket fixes — asserted directly via `host.registry.forCoord(...).cohort()`.
  - *renewal-resolution*: with a single-member cohort (`wantK:1`), a tier-0 bootstrap admits; the renew
    resolves to the holding engine (`findHolder` returns it, `resolveRenew` → `ok`); an unheld
    `(topic, participant)` → `unknown_registration` (re-lookup, not a throw).
- **db-core `walk.spec.ts`**: a single tier-0 cohort that is **promoted but childless** — the walk
  oscillates root↔child and **terminates within `maxSteps`** (`retry_later`, capped probe count), never
  spins. (Companion to the existing oscillation test, framed for this milestone's `d_max = 0` tree.)

Manual / multi-node exercise (for the reviewer or the live-tier e2e): drive the captured FRET activity
handler with a `RegisterV1` whose `treeTier`/`participantCoord`/`topicId` route to a topic coord, and
confirm the served engine's cohort is `assembleCohort(coord_0(topic))`, not the dialing node's ring
neighbours.

## Honest gaps (each owned by a named downstream ticket — design as if they land)

1. **Multi-member admission needs willingness gossip (BLOCKER for >1-member cohorts).** Admission runs
   `willingness.evaluate`, whose quorum (default `⌊k/2⌋+1`) is met from the **gossiped** willingness
   view + self. This milestone wires **no** willingness-gossip broadcast tick, so the view is empty and
   only *self* counts — a register to a multi-member cohort returns `unwilling_cohort` until siblings
   gossip. The single-member case (`wantK` effectively 1, quorum 1) admits, which is why the renewal
   test uses `wantK:1`. **Owner: `cohort-topic-gossip-cadence`** (the gossip publish/round tick that
   populates the view). This was *also* true of the prior node-level host — not a regression — but it is
   the reason the live cohort can't admit yet.

2. **No empty-engine eviction (deliberate).** A cold `no_state` probe never persists a record (engine
   semantics), but `forCoord` still leaves an **empty** `CoordEngine` (with a gossip subscription) in the
   map. I intentionally did **not** auto-evict after each register: evicting on `!hasState()` races a
   concurrent register on the same coord (B accepts after A evicts → orphaned record + closed bus). The
   registry exposes `hasState()` / `close()` for a future sweep tick. **Owner:
   `cohort-topic-host-antidos-coldstart`** (topic-budget) and `cohort-topic-gossip-cadence` (sweep tick)
   — both already cite this. Memory growth is bounded by distinct coords probed; for the single-tier-0
   milestone (`d_max≈0`, participants hit `coord_0` directly) cold high-tier probes are rare.

3. **Shared gossip transport fans inbound to every coord bus.** One libp2p gossip frame is delivered to
   *all* `CoordEngine` buses (the wire frame carries no coord). Record-delta merge is **epoch-filtered**,
   so deltas land only in the bus whose epoch matches (correct). But the per-member willingness/load
   **view** merges regardless of epoch, so it cross-pollinates across coords on one node. Willingness/load
   are per-member node properties (not per-coord), so this is benign for the single-cohort milestone;
   flag for the gossip-cadence ticket if it ever keys view state per coord.

4. **`followOn` stays `false`; multi-tier promoted-redirect instantiation out of scope.** Per the ticket
   and `backlog/cohort-topic-followon-derivation`. Consequence (test #3 above): a promoted-childless
   single cohort cannot *resolve* a walk — it terminates with `retry_later`. True resolution needs
   `followOn` instantiation of the child cohort (multi-tier).

5. **⚠️ Latent multi-tier addressing inconsistency — verify before tier ≥ 1.** The ticket's premise is
   `servedCoord = coord(treeTier, participantCoord, topicId)` "equals the participant's routing key by
   construction". That holds at **tier 0** (`coord_0` ignores `P`). For **d ≥ 1** it may **not**: the
   participant walk (`db-core/walk.ts`) routes with `key = coord_d(deps.self, topicId)` where
   `deps.self = selfCoord` (the host passes `selfCoord` as the service's `self`), but the wire
   `participantCoord` field carries `hash.H(deps.self)` (service.ts `participantId = hash.H(self)`). So
   the host recomputes `coord_d(H(selfCoord), …)` while FRET routed to `coord_d(selfCoord, …)` — the
   cross-check would warn and the host would assemble the *wrong* cohort. Out of scope here (single
   tier-0), but **must be reconciled** (align the routing `P` with the wire `participantCoord`, or vice
   versa) before the live-tier multi-tier work. Reviewer: confirm this is the correct read and decide
   whether it belongs in `cohort-topic-live-tier-e2e` or a dedicated fix.

6. **Per-coord threshold crypto / anti-DoS still node-shared (interim, as planned).** The threshold
   `signer` and (absent) anti-DoS guards are node-wide here; `CoordEngineContext` is the seam where
   `cohort-topic-threshold-assembly` makes the crypto per-`CoordEngine` and
   `cohort-topic-host-antidos-coldstart` injects the shared guards into each engine. No change needed in
   this ticket; noted so the seam is obvious.

## ⚠️ Working-tree note for the runner/reviewer (NOT this ticket's diff)

When I started, `git status` was clean. By handoff the working tree **also** contained unrelated,
in-flight changes I never touched — they belong to the concurrent `optimystic-session-mode-commit-composition`
fix ticket (still in `implement/`):
- `packages/db-core/src/collection/collection.ts` (new `getPendingActions` / `clearPendingActions` /
  `applyCommittedToCache`),
- `packages/db-core/src/transaction/coordinator.ts`,
- `packages/quereus-plugin-optimystic/test/session-mode-commit.spec.ts` (rewrite) and deletion of
  `packages/quereus-plugin-optimystic/repro-session.mjs`.

I did **not** revert or modify these (reverting would destroy another agent's work). They compile and
are green in my db-core build/tests (534 passing), so they don't affect this ticket — flagged only so
the per-coord-scoping commit isn't misread as including them, and so the runner can separate them if
needed. **This ticket's actual diff is only:** `host.ts`, `service.spec.ts`, `walk.spec.ts`,
`docs/internals.md`, and the ticket move.

## Done-when (met)
- `CoordEngine` + `CoordRegistry` (`forCoord` compute-if-absent, `findHolder`, `all`, `close`) in
  `host.ts`; node-level composition extracted into `createCoordEngine(servedCoord, treeTier, participantCoord)`. ✅
- Register dispatch recomputes `servedCoord` and routes to `registry.forCoord`; renewal resolves by held
  record with `unknown_registration` fallback; FRET cohort cross-checked. ✅
- Promotion deps coord-derived; `currentCohort()`/`localEpoch()` per-coord; `stop()` closes every bus. ✅
- Tests (a) topic-coord cohort, (c) renewal resolution, (d) handshake still green; (b) single-cohort
  walk terminates within `maxSteps`. ✅
- `yarn build` (tsc) + `yarn test:db-core` + `yarn test:db-p2p` green; docs (`internals.md`) updated. ✅
