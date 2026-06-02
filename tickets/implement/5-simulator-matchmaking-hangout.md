description: Simulator matchmaking hang-out-vs-continue decision and seeker-path tracer — models expectedNewMatches/contentionFactor under load, replicates docs worked example, bounds adversarial traffic reporting.
prereq: simulator-cohort-topic-tree, simulator-participant-walk
files:
  - docs/matchmaking.md
effort: medium
----

# Simulator matchmaking hang-out-vs-continue decision and seeker-path tracer

Models the seeker hang-out decision under modeled load and traces seeker path length / success. Answers the GROUNDING matchmaking timing and adversarial-reporting questions, and measures whether the deferred refinements (`matchmaking-per-tier-patience-splitting`, `matchmaking-contention-from-seeker-pool` — existing backlog tickets) are actually needed. **Do not implement those refinements here** — only measure whether the simulator says they are warranted. Builds on `simulator-cohort-topic-tree` (topic traffic signal, cohort population) and `simulator-participant-walk` (seeker registration walk + escalation).

## The decision math (docs/matchmaking.md §Hang-out vs. continue ~L198–293)

```
expectedNewMatches = arrivalsPerMin × filterAcceptRatio × (patienceMs / 60000)
contentionFactor   = min(1 + (queriesPerMin × meanWantCount) / max(arrivalsPerMin, 1),
                         contention_factor_cap)        // contention_factor_cap = 4.0
hangOut  ⟺  currentMatches + expectedNewMatches ≥ wantCount × contentionFactor
```

Edge cases to model:
- **Missing traffic** (no `topicTraffic` on the reply) → conservative default (continue/escalate).
- **Zero arrivals post-rotation** (single zero from epoch reset) → do not over-react to one zero (per the resolved traffic-signal design lock).
- **Pathological filter** (`filterAcceptRatio` near 0).
- **`filterAcceptRatio` decay** from initial 1.0 toward the observed accept rate across the walk.

## Worked example (matchmaking.md worked example, must replicate as assertions)

6 existing providers, `arrivalsPerMin = 90`, `queriesPerMin = 4`, `wantCount = 8`, `meanWantCount = 3`, `patienceMs = 10s`:
- `expectedNewMatches = 90 × 1.0 × (10000/60000) = 15`.
- `contentionFactor = 1 + (4 × 3 / 90) ≈ 1.13` (clamped to ≤ 4.0).
- Threshold `8 × 1.13 ≈ 9.05`; have `6 + 15 = 21 ≥ 9.05` → **hang out**.

(This matches the corrected arithmetic from `tickets/complete/cohort-topic-traffic-signal.md` review.)

## Seeker path tracer

```ts
interface SeekerTrace {
	seeker: PeerRef;
	tiersVisited: number;
	hangOutDurationMs: VTime;
	matched: boolean;
	matchLatency: VTime;
	requeries: number;            // polls at requery_interval_ms while hanging out
}
```

## Adversarial traffic reporting (matchmaking.md §Adversarial traffic reporting)

`topicTraffic` is single-member-signed (advisory). Bound the harm of one lying primary:
- **Under-report** arrivals → seeker walks inward → bounded by **one extra hop per tier**.
- **Over-report** arrivals → seeker hangs out longer → bounded by **patienceMs** drain.

## Doc sync

- `docs/matchmaking.md` §Hang-out vs. continue / §Worked scenarios: forward note that the formula traces, `contention_factor_cap` justification, and adversarial bounds are simulator-validated (numbers land via `fold-simulator-findings-into-design-docs`).

## TODO

### Phase 1 — decision engine
- Implement `expectedNewMatches` / `contentionFactor` / threshold with the `contention_factor_cap` clamp and the four edge cases; `filterAcceptRatio` decay from 1.0.

### Phase 2 — seeker walk + tracer
- Wire the seeker registration + escalation onto `simulator-participant-walk`; poll at `requery_interval_ms` while hanging out; record `SeekerTrace`.

### Phase 3 — adversarial + doc sync
- Model under/over-reporting and measure the bounded harm.
- Add the *Done when* tests (including the worked example); add the forward note to `docs/matchmaking.md`.

## Done when

- `yarn build` green; ES modules, no `any`, tabs.
- `yarn test` passes, including:
  - **Worked example:** the docs hang-out example reproduces (`expectedNewMatches = 15`, `contentionFactor ≈ 1.13`, decision = hang out); plus the docs §Test expectations cases (hot deep-tier suffices; cold walks to root; borderline hangs out for full patience).
  - **Fairness at scale:** 100 parallel seekers stay fair under `contention_factor_cap = 4.0` (no self-inflicted escalation storm).
  - **Adversarial bounds:** under-report costs ≤ +1 hop/tier; over-report costs ≤ `patienceMs` of drain.
  - **Refinement signal:** the run reports whether per-tier-patience-splitting or contention-from-seeker-pool would materially improve borderline-regime success (recorded for fold-back; not implemented here).
