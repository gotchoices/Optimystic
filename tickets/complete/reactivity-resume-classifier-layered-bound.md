----
description: Retune classifyResume to the layered checkpoint bound (W + W_checkpoint) — reviewed and completed
files: packages/substrate-simulator/src/reactivity.ts, packages/substrate-simulator/test/reactivity.spec.ts, docs/reactivity.md
----

## Summary

`classifyResume` in `packages/substrate-simulator/src/reactivity.ts` cut over to `OutOfWindow` one
full `W` too shallow (`lag ≥ Wcheckpoint = 4096`), disagreeing with `RollingCheckpoint.covers` (which
reaches lag `W + Wcheckpoint − 1`) and with the authoritative `docs/reactivity.md` layered semantics.
The implement stage moved the second bound to `lag < config.W + config.Wcheckpoint`, updated two stale
in-file comments, retargeted the `OutOfWindow` test, and added a boundary + cross-check test. Review
confirmed the fix correct and tightened the documentation the implementer left stale.

## What the fix does

- `classifyResume`: `lag < W` → `Backfill`; `W ≤ lag < W + Wcheckpoint` → `CheckpointWindow`; else
  `OutOfWindow`. At defaults the cutover moves from 4096 to 4352. The band `[4096, 4351]` now correctly
  resolves `CheckpointWindow` (1 RPC) instead of `OutOfWindow` (2 RPCs + chain read).
- `TailRotated` precedence, `resumeRpcCount`, `resumeLatency`, `traceResume`, and the `W`/`Wcheckpoint`
  defaults are all unchanged.

## Review findings

**Correctness of the bound (checked — correct).** Verified the layered arithmetic end-to-end: the ring
covers `[ringLow, head]` (deepest lag `W − 1`), the checkpoint covers `[ringLow − Wcheckpoint,
ringLow − 1]` — contiguous with the ring, no gap — so the deepest lag recoverable in one round trip is
exactly `W + Wcheckpoint − 1`. The classifier's `lag < W + Wcheckpoint` boundary matches this precisely.
The cross-check test's steady-state arithmetic is tight: 4452 ingests → ringLow 4197, checkpoint.from
101, deepest covered lag `4452 − 101 = 4351 = W + Wcheckpoint − 1`. No off-by-one.

**Test coverage (checked — adequate).** The three classification tests jointly exercise every boundary
— `W−1` (Backfill), `W` (CheckpointWindow lower edge), `Wcheckpoint−1`/`Wcheckpoint` (old cut, now
CheckpointWindow — regression guards), `W+Wcheckpoint−1` (deepest in-window), `W+Wcheckpoint`
(OutOfWindow). All built from `C.W`/`C.Wcheckpoint`, not hard-coded, so they track config changes. The
`classifyResume ↔ RollingCheckpoint.covers` agreement assertion is a durable guard against the two
drifting apart again. `measureRepeatedWakeThrash` (lag 255) sits well below the moved boundary and is
unaffected (full suite green).

**Documentation (FOUND STALE — fixed inline).** The implement ticket listed `docs/reactivity.md` in its
`files:` but never updated it. Two notes still described the simulator as lagging the doc:
- Line 277: "its `classifyResume` … still uses the older single-absolute-bound form (`lag <
  W_checkpoint`) … a follow-up retunes it." → rewritten to state the simulator now implements the
  layered span end-to-end and cuts over at `lag ≥ W + W_checkpoint`.
- Line 353: "The simulator's `classifyResume` currently cuts over … at `lag ≥ W_checkpoint = 4096` …
  retunes the simulator to match." → rewritten to state it now cuts over at `lag ≥ W + W_checkpoint =
  4352`, guarded by the new test.
The worked-scenario bounds (lines 348–353) and §Parent-checkpoint description were already correct.
No stale references to the ticket slug, "single-absolute", or "shallower" remain in the doc.
`README.md` and `sweep.ts` mention `W`/`W_checkpoint` only as config values — no classifier claims,
nothing to update.

**Other dimensions (checked — clean).**
- *Resource cleanup / performance*: the cross-check test ingests 4452 revisions; `DedupeWindow` evicts
  by age and stays bounded at 64 entries, so no memory blowup. Suite runs in ~37 s.
- *Type safety*: `tsc` strict build green; the new test's `Array<[number, string]>` cases compare
  cleanly against `ResumeKind`.
- *Error/edge paths*: negative/zero lag is clamped via `Math.max(0, …)` (pre-existing, unchanged).

**Minor nit (not fixed — cosmetic).** The cross-check computes `deepestCovered` by probing
`checkpoint.covers(ringLow − Wcheckpoint)` rather than reading `checkpoint.window().fromRevision`
directly. It is correct and tests what it claims; left as-is to avoid churn.

## Build + test (review re-run)

- `yarn workspace @optimystic/substrate-simulator build` — green (tsc strict, no output).
- `yarn workspace @optimystic/substrate-simulator test` — **196 passing, 0 failing** (~37 s).

## Out of scope (unchanged from implement)

- No change to `W`/`Wcheckpoint` defaults or the layered-vs-single decision (layered settled).
- No adaptive-`W` work (owned by `reactivity-backfill-resume-checkpoints`).
- `measureCoverage` / `CoverageReadout` report `W` and `Wcheckpoint` spans separately by design — left
  as-is.

## No new tickets

No major findings; nothing spawned downstream. The single documentation gap was a minor fix applied in
this review pass.
