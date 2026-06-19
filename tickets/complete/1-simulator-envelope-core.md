description: Reviewed and completed the design simulator's "stress until a guarantee breaks" measurement — a generic harness that drives one worsening condition upward until a design claim stops holding, plus the first real claim wired into it (how many arrivals per round the topic tree can absorb before it stops reaching its predicted depth).
prereq:
files:
  - packages/substrate-simulator/src/boundary.ts            (generic finder — pre-existing, reviewed as core deliverable)
  - packages/substrate-simulator/src/boundary-reference.ts  (the reference axis this ticket added)
  - packages/substrate-simulator/test/boundary.spec.ts      (synthetic harness tests + reference-axis tests; +1 second-config test added in review)
  - packages/substrate-simulator/src/index.ts               (barrel exports)
  - packages/substrate-simulator/src/promotion-convergence.ts (runConvergence — the reference axis driver)
  - packages/substrate-simulator/README.md                  (validity-envelope module list)
difficulty: medium
----

# Complete: validity-envelope harness + reference boundary

Foundation ticket of the validity-envelope family (parent `simulator-validity-envelope`): the generic
boundary/envelope finder (`boundary.ts`, already committed by sibling `simulator-envelope-tree`) plus
the one real reference axis this ticket owned — `root-not-overloaded` × `arrivalsPerRound`, driven by
`runConvergence`, in `boundary-reference.ts`.

## Review findings

Adversarial pass over the implement diff (`da50382`) and every file it touched, read before the handoff.

### What was checked

- **Generic harness (`boundary.ts`)** — re-read as part of the core deliverable. `findBoundary`'s
  harm-ascending scan, geometric vs linear bracket (`LINEAR_INT_THRESHOLD`), integer/real bisection,
  the three open-bracket cases (fail-at-floor → negative margin; held-to-ceiling → `boundaryFound=false`
  lower bound; non-monotone → `monotoneViolated=true` with first-fail edge still returned), the
  decreasing-harm reflection, and `recordBoundary`'s `(claim, axis)` metric fold. Matches the ticket's
  interface spec; no defects.
- **Reference axis (`boundary-reference.ts`)** — `rootOverloadAxis` / `runReferenceBoundary`. Verified
  the `holds(R)` AND-semantics, the `cap_promote` margin reference, the N-gate, and that every
  `runConvergence` arg passed is valid.
- **Structural decision** (flagged for reviewer): placing the reference axis in a sibling
  `boundary-reference.ts` rather than inlining into `boundary.ts`. **Confirmed correct.** `boundary.ts`
  stays generic (the `holds` callback its only extension point) and the new module mirrors
  `boundary-tree.ts` byte-for-byte in shape (same `boundary.js` imports, same `findBoundary`/
  `recordBoundary` pattern, same docstring style). All three sibling modules (`-tree`, `-churn`,
  `-reactivity`) carry deferral comments pointing the reference axis back to this ticket; that contract
  is now fulfilled. The rejected alternative (inlining) would have violated the generic-harness
  constraint and the established structure.
- **Empirical claims** — re-verified independently with a throwaway probe over `runConvergence` (since
  removed). Confirmed: N=2000 expected depth 2; edge `R* ≈ 665` (depth 2 holds through 665, drops to 1
  by 672, to 0 at R=N); finder makes ~18 evaluations (logarithmic). The handoff's numbers hold.
- **The known non-monotone dip** — confirmed empirically: at N=2000, depth dips to 1 at the single point
  R=504 while both R=496 and R=512 hold at depth 2 (an arrival/round interleaving artifact, well below
  the ~665 edge). The geometric scan probes 512/1024 and bisection stays in `[512,1024]`, so 504 is
  never probed and `monotoneViolated` correctly stays `false`. The result is unaffected and the harness
  honestly reports the flag.
- **Build + tests** — `yarn build` (strict tsc) clean (exit 0); `yarn test` green
  (243 passing after the review addition), including `no-real-time.spec` and `determinism.spec` scanning
  the new module.

### What was found and done

- **Minor — coverage gap (the axis was exercised at exactly one config):** fixed inline. Added a
  second-config regression test (`N=10000`) to `boundary.spec.ts`. It pins `boundaryFound=true`,
  `monotoneViolated=false`, `criticalValue > cap`, and the margin identity at a config away from the
  default. I verified N=10000 finds a clean edge (`criticalValue=4999`, 24 evals, `monotoneViolated=false`,
  ~1.2 s) — so the located edge and the dip-stays-off-the-probes property are not specific to N=2000.
  This directly hardens the previously-unguarded "a different config could place a dip on a probe and
  flip `monotoneViolated`" concern by demonstrating a second clean point.
- **Accepted with reason — the non-monotone dip itself:** not a defect, no ticket filed. The dip is a
  property of the underlying `runConvergence` driver (a subsystem outside this ticket's deliverable),
  not the boundary harness or the reference module. The harness exists precisely to flag such cases via
  `monotoneViolated`, and a sampling-based O(log n) finder cannot guarantee *global* monotonicity without
  exhaustive probing that would defeat its cost contract. The shipped config is correct and now verified
  clean at two configs. Forcing global monotonicity on the driver would be chasing an artifact for no
  measurement benefit.
- **Accepted with reason — vacuous `peakOvershoot ≤ R` clause:** the convergence driver guarantees
  `peakOvershoot < R` structurally (re-confirmed: overshoot ≤ R at every probed point), so the first
  AND-clause never drives the edge. This is intentional and documented as an explicit sanity guard per
  the ticket's AND-semantics; depth is the active driver. No change.
- **Accepted with reason — `marginRatio` not folded into `Metrics`:** intentional. It is `NaN` when
  `designAssumption === 0` (serializes to `null`); the omission is consistent with `boundary.ts`'s own
  `recordBoundary` and is fine for downstream `fold-envelope-into-design-docs`, which reads the
  `EnvelopeBoundary[]` objects directly (where `marginRatio` is present), not the metric sink.
- **Accepted — `decreasing-harm` synthetically tested only:** per the ticket, increasing-harm is the
  live path; the reflected branch is covered by the synthetic harness tests. No change.
- **Accepted — cross-process byte identity not re-verified:** determinism is checked in-process
  (deep-equal + `exportJson`); cross-process identity rests on the existing `no-real-time`/`determinism`
  guarantees, which still pass over the new module. No change.

### Empty categories

- **No major findings** → no new `fix`/`plan`/`backlog` tickets were filed. Every finding was either
  fixed inline (the second-config test) or accepted with the reasoning above.

## Downstream

`3-fold-envelope-into-design-docs` consumes `EnvelopeBoundary[]` and the per-subsystem runners
(including `runReferenceBoundary`) to write the **Operating envelope** subsections. No interface changes
were made to the generic surface during review; the four sibling `boundary-*` modules are unaffected.
