description: Per-served-coord scoping in the cohort-topic FRET host — a lazy `servedCoord → CoordEngine` registry replaces the single node-level engine, so each topic/tier cohort is served by an engine bound to the FRET cohort around the topic's coord (not the node's own ring position). Reviewed, validated, and completed.
files:
  - packages/db-p2p/src/cohort-topic/host.ts (CoordEngine, CoordRegistry, dispatchRegister, resolveRenew, createCoordEngine)
  - packages/db-p2p/test/cohort-topic/service.spec.ts (per-served-coord scoping describe: cohort-coord + renewal-resolution + dispatch-path)
  - packages/db-core/test/cohort-topic/walk.spec.ts (single-cohort promoted-childless termination test + SingleCohortRouter)
  - docs/internals.md (§Cohort-Topic Port Boundary → per-served-coord host paragraph)
----

# Complete: cohort-topic per-served-coord scoping

## What shipped

`createCohortTopicHost` keeps a lazy **`CoordRegistry`** — `Map<bytesToB64url(servedCoord), CoordEngine>`
with synchronous compute-if-absent `forCoord` — and one **`CoordEngine`** per coord FRET routes to the
node, replacing the single node-level engine. Each `CoordEngine` owns the per-coord slice of state (its
own `RegistrationStore`, gossip bus bound to the served coord, willingness/traffic/renewal/cold-start, a
`PromotionLifecycle` with coord-derived tier inputs, and a `CohortMemberEngine`) and threshold-signs /
shards with the FRET cohort **around the served coord**. Node-wide collaborators (`hash`, `slots`,
`barometer`, threshold `signer`, FRET ports, participant `CohortTopicService`) stay singletons, injected
via `CoordEngineContext`.

- **Register** (activity callback + direct `register` handler) recomputes
  `servedCoord = addressing.coord(reg.treeTier, reg.participantCoord, reg.topicId)` from the decoded
  frame and runs the decision on `registry.forCoord(servedCoord).engine`.
- **Renew** (no `treeTier`) is resolved by the held record via `registry.findHolder`; no holder ⇒
  `unknown_registration` (never a throw), driving the participant's failover → re-lookup.
- FRET-passed cohort is cross-checked against `assembleCohort(servedCoord)` (warn on mismatch; the
  recomputed assembly is trusted).
- `stop()` closes every `CoordEngine` bus + the participant bus, then unhandles the protocols.

Interface change: `CohortTopicHost.engine` → `CohortTopicHost.registry: CoordRegistry`; `resolveRenew`
exported. No external caller referenced `host.engine`.

## Review findings

Adversarial pass over the implement diff (commit `80930c5`), read before the handoff summary. Build +
tests run green after the review additions: `yarn build:db-core`/`build:db-p2p` exit 0;
`yarn test:db-core` **534 passing**; `yarn test:db-p2p` **520 passing, 9 pending** (was 519 — +1 from
the review's dispatch-path test). `lint` is a no-op echo in this repo (`tsc` is the floor).

### Checked — and clear

- **FRET `ActivityHandler` signature.** Verified `setActivityHandler` is typed
  `(activity, cohort, minSigs, correlationId) => {commitCertificate}` (p2p-fret `index.d.ts`); the
  host's `(activity, cohort) => …` callback is contract-correct (uses the first two args). ✓
- **Multi-subscriber gossip transport.** `FretCohortGossipTransport` holds a `Set` of handlers and
  fans `deliver` to all — so N coord buses + the participant bus each receive every frame, as the
  per-coord design requires. No single-subscriber overwrite. ✓
- **Concurrent same-coord register race.** `forCoord` is synchronous and `dispatchRegister` does the
  `get`/`set` before its first `await`, so two activity callbacks for one coord share a single engine
  (single-threaded, no interleave). The handoff's claim holds. ✓
- **Resource cleanup.** Every `createCoordEngine` adds one transport subscription via its bus;
  `registry.close()` closes all, `stop()` also closes the participant bus and unhandles. No leak on
  stop (eviction *during* run is a deliberate non-goal — gap #2 below). ✓
- **Renewal resolution.** `findHolder` is topic-scoped (`holds(topicId, participantId)`); for the
  single-tier-0 milestone a participant holds one record per topic, so it is unambiguous.
  `resolveRenew` returns `ok` for a held record and `unknown_registration` for an unheld one (no
  throw). Backed by the renewal-resolution test. ✓
- **Docs.** `docs/internals.md` §Cohort-Topic Port Boundary accurately describes the per-coord host
  (registry, recompute, renewal-by-record, coord-derived promotion inputs). It even documents both the
  participant routing key `coord_d(self, …)` and the host recompute `coord(…, participantCoord, …)` —
  which surfaces the gap #5 mismatch rather than hiding it. ✓

### Found — minor, fixed in this pass

- **Test gap: the production dispatch path was untested.** The implementer's two scoping tests poke
  `registry.forCoord(...)` and `engine.handleRegister(...)` directly with a pre-computed coord — they
  never drive `dispatchRegister`, the activity-handler wiring, or the `servedCoord` recompute from a
  frame (the actual production code path, and where the core fix lives). **Added** a test
  (`service.spec.ts` › "the FRET activity callback recomputes the served coord from the frame and
  routes to its engine") that captures the activity handler the host installs, feeds it an encoded
  `RegisterV1`, asserts `accepted`, and asserts the record landed on the engine whose
  `servedCoord === coord_0(topic)` — exercising recompute + `forCoord` caching + cross-check +
  `handleRegister` end-to-end. (+1 passing.)

### Found — major, filed as a new ticket

- **Latent multi-tier addressing mismatch (gap #5 in the handoff) — NOT captured by any existing
  ticket.** The participant walk routes with `coord_d(self, topicId)` (`db-core/walk.ts` L162) but the
  wire `participantCoord` field carries `H(self)` (`db-core/service.ts` L166/L296 — `participantId`,
  the renewal key, reused as the wire coord). The host recomputes `coord_d(H(self), …)`, so for
  `d ≥ 1` it assembles the wrong cohort and trips `crossCheckCohort`. **Benign at tier 0** (`coord_0`
  ignores `P`), so nothing breaks at this milestone, but it is a real correctness bug the first time a
  `d ≥ 1` cohort is served. Confirmed the read against the source; confirmed it is not covered by
  `cohort-topic-live-tier-e2e` (tier-0 only), `cohort-topic-followon-derivation` (a different walk
  gap), or `cohort-topic-peer-key-signing` (signs the field, doesn't fix its value). **Filed
  `tickets/backlog/cohort-topic-participant-coord-routing-key-mismatch.md`** with root cause, the two
  reconciliation options (recommend: send `self` as `participantCoord`), and acceptance criteria. It is
  a gate for any `d ≥ 1` cohort work.

### Noted — owned by existing downstream tickets (no action here)

- **Multi-member admission needs willingness gossip** (gap #1) — only *self* counts until siblings
  gossip, so a >1-member cohort returns `unwilling_cohort`. Pre-existing (true of the old node-level
  host too), not a regression. Owner: `cohort-topic-gossip-cadence` (in implement/). The single-member
  (`wantK:1`) path admits, which the renewal + dispatch tests rely on.
- **No empty-engine eviction** (gap #2) — a cold `no_state` probe leaves an empty `CoordEngine` (+ a
  gossip subscription) in the map; deliberately not auto-evicted (evicting on `!hasState()` races a
  concurrent register). `hasState()`/`close()`/`all()` are exposed as forward-looking API for a sweep
  tick — currently unused, intentionally kept rather than churned. Owners:
  `cohort-topic-host-antidos-coldstart` + `cohort-topic-gossip-cadence`.
- **Shared gossip transport fans to every coord bus** (gap #3) — record-delta merge is epoch-filtered
  (correct); per-member willingness/load view cross-pollinates across coords on one node, benign since
  those are per-node properties. Owner: `cohort-topic-gossip-cadence`.
- **`followOn` stays `false`** (gap #4) — multi-tier promoted-redirect instantiation out of scope; a
  promoted-childless single cohort terminates a walk with `retry_later` (covered by the new db-core
  `walk.spec.ts` termination test). Owner: `cohort-topic-followon-derivation` (backlog).
- **Per-coord threshold crypto / anti-DoS still node-shared** (gap #6) — interim by design;
  `CoordEngineContext` is the seam. Owners: `cohort-topic-threshold-assembly`,
  `cohort-topic-host-antidos-coldstart`.

### Process note (not this ticket's logic)

The implement commit `80930c5` bundled unrelated `optimystic-session-mode-commit-composition` changes
(`db-core/collection.ts`, `transaction/coordinator.ts`, `quereus-plugin-optimystic` test rewrite +
`repro-session.mjs` deletion, and three new backlog tickets). They are committed and green and belong
to that still-in-`implement/` ticket; flagged only so the per-coord-scoping commit isn't misread as
including them. This review touched none of them.

## Validation summary

- `yarn build:db-core` ✅ (exit 0), `yarn build:db-p2p` ✅ (exit 0).
- `yarn test:db-core` → **534 passing**.
- `yarn test:db-p2p` → **520 passing, 9 pending** (review added the dispatch-path test).

## Done-when (met)

- `CoordEngine` + `CoordRegistry` (`forCoord`, `findHolder`, `all`, `close`) in `host.ts`; per-coord
  composition in `createCoordEngine`. ✅
- Register dispatch recomputes `servedCoord` and routes to `registry.forCoord`; renewal resolves by
  held record with `unknown_registration` fallback; FRET cohort cross-checked. ✅
- Promotion deps coord-derived; per-coord `cohort()`/`localEpoch()`; `stop()` closes every bus. ✅
- Tests: topic-coord cohort, renewal resolution, **dispatch-path recompute (added in review)**,
  handshake, single-cohort walk termination — all green. ✅
- Build (tsc) + db-core + db-p2p tests green; `docs/internals.md` updated. ✅
- Major out-of-scope finding (multi-tier addressing mismatch) filed as a backlog ticket. ✅
