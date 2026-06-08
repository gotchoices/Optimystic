description: Retune the simulator's resume classifier to the layered (stacked) checkpoint bound — `classifyResume` must cut over to OutOfWindow at `lag ≥ W + W_checkpoint`, not `lag ≥ W_checkpoint`, to match the authoritative reactivity.md semantics.
files: packages/substrate-simulator/src/reactivity.ts, packages/substrate-simulator/test/reactivity.spec.ts, docs/reactivity.md
----

## Problem

`fold-simulator-findings-into-design-docs` settled the reactivity resume semantics in favor of the
**layered (stacked)** checkpoint form, and made `docs/reactivity.md` authoritative on it:

- The replay ring covers the head `W` revisions; the parent checkpoint sits **immediately below** it,
  covering `[ringLow − W_checkpoint, ringLow − 1]`.
- Total single-round-trip recoverable range is therefore **`W + W_checkpoint`** (≈ 256 + 4096 = 4352
  revisions), and a resume is classified:
  - `lag < W` → `Backfill`
  - `W ≤ lag < W + W_checkpoint` → `CheckpointWindow`
  - `lag ≥ W + W_checkpoint` → `OutOfWindow`

The simulator is **internally inconsistent** with this:

- `RollingCheckpoint` (in `reactivity.ts`) already implements the layered span — `advanceTo(ringLow)`
  sets the window to `[ringLow − span, ringLow − 1]`, sitting immediately below the ring. So
  `RollingCheckpoint.covers(rev)` reaches one full `W` deeper than the classifier admits.
- But `classifyResume` uses the older **single-absolute-bound** form:
  ```ts
  if (lag < config.W) return 'Backfill';
  if (lag < config.Wcheckpoint) return 'CheckpointWindow';   // <-- should be W + Wcheckpoint
  return 'OutOfWindow';
  ```
  So with defaults it cuts over to `OutOfWindow` at `lag ≥ 4096` — one `W` (256) **shallower** than
  both `RollingCheckpoint.covers` and the doc. Resumes with `4096 ≤ lag < 4352` are misclassified
  `OutOfWindow` (2 RPCs + chain read) when they are actually recoverable from the checkpoint in 1 RPC.

This was flagged but deliberately not fixed during the docs fold-back (docs-only ticket); the doc now
explicitly notes the simulator classifier lags the authoritative bound and points here.

## Expected behavior

`classifyResume` (and anything that mirrors its thresholds) must use the stacked bound:

```ts
const lag = Math.max(0, input.currentRevision - input.fromRevision);
if (lag < config.W) return 'Backfill';
if (lag < config.W + config.Wcheckpoint) return 'CheckpointWindow';
return 'OutOfWindow';
```

After the change:
- `lag = 4095` → `CheckpointWindow` (unchanged)
- `lag = 4096 … 4351` → `CheckpointWindow` (**changed** from `OutOfWindow`)
- `lag = 4352`+ → `OutOfWindow`
- This makes `classifyResume` agree with `RollingCheckpoint.covers` (the layered span) and with
  `docs/reactivity.md` §Parent checkpoint summaries / §Failure modes / §Worked scenarios.

`TailRotated` precedence (stale `latestKnownTailId`) is unchanged and still wins over the lag check.

## Use cases / validation

- Update `test/reactivity.spec.ts` resume-classification cases: assert the cutover at `W + W_checkpoint`
  (4352 at defaults), with explicit boundary cases at lag 4095 / 4096 / 4351 / 4352.
- Confirm `measureRepeatedWakeThrash` still reports no thrash (the lag-≈-`W` repeated-wake path is
  unaffected — it lives well below the changed boundary).
- The 20-min worked-scenario lag (1,299) is unaffected; the change only widens the in-window range at
  the deep end.
- `yarn build` (strict tsc) + `yarn test` green.

## Out of scope

- Any change to `W` / `W_checkpoint` defaults (256 / 4096 stay) or to the layered-vs-single decision
  (already settled: layered wins).
- Making `W` adaptive per cps — that is a separate downstream concern owned by
  `reactivity-backfill-resume-checkpoints` (the docs already record the adaptive-`W` recommendation).
