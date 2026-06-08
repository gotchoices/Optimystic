description: Fold the simulator's measured results into the cohort-topic, reactivity, and matchmaking design docs — confirm or revise every quantitative claim with evidence before substrate implementation begins.
prereq: simulator-metrics-and-scenarios
files: docs/cohort-topic.md, docs/reactivity.md, docs/matchmaking.md, docs/architecture.md
effort: medium
----

## Context

This is **the single mandated bridge ticket** between the simulator phase and the substrate implementation phase. It sequences **after** the full simulator (`simulator-metrics-and-scenarios`, which orchestrates all scenarios + the scale/sensitivity sweep) and **before** any subsystem implementation that commits to parameters or structure.

The program intent: start with a simulator that answers the design's timing/structure questions, then **fold those findings back into the design docs** so the dependent implement tickets build to corrected, evidence-backed values. Every quantitative claim in the three design docs must end this ticket either **confirmed-with-evidence** or **revised**.

The simulator produces structured metrics (JSON/CSV) plus a per-scenario pass/fail claim-validation report and a scale-sweep report confirming (or refuting) the `O(log N)` / `ceil(log_F(N / cap_promote))` depth law. Those outputs are the evidence this ticket cites.

**Downstream dependency:** all subsystem implement tickets whose parameters the simulator settles declare this ticket as a prereq (notably `cohort-topic-wire-formats`, `cohort-topic-tier-addressing-dmax`). Do not let those land ahead of corrected values.

## What to fold, by document

### docs/cohort-topic.md
- **§Configuration** (L604–629): update rationales for `cap_promote`, `cap_promote_fast`, `T_promote_lookahead`, `T_demote`, `d_max_cap`. Replace any "chosen for X" hand-wave with the simulator-measured basis (e.g., overshoot bound at `cap_promote=64` under sustained uniform arrivals; whether `cap_promote_fast=32` absorbs the tail-rotation burst within `T_drain`).
- **§Tier addressing** (`coord_d`, ~L54–74): record the simulator's **collision-rate finding** for the `coord_d(P, topicId) = H(d ‖ prefix(P, d·log2 F) ‖ topicId)` scheme across the prefix space; confirm collisions stay within the design's tolerated bound, or flag a revision.
- **§Anti-flood properties** (L385–395): attach **per-claim simulator evidence** for each of the five claims (cold-start storm avoidance via probe-`d_max`-first; re-registration storm bounded by `T_rejoin_jitter` to ≈ `cap_promote / T_rejoin_jitter` per sec; no speculative outward probe except via Promoted; inward retry restarts at `d_max`; promotion-flap prevention via sticky window). Convert each structural claim into a measured statement.
- **§Promotion and demotion lifecycle** (L346–381): record measured **convergence latency** (peak load → depth stabilization) and **overshoot** past `cap_promote` during the promotion window; note whether pre-promotion lookahead measurably reduced overshoot.

### docs/reactivity.md
- **§Configuration**: settle the **`W` vs `W_checkpoint` ratio** (W=256 / W_checkpoint=4096) and explicitly resolve **whether `W` should be adaptive per measured cps** (at 1 cps W covers ≈4 min; at 100 cps ≈2.5 s). State the decision and its evidence.
- **§Worked scenarios**: replace narrative estimates with **measured RPC counts and latency** for the 90 s wake, the 20 min wake, and the tail-rotation re-registration burst (confirm the burst stays within `cap_promote_fast` inside `T_drain` at `T_rejoin_jitter=30s`, `block_fill_size=64`).

### docs/matchmaking.md
- **§Hang-out vs. continue**: fold in **validated formula traces** for `expectedNewMatches` and `contentionFactor`, and a **justification for `contention_factor_cap = 4.0`** (does it keep 100 parallel seekers fair without self-inflicted escalation storms; should it stay global or become per-tier).
- **§Worked scenarios**: update the worked examples (capability lookup; voting on a popular proposal; sparse provider in large network) with simulator-derived decision outcomes and path lengths. Confirm the documented Hang-out test expectations remain correct as written.

### docs/architecture.md
- Update the **Doc Sync Status** table (added by `fix-architecture-applications-overstatement`): flip each subsystem's "Simulator validation" cell from `pending` to `done`.

## Cross-cutting requirements

- Add **"Defaults validated by simulator"** callouts in each Configuration section, referencing the simulator scenario(s) and the sweep that produced the evidence.
- **Record any parameter the simulator says must change.** If a default changed (e.g., `W` made adaptive, `cap_promote` retuned, `contention_factor_cap` raised), state the new value AND make it unambiguous so the dependent implement tickets build to the corrected value — they prereq this ticket precisely to pick up these numbers.
- Keep claims falsifiable: every quantitative statement should cite the metric/report that confirms it, or be marked revised.

## Out of scope

- Any code (this is docs-only; the simulator already ran in its own tickets).
- Re-running the simulator (consume its emitted reports).

## TODO

### Phase 1 — Ingest simulator outputs
- [ ] Read the `simulator-metrics-and-scenarios` claim-validation reports and the scale/sensitivity sweep results (JSON/CSV + per-scenario pass/fail).
- [ ] Build a checklist of every quantitative claim in cohort-topic.md, reactivity.md, matchmaking.md and map each to a simulator metric (confirmed / revised / no-evidence).

### Phase 2 — Fold into cohort-topic.md
- [ ] Update §Configuration rationales (cap_promote, cap_promote_fast, T_promote_lookahead, T_demote, d_max_cap) with measured bases.
- [ ] Add coord_d collision-rate finding to §Tier addressing.
- [ ] Attach per-claim evidence to §Anti-flood properties.
- [ ] Record convergence latency + overshoot in §Promotion and demotion lifecycle.

### Phase 3 — Fold into reactivity.md
- [ ] Resolve W vs W_checkpoint ratio and the adaptive-W question in §Configuration with evidence.
- [ ] Update §Worked scenarios with measured RPC counts/latency (90 s / 20 min wake, tail-rotation burst).
- [ ] **Reconcile the resume-lag bound inconsistency surfaced by the simulator review** (`simulator-reactivity-replay`). §Failure modes ("Subscriber wakes after long sleep") reads the checkpoint as an *absolute* lag bound (`< W` → Backfill, `< W_checkpoint` → CheckpointWindow, else OutOfWindow), but §Parent checkpoint summaries + the "20 min wake" worked scenario layer the checkpoint *below* the replay window (recoverable ≈ `W + W_checkpoint`, checkpoint covers `[ringLow − W_checkpoint, ringLow − 1]`). The simulator's `classifyResume` implements the single-bound §Failure-modes form (so its `RollingCheckpoint.covers` actually reaches one `W` deeper than `classifyResume` will classify as in-window). Pick one semantics, state it, and make §Failure modes / §Parent checkpoint / §Worked scenarios agree; if the layered form wins, note that the simulator's resume classifier should be retuned to `lag < W + W_checkpoint` in a follow-up.

### Phase 4 — Fold into matchmaking.md
- [ ] Add validated formula traces and contention_factor_cap justification to §Hang-out vs. continue.
- [ ] Update §Worked scenarios with simulator-derived outcomes.

### Phase 5 — Architecture + callouts
- [ ] Flip the Doc Sync Status "Simulator validation" cells to `done` in architecture.md.
- [ ] Add "Defaults validated by simulator" callouts in all three Configuration sections.
- [ ] Enumerate any parameter that must change so dependent implement tickets pick up the corrected value.

## Done when
- Every quantitative claim in cohort-topic.md, reactivity.md, and matchmaking.md is either confirmed-with-evidence or explicitly revised.
- Any changed default is stated clearly enough that `cohort-topic-wire-formats`, `cohort-topic-tier-addressing-dmax`, and other downstream tickets build to it.
- architecture.md Doc Sync Status shows simulator validation `done` for all three subsystems.
- Doc-only change; no build/test impact.
