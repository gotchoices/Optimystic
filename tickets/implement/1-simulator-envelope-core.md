<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-18T02:45:25.386Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\1-simulator-envelope-core.implement.2026-06-18T02-45-25-386Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Add a reusable "how much stress before this guarantee breaks" measurement harness to the design simulator — it drives a single worsening condition upward until a design claim stops holding, records the exact value where it broke, and reports how much slack the design had before that point.
prereq:
files:
  - packages/substrate-simulator/src/boundary.ts        (NEW — the harness)
  - packages/substrate-simulator/test/boundary.spec.ts   (NEW)
  - packages/substrate-simulator/src/promotion-convergence.ts  (runConvergence — the reference axis driver)
  - packages/substrate-simulator/src/sweep.ts            (N-gating + Metrics-folding pattern to mirror)
  - packages/substrate-simulator/src/metrics.ts          (Metrics sink)
  - packages/substrate-simulator/src/index.ts            (barrel exports)
difficulty: hard
----

# Validity-envelope harness + reference boundary (the foundation)

This is the shared foundation for the validity-envelope work (parent: `simulator-validity-envelope`).
It adds the **third validation mode** to the simulator — boundary/envelope finding — alongside the
existing absolute-target checks (scenarios) and relationship/monotonicity checks (`sweep.ts`).

Where `sweep.ts` answers *"which direction does this parameter move the metric"* and the scenarios
answer *"does the claim hold at the nominal point"*, this harness answers *"how far can a worsening
condition be pushed before the claim flips pass→fail, and how much margin is there to the operating
point the design assumes."* The headline output is the **margin**, not the pass/fail.

The subsystem boundary tickets (`simulator-envelope-tree`, `-churn`, `-reactivity`, `-matchmaking`)
all depend on this module and only supply per-axis `holds(value)` evaluators. This ticket builds the
generic finder and proves it end-to-end against **one** real, cheap reference axis so the harness is
self-validating before the heavier axes land.

## Module shape (`boundary.ts`)

The finder drives a single **stress axis** that is monotone-in-harm (larger value ⇒ strictly more
stress on the claim) against an otherwise-nominal config, scanning upward to bracket the pass→fail
transition and then bisecting to locate the edge. Every evaluation is a fresh run deterministic from
`(seed, config, axisValue)` — scan/bisect on the virtual clock only, no wall-clock, no randomness
outside the seeded rng.

```ts
/** A claim's measured operating-envelope edge along one stress axis (parent ticket §What a boundary readout looks like). */
export interface EnvelopeBoundary {
  readonly claim: string;            // e.g. 'root-not-overloaded'
  readonly axis: string;             // e.g. 'arrivalsPerRound'
  /** Last axis value at which the claim still held — the envelope edge. */
  readonly criticalValue: number;
  /** The operating point the design assumes (from the doc / DEFAULT_*). */
  readonly designAssumption: number;
  /** criticalValue − designAssumption. > 0 ⇒ the design sits inside the envelope. */
  readonly margin: number;
  /** criticalValue / designAssumption (NaN when designAssumption === 0) — the slack as a ratio. */
  readonly marginRatio: number;
  /** > 0 ⇒ design point is inside the envelope (margin > 0). */
  readonly designInsideEnvelope: boolean;
  readonly monotoneDirection: 'increasing-harm' | 'decreasing-harm';
  /** false ⇒ the claim held across the entire scanned range; criticalValue is then a *lower bound* (= scanHi). */
  readonly boundaryFound: boolean;
  /** true ⇒ a pass was observed at a value past an observed fail — the axis is not actually monotone-in-harm (finding is suspect). */
  readonly monotoneViolated: boolean;
  readonly scanLo: number;
  readonly scanHi: number;
  /** Count of holds() evaluations performed (cost transparency). */
  readonly evaluations: number;
}

/** Caller-supplied per-axis definition; `holds` is the only subsystem-specific part. */
export interface BoundaryAxisSpec {
  readonly claim: string;
  readonly axis: string;
  readonly designAssumption: number;
  readonly monotoneDirection?: 'increasing-harm' | 'decreasing-harm'; // default 'increasing-harm'
  readonly lo: number;     // scan floor (expected to hold; if it already fails, margin < 0 is reported)
  readonly hi: number;     // scan ceiling (cap on the search; if it still holds, boundaryFound=false)
  readonly integer: boolean;       // integer-resolution axis (counts) vs real-valued (ratios/fractions)
  readonly tolerance?: number;     // bisection stop width for real axes (default e.g. 1e-3 * (hi−lo))
  /** Evaluate the target claim at one axis value: true ⇒ claim holds. Must be deterministic. */
  holds(value: number): boolean;
}

export function findBoundary(spec: BoundaryAxisSpec): EnvelopeBoundary;
export function recordBoundary(metrics: Metrics, b: EnvelopeBoundary): void;
export interface BoundaryReport { readonly boundaries: EnvelopeBoundary[]; readonly metrics: Metrics; }
```

### Finder algorithm

1. **Bracket.** Evaluate `holds(lo)`. Geometrically (or linearly for small integer ranges) step the
   axis up from `lo` toward `hi` until `holds` flips to `false`, yielding a bracket
   `[lastPass, firstFail]`. The default convention is `monotoneDirection: 'increasing-harm'` — larger
   axis value is worse, so the claim holds below the edge and fails above it. (`'decreasing-harm'` is
   supported by scanning downward; the subsystem tickets all choose increasing-harm axes, so this is
   the rarely-used branch — keep it but the increasing-harm path is the tested one.)
2. **Bisect.** Bisect `[lastPass, firstFail]` until the bracket is within `tolerance` (real axes) or
   adjacent integers (integer axes). `criticalValue` = the last value that still held.
3. **Margin.** `margin = criticalValue − designAssumption`; `marginRatio = criticalValue /
   designAssumption`; `designInsideEnvelope = margin > 0`.

### Boundary conditions the finder MUST handle explicitly (not silently mis-report)

- **Claim already fails at `lo`** (design sits *outside* the envelope) → `criticalValue < lo`,
  `margin < 0`, `designInsideEnvelope = false`. This is the regression-detector's key signal and the
  `cold-start-storm-default-claim-semantics` case (cumulative tier-0 acceptance 122 > cap 64 at the
  10k default already fails `root-not-overloaded`). Do **not** throw — report the negative margin.
- **Claim still holds at `hi`** (margin larger than the scanned range) → `boundaryFound = false`,
  `criticalValue = hi` documented as a *lower bound*, not the true edge. `log()`/record the cap so a
  reader never mistakes "held to the cap" for "unbounded."
- **Non-monotone predicate** (a `pass` observed at a value beyond an observed `fail` during bracket or
  bisection) → set `monotoneViolated = true` and still return the first-fail edge, so the caller knows
  the axis assumption was violated rather than trusting a wrong number.

### Reference axis implemented in THIS ticket

To prove the harness against a real driver, implement exactly one boundary here — the cheapest, most
central one — the tree `root-not-overloaded` / depth-law axis over **arrivals-per-gossip-round `R`**,
reusing `runConvergence` (virtual clock, ~no full-tree growth, so it stays fast):

- **axis** `arrivalsPerRound`, **claim** `root-not-overloaded` (parent ticket table row 1).
- `holds(R)` runs `runConvergence({ N, arrivalsPerRound: R, lookahead: false })` and returns whether
  the cumulative tier-0 overshoot stays within one round **and** the depth still equals
  `expectedDepth(N,F,cap)` (cold max-hops `≤ d_max + 2` is the lookahead-OFF bound this driver gives).
- **designAssumption** = `cap_promote` (DEFAULT_LIFECYCLE_CONFIG.capPromote, 64): the overshoot
  analysis is naturally expressed relative to the cap (the fold-back established overshoot `< R`, and
  `= 0` exactly when `R` divides `cap_promote`; the admission buffer is sized for `cap_promote + one
  round`). The measured `R*` and `margin = R* − cap_promote` are the output — do not hard-code them.
  Document this designAssumption choice inline (the alternative, the doc's nominal storm rate, is
  noted-and-rejected because it is N/window-dependent and less stable as a reference).

Gate the reference axis by N exactly as `sweep.ts` gates its full-tree measurements (cheap N for the
default run; large N opt-in), and fold each `EnvelopeBoundary` into a `Metrics` sink via
`recordBoundary` (counters/timelines keyed by `(claim, axis)`), mirroring `recordScaleSample`.

## Edge cases & interactions

- **Determinism / no real time.** Every `holds` evaluation must produce identical results across runs
  for the same `(seed, config, axisValue)`; the `no-real-time.spec` / `determinism.spec` guarantees
  must continue to hold. No `Date.now`, no unseeded rng. Bisection order must not depend on map
  iteration or timing.
- **Already-failing-at-lo vs held-to-hi** — the two opposite open-bracket cases above; both must be
  unit-tested with a synthetic monotone predicate (a pure step function) so the harness logic is
  proven independent of any subsystem driver.
- **Integer vs real resolution.** Integer axes bisect to adjacent integers (no infinite loop on a
  `tolerance` finer than 1); real axes bisect to `tolerance`. A `tolerance` ≥ `(hi−lo)` must terminate
  immediately, not loop.
- **Off-by-one at the edge.** `criticalValue` is the *last value that holds*, not the first that
  fails — pin this with a synthetic predicate whose edge is known exactly.
- **Cost transparency / cap.** Record `evaluations`; the geometric bracket + bisection must be
  `O(log(range))` evaluations. A pathological `holds` that flips repeatedly must terminate via the
  `monotoneViolated` path, not run unboundedly.
- **Cross-subsystem reuse.** The four subsystem tickets import `findBoundary`/`EnvelopeBoundary`
  unchanged — keep the `holds` callback the *only* extension point; do not bake any tree/reactivity/
  matchmaking specifics into `boundary.ts`.
- **`marginRatio` when `designAssumption === 0`** → return `NaN` (or a documented sentinel), never
  divide-by-zero or `Infinity` silently.

## TODO

- Add `packages/substrate-simulator/src/boundary.ts` with `EnvelopeBoundary`, `BoundaryAxisSpec`,
  `BoundaryReport`, `findBoundary`, `recordBoundary` as specified above (generic, no subsystem
  specifics).
- Implement the geometric-bracket → bisection finder with the three explicit boundary conditions
  (fails-at-lo, holds-to-hi, non-monotone) and `evaluations` accounting.
- Implement the single reference axis (`root-not-overloaded` × `arrivalsPerRound`) using
  `runConvergence`, with `designAssumption = cap_promote`, N-gated like `sweep.ts`, folded into
  `Metrics` via `recordBoundary`.
- Export the new surface from `src/index.ts`.
- Add `test/boundary.spec.ts`:
  - synthetic step-predicate tests: edge located exactly (`criticalValue` is last-pass); fails-at-lo
    → negative margin; holds-to-hi → `boundaryFound=false`, `criticalValue=hi`; non-monotone
    predicate → `monotoneViolated=true`; integer vs real tolerance termination.
  - reference-axis test: `root-not-overloaded` boundary finds a finite `R*`, `margin` is computed
    against `cap_promote`, and the result is byte-identical across two runs (determinism).
- Run `yarn build` (strict tsc) and `yarn test` in `packages/substrate-simulator`, streaming output
  (`2>&1 | tee /tmp/envelope-core.log`); both clean/green before handoff.
