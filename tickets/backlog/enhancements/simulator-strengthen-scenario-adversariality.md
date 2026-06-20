description: Strengthen the simulator's scenario/sweep claim validators where they are currently structurally guaranteed rather than emergently discovered, and add a claim characterizing the slope-lookahead-ON cold-start transient hop bound (the lookahead path is presently unvalidated by any scenario).
files:
  - packages/substrate-simulator/src/scenarios.ts
  - packages/substrate-simulator/src/sweep.ts
  - packages/substrate-simulator/test/scenarios.spec.ts
  - packages/substrate-simulator/src/partition.ts
  - packages/substrate-simulator/src/promotion-convergence.ts
----

# Strengthen simulator scenario/sweep adversariality

The sequence-6 gate (`simulator-metrics-and-scenarios`) landed five scenarios + a scale/sensitivity
sweep, all green. The review confirmed correctness, but several "claims" pass **by construction** —
they confirm a model invariant rather than discovering an emergent property — and one promotion code
path is exercised by no scenario at all. This ticket hardens the gate so its pass/fail signal has
teeth where it currently does not. None of this blocks `fold-simulator-findings-into-design-docs`
(the current artifacts are usable and honestly caveated); it raises the confidence the gate provides.

## Structurally-guaranteed claims to make adversarial

- **`churn-recovery / heal-convergence`** — `checkConvergence` (partition.ts) is a pure function:
  `CohortMembership.merge(a, b).epoch === pre.epoch` by definition, and `assign` is deterministic, so
  `converged` is always true. It re-tests merge/assign determinism (already unit-tested), not failover
  resilience. Make it adversarial: kill members *during* the partition window, heal into a membership
  that does **not** trivially reproduce the pre-split set, and assert convergence holds anyway (or is
  detected as a `primary_moved` within one renewal window).

- **`churn-recovery`** kills all 20% of members at `t = 0`. Kill members *during* renewal (staggered
  on the clock) so failover races real renewal traffic rather than a settled post-crash steady state.

- **`adversarial-traffic-reporting / over-report-bounded-drain`** — bounded by the seeker's own
  `deadline`, so `≤ patienceMs` is near-tautological. Consider a reporter that flips its lie
  per-query (so the seeker cannot settle), and assert the harm is still bounded.

- **`tail-rotation-under-load / completes-within-drain`** — `withinDrain` can never be false at the
  default config: arrivals jitter over `T_rejoin_jitter` (30 s), hardcoded **smaller** than `T_drain`
  (60 s), so `lastArrivalAt ≤ T_drain` always holds regardless of system behavior. Either drive a
  jitter window that can plausibly exceed `T_drain` (and assert the wave still drains via promotion
  fan-out, not via the window being trivially short), or replace the claim with one that measures the
  *drain* dynamics (old-tail forwarding tail-off) rather than just the arrival-window bound.

  **Partially landed — read before starting.** `simulator-envelope-reactivity` (now in `complete/`)
  built a `boundary-reactivity.ts` harness that already drives the `T_rejoin_jitter / T_drain` ratio
  past 1 and asserts the wave still drains via fast-promote fan-out (the first alternative above), so
  the *boundary*-mode coverage of this gap exists. Two consequences for this ticket:
  - **The horizon bug is already fixed.** `simulateRotationBurst` previously also capped its run at
    `world.scheduler.run(T_drain)`, so any arrival scheduled past `T_drain` never fired — a *second*,
    independent reason `completedWithinDrain` could never be false once jitter exceeded drain. That run
    horizon is now `max(T_drain, T_rejoin_jitter)`, so the genuine last-arrival time is observed. Do
    **not** re-fix it; if you touch that line, expect a clean no-op rather than a conflict (the
    shipped-config horizon is still exactly `T_drain`, so the default burst is byte-unchanged).
  - **Remaining scope here is the *scenario* claim, not the boundary.** The `TailRotationScenario`
    claim in `scenarios.ts` still runs at the default config and is still tautological. The
    higher-value remaining work is the *second* alternative — make the scenario claim measure real
    drain dynamics (per-arrival absorption / old-tail forwarding tail-off / queue depth at the new
    tail) rather than the arrival-window bound, which would also lower the boundary's `ratio*`.

## Unvalidated lookahead-ON cold-start path

`ColdStartStormScenario` and `simulateRotationBurst` both disable slope lookahead
(`tPromoteLookaheadMs: 0`) so promotion fires strictly at the cap and the `≤ d_max + 2` cold bound is
a real check. That is the right call for *those* claims — but it means the slope-lookahead promotion
path is exercised by **no** scenario. With lookahead ON the storm transiently over-deepens the tree
(pre-promotion below `cap_promote`), pushing max hops past `d_max + 2` (the implementer observed 8 at
N=3000, d_max=4) — still `O(log N)`, but a different, looser transient bound (≈ `2·d_max`).

Add a scenario (or a scale-sweep variant) that runs the storm with lookahead ON and validates the
transient hop bound (≈ `2·d_max`) and that steady-state still converges to the depth law once the
ramp settles. This pins the lookahead path so a regression there is caught.

## Notes for the implementer
- Keep the lookahead-OFF claims as-is; this adds coverage, it does not relax existing bounds.
- The `samplesFor` / sweep monotonicity checks validate *relationships*, not absolute targets — that
  split is intentional (absolute-number validation is the fold-back's job); do not change it here.
- Reuse the existing drivers (`ParticipantWalk`, `TopicTree`, `checkConvergence`,
  `simulateRotationBurst`) — this is validation hardening, not new modeling.
