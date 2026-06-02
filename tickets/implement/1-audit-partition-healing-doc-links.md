description: Add partition-healing.md to the architecture document map and verify cohort-topic/reactivity cross-links are consistent with its two-tier rule model.
prereq:
files: docs/architecture.md, docs/partition-healing.md, docs/cohort-topic.md, docs/reactivity.md
effort: low
----

## Context

Verified state (2026-06-02):

- `docs/partition-healing.md` **EXISTS** (it is a full spec: "Partition Healing via Deterministic Application Rules", the two-tier intent/invariant rule model, three honest CAP stances, `effectGate`, reservation/escrow).
- The cross-links from the substrate docs are **NOT dangling**:
  - `docs/cohort-topic.md` L662 → `[partition-healing.md](partition-healing.md)` ("cohort merge after partition is handled by FRET stabilization; the layer reacts via `cohortEpoch` refresh").
  - `docs/reactivity.md` L497 → `[partition-healing.md](partition-healing.md)` ("handled at the cohort-topic layer via `cohortEpoch` refresh; reactivity reacts by re-verifying its parent-checkpoint bracketing signatures").
  - `docs/crdt-sync.md` also references it in several places (already in the doc map's spirit via crdt-sync, but partition-healing itself is its own document).

**DEFECT:** `docs/partition-healing.md` is **missing from the architecture.md Document Map** (the table at L279–294). Every other spec doc is listed there; partition-healing is not.

## Required edits

1. **Add partition-healing.md to the Document Map** table in `docs/architecture.md` (the `## Document Map` table near L281). Insert a row with an accurate focus description, e.g.:

   | [partition-healing.md](partition-healing.md) | Partition-induced invariant reconciliation: two-tier intent/invariant rules, deterministic application-defined merge |

   Place it logically (near `crdt-sync` if present, otherwise near the correctness/internals rows). Note: confirm whether `crdt-sync.md` itself is in the map; if it is also absent, add it too (it is the paired document partition-healing builds on) — but the mandated fix is partition-healing.

2. **Consistency audit (cohort-topic ↔ partition-healing).** Confirm `docs/cohort-topic.md` §"Failure modes" — specifically "Cohort partition (minority loss)" (L418) and "Network partition healing" (L424) — are consistent with partition-healing.md's model. The cohort-topic doc describes FRET stabilization + `cohortEpoch` refresh + deterministic primary re-assignment + child-cohort list merge; partition-healing.md describes the *application-data* two-tier rule model. These operate at different layers and should be mutually consistent (cohort-topic = membership/transport recovery; partition-healing = data/invariant reconciliation). Verify the cohort-topic L662 link's claim accurately reflects partition-healing's scope; fix wording if it overclaims (cohort-topic does **not** perform data reconciliation — that is partition-healing's job at the transaction layer).

3. **Consistency audit (reactivity ↔ partition-healing).** Confirm `docs/reactivity.md` §"Failure modes" and §"Interaction with other subsystems" (L497) are consistent: the `cohortEpoch` refresh, dedupe-window merge behavior, and bracketing-signature re-verification claims must align with partition-healing's merge model. Verify that reactivity's "re-verifying parent-checkpoint bracketing signatures" on heal is coherent with how partition-healing describes stable-transaction survival across merges (`effectGate: 'on-stable'`, L182). Fix any inconsistency in the reactivity wording.

## Out of scope

- Creating `partition-healing.md` (it already exists).
- The existing `tickets/backlog/6.5-partition-healing.md` is a separate **healing-mechanics implementation** concern, not this documentation audit. Do not touch it.
- Source code.

## TODO

### Phase 1 — Doc map
- [ ] Add the `partition-healing.md` row to the `## Document Map` table in `docs/architecture.md` (and `crdt-sync.md` if it too is absent).

### Phase 2 — Cross-link consistency
- [ ] Read partition-healing.md's "Two-Tier Rule Model" and the cohort-topic §Failure modes; confirm the cohort-topic L662 link description is layer-accurate; correct if it overstates cohort-topic's role in data reconciliation.
- [ ] Confirm reactivity L497 interaction text (cohortEpoch refresh, dedupe-window merge, bracketing-sig re-verification) is consistent with partition-healing's stable-transaction-survives-merge semantics; correct wording if needed.

## Done when
- `docs/architecture.md` Document Map lists `partition-healing.md`.
- The cohort-topic and reactivity cross-links to partition-healing are confirmed consistent (or corrected) against its two-tier rule model.
- Doc-only change; no build/test impact.
