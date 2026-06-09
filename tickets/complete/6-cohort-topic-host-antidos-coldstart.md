description: COMPLETE — host wiring of the cohort-topic anti-DoS guards (gap 6) and cold-start parent-registration transport (gap 7): per-CoordEngine rate/replay/budget guards, a node-level bootstrap-evidence policy, and registerWithParent over the router. Reviewed; one inline fix (bootstrap-evidence fail-closed at T2/T3 when configured).
files:
  - packages/db-p2p/src/cohort-topic/host.ts (guard construction + injection; bootstrap-evidence policy; registerForwarderWithParent; antiDos options; CoordEngine.forwarder)
  - packages/db-core/src/cohort-topic/coldstart.ts (opTier threaded through instantiate / registerWithParent)
  - packages/db-core/src/cohort-topic/member-engine.ts (passes reg.tier as opTier to coldStart.instantiate)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (gap-6/7 host cases + new T2/T3 reputation-gating regression)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (timestamp alignment for the now-live replay guard)
  - docs/cohort-topic.md (§Anti-DoS + §Cold-start implementation notes)
  - tickets/backlog/cohort-topic-bootstrap-evidence-scheme.md, tickets/backlog/cohort-topic-parent-child-link.md (deferrals)
----

# Complete: cohort-topic anti-DoS wiring + cold-start parent registration

Two host-wiring gaps over already-built (and unit-tested) db-core modules. The db-core `antidos/*`
modules and the `ColdStartManager` were **constructed and injected** by the FRET host; the cold-start
parent-registration **transport** was supplied over `ITopicRouter.routeAndAct`.

## What landed

**Gap 6 — anti-DoS guards (`host.ts`).** Per-`CoordEngine` rate limiter / replay guard / topic budget
(coord-scoped, one independent set each), built in `createCoordEngine` from `ctx.antiDos.*` and
injected into the member engine. The node-level `BootstrapEvidence` policy (no per-coord state) is
built once via `createBootstrapEvidencePolicy` and shared. New `CohortTopicHostOptions.antiDos`
exposes per-guard configs + bootstrap-evidence verifier overrides + a `reputation` view.

**Gap 7 — cold-start parent registration (`host.ts` `registerForwarderWithParent`).** A real transport
replaces the no-op: route a `RegisterV1`-style forwarder-link frame to `parentCoord` via
`routeAndAct` (riding the parent's serving tier `d−1` with the engine's seed `participantCoord`).
Resolution = ack (flip to `serving`); rejection leaves the forwarder `awaiting_parent` and never
crashes the instantiating register. `router` added to `CoordEngineContext`; `CoordEngine.forwarder`
added to observe the lifecycle.

**db-core.** Threaded an optional `opTier` through `ColdStartManager.instantiate` →
`ParentRegistrar.registerWithParent` (trailing optional) so the link frame carries the topic's real
capacity tier; the member engine passes `reg.tier`.

## Review findings

Reviewed the full implement diff (`dd1a33c`) with fresh eyes, the db-core modules it wires
(`member-engine`, `coldstart`, `antidos/{bootstrap-evidence,replay-guard,topic-budget}`,
`willingness`), the transport (`topic-router`), and the docs/backlog deferrals. Validation:
`yarn build:db-core` clean, `yarn test:db-core` **541 passing**; `yarn build:db-p2p` clean,
`yarn test:db-p2p` **564 passing / 0 failing / 9 pending** (the 9 pending are pre-existing and
unrelated; lint is not configured repo-wide — `tsc` is the effective gate and is clean).

**Major (fixed inline — security-relevant, but small + contained to this ticket's own new code):**

- **Bootstrap-evidence gate was ineffective at T2/T3 even when a `reputation` view was supplied.**
  `createBootstrapEvidencePolicy` defaulted `verifyPoW` to the *permissive* fallback unconditionally.
  T2/T3 evaluates `verifyPoW(reg) || verifyReputation(reg) || verifyParentReference(reg)`, so a
  permissive PoW short-circuited the disjunction to `true` — a **banned peer was admitted at T2/T3**
  despite a configured reputation view, silently defeating the gate and contradicting the `reputation`
  option's own doc ("backing … the T2/T3 reputation evidence"). Only T0 was exercised by the original
  test, so the hole was untested.
  **Fix:** once *any* gating is configured (a `reputation` view or explicit `bootstrapEvidence`
  verifiers), unfilled verifiers now fail **closed** (deny) instead of permissive; the
  permissive-but-logged fallback is reserved for the entirely-unconfigured interim node (the existing
  tier-0 e2e default path is unchanged). Updated the `reputation` option doc + the
  `cohort-topic-bootstrap-evidence-scheme` backlog note to state the all-tier effect, and added a
  regression test (`bootstrap evidence gates T2/T3 too…`): banned peer → `unwilling_cohort` at T2,
  non-banned → `accepted` at T2.

**Minor / confirmations (no change needed):**

- **Replay-guard memory.** Now that the guard is live, confirmed it prunes on access (bounded to one
  `maxAgeMs` window) — going live introduces no unbounded-growth DoS vector.
- **`signedRegister` timestamp alignment (gossip-cadence).** Audited all four call sites: line 260
  uses `now=5_000` vs the default `timestamp=1_000` (within the 60 s freshness window); the two
  real-clock sites pass `timestamp=now`. No other real-clock-vs-synthetic-timestamp register path can
  silently start returning `no_state`.
- **Per-coord `TopicBudget` placement.** Correct per spec: the budget is per-cohort (per served
  coord). At tier 0 a `coord_0(topic)` is unique per topic (≤ 1 topic/cohort, eviction barely
  exercised — covered by the host test pushing two topics through one engine); at tier ≥ 1 many topics
  fan into one tier-`d` cohort coord, where the budget genuinely bounds forwarder state as `docs
  §Anti-DoS bullet 2` intends. Node-wide topic count is bounded by FRET cohort assignment, not this
  per-cohort budget — inherent, not introduced here.
- **`participantCoord` decoded as a peer-id** in the reputation verifier is consistent with the rest of
  the host (the wire identity `participantCoord`/`participantId` *is* the dialable peer-id bytes — same
  assumption `verifyRegisterSig` makes).
- **`clampTier` / `opTier` placeholder.** The member engine always supplies the real `reg.tier`; the
  `tier: 0` clamp only bites a caller invoking `instantiate` without an op tier. Acceptable.

**Accepted interim gaps (already filed as backlog tickets — out of scope here):**

- **Permissive-but-logged bootstrap evidence by default.** A default-configured node (no `antiDos`)
  still admits cold-root bootstraps after a one-time warning — the explicit ticket allowance
  ("permissive-but-logged + documented deferral, never an undefined gate"). The tier-0 e2e relies on
  this default. Production PoW + committed-work schemes → `cohort-topic-bootstrap-evidence-scheme`.
- **Parent registration records nothing parent-side.** The transport round-trips and acks, but the
  interim link rides the participant-`RegisterV1` path, is unsigned, and `childCohortCount` is still
  `0`; treating *any* resolved `routeAndAct` (including a `no_state` anchor-miss) as the ack is the
  interim semantics. Parent-side recording + a dedicated signed child-link frame →
  `cohort-topic-parent-child-link`.

**Categories with nothing found:** No correctness bug in the rate-limiter / replay-guard / topic-budget
wiring (each guard is per-coord, isolated, and ordered before downstream state — verified by the
isolation + over-rate + replay + budget tests). No resource-cleanup leak (guards are GC'd with their
engine; the replay guard self-prunes). No type-safety gaps (`tsc` clean). No doc drift remaining (the
two new doc sections + the two option/comment edits reflect the shipped behavior, including the
fail-closed fix).
