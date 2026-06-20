description: Review the d_max confidence-clamp fix: the semantics were changed from an unconditional set-to-30 to an upper-bound min(formula, 30), aligning simulator, doc, and tests.
prereq:
files:
  - docs/cohort-topic.md
  - packages/substrate-simulator/src/size-model.ts
  - packages/substrate-simulator/test/fret-model.spec.ts
difficulty: easy
----

## What was done

Human decision: the low-confidence clamp should be a **cap** (upper bound), not a literal assignment.

### `packages/substrate-simulator/src/size-model.ts`

`computeDMax` was changed from:
```ts
if (confidence < cfg.confidenceMin) {
    return Math.floor(cfg.dMaxCap / 2);  // unconditional set-to-30
}
```
to:
```ts
const formula = Math.max(0, Math.floor(logF) - 1);
if (confidence < cfg.confidenceMin) {
    return Math.min(formula, Math.floor(cfg.dMaxCap / 2));  // upper bound
}
return formula;
```

The `nEst <= 0` guard was moved before the confidence check (same result; cleaner).

JSDoc on `computeDMax` and on the `confidenceMin` field were updated to say "cap/upper bound" instead of "clamp to".

### `packages/substrate-simulator/test/fret-model.spec.ts`

Two tests in `describe('FretModel — confidence clamp on d_max')` updated:

1. **Pure test** — old: asserted `computeDMax(10, 0, cfg) == 30` (set-to). New: demonstrates cap fires only when formula > cap (uses `dMaxCap: 6` tightened config to get formula=5 > cap=3), and explicitly asserts `computeDMax(10, 0, cfg) == 0` (small pop is not inflated).

2. **Real-FRET single-peer test** — old: `expect(model.size.dMax(...)).to.equal(30)`. New: `expect(model.size.dMax(...)).to.equal(dMaxFormula(n, cfg.F))` — single-peer low-confidence population stays at its formula value (≈0), not inflated.

### `docs/cohort-topic.md`

- §Maximum useful depth prose: changed "clamp to `d_max = ⌊d_max_cap / 2⌋`" → "cap `d_max` at `⌊d_max_cap / 2⌋` — i.e. `d_max = min(formula, ⌊d_max_cap / 2⌋)`". Added clarification that small populations are unaffected.
- Implementation note: changed "applies the clamp to `⌊d_max_cap / 2⌋`" → "caps the formula result at `⌊d_max_cap / 2⌋` (upper bound, not a set-to)".
- Simulator sentence: changed "clamp" → "cap".

## Test results

`packages/substrate-simulator`: **258 passing** (24s). No pre-existing failures.

## Validation notes

- The existing N-sweep test (`n_est and d_max track an injected population`) still passes because for all tested N values the formula value is ≪ 30 regardless of confidence, so `min(formula, 30) == formula`.
- The only scenario where the cap fires under default config (`dMaxCap=60`) is when a low-confidence FRET estimate reports `n_est > 16^32` — astronomically large, effectively a safety valve. The tests use a tightened `dMaxCap: 6` to demonstrate cap-firing at testable values.

## Known gaps

- `packages/db-core/src/cohort-topic/dmax.ts` (`makeDMaxComputer`) also implements the same logic per the doc's implementation note. This ticket only touched the simulator; a reviewer should check whether `dmax.ts` also needs the same `min()` fix (it is the production code path that the doc now governs).
