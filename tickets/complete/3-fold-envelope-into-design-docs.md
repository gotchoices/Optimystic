description: Each subsystem design doc now states, per guarantee, the measured condition at which it breaks and how much margin the design has before it gets there; a fresh simulator run confirmed every written number and the one negative-margin caveat is stated honestly.
files:
  - docs/cohort-topic.md          (### Operating envelope, under ## Configuration)
  - docs/reactivity.md            (### Operating envelope, under ## Configuration)
  - docs/matchmaking.md           (### Operating envelope, under ## Configuration)
  - docs/architecture.md          (Doc Sync Status — Simulator validation column/cells)
  - packages/substrate-simulator/src/boundary*.ts           (the envelope finder + the five axis drivers)
difficulty: medium
----

# Complete: fold the validity-envelope boundaries into the design docs

Docs-only fold-back. The four boundary tickets (`simulator-envelope-tree`/`-churn`/`-reactivity`/
`-matchmaking`, plus the `-reference` axis) produce `EnvelopeBoundary[]` with measured critical values +
margins; the implement stage wrote each one into the spec beside the claim it bounds, as an
`### Operating envelope` subsection under `## Configuration` in cohort-topic.md, reactivity.md, and
matchmaking.md, and extended the architecture.md Doc Sync Status "Simulator validation" cells to note the
envelope is now documented. No code changed.

## Review findings

The numbers are the product here, so the review re-derived **every** edge from the committed simulator
rather than trusting the handoff tables, then checked the surrounding prose, constants, configs, and
cross-references. Method: a throwaway `_rederive.ts` in `packages/substrate-simulator/` imported the five
drivers from `./src/index.js` and ran them with their committed defaults under the package's ts-node
loader (`node --import ./register.mjs`); the script was removed after. All five drivers are deterministic
from `(seed, config)`.

### Numbers — re-derived, all match (the core check)

Every one of the ten documented edges reproduced **byte-for-byte** against the committed simulator (the
doc rounds editorially; the raw bisected values are shown):

| Claim × axis | Doc edge | Re-derived `criticalValue` | Margin | Flags |
|---|---|---|---|---|
| `root-not-overloaded` × R | 666 | 666 | +602 (×10.40625) | found, !violated |
| depth-law × prefix-skew s | 0.042 | 0.0419921875 | +0.042 (NaN ratio) | found, !violated |
| promotion-demotion-stable × churn r | 0.499 | 0.4990234375 | +0.499 | found, !violated |
| no-give-ups ∧ hop-bound × unwilling f | 0.479 | 0.4794921875 | +0.479 | found, !violated, breach=hop-bound |
| no-lost-registrations × kill k | 0.249 | 0.2490234375 | +0.249 | found, mechanism=backup-exhaustion |
| heal-convergence × partition σ | 0.312 | 0.3115234375 | +0.312 | found, 87.5% converge, healedEpoch≠pre |
| revision-continuity × cps | 72.5 | 72.52003 | +62.5 (×7.252) | found, layeredCoverage=60.011s, kind=OutOfWindow |
| completes-within-drain × ratio | <1.0 | 1.0000122 | +0.5 (×2.0) | found, viaFanout=true, lastArrival=60105ms |
| bounded-harm × lying f | 0.187 | 0.1865234375 | +0.187 | found, mechanism=match-failure, tiers=2, staticHoldsAt f=1 |
| hang-out-fairness × ρ | 2.5 | 2.5 | **−0.5** | found, **insideEnvelope=false**, exactContention=3.5<cap4, refinementWarranted |

- All ten: `boundaryFound = true`, `monotoneViolated = false` — confirmed. No axis held to its scan cap,
  so the `boundaryFound = false` lower-bound case did not arise (consistent with the handoff).
- `marginRatio` is `NaN` for exactly the **six** axes whose design assumption is 0 (prefix-skew, churn,
  unwilling, kill, heal, bounded-harm) — the doc states the absolute margin there, as intended.
- Replay-only edge `replayOnlyEdgeCps = 4.2667` = `W/gap = 256/60`, matching the doc's `cps ≈ 4.27`
  *below* the nominal 10 cps — the adaptive-`W` motivation.

### Constants & configs — verified against source (not fabricated)

- **Layered-bound consistency (the claim most worth distrusting).** `classifyResume`
  (`reactivity.ts:318-329`) cuts to `OutOfWindow` at `lag ≥ W + Wcheckpoint`; `DEFAULT_REACTIVITY_CONFIG`
  has `W = 256`, `Wcheckpoint = 4096` → 4352. Measured `cps* = 72.52 → 72.52·60 ≈ 4351` revisions sits
  just under 4352. The doc's "**agrees**" wording is accurate — the single-bound discrepancy the prior
  fold-back flagged is gone (the `reactivity-resume-classifier-layered-bound` fix has landed).
- Tree/lifecycle caps: `capPromote = 64`, `capPromoteFast = 32`, `capDemote = 16` (= cap/4, the "4× cap
  gap"), `F = 16` — all in `DEFAULT_LIFECYCLE_CONFIG`. Matchmaking `contentionFactorCap = 4.0` →
  `cap − 1 = 3`, and `exactContentionAtEdge = 3.5 < 4` confirms the misfire precedes cap saturation.
  Rejoin/drain `tRejoinJitterMs = 30_000` / `tDrainMs = 60_000` = 0.5 shipped ratio.
- Driver config context the doc cites for reproduction all match committed defaults: reference/tree
  `N = 2000, F = 16, capPromote = 64`, walk `walkSamples = 100`; kill `memberCount = 20,
  participantCount = 80, ttl = 90_000` (ping `ttl/3`); partition `memberCount = 16, participantCount = 64`;
  drain `subscriberCount = 2000`; matchmaking `landingTier = 8, wantCount = 8, patienceMs = 10_000`.

### Prose, placement, cross-refs — checked

- **Negative margin (matchmaking `ρ* = 2.5 < cap−1 = 3`).** Stated plainly with
  `designInsideEnvelope = false`. The reconciliation with §Worked example is **honest and
  non-contradictory**: the flip at ρ*=2.5 is in the un-capped regime (exact contention 3.5 < cap 4), so
  it does not undercut the existing "keep the cap a global scalar" finding — which itself already
  references `matchmaking-contention-from-seeker-pool` (matchmaking.md:415) as the tracked refinement the
  envelope's negative margin motivates. Different questions, both about the un-capped regime, as the doc
  says.
- **Thin prefix-skew margin (`s* = 0.042`).** Framed honest-not-alarmist: peer-ID prefixes are ~uniform
  so the operating point is `s ≈ 0`; the ~4% margin is explicitly about adversarial/pathological prefix
  concentration, and the text says the depth law is "not robust" to that — accurate, not over-stated.
- **Placement & cross-refs.** Each `### Operating envelope` sits under `## Configuration` (cohort-topic
  before §Per-tier overrides, reactivity before §Edge profile, matchmaking before §Worked scenarios).
  All referenced section anchors resolve (§Why this distributes naturally, §Hysteresis, §Failure modes
  → Recovery time bounds / Network partition healing, §Willingness, §Anti-flood, §Tier addressing,
  §Promotion and demotion lifecycle, §Replay window, §Resume, §Parent checkpoint summaries, §Tail
  rotation, §Adversarial cohort traffic reporting, §Hang-out vs. continue → Decision rule, §Worked
  example). New subsections do not duplicate the existing "Simulator-validated"/"Defaults validated"
  callouts — they add the margin framing beside them.

### Validation

- `yarn build` (substrate-simulator) — **clean** (exit 0).
- `yarn test` (substrate-simulator) — **257 passing** (17s), exit 0. Unchanged by a docs-only ticket, as
  expected.
- No root/package lint config exists for substrate-simulator (no `.eslintrc`/`eslint.config.*`); nothing
  to lint, and a Markdown-only diff has no lintable surface.
- Full-monorepo `yarn build`/`yarn test` not run: a docs-only change touches no other package and the
  long wall-clock isn't agent-runnable. `git diff` for commit `a8939f9` confirms only `docs/*.md` (plus
  ticket board moves) changed code-wise.

### Findings disposition

- **Major (new tickets):** none. Re-derivation surfaced no new code/UX issue and no wrong doc number.
  The two design-gap signals the envelope quantifies are already tracked
  (`matchmaking-contention-from-seeker-pool` for the −0.5 margin,
  `matchmaking-per-tier-patience-splitting` for `f* = 0.187`), both already referenced in matchmaking.md;
  the layered-bound fix already landed.
- **Minor (fixed inline):** none required. Every number is correct, every cross-reference resolves, the
  framing is honest, and the build/tests are green — there was nothing to correct without inventing
  churn. Explicitly: no numeric edits, no prose edits, no constant corrections were warranted.
- **Observation (no action, not this ticket's to fix):** the implement commit `a8939f9` also added
  `tickets/backlog/crypto-cid-v1-content-identifier.md`, a genuine but **unrelated** backlog ticket
  (self-describing content identifiers for `quereus-plugin-crypto`) — a concurrent human board move swept
  into the commit by the runner. It is not a product of this ticket's work and, per the "never sanitize
  the working tree" rule, was left untouched. Flagged here only so the trail is honest.

## Outcome

- Each subsystem doc states, per guarantee, the breaking condition + margin to the operating point,
  framed as the justification for the default it bounds (`cap_promote`, `F`/depth law, `T_demote`,
  `backups`/`ttl`, `W`/adaptive-`W`, `T_drain`, `patience`, `contention_factor_cap`).
- The one negative margin (matchmaking hang-out-fairness, `ρ* = 2.5`) is stated plainly, not papered over.
- architecture.md Doc Sync Status "Simulator validation" reflects claims **+ operating envelope** for all
  three subsystems.
- Review re-derived all ten edges from the committed simulator — **all match**. Build clean;
  substrate-simulator suite green at **257 passing**.
