description: Folded simulator-measured results back into cohort-topic.md, reactivity.md, matchmaking.md, and architecture.md so every quantitative claim is confirmed-with-evidence or explicitly revised. Docs-only. Reviewed: all headline numbers re-validated against the simulator (build clean, 195 passing); one accuracy finding (lookahead overshoot characterization) fixed inline; one latent simulator-code issue filed to backlog.
files: docs/cohort-topic.md, docs/reactivity.md, docs/matchmaking.md, docs/architecture.md, packages/substrate-simulator/src/scenarios.ts, packages/substrate-simulator/src/sweep.ts, packages/substrate-simulator/src/reactivity.ts, packages/substrate-simulator/src/promotion-convergence.ts, packages/substrate-simulator/src/matchmaking.ts, tickets/fix/reactivity-resume-classifier-layered-bound.md, tickets/backlog/cold-start-storm-default-claim-semantics.md
----

# Fold simulator findings into design docs — COMPLETE

Docs-only change. The implement stage folded the design simulator's measured results back into the
three design specs (cohort-topic, reactivity, matchmaking) and flipped the architecture.md
Doc Sync Status "Simulator validation" column to `done` for all three subsystems. The review stage
re-derived every headline number from the committed simulator and corrected one mischaracterized
claim. No code changed; the simulator suite is green at **195 passing** and `tsc` builds clean.

## Review findings

### Scope checked

- Read the full implement diff (`docs/architecture.md`, `docs/cohort-topic.md`, `docs/matchmaking.md`,
  `docs/reactivity.md`) and the spun-off `fix/reactivity-resume-classifier-layered-bound` ticket.
- **Built** the simulator (`yarn build`, strict `tsc`) — clean.
- **Ran the full suite** (`yarn test`) — **195 passing**.
- **Independently re-derived every headline number** by running the package's own entry points through
  the ts-node loader (`runScaleSweep`, `compareLookahead`, `runSensitivitySweep`,
  `ColdStartStormScenario`, `TailRotationScenario`/`simulateRotationBurst`,
  `AdversarialReportingScenario`) and reading the pure functions (`reactivity.ts` coverage/resume,
  `matchmaking.ts` decision math, `backoff.ts`). Throwaway scripts removed after use.

### Numbers confirmed against the simulator (all matched the docs exactly)

- **Depth law** 1,1,2,3,4 at N ∈ {100,1k,10k,100k,1M}; **convergenceLatency 0**; **oscillations 0**;
  **peakOvershoot 0,0,36,436,4936** (all `< arrivalsPerRound`).
- **coord_d collisions 0** over 1,536 coords (64 × 4 × tiers 0–5) — `topic-addressing.spec.ts`.
- **Cold-start**: 3,000 → tier-0 accepts 64 (claim passes); 10,000 → 122 (the documented gossip-lag
  caveat). Max hops 6 (`d_max + 2`) at both.
- **Tail-rotation burst**: peak new-tail root = 32 = `cap_promote_fast`, last arrival 29,995 ms ≤
  `T_drain`, finalDepth 2.
- **Reactivity coverage**: W=256 → 256/25.6/2.56 s at 1/10/100 cps; W_checkpoint=4096 → 4096 s;
  W+W_checkpoint = 4352. **Adaptive-W** recommendations 600 @10cps, 6000 @100cps (`ceil(60·cps)`).
- **Resume RPC/latency**: Backfill & CheckpointWindow = 1 RPC / 100 ms; OutOfWindow = 2 RPC / 500 ms;
  TailRotated = 3 RPC / 300 ms (`DEFAULT_RESUME_COST`: roundTrip 100, chainRead 400, reResolve ×2).
- **Matchmaking**: worked example 15.00 / 1.13 / 9.07 → hang out; `contention_factor_cap` sweep
  thresholds 3/6/12/24 for cap 1/2/4/8, decision flips hang-out→escalate at cap ≥ 2; uncapped factor
  31 → threshold 93 clamped to 4 → 12. Adversarial: under-report +2 hops over 2 tiers (1/tier),
  over-report wasted 9,000 ms ≤ patience, terminated at 10,000 ms.
- **Sensitivity**: F depth 4,3,2,2; cap_promote depth 3,3,2,2; d_max_cap hops 5,6,7,8.
- **Back-off** `DEFAULT_BACKOFF_CONFIG`: base 1 s, factor 2, cap 60 s — `O(log(window/base))`.

### Finding — lookahead overshoot mischaracterization (MINOR, fixed inline)

cohort-topic.md (§Why this distributes naturally, §Promotion and demotion lifecycle, and the
§Configuration callout) claimed `T_promote_lookahead` **"removes overshoot only when the per-round
increment is comparable to `cap_promote`,"** citing `compareLookahead` at `arrivalsPerRound = 64` →
"0 both with and without lookahead" as the evidence. **The measured data refutes this:**

- Overshoot magnitude is `⌈cap_promote / arrivalsPerRound⌉ · arrivalsPerRound − cap_promote` — i.e.
  **0 whenever the increment divides `cap_promote = 64`** (R ∈ {8,16,32,64} → 0), and otherwise
  `< arrivalsPerRound` (R=10→6, R=50→36, R=128→64, R=256→192). It depends on the increment, **not** N
  (identical overshoot across N=1k/10k/100k for the same R).
- Pre-promotion **removes** overshoot only in the small-increment regime the committed test pins
  (`promotion-convergence.spec.ts`: N=1,000, R=10 → **6 without lookahead, 0 with**). At R=50/128/256
  lookahead changes **nothing** (`off == on`), and the scale sweep's 36/436/4936 are the
  **lookahead-on** figures.
- The R=64 example the doc cited shows "0 both ways" because **64 divides `cap_promote`** — lookahead
  removes nothing there, so it is the *opposite* of evidence that lookahead "removes overshoot when the
  increment is comparable to cap."

**Fix applied (docs-only, in the same docs the ticket touched):** rewrote all three spots to the
divisor relationship + the pinned small-increment removal case, and clarified that the scale-sweep
overshoots are lookahead-on (so lookahead does not bound storm overshoot). The unchanged practical
guidance — size the admission buffer for `cap_promote + one round of arrivals`, treat lookahead as a
smoothing aid not a hard cap, default `T_promote_lookahead = 30 s` — remains correct.

### Checked, honest, no change needed

- **`convergenceLatency = 0` framing** ("depth stabilizes within the load ramp"): a true property of
  the convergence model (last depth change precedes peak load on the virtual clock), honestly stated —
  not a claim of instantaneous real-world convergence.
- **Cold-start 122 caveat**: honestly stated in §Anti-flood as the same gossip-lag overshoot; the
  committed test pins the passing 3,000 case. (See backlog item below for the `runAllScenarios()`
  default-failure follow-up.)
- **Resume classifier doc/code split**: reactivity.md is authoritative on the layered bound
  (`lag < W + W_checkpoint`); the simulator's `classifyResume` still uses the single bound
  (`lag < W_checkpoint`), one `W` shallower than its own `RollingCheckpoint.covers`. Verified the
  inconsistency is exactly as the doc and `fix/reactivity-resume-classifier-layered-bound` describe
  (1-line + test change, well scoped). Not fixed here (docs-only ticket); the fix ticket carries it.

### New ticket filed

- **`backlog/cold-start-storm-default-claim-semantics`** — `runAllScenarios()` runs cold-start at the
  default 10,000 subscribers, where the `root-not-overloaded` claim evaluates **false** (cumulative
  tier-0 acceptance 122 > 64) by design. The claim also conflates cumulative with instantaneous
  acceptance. This is a latent simulator-code/UX issue inherited from `simulator-metrics-and-scenarios`
  (not a docs bug, not introduced here, honestly documented), so it is tracked rather than fixed inline
  in a docs review. Filed to backlog (future concern, decision: lower the default vs. reword the claim).

### Not changed (acceptable per handoff)

- `d_max = ⌊log_F(n_est)⌋ − 1` / `confidence_min` clamp note (cohort-topic §Maximum useful depth) left
  as a structural FRET-model note; no numeric claim was changed there.
- Back-off params taken from `DEFAULT_BACKOFF_CONFIG` constants + the churn gate rather than a dedicated
  back-off-curve sweep; `backoffDelay` is pure and the curve (1,2,4,8,16,32 → cap 60 s, ≤6 rejections
  per 60 s window) is arithmetically confirmed. Acceptable.

## Outcome

- Every quantitative claim in the three specs is confirmed-with-evidence or explicitly revised
  (adaptive-W; layered resume bound; lookahead overshoot characterization).
- No default *value* changed; the guidance revisions (adaptive-W, layered resume bound) and the
  corrected lookahead characterization are stated with the verified behavior for downstream tickets.
- architecture.md Doc Sync Status shows simulator validation `done` for all three subsystems.
- Build clean; simulator suite green at **195 passing** — unchanged by this ticket.
- Follow-ups: `fix/reactivity-resume-classifier-layered-bound` (filed by implement),
  `backlog/cold-start-storm-default-claim-semantics` (filed by review).
