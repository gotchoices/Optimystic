description: Replace the cohort-topic host's single node-level engine with per-served-coord scoping, so each topic/tier cohort is served by an engine bound to the FRET cohort around the topic's coord (not the node's own ring position). Foundational for the live-tier threshold-signature, promotion, and membership-cert work.
prereq:
files:
  - packages/db-p2p/src/cohort-topic/host.ts (the refactor lives here)
  - packages/db-core/src/cohort-topic/addressing.ts (TierAddressing.coord — the per-coord key)
  - packages/db-core/src/cohort-topic/member-engine.ts (RegisterContext: followOn/treeTier/parentCoord)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (createCohortGossipBus — one bus per coord)
  - packages/db-core/src/cohort-topic/promotion.ts (treeTier/parentCoord/childCohortCount deps)
  - packages/db-p2p/src/cohort-topic/cohort-gossip-transport.ts (CohortPeerResolver around a coord)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (existing mock-tier handshake test)
effort: xhigh
----

# Cohort-topic: per-served-coord scoping

Today `createCohortTopicHost` composes **one** `CohortMemberEngine` for the whole node. Its
`currentCohort()` snapshot is the FRET assembly around the node's **own** ring position
(`selfCoord`), `treeTier` is hardwired to `0`, `childCohortCount` to `0`, `parentCoord` is derived
from `selfCoord`, and `followOn` is always `false`. That is correct for nothing but the mock test:
a topic's responsible cohort sits at `coord_0(_, topicId) = H(0x00 ‖ topicId)` (and at
`coord_d(P, topicId)` for `d ≥ 1`), which is unrelated to any node's `selfCoord`. The members the
node-level engine would threshold-sign with are its ring neighbours, **not** the topic cohort — so
no real membership cert or promotion notice can be produced or verified. A node genuinely belongs to
many cohorts, one per coord FRET routes to it.

## Design

Introduce a **per-coord engine registry** in the host: a lazy `Map<string, CoordEngine>` keyed by
`bytesToB64url(servedCoord)`. A `CoordEngine` owns the per-coord slice of state that today lives at
node scope:

- its own `RegistrationStore` (`createRegistrationStore`),
- a `cohort()` closure = `{ members, cohortEpoch }` derived from `fret.assembleCohort(servedCoord, wantK)`
  (self prepended, deduped; epoch = `hash.H(sorted-member-join)` exactly as today but around the
  served coord),
- a `CohortGossipBus` bound to `coord = servedCoord` and that store,
- `willingness` / `traffic` / `renewal` / `coldStart` built over that store and cohort,
- a `PromotionLifecycle` whose `treeTier(topicId)`, `parentCoord(topicId)`, and
  `childCohortCount(topicId)` are **coord-derived** (see below),
- a `CohortMemberEngine` over the above.

The shared, node-wide collaborators stay singletons and are injected into each `CoordEngine`:
`hash` (`RingHash`), `slots` (`createSlotAssigner`), `barometer`, the FRET ports
(`FretTopicRouter`, `FretSizeEstimator`, `FretCohortGossipTransport`, `FretMembershipSource`,
`FretMembershipPublishSink`, `FretSizeEstimator`), and the participant-facing `CohortTopicService`
(participant scope is the node, not a coord).

### Deriving the served coord (no FRET change)

FRET's `ActivityHandler` callback receives `(activity, cohort, minSigs, correlationId)` — it does
**not** carry the routed key. The host recomputes it from the decoded frame:

```
servedCoord = addressing.coord(reg.treeTier, b64urlToBytes(reg.participantCoord), b64urlToBytes(reg.topicId))
```

This equals the participant's `coord_d(self, topicId)` routing key by construction (§Tier addressing),
so it is the coordinate FRET routed to. Both the activity callback (`runRegisterActivity`) and the
direct `register`-protocol handler (re-attach walk fallback) dispatch through
`registry.forCoord(servedCoord)`. The `cohort` member list FRET passes the activity handler is used
as a **cross-check** against `assembleCohort(servedCoord, wantK)` (log a warning on mismatch; trust
the recomputed assembly so renewal/gossip/signing — which run outside the activity callback — stay
consistent).

`RenewV1` carries no `treeTier`; a renewal dials the primary directly and must resolve its coord
from the held record. Key renewal dispatch by `(topicId)`’s resident coord: look up which
`CoordEngine` holds a record for `(topicId, participantId)` and route the renew there. If none holds
it (cross-node renewal after the host restarted), fall through to a `no_state`-equivalent
`primary_moved`/re-lookup path — document this as the renewal-coord-resolution behaviour.

### Coord-derived promotion inputs

For a `CoordEngine` at `servedCoord` serving tier `d`:

- `treeTier(topicId)` → the `d` the coord was instantiated at (store it on the `CoordEngine`; the
  first register that instantiates the engine fixes it from `reg.treeTier`).
- `parentCoord(topicId)` → `addressing.coord(d - 1, participantCoordOfTopic, topicId)` for `d > 0`;
  undefined at the root (`d = 0`). Capture the participant coord at instantiation (the demotion
  notice needs the parent coord of the **shard**, which is `coord_{d-1}(P, topicId)` for the same
  prefix `P` — store the instantiating participant coord per topic).
- `childCohortCount(topicId)` → count of distinct live tier-`(d+1)` child cohorts known for the
  topic (from gossip `topicSummaries.childCohortCount` max across siblings, as the traffic layer
  already aggregates). Until child-cohort tracking lands it is `0`, which is correct for the
  single-cohort milestone (a tier-0 cohort with no children).

### followOn stays false on the direct path (documented)

`followOn` (the cold-start instantiation gate for a promoted-redirect arrival) cannot be derived
from FRET routing context without a wire-carried parent-promotion reference. That design decision is
already parked in backlog (`cohort-topic-followon-derivation`). For this milestone — a **single
tier-0 cohort** — `followOn` remains `false`; tier-0 bootstrap instantiation goes through the
`bootstrap: true` path. Multi-tier promoted-redirect instantiation is explicitly out of scope here.

### Registry lifecycle

- `forCoord(coord)` lazily creates and caches a `CoordEngine`; a cold probe that yields `no_state`
  must **not** leave a populated engine behind (instantiate the engine lazily but only persist a
  record when the engine actually admits — the `serves()`/`shouldInstantiate` gate already governs
  this; ensure an empty engine is cheap and GC-able).
- `stop()` tears down every `CoordEngine`'s gossip bus (`bus.close()`) and unhandles the protocols.

## Edge cases & interactions

- **Wrong-cohort signing (the core bug this fixes):** assert in the e2e follow-on that the engine
  serving topic `T` lists `assembleCohort(coord_0(T))` members, not the node's ring neighbours.
- **Renewal coord resolution:** a `RenewV1` with no `treeTier` must find its `CoordEngine`; a
  renewal for a record this host never held (or evicted) replies `primary_moved`/triggers re-lookup
  rather than throwing.
- **Single-cohort walk termination:** with a promoted single (tier-0) cohort, the participant walk
  must terminate — a promoted tier-0 returns `Promoted(1)`, the participant recomputes `coord_1` and
  gets `no_state` walking back to `0`. Confirm the `maxSteps` valve in `walk.ts` is not tripped by a
  one-cohort tree (the mock test sidesteps this by never promoting on the walk path). Add a test
  that a registration against a promoted-then-childless tier-0 cohort resolves within `maxSteps`.
- **Coord collision / aliasing:** two distinct topics never share a coord (validated by
  `addressing.spec.ts`); the registry key is the full 32-byte coord b64url, so no aliasing.
- **Concurrent registers at the same coord:** two activity callbacks for the same `servedCoord`
  race on `forCoord`; the lazy map create must be idempotent (compute-if-absent without a second
  engine being constructed). No real async gap exists in `forCoord` if it's synchronous; keep it so.
- **Self not in the assembled cohort:** if FRET routes to this node but `assembleCohort(servedCoord)`
  (a slightly stale table) does not include self, still serve (self is the routed member) but log;
  the epoch/members snapshot prepends self as today.
- **Memory growth:** a node hit at many coords accumulates `CoordEngine`s. Bound this with the
  existing `topicBudget` semantics applied per-coord, or document that an idle engine (empty store,
  no promotion state) is evicted from the registry on the gossip/sweep tick. (Eviction policy can be
  minimal here; the anti-DoS ticket owns the budget.)

## TODO

- Define a `CoordEngine` type and a registry (`Map<string, CoordEngine>` + `forCoord(coord)`
  compute-if-absent) inside `host.ts`; extract the current node-level composition into a
  `createCoordEngine(servedCoord, treeTier, instantiatingParticipantCoord)` factory.
- Recompute `servedCoord` in `runRegisterActivity` and the `register`-protocol handler from
  `reg.treeTier`, `reg.participantCoord`, `reg.topicId`; dispatch to `registry.forCoord(servedCoord)`.
- Cross-check the FRET-passed `cohort` against `assembleCohort(servedCoord)`; warn on mismatch.
- Wire `PromotionLifecycle` deps (`treeTier`, `parentCoord`, `childCohortCount`, `cohortEpoch`) to
  the coord-derived values per `CoordEngine`.
- Resolve renewal dispatch: find the `CoordEngine` holding `(topicId, participantId)`; fall back to
  `primary_moved`/re-lookup when none.
- Make `currentCohort()`/`localEpoch()` per-coord (assembly around `servedCoord`).
- Update `stop()` to close every `CoordEngine` gossip bus.
- Tests: (a) engine serving a topic uses the topic-coord cohort, not `selfCoord` neighbours;
  (b) single-cohort promoted walk terminates within `maxSteps`; (c) renewal resolves its coord;
  (d) the existing four-protocol handshake test still passes.
- Run `yarn test:db-p2p` and `yarn test:db-core` (stream with `2>&1 | tee`), and the package
  type-check (`yarn build` or `tsc`), before handoff.
