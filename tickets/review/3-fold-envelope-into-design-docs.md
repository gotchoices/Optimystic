description: Each subsystem design doc now states, per guarantee, the measured condition at which it breaks and how much margin the design has before it gets there — review that the written numbers match a fresh simulator run and that the one negative-margin caveat is stated honestly.
files:
  - docs/cohort-topic.md          (### Operating envelope, under ## Configuration)
  - docs/reactivity.md            (### Operating envelope, under ## Configuration)
  - docs/matchmaking.md           (### Operating envelope, under ## Configuration)
  - docs/architecture.md          (Doc Sync Status — Simulator validation column/cells)
  - packages/substrate-simulator/src/boundary.ts            (findBoundary / EnvelopeBoundary — the harness)
  - packages/substrate-simulator/src/boundary-reference.ts  (root-not-overloaded vs R)
  - packages/substrate-simulator/src/boundary-tree.ts       (prefix-skew, churn, unwilling-fraction)
  - packages/substrate-simulator/src/boundary-churn.ts      (kill-rate, partition-severity)
  - packages/substrate-simulator/src/boundary-reactivity.ts (continuity-cps, drain-ratio)
  - packages/substrate-simulator/src/boundary-matchmaking.ts (lying-fraction, seeker:provider ratio)
difficulty: medium
----

# Review: fold the validity-envelope boundaries into the design docs

Docs-only fold-back. The four boundary tickets (`simulator-envelope-tree`/`-churn`/`-reactivity`/
`-matchmaking`, plus the `-core` reference axis) produce `EnvelopeBoundary[]` with measured critical
values + margins; this ticket wrote each one into the spec **beside the claim it bounds**, as an
`### Operating envelope` subsection under `## Configuration` in cohort-topic.md, reactivity.md, and
matchmaking.md, and extended the architecture.md Doc Sync Status "Simulator validation" column to note
the envelope is now documented. Mirrors the completed `7-fold-simulator-findings-into-design-docs`.

**No code changed.** Build clean; substrate-simulator suite green at **257 passing** (16s) — unchanged
by a docs-only ticket (was 195 before the four boundary tickets added the envelope test files).

## What a reviewer should re-verify (numbers are the product here)

Every number below was **re-derived from the committed simulator**, not copied from the (illustrative)
boundary-ticket tables. To reproduce: drop a throwaway `.ts` in `packages/substrate-simulator/` that
imports the driver entry points from `./src/index.js` and run it with the package's ts-node loader —
`node --import ./register.mjs <script>.ts` (the prior fold-back used the same loader; remove the script
after). The five drivers, all deterministic from `(seed, config)` with their committed defaults:

| Driver (`src/index.ts`) | Claim × axis | Edge (criticalValue) | Design pt | Margin | Notes |
|---|---|---|---|---|---|
| `runReferenceBoundary` | `root-not-overloaded` / depth-law × arrivals-per-round `R` | **666** | 64 (`cap_promote`) | **+602** (≈10.4×) | boundaryFound, lookahead off |
| `runTreeBoundaries` | depth-law × prefix-skew `s` | **0.042** | 0 | **+0.042** | thin margin (honest caveat) |
| `runTreeBoundaries` | promotion/demotion-stable × churn `r` | **0.499** | 0 | **+0.499** | `T_demote` shortened so demotion reachable |
| `runTreeBoundaries` | `no-give-ups` ∧ hop-bound × unwilling-frac `f` | **0.479** | 0 | **+0.479** | breach = **hop-bound**, not give-up |
| `runChurnBoundaries` | `no-lost-registrations` × kill-rate `k` | **0.249** | 0 | **+0.249** | mechanism = **backup-exhaustion** |
| `runChurnBoundaries` | `heal-convergence` × partition-severity `σ` | **0.312** | 0 | **+0.312** | edge: 87.5% converge, `healedEpoch≠pre` |
| `runReactivityBoundaries` | `revision-continuity` × commit-rate `cps` | **72.5** | 10 (nominal) | **+62.5** (≈7.25×) | layered `W+W_checkpoint=4352` |
| `runReactivityBoundaries` | `completes-within-drain` × rejoin/drain ratio | **1.0** | 0.5 (shipped) | **+0.5** (2×) | drains via fast-promote fan-out |
| `runMatchmakingBoundaries` | `bounded-harm` × lying-frac `f` (per-query-flip) | **0.187** | 0 | **+0.187** | edge mechanism = match-failure |
| `runMatchmakingBoundaries` | `hang-out-fairness` × seeker:provider `ρ` | **2.5** | 3 (`cap−1`) | **−0.5** | **NEGATIVE** — see below |

All ten edges have `boundaryFound = true` and `monotoneViolated = false`; **no axis held to its scan
cap**, so no "`≥ scanHi`" lower-bound cases arose (the ticket's `boundaryFound = false` edge case did
not occur). `marginRatio` is `NaN`/omitted wherever the design assumption is 0 (six of ten) — the doc
states the absolute margin there, as intended.

## Points that most need an adversarial eye

- **The negative margin (matchmaking `hang-out-fairness`, `ρ* = 2.5 < cap−1 = 3`, margin −0.5).** This
  is the honest negative-margin case the ticket called out (analogue of the prior fold-back's
  cold-start 122-vs-64). matchmaking.md now states it plainly with `designInsideEnvelope = false`.
  **Verify the consistency claim:** the new text asserts this does **not** contradict the existing
  §Worked example callout ("the exact-`Σ wantCount` refinement only flips in the un-capped regime …
  per-tier cap buys nothing"). The reconciliation: the flip at `ρ* = 2.5` is itself in the regime where
  exact contention (3.5) is still **below** the cap (4), so both statements are about the un-capped
  regime — the existing callout is about cap *globality*, the envelope is about the decision *divergence
  window* `2.5 ≤ ρ < 3`, which is the principled signal that `matchmaking-contention-from-seeker-pool`
  (already a referenced backlog ticket) is warranted. Confirm this framing reads as non-contradictory.
- **Layered-bound consistency (reactivity `cps*`).** The ticket required `cps*` be stated against the
  same layered `W + W_checkpoint` bound reactivity.md §Parent checkpoint summaries is authoritative on,
  and to flag any simulator/doc disagreement. **They agree:** `classifyResume` (reactivity.ts:323-329)
  cuts to `OutOfWindow` at `lag ≥ W + W_checkpoint = 4352`, and the measured `cps* = 72.52` → ≈4351
  revisions sits just under 4352 — i.e. the `reactivity-resume-classifier-layered-bound` fix has landed
  and the single-bound discrepancy the prior fold-back noted is gone. Worth a spot-check that the doc's
  "agrees" wording is accurate. The replay-only edge (`cps ≈ 4.27`, *below* nominal 10) is stated as the
  conservative bound and tied to the adaptive-`W` finding.
- **The thin prefix-skew margin (`s* = 0.042`).** Framed as a deliberate honest caveat: the depth law
  is exact under uniform `sha256` sharding but only ~4% prefix concentration adds a tier. Check the
  framing is honest-not-alarmist — peer-ID prefixes are ~uniform in practice, so the operating point is
  `s ≈ 0`; the margin is about adversarial/pathological concentration, which the text says.
- **Placement.** Each `### Operating envelope` sits under `## Configuration` (next to the defaults the
  margins justify), cross-referencing the section each claim lives in (§Why this distributes naturally,
  §Hysteresis, §Failure modes, §Replay window, §Tail rotation, §Hang-out, §Adversarial reporting).
  Confirm the cross-refs resolve and nothing duplicates the existing "Defaults validated by simulator"
  callouts.

## Known gaps / honesty notes

- **Validation scope.** Only `packages/substrate-simulator` build + test were run (clean; 257 passing).
  A docs-only change touches no other package, so the full monorepo `yarn build`/`yarn test` was not run
  (long wall-clock, nothing else changed) — a reviewer wanting belt-and-suspenders can `git diff --stat`
  to confirm only `docs/*.md` changed.
- **No follow-up tickets filed.** Re-derivation surfaced no *new* code/UX issue. The two design-gap
  signals it quantified are already tracked: `matchmaking-contention-from-seeker-pool` (the negative
  margin) and `matchmaking-per-tier-patience-splitting` (the `f* = 0.187` bound) are both already
  referenced in matchmaking.md; the layered-bound fix already landed. No existing doc *number* was found
  wrong, so no in-scope numeric corrections were made.
- **Determinism caveat for re-verification.** Edges are bisected to integer/real tolerance; the doc
  rounds (e.g. `s* = 0.0419921875 → 0.042`, `σ* = 0.3115234375 → 0.312`). A reviewer re-running with the
  committed defaults should get byte-identical raw values; only the rounding is editorial.

## Outcome

- Each subsystem doc now states, per guarantee, the breaking condition + margin to the operating point,
  framed as the justification for the default it bounds (`cap_promote`, `F`/depth law, `T_demote`,
  `backups`/`ttl`, `W`/adaptive-`W`, `T_drain`, `patience`, `contention_factor_cap`).
- The one negative margin is stated plainly, not papered over.
- architecture.md Doc Sync Status "Simulator validation" reflects claims **+ operating envelope** for
  all three subsystems.
- Build clean; substrate-simulator suite green at **257 passing**.
