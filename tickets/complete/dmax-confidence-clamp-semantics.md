description: Made the low-confidence d_max rule a cap (upper bound) instead of a fixed value, so small networks are no longer wrongly pushed to a deep value, and aligned the doc, the production code, the simulator, and their tests.
prereq:
files:
  - docs/cohort-topic.md
  - packages/db-core/src/cohort-topic/dmax.ts
  - packages/db-core/test/cohort-topic/dmax.spec.ts
  - packages/substrate-simulator/src/size-model.ts
  - packages/substrate-simulator/test/fret-model.spec.ts
difficulty: easy
----

## Summary

Per the human design decision, the low-confidence `d_max` rule is a **cap** (`min(formula, ⌊d_max_cap/2⌋)`), not an unconditional set-to-⌊d_max_cap/2⌋. The implement stage applied this to the simulator (`size-model.ts`) and the doc prose, but left the **production code path** (`packages/db-core/src/cohort-topic/dmax.ts`) on the old set-to semantics — exactly the gap the implementer flagged. Review completed the fix inline so all four artifacts (doc, production code, simulator, tests) now agree.

## Review findings

### What was checked
- The implement-stage diff (`b889e1a`) read first, before the handoff summary.
- Production code path `packages/db-core/src/cohort-topic/dmax.ts` (`makeDMaxComputer`) — the path the doc's implementation note governs.
- Both test suites (`db-core`, `substrate-simulator`) — happy path, the cap-firing path, the small-population-not-inflated path, the confidence-boundary path, and custom-config path.
- Doc consistency across `docs/cohort-topic.md`: §Maximum useful depth prose, the implementation note, and the parameter table.
- `db-p2p` for any separate clamp logic or wiring of the d_max computer.

### Major — fixed inline (production code contradicted the doc)
`makeDMaxComputer.dMax()` still returned `Math.min(clampValue, dMaxCap)` unconditionally when `confidence < confidenceMin` — i.e. the old set-to behavior that inflates small/low-confidence populations to ⌊d_max_cap/2⌋ (=30 by default), the very "pathological deep probe" the rule is meant to prevent. The doc's implementation note (rewritten by the implement stage) already claimed this path did `min(formula, ⌊d_max_cap/2⌋)`, so production code and doc were in direct contradiction.

The implementer disposed of this as a "Known gap" for the reviewer. Because the design decision was already made by the human and the fix is the same mechanical change already applied to the simulator, it was fixed inline rather than deferred to a new ticket (the ticket's stated goal was to align doc + simulator + **production**).

Fix in `dmax.ts`:
```ts
const formula = Math.min(Math.max(0, floorLogF(nEst, F) - 1), dMaxCap);
if (confidence < confidenceMin) {
    return Math.min(formula, capValue);   // upper bound, not set-to
}
return formula;
```
`clampValue` → `capValue` rename; JSDoc on the module header, `DMaxComputer.dMax`, the `confidenceMin`/`dMaxCap` config fields, and the default constants updated from "clamp to" → "cap at (upper bound)".

### Minor — fixed inline
- `packages/db-core/test/cohort-topic/dmax.spec.ts`: the two tests that codified set-to semantics were rewritten to verify cap semantics — `caps d_max … (upper bound)` now uses a tight `dMaxCap: 6` so the cap fires at a testable `n_est` (16⁶ → formula 5 > cap 3 → 3); added a `low confidence does NOT inflate a small population to the cap` test (n=10, conf=0 → 0); `honors custom confidenceMin and dMaxCap` now uses `n=16⁸` so the formula (7) actually exceeds the custom cap (5). Renamed "does not clamp" → "does not cap". Removed the now-unused `DEFAULT_D_MAX_CAP` import.
- `docs/cohort-topic.md` parameter table (line 1206): still read "clamp `d_max` to ⌊d_max_cap/2⌋" — the implement stage missed it. Changed to "cap `d_max` at ⌊d_max_cap/2⌋ (upper bound)".

### Checked, nothing to do
- **db-p2p wiring**: no references to `makeDMaxComputer`/`dMaxCap`/`confidenceMin` — the d_max computer is not yet consumed by any production path, so there is no live regression and nothing else to align. (Consistent with the implementer's note.)
- **Boundary/cap correctness**: in the low-confidence path the result is `min(formula, capValue)` and `capValue = ⌊dMaxCap/2⌋ ≤ dMaxCap`, so `dMaxCap` is still respected; `formula` is independently clamped to `dMaxCap` for the high-confidence path. `floorLogF` power-of-F correction unchanged.
- **Other `clamp` occurrences** in the repo (voting-quorum, reactivity, matchmaking, load barometer) are unrelated to d_max — left untouched.

### Test results
- `packages/db-core`: **881 passing** (~1s). `yarn build` (tsc) clean.
- `packages/substrate-simulator`: **258 passing** (~24s).
- No pre-existing failures.
