description: Cohort gossip-cadence driver (gap 5) — host periodic timer broadcasting each CoordEngine's willingness/load/traffic + registration-record deltas, per-touch replication via renewal touch/evicted hooks, per-coord inbound routing, signed gossip, plus sweep/membership-refresh/demotion on the same tick. Implemented, reviewed, and merged.
files:
  - packages/db-p2p/src/cohort-topic/cohort-gossip-driver.ts (pending-delta queue + buildCohortGossip + DEFAULT_GOSSIP_INTERVAL_MS)
  - packages/db-p2p/src/cohort-topic/host.ts (driver timer, signGossip/verifyGossip, per-coord delta hooks, gossipRound/demotionTick/cohortView)
  - packages/db-core/src/cohort-topic/wire/types.ts, validate.ts, payloads.ts (CohortGossipV1.coord + cohortGossipSigningPayload)
  - packages/db-core/src/cohort-topic/gossip/bus.ts (coord routing + verifyInbound auth gate)
  - packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts (driver + host round + routing + replication + timer + auth-gate negative tests)
  - packages/db-core/test/cohort-topic/gossip.spec.ts, wire.spec.ts
  - docs/cohort-topic.md, docs/internals.md
----

# Complete: cohort-topic gossip publishing cadence + per-touch replication

The host-side gossip-cadence driver, per-touch record replication via the renewal `touch`/`evicted`
hooks, per-coord inbound routing, and the signed-gossip auth gate all landed and passed review. See the
implement commit `ticket(implement): cohort-topic-gossip-cadence` for the full architecture; the summary
below records what the review checked and changed.

## What landed (recap)

- **db-core**: `CohortGossipV1.coord` (new required routing key) + validation; `cohortGossipSigningPayload`
  (canonical signed image); gossip bus `coord` routing (a fanned frame merges only into the bus whose
  coord it names — epoch can't isolate two cohorts that share a member set) + optional `verifyInbound`
  auth gate on the transport path.
- **db-p2p**: `cohort-gossip-driver.ts` (`createPendingDeltas` last-writer-wins queue, `buildCohortGossip`
  idle-skip frame assembly, `DEFAULT_GOSSIP_INTERVAL_MS = 5_000`); host single `setInterval` driver
  (`unref`'d, re-entrancy + `stopped` guarded, created after all handlers are live) driving each live
  CoordEngine's `gossipRound` → `pumpMembership` → `demotionTick`; `signGossip`/`verifyGossip` peer-key
  closures (sign the envelope; on inbound verify `fromMember`'s signature **and** cohort membership).

## Review findings

**Diff reviewed:** full implement commit `0108856` read first (db-core wire/bus/payloads, db-p2p
driver/host, both test files, both doc files) before the handoff summary.

**Validation run (all green):**
- `yarn build:db-core` and `yarn build:db-p2p` — clean `tsc` (exit 0).
- `yarn test:db-core` — 541 passing.
- `yarn test:db-p2p` — **554 passing** (+2 from this review's added auth-gate tests), 9 pre-existing
  pending. No lint configured project-wide (`lint` is a no-op echo).

**Correctness / SPP / DRY / cleanup — checked, no defects found:**
- **Signing determinism** — `cohortGossipSigningPayload` is `Omit<…,"signature">` with fixed ordered
  tuples for nested records/summaries/evictions and `?? []`/`?? null` normalization, so signer and the
  receiver (which re-derives from the validated frame) agree byte-for-byte. The host signs after
  `buildCohortGossip` leaves the signature slot empty, then fills it; verified by a round-trip test.
- **Record aliasing** — `touchAndServe`/`accept` `put` fresh `{...rec}` objects (never mutate in place),
  so the pending-delta queue holding a reference cannot be retroactively altered before `drain`.
- **`traffic.publish` idempotence** — freezes a windowed snapshot without resetting the sliding window,
  so calling it once per (fast) round is safe.
- **Transport self-exclusion** — `FretCohortGossipTransport.broadcast` skips `selfPeerId`, so a node does
  not merge its own gossip; the cheap `isOurCoord` routing check runs before the expensive signature
  verify on the inbound path.
- **Timer hygiene** — `unref`'d, re-entrancy guard skips overlapping ticks, `stopped` short-circuits any
  tick after `stop()`, per-engine errors are caught + logged (no eaten exceptions; matches AGENTS.md).
- **Docs** — `docs/cohort-topic.md` and `docs/internals.md` read and confirmed to reflect the new reality
  (the `coord` field, per-coord routing, the host-owned cadence, and — honestly — that a freshly admitted
  record replicates only on its next renewal touch).

**Minor — fixed in this pass:**
- *Auth-gate test coverage gap.* The security-critical host `verifyGossip` closure (peer-key signature +
  cohort-membership binding) had **no negative coverage**: db-core only tested the bus plumbing with a
  stub verifier, and the db-p2p tests delivered only valid frames. Added two db-p2p tests
  (`cohort-topic: host gossip auth gate`): a validly-self-signed gossip from a **non-cohort member** is
  dropped (membership half), and a gossip claiming a real member but signed with the **wrong key** is
  dropped (signature half). Both assert neither the record nor the willingness merges. Pass.

**Major — filed as follow-on tickets (out of this ticket's renewal-hooks scope):**
- `cohort-topic-accept-time-replication` (backlog) — `member-engine.accept()` persists a record but fires
  no gossip hook, so a freshly *admitted* record only replicates on its first renewal touch (≤ ttl/3 ≈
  30 s). A primary crash inside that window loses the record with no replica. Confirmed against
  `member-engine.ts` (store.put, no gossip). Needs an admission-time gossip hook in db-core — a member-
  engine change beyond this ticket's renewal-hook scope.
- `cohort-topic-idle-willingness-heartbeat` (backlog) — idle (topic-less) engines skip gossip, so a brand-
  new multi-node cohort never advertises willingness and can't meet the gossiped-sibling-willingness
  quorum to admit its first registration (chicken-and-egg). The tests seed sibling willingness to step
  around it. Resolution (idle willingness heartbeat vs. admission-policy change) is a design decision;
  distinct from `cohort-topic-admission-quorum-semantics` (which pins the quorum number, not the
  bootstrap path).

**Noted, intentionally not actioned (acceptable for the tier-0 single-cohort milestone):**
- *Sign-failure delta loss.* `gossipRound` drains the pending queue before `await signGossip`; a signing
  rejection (logged by the driver) drops that round's record/eviction deltas. Self-heals — the record
  stays in the local store and re-gossips on the next renewal touch, and each member sweeps evictions
  independently so eviction still converges. `signPeer` over a local key does not throw in practice.
- *Per-coord decode fan-out.* Each delivered frame is decoded once per coord engine on the node (the
  `coord` field is only readable post-decode). O(coords-served) per frame; fine at milestone scale,
  candidate optimization (pre-filter) only if a node serves very many cohorts.
- *`windowSeconds` constant.* `gossipRound` passes `DEFAULT_TRAFFIC_WINDOW_SECONDS` (60), matching every
  engine's default traffic window today. Correct now; thread from the engine if a later ticket makes the
  window per-engine configurable (the implementer's gap 6 — left as a documented note).
- *Driver `pumpMembership`/`demotionTick` over a real network* and the *full libp2p stream round-trip*
  remain exercised by other protocols' tests / direct unit tests, not driver-end-to-end here (the cadence
  tests park the timer or use a no-op outbound dial). `demotionTick` is a genuine no-op for the tier-0
  root (never demotes). Matches the implementer's gaps 3–4; no defect, covered elsewhere.
- *Timer-lifecycle test* uses real `setTimeout` with robust threshold assertions (`>1` dial; stable after
  stop) — mildly wall-clock-sensitive but not flaky in observed runs.
