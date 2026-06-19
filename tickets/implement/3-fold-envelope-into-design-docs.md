<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-19T05:50:25.482Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\3-fold-envelope-into-design-docs.implement.2026-06-19T05-50-25-482Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Write the measured operating limits back into the design docs — for each subsystem, add a short "operating envelope" section stating, per guarantee, the condition at which it breaks and how much margin the design has before it gets there.
prereq: simulator-envelope-tree, simulator-envelope-churn, simulator-envelope-reactivity, simulator-envelope-matchmaking
files:
  - docs/cohort-topic.md
  - docs/reactivity.md
  - docs/matchmaking.md
  - docs/architecture.md          (Doc Sync Status, if an envelope column is warranted)
  - packages/substrate-simulator/src/boundary.ts            (EnvelopeBoundary — the source data)
  - packages/substrate-simulator/src/sweep.ts               (recordBoundary readouts)
  - tickets/complete/7-fold-simulator-findings-into-design-docs.md  (the pattern to mirror)
difficulty: medium
----

# Fold the validity-envelope boundaries back into the design docs

Docs-only fold-back (parent: `simulator-validity-envelope`, §Expected artifact & fold-back), mirroring
the completed `fold-simulator-findings-into-design-docs`. The four subsystem boundary tickets produce
`EnvelopeBoundary[]` with measured critical values and margins; this ticket states them in the design
specs as an explicit **Operating envelope** subsection per subsystem, so the docs say not just "depth
== 4" but "the depth law holds for `R < R*`, churn `< C*`, prefix-skew `< s*`, …".

This is the absolute-target / fold-back validation mode (parent ticket §Three validation modes, mode
1) consuming the boundary mode's output: re-derive every margin from the committed simulator, then
write it into the doc beside the claim it bounds.

## What to add, per subsystem

For each measured boundary, add (in the relevant doc section, beside the existing claim) a line of the
form: **claim** holds for **axis** `< criticalValue` (margin **margin** to the assumed operating point
**designAssumption**). Use the actual measured numbers from a fresh simulator run — do not copy any
illustrative numbers from the boundary tickets (those are placeholders).

- **cohort-topic.md** — Operating envelope for: `root-not-overloaded` / depth-law vs arrivals-per-round
  `R*` (from `simulator-envelope-core`); depth-law vs prefix-skew `s*`; promotion/demotion stability
  vs churn `C*`; walk `no-give-ups` / hop-bound vs unwilling-fraction `f*`; and the churn failure-mode
  boundaries `no-lost-registrations` vs kill-rate `k*` and `heal-convergence` vs partition-severity
  `σ*`. Each margin is the principled justification for the default it bounds (`cap_promote`, `F`,
  `T_demote`, `ttl`).
- **reactivity.md** — Operating envelope for: `revision-continuity` vs commit-rate `cps*` (justifying
  `W` / the adaptive-W recommendation) and tail-rotation drain vs `T_rejoin_jitter/T_drain` ratio*.
- **matchmaking.md** — Operating envelope for: bounded-harm vs lying-reporter fraction `f*` (justifying
  `patienceMs` / the `+1 hop/tier` structure) and hang-out fairness vs seeker:provider ratio `ρ*`
  (justifying `contention_factor_cap = 4`, and stating whether the deferred exact-sum refinement is
  needed).
- **architecture.md** — if the Doc Sync Status table has (or should gain) an envelope/validation
  column, flip it to reflect that the operating envelope is now documented for each subsystem; mirror
  how `7-fold-simulator-findings-into-design-docs` flipped the simulator-validation column.

## Edge cases & interactions

- **Re-derive, don't transcribe.** Run the committed boundary modules (`runScaleSweep`-style entry
  points / `findBoundary` per axis) and read the actual `criticalValue`/`margin`/`marginRatio`; the
  boundary tickets' table numbers are illustrative and must not be copied into the docs.
- **Negative-margin honesty.** If any boundary reports `designInsideEnvelope = false` (the design point
  already fails — e.g. the `cold-start-storm-default-claim-semantics` cumulative-overshoot case), state
  it plainly as a known operating-point caveat with the negative margin, exactly as the prior fold-back
  handled the cold-start 122-vs-64 case. Do not paper over it.
- **`boundaryFound = false` (held to the scan cap).** Where a claim held across the entire scanned
  range, document the margin as "`≥ scanHi`" (a lower bound), never as an exact or unbounded edge.
- **Layered-bound consistency.** The reactivity `cps*` must be stated against the same layered resume
  bound (`W + W_checkpoint`) reactivity.md is authoritative on (`reactivity-resume-classifier-layered-
  bound`); flag if the simulator path and the doc disagree.
- **Docs-only.** No code changes (matching the prior fold-back's discipline). If re-derivation surfaces
  a simulator-code/UX issue, file a `backlog/` or `fix/` ticket rather than fixing inline; if it
  surfaces a doc accuracy error in an existing number, that is in-scope to correct.
- **Suite stays green.** Confirm `yarn build` + `yarn test` are clean/green (unchanged by a docs-only
  ticket) and record the passing count, mirroring the prior fold-back's review.

## TODO

- Re-derive every boundary's `criticalValue` / `margin` from the committed simulator (throwaway entry
  scripts removed after use, as the prior fold-back did).
- Add the **Operating envelope** subsection to each of cohort-topic.md, reactivity.md, matchmaking.md
  with the measured per-claim edges + margins, framed as the justification for each bounded default.
- Update architecture.md Doc Sync Status if an envelope column is warranted.
- State negative-margin / held-to-cap cases honestly; file follow-up tickets for any code/UX issues
  surfaced (do not fix inline).
- Confirm build clean + suite green (streamed via `tee`); record the passing count in the handoff.
