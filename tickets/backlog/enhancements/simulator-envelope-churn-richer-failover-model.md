description: The simulator's two churn/partition stress tests currently bottom out on simple capacity arithmetic rather than on the timing races they were meant to expose; enrich the failover model so the located edges reflect those races and a richer set of failure modes.
prereq:
files:
  - packages/substrate-simulator/src/boundary-churn.ts
  - packages/substrate-simulator/src/registration.ts
  - packages/substrate-simulator/src/cohort-membership.ts
difficulty: hard
----

# Enrich the cohort-topic failure-mode envelope model

The two operating-envelope boundaries delivered by `simulator-envelope-churn`
(`no-lost-registrations` × member-kill rate, `heal-convergence` × partition severity) are correct
and honest about what they measure, but review confirmed both edges are governed by a *structural
arithmetic* rather than by the renewal-timing dynamics the boundaries were intended to stress. This
ticket captures the richer-model follow-up the implementer flagged. It is a **modeling-fidelity
enhancement, not a bug** — the current boundaries faithfully report their model's behavior.

## Why the current edges are arithmetic, not emergent

**Boundary 1 (`killRatePerWindow`).** The located edge `k* ≈ 0.249` is *seed-invariant* (verified
across seeds 1, 7, 909, 4242, 123456 — all `0.2490`). The reason: `ParticipantRenewal.reLookup`
recovers a registration from *any* still-reachable member within three strikes, so a snapshot
registration is lost **only** when the cohort is driven to full serving-capacity exhaustion
(`reachableMembersAtHorizon === 0`). The edge is therefore exactly the window arithmetic
`floor(k·N)·killWindows ≥ N` (with `N = memberCount = 20`, `killWindows = 4`: exhaustion at
`floor(k·20) ≥ 5`, i.e. `k ≥ 0.25`). The renewal *race* is real but **transient** — at `k = 0.2`,
~46 of 80 participants go momentarily lost and recover before the horizon (captured separately as
`peakTransientLost`). Consequently the `renewal-race` branch of the snapshot `KillMechanism`
classifier is effectively unreachable, and the adversarial kill-staggering / seeded-priority-order
machinery does not move the edge at all.

**Boundary 2 (`partitionSeverity`).** The located edge `σ* ≈ 0.3115` is likewise seed-invariant and
is essentially `joinBudget` worth of severity: the first *leave* past the join budget strands the
~4 participants that the removed member served (because `participantCount > memberCount`). The margin
is "how much re-slotting churn the heal absorbs before a served-member removal bites" — reasonable,
but determined by `joinBudget` and `round(σ·maxChangesPerSide)`, not by an emergent timing race.

## What a richer model would change

For the renewal-race (not capacity) to be the *binding snapshot* constraint on Boundary 1, the model
would need at least one of:

- **Re-lookup latency** — `reLookup` resolving over one or more renewal windows instead of
  instantaneously, so a burst of concurrent re-lookups can still leave registrations momentarily
  unserved at the horizon even while reachable members remain.
- **Re-lookup failure / bounded re-lookup target set** — `reLookup` able to *fail* (e.g. it only
  considers a bounded candidate set, or contends for a member that is itself mid-failover), so
  coverage existing in principle does not guarantee coverage in one window.

For Boundary 2 to be more emergent, introduce a **served-vs-unserved-member distinction** so that
`σ*` depends on *which* members churn (whether they currently serve a cached primary), not just on
the join/leave count — making the edge sensitive to the seeded churn order the way Boundary 1's
*transient* signature already is.

## Optional: phase-sweep spot check

The adversarial kill *phase* (offset within the renewal window) is fixed at "just after the tick"
and not swept as a second axis (the axis is kept 1-D by design). Because the current edge is
capacity-bound it is provably phase-invariant; once a timing race becomes the binding constraint, a
spot-check that a different kill phase does not materially move `k*` becomes worth adding.

## Acceptance / expectations

- A churn/partition envelope whose located edge moves with the renewal cadence and seed (not pure
  member-count arithmetic), demonstrating the renewal-race as the binding constraint.
- The `KillMechanism` `renewal-race` classification becomes reachable at the snapshot horizon (today
  it is dead code), distinguishing a genuine timing-race loss from capacity exhaustion.
- Existing boundaries either evolve or coexist; the capacity-exhaustion reading remains available as
  the honest current-model finding.

Cross-ref: shares hardening intent with `simulator-strengthen-scenario-adversariality`.
