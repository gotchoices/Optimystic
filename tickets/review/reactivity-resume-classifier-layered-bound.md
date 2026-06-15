----
description: Review — retune classifyResume to the layered checkpoint bound (W + W_checkpoint)
files: packages/substrate-simulator/src/reactivity.ts, packages/substrate-simulator/test/reactivity.spec.ts
----

## What was done

Fixed a classifier/checkpoint mismatch in `packages/substrate-simulator/src/reactivity.ts`:

**`classifyResume` (line ~327)** — the second bound changed from `config.Wcheckpoint` (4096) to
`config.W + config.Wcheckpoint` (4352). Resumes with `4096 ≤ lag < 4352` are now `CheckpointWindow`
instead of `OutOfWindow`, matching `RollingCheckpoint.covers` and `docs/reactivity.md`.

**Two stale comments updated:**
- "Modeling note — resume thresholds" block (~lines 27–31): rewritten to describe the layered form.
- `Wcheckpoint` field doc (~line 41): reworded from "absolute recoverable lag bound" to "span layered
  immediately below the replay ring; combined bound is `W + Wcheckpoint`".

**Tests (`test/reactivity.spec.ts`):**
- Existing `CheckpointWindow` test title updated to say `W + W_checkpoint` (was `W_checkpoint`).
- Existing `OutOfWindow` test retargeted to `lag = C.W + C.Wcheckpoint` (4352); was `C.Wcheckpoint` (4096) — that lag now classifies `CheckpointWindow`.
- New test `classifyResume cutover aligns with RollingCheckpoint.covers at the layered bound` added:
  - Four boundary cases: lag 4095 → `CheckpointWindow`, lag 4096 → `CheckpointWindow` (regression guard),
    lag 4351 → `CheckpointWindow`, lag 4352 → `OutOfWindow`. All built from `C.W`/`C.Wcheckpoint`.
  - Agreement assertion: drives `CohortPushState` to steady state and verifies the deepest lag covered
    by `RollingCheckpoint` equals `C.W + C.Wcheckpoint - 1`, matching the classifier cutover.

## Build + test

`yarn workspace @optimystic/substrate-simulator build` — green (tsc strict).  
`yarn workspace @optimystic/substrate-simulator test` — 196 passing, 0 failing.

## Use cases to validate

- Lag exactly at old cut (`4096`) now routes to `CheckpointWindow` (1 RPC), not `OutOfWindow` (2 RPCs).
- Lag at new cut (`4352`) correctly routes `OutOfWindow`.
- The `measureRepeatedWakeThrash` test (`lag = C.W - 1 = 255`) still reports `transitions === 0` and `allSingleRpc === true` (confirmed by full test suite passing).
- Coverage/CoverageReadout tests unchanged — they report `W` and `W_checkpoint` spans separately by design.

## Known gaps / reviewer focus

- The `deepestLagCovered` cross-check in the new test computes steady-state deepest lag manually by
  inspecting `ringLow`. It assumes the ring is full and the checkpoint is fully populated — this holds
  after `W + Wcheckpoint + 100` ingests. Reviewer should verify the arithmetic is tight.
- No adaptive-W changes were made (out of scope per ticket).
