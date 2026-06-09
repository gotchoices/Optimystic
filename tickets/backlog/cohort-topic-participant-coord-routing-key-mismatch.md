description: The participant's FRET routing key (`coord_d(self, topicId)`) and the wire `participantCoord` field (`H(self)`) diverge for tier d ≥ 1, so a cohort host recomputing the served coord from a RegisterV1 assembles the wrong cohort. Benign at tier 0 (coord_0 ignores P); a correctness bug the moment multi-tier (d ≥ 1) cohorts are served. Must be reconciled before any live multi-tier work.
prereq:
files:
  - packages/db-core/src/cohort-topic/service.ts (participantId = H(self) at L166; participantCoord = bytesToB64url(participantId) at L296)
  - packages/db-core/src/cohort-topic/walk.ts (routes with addressing.coord(d, deps.self, topicId) at L162)
  - packages/db-core/src/cohort-topic/addressing.ts (coordD: H(d ‖ prefix(P, d·log₂F) ‖ topicId))
  - packages/db-p2p/src/cohort-topic/host.ts (dispatchRegister recomputes servedCoord = addressing.coord(reg.treeTier, participantCoord, topicId))
  - docs/cohort-topic.md (§Tier addressing, §Wire formats — what `participantCoord` carries)
----

# Reconcile the participant routing key `P` with the wire `participantCoord`

## The inconsistency

The tier-addressing spec is `coord_d(P, topicId) = H(d ‖ prefix(P, d·log₂F) ‖ topicId)` for `d ≥ 1`
(`coord_0` ignores `P`). Two places disagree on what `P` is:

- **Routing (participant side).** `WalkEngine` routes a register to
  `addressing.coord(d, deps.self, topicId)` — i.e. `P = self`, the participant's ring coordinate
  (`db-core/walk.ts` L162). The host passes `self: selfCoord` into the service.
- **Wire field.** The `RegisterV1.participantCoord` field carries
  `bytesToB64url(this.participantId)` where `participantId = hash.H(deps.self)` — i.e. `P = H(self)`
  (`db-core/service.ts` L166, L296). `participantId` was introduced as the **renewal/storage key**
  (`recordKey(topicId, participantId)`) and is reused, unintentionally, as the wire `participantCoord`.

So FRET routes a register to `coord_d(self, topicId)`, but the cohort host recomputes the served coord
as `addressing.coord(reg.treeTier, participantCoord, topicId) = coord_d(H(self), topicId)`
(`db-p2p/host.ts` `dispatchRegister`). For `d ≥ 1` these are different coordinates, so the host:

1. instantiates / selects the wrong `CoordEngine` (keyed on the recomputed coord),
2. assembles `assembleCohort(coord_d(H(self), …))` — **not** the cohort FRET actually routed to, and
3. trips the host's `crossCheckCohort` warning (FRET-routed cohort ≠ recomputed assembly).

**At tier 0 it is benign** — `coord_0` ignores `P`, so `coord_0(self) == coord_0(H(self))` and the
two agree. The per-coord-scoping milestone serves only tier-0 cohorts, so nothing observable breaks
today; this is a **latent** bug that bites the first time a `d ≥ 1` cohort is served (multi-tier
promotion / live-tier multi-tier e2e).

## What to decide

Pick the single source of truth for `P` and align both sides:

- **Option A — `participantCoord` carries `self` (the routing coordinate).** Stop reusing
  `participantId` for the wire field; send `bytesToB64url(self)` as `participantCoord` and keep
  `participantId = H(self)` purely as the local renewal/storage key. Then the host's recompute
  `coord_d(participantCoord, topicId)` matches FRET's routing key by construction. Lowest-risk; the
  wire field then literally means "the participant's ring coordinate", which is what `coord_d` wants.
- **Option B — route on `H(self)`.** Make `WalkEngine` route with `coord_d(H(self), topicId)` so the
  routing key matches the existing wire field. Changes the ring placement of every tier-`d` cohort;
  re-validate that `prefix(H(self), …)` still distributes shards as intended.

Option A is the expected resolution (the wire field's name and the `coord_d` contract both say "ring
coordinate"), but confirm against the §Tier addressing / §Wire formats intent before committing.

## Acceptance

- The participant routing key and the value the host recomputes `servedCoord` from are provably equal
  for `d ≥ 1` (not just `d = 0`). Add a db-core test that registers at `d = 1` and asserts the coord
  the walk routes to equals `addressing.coord(1, <wire participantCoord>, topicId)`.
- `db-p2p/host.ts` `crossCheckCohort` does not warn for a correctly-routed `d ≥ 1` register in a
  multi-node harness.
- `docs/cohort-topic.md` §Wire formats states unambiguously what `participantCoord` carries, and
  §Tier addressing's `P` is cross-referenced to it.

## Notes

- Surfaced by the `cohort-topic-per-coord-scoping` review (gap #5 in that implement handoff). The
  implementer flagged it explicitly and asked whether it belongs in `cohort-topic-live-tier-e2e` or a
  dedicated fix — this is that dedicated item. It is a **prerequisite** for serving any `d ≥ 1` cohort,
  so the multi-tier promotion / live-tier-multi-tier work should treat it as a gate.
- Intersects `cohort-topic-peer-key-signing` (which signs the `participantCoord` body) and
  `cohort-topic-followon-derivation` (the other multi-tier walk gap) — coordinate the wire-field
  decision with both if they land first.
