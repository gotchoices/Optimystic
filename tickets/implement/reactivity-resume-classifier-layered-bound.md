description: Retune the simulator's resume classifier to the layered (stacked) checkpoint bound — `classifyResume` cuts over to `OutOfWindow` at `lag ≥ W + W_checkpoint` (4352 at defaults), not `lag ≥ W_checkpoint` (4096), to match the authoritative `docs/reactivity.md` semantics and agree with `RollingCheckpoint.covers`.
files: packages/substrate-simulator/src/reactivity.ts, packages/substrate-simulator/test/reactivity.spec.ts, docs/reactivity.md
difficulty: easy
----

## Summary

`classifyResume` in `packages/substrate-simulator/src/reactivity.ts` uses the older
**single-absolute-bound** form (`OutOfWindow` at `lag ≥ Wcheckpoint`). The authoritative doc
(`docs/reactivity.md` §Resume / §Failure modes, lines ~323–328) settled the resume semantics in
favor of the **layered (stacked)** form: the replay ring covers the head `W` revisions, the parent
checkpoint sits *immediately below* it covering `W_checkpoint` more, so the combined single-round-trip
recoverable range is `W + W_checkpoint` (≈ 256 + 4096 = 4352).

This is an internal inconsistency in the simulator: `RollingCheckpoint.advanceTo(ringLow)` already
implements the layered span (`[ringLow − Wcheckpoint, ringLow − 1]`), so `RollingCheckpoint.covers`
reaches a deepest lag of `W + Wcheckpoint − 1 = 4351`, while the classifier cuts over one full `W`
(256) shallower at `lag ≥ 4096`. Resumes with `4096 ≤ lag < 4352` are therefore misclassified
`OutOfWindow` (2 RPCs + chain read) when they are in fact recoverable from the checkpoint in 1 RPC.

The doc explicitly notes the classifier lags the authoritative bound and points at this ticket
(`docs/reactivity.md:328`).

## Bug reproduction (confirmed)

With `DEFAULT_REACTIVITY_CONFIG` (W=256, Wcheckpoint=4096):

```ts
// currentRevision 9000, fromRevision 4904 → lag = 4096
classifyResume({ ...same tail..., currentRevision: 9000, fromRevision: 4904 })
//   → 'OutOfWindow'   (current, wrong)
//   → 'CheckpointWindow' after fix (lag 4096 < W + Wcheckpoint = 4352)
```

`RollingCheckpoint.covers` at steady state already covers down to lag 4351 — the classifier disagrees
with it over the band `[4096, 4351]`.

## Required change

In `classifyResume` (reactivity.ts ~line 319), change the second bound from `config.Wcheckpoint` to
`config.W + config.Wcheckpoint`:

```ts
const lag = Math.max(0, input.currentRevision - input.fromRevision);
if (lag < config.W) return 'Backfill';
if (lag < config.W + config.Wcheckpoint) return 'CheckpointWindow';   // was: lag < config.Wcheckpoint
return 'OutOfWindow';
```

Resulting cutover (defaults):
- `lag = 4095` → `CheckpointWindow` (unchanged)
- `lag = 4096 … 4351` → `CheckpointWindow` (**changed** from `OutOfWindow`)
- `lag ≥ 4352` → `OutOfWindow`

`TailRotated` precedence (stale `latestKnownTailId`) is unchanged and still wins over the lag check.
`resumeRpcCount` / `resumeLatency` / `traceResume` are unchanged — only the classification threshold moves.

## Stale documentation in the same file

Two comments in `reactivity.ts` currently *describe the old single-bound choice as intentional* and
must be corrected so the file is self-consistent after the fix:

- **`Modeling note — resume thresholds` block (reactivity.ts ~lines 27–32)** — this whole paragraph
  argues the simulator "follows the ticket's `ResumeKind` definition instead [of the doc]" and treats
  `W`/`W_checkpoint` as the two absolute bounds. Rewrite it to state the classifier now follows the
  authoritative layered/stacked form (`lag < W` → Backfill, `W ≤ lag < W + W_checkpoint` →
  CheckpointWindow, else OutOfWindow), matching `RollingCheckpoint` and `docs/reactivity.md`.
- **`Wcheckpoint` field doc (reactivity.ts ~line 41)** — currently "the absolute recoverable lag bound
  in this model". It is the *parent-checkpoint span*, not the absolute bound (the bound is now
  `W + Wcheckpoint`). Reword to describe it as the checkpoint span layered below the replay ring.

## Test updates (`test/reactivity.spec.ts`, describe block "resume classification")

- The existing case `lag ≥ W_checkpoint falls to a chain read (OutOfWindow)` (~lines 121–127) uses
  `currentRevision: 9000, fromRevision: 9000 - C.Wcheckpoint` → lag 4096, which now classifies
  `CheckpointWindow`. Retarget it to the new bound: use lag `≥ C.W + C.Wcheckpoint` (e.g.
  `fromRevision: 9000 - (C.W + C.Wcheckpoint)` → lag 4352).
- Add explicit boundary cases asserting the cutover at `W + W_checkpoint`:
  - lag `C.Wcheckpoint - 1` (4095) → `CheckpointWindow`
  - lag `C.Wcheckpoint` (4096) → `CheckpointWindow` (**the regression guard** — was OutOfWindow)
  - lag `C.W + C.Wcheckpoint - 1` (4351) → `CheckpointWindow`
  - lag `C.W + C.Wcheckpoint` (4352) → `OutOfWindow`
  Build each input from `C.W` / `C.Wcheckpoint` (not hard-coded 4352) so the assertions track the
  config. A good cross-check: pick the deepest still-in-window lag and assert it equals the deepest lag
  `RollingCheckpoint` covers at steady state, so the two never drift apart again.
- The existing `W ≤ lag < W_checkpoint resolves as CheckpointWindow` case (~lines 112–119) still passes
  (lags 256 and 4095) — leave it, or fold it into the boundary set.
- `measureRepeatedWakeThrash` test (lag `C.W - 1` = 255) is unaffected — it lives well below the moved
  boundary; confirm it still reports `transitions === 0`, `allSingleRpc === true`.

## Out of scope

- No change to `W` / `W_checkpoint` defaults (256 / 4096) or to the layered-vs-single decision
  (settled: layered wins).
- No adaptive-`W` work — that is owned by `reactivity-backfill-resume-checkpoints`.
- `measureCoverage` / `CoverageReadout` report `W` and `W_checkpoint` coverage *separately* on purpose
  (they measure each span, not the combined bound) — leave them as-is.

## Validation

- `yarn build` (strict tsc) green from `packages/substrate-simulator` (or repo root per AGENTS.md).
- `yarn test` green; stream output (`yarn test 2>&1 | tee /tmp/reactivity-test.log`).
- Confirm the four new boundary assertions and the unchanged thrash/coverage/rotation tests all pass.

## TODO

- Edit `classifyResume` second bound to `config.W + config.Wcheckpoint`.
- Rewrite the `Modeling note — resume thresholds` comment block (reactivity.ts ~27–32) to the layered form.
- Reword the `Wcheckpoint` field doc (reactivity.ts ~41) — span layered below the ring, not the absolute bound.
- Retarget the `OutOfWindow` test to `lag ≥ W + W_checkpoint`; add boundary cases at 4095 / 4096 / 4351 / 4352 (built from `C.W`/`C.Wcheckpoint`).
- Add the `classifyResume` ↔ `RollingCheckpoint.covers` deepest-in-window agreement assertion.
- Run `yarn build` + `yarn test` (streamed) and confirm green.
