description: Review the design simulator's new "stress until a guarantee breaks" measurement — a generic harness that drives one worsening condition upward until a design claim stops holding, plus the first real claim wired into it (how many arrivals per round the topic tree can absorb before it stops reaching its predicted depth).
prereq:
files:
  - packages/substrate-simulator/src/boundary.ts            (generic finder — pre-existing, landed with simulator-envelope-tree)
  - packages/substrate-simulator/src/boundary-reference.ts  (NEW — the reference axis this ticket added)
  - packages/substrate-simulator/test/boundary.spec.ts      (synthetic harness tests + NEW reference-axis tests)
  - packages/substrate-simulator/src/index.ts               (barrel exports)
  - packages/substrate-simulator/src/promotion-convergence.ts (runConvergence — the reference axis driver)
  - packages/substrate-simulator/README.md                  (validity-envelope module list)
difficulty: medium
----

# Review: validity-envelope harness + reference boundary

This is the foundation ticket of the validity-envelope family (parent `simulator-validity-envelope`):
the generic boundary/envelope finder **plus** one real, cheap reference axis that proves it end-to-end.

## What the reviewer needs to know about the starting state (important)

This ticket landed in an unusual order. The **generic harness** it was specced to create
(`boundary.ts` + `boundary.spec.ts`'s synthetic tests) was already committed by the sibling
`simulator-envelope-tree` ticket (commit `a37cd6e`), which needed `findBoundary` to exist and so
built it itself, treating the prereq as landed. All four sibling `boundary-*` modules carry a comment
that explicitly defers the `root-not-overloaded` reference axis back to *this* core ticket. So the only
piece genuinely outstanding when this run began was that **reference axis** — the generic finder was
done and correct.

What this run added:
- `src/boundary-reference.ts` (NEW) — `rootOverloadAxis(...)` + `runReferenceBoundary(...)`.
- `test/boundary.spec.ts` — a new `runReferenceBoundary` describe block (4 tests).
- `src/index.ts` — exports for the new surface.
- `README.md` — completed the validity-envelope module enumeration (added reference + reactivity).

The generic `boundary.ts` and the synthetic `findBoundary`/`recordBoundary` tests are unchanged by this
run; they should still be reviewed as part of the core deliverable (they match the ticket's interface
spec — `EnvelopeBoundary` fields, the three explicit open-bracket cases, integer/real resolution,
decreasing-harm reflected branch).

## Why the reference axis lives in `boundary-reference.ts`, not `boundary.ts`

The ticket gave two directives in tension: "implement the reference axis in this ticket" **and** "do not
bake any tree/reactivity/matchmaking specifics into `boundary.ts` — keep the `holds` callback the only
extension point." The reference axis *is* a tree specific (it drives `runConvergence`), so putting it in
`boundary.ts` would violate the generic-harness constraint and the existing committed structure (where
`boundary.ts` is clean and each subsystem gets its own `boundary-<x>.ts`). It was placed in a sibling
module `boundary-reference.ts`, mirroring `boundary-tree.ts` exactly. **Flag for the reviewer:** confirm
this resolution is acceptable; the alternative (inlining into `boundary.ts`) was rejected on that basis.

## The reference axis — semantics

`root-not-overloaded` × `arrivalsPerRound`, driven by `runConvergence({ lookahead: false })`.

`holds(R)` returns `(peakOvershoot ≤ R) ∧ (steadyStateDepth === ⌈log_F(N/cap)⌉)`:
- **`peakOvershoot ≤ R`** is the one-round admission-buffer invariant. Empirically it is *structurally
  satisfied for every R by this driver* (the convergence fold-back established `peakOvershoot < R`), so
  it never drives the edge — it is carried as an explicit sanity guard, per the ticket's AND-semantics.
- **`steadyStateDepth === law`** is the *active* edge driver. As `R` grows, a larger gossip-lagged burst
  piles onto the still-cold root before promotion cascades, so an ever-larger fraction never routes
  deeper and the tree settles shallow. Depth first drops below the law at `R*`.

`designAssumption = cap_promote` (64); `margin = R* − cap_promote`, a **measured** output (not hard-coded).

### Empirically observed behavior (default N = 2000, expected depth 2, F = 16, cap = 64)

Verified with a throwaway probe over `runConvergence` (since removed):
- depth == 2 for R ≤ 664, then drops to 1 (R ≥ 672) and to 0 at R = N (single-round burst). So
  `R* ≈ 664`, `margin ≈ 600`, `designInsideEnvelope = true`, `boundaryFound = true`.
- The finder makes ~18 `runConvergence` evaluations (geometric bracket 8→16→…→1024→2000 then bisection),
  ~117 ms for the whole boundary. Logarithmic, as required.

### KNOWN WRINKLE — the axis is not *globally* monotone (please scrutinize)

There is an **isolated single-R depth dip at R ≈ 504** (depth 1 at 504, but 2 at both 496 and 512) — an
arrival/round interleaving artifact, *well below* the located edge (~664). It does **not** affect the
result because the geometric scan steps only the doubling sequence (…, 512, 1024) and the bisection
stays inside the `[512, 1024]` bracket, so 504 is never probed and `monotoneViolated` stays `false`.
But the axis is therefore not monotone over the full `[lo, hi]` range. Reviewer should decide whether
this is acceptable for a "reference" axis or whether the predicate/range deserves hardening (e.g. a
floor above any dip, or asserting monotonicity over the bracket). The tests assert `monotoneViolated
=== false` for the default config, which passes, but that is config-dependent.

## Validation performed

- `yarn build` (strict tsc) in `packages/substrate-simulator` — **clean (exit 0)**.
- `yarn test` full suite — **242 passing (15s)**, including:
  - `no-real-time.spec` (scans `src/` for wall-clock/rng/async tokens — passes over the new module),
  - `determinism.spec`,
  - the 11 pre-existing synthetic harness tests in `boundary.spec.ts`,
  - the 4 new reference-axis tests.

## Test floor (treat as a floor, not a ceiling) — use cases worth probing

Covered:
- Reference boundary finds a finite `R*`; `boundaryFound`, `designInsideEnvelope`, `monotoneViolated=false`.
- `margin === criticalValue − cap_promote`, `marginRatio === criticalValue / cap_promote`, `criticalValue > cap`.
- Determinism: two `runReferenceBoundary()` runs are deep-equal and produce byte-identical `exportJson`.
- Metrics fold: `boundary.criticalValue` histogram keyed by `(claim, axis)`.
- N-gating: `runReferenceBoundary({ N: 200_000, referenceSampleMaxN: 100_000 })` → `skipped=['arrivalsPerRound']`, no boundary, `boundary.skipped` counter recorded.

Gaps / not covered (candidate review probes):
- The reference axis is exercised at **one** config only (N=2000, F=16, cap=64). Behavior at larger N
  (opt-in, gated) or different F/cap is unverified — the depth-collapse edge is *plausibly* similar but
  not pinned. Worth a spot check at e.g. N=10k (expected depth 2 still) to confirm `R*`/monotonicity.
- The non-monotone dip (above) is config-dependent; a different `lo`/`N` could in principle place a dip
  on a scan/bisection probe and flip `monotoneViolated`. No test guards against that.
- `decreasing-harm` is only synthetically tested (per the ticket — increasing-harm is the live path).
- Determinism is checked in-process (deep-equal + exportJson); cross-process byte identity rests on the
  existing `no-real-time`/`determinism` guarantees, not re-verified here.
- `marginRatio` is deliberately **not** folded into `Metrics` (it is `NaN` when `designAssumption===0`,
  which would serialize to `null`); confirm that omission is intended for downstream `fold-envelope-into-design-docs`.

## Downstream

`3-fold-envelope-into-design-docs` consumes `EnvelopeBoundary[]` (and the per-subsystem runners,
including `runReferenceBoundary`) to write the **Operating envelope** subsections into the design docs.
No interface changes were made to the generic surface, so the four sibling `boundary-*` modules are
unaffected.
