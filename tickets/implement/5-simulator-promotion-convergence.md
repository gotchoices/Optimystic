description: Simulator promotion-depth tracer and convergence validator — records every coordinate instantiation/promotion, validates steady-state depth == ceil(log_F(N/cap_promote)), measures overshoot and convergence latency.
prereq: simulator-cohort-topic-tree, simulator-participant-walk
files:
  - docs/cohort-topic.md
effort: medium
----

# Simulator promotion-depth tracer and convergence validator

Tracks tier growth over time and validates the central cohort-topic scaling claim. Answers the GROUNDING tree-depth-vs-`n_est`-confidence and overshoot-tolerance questions. Builds on `simulator-cohort-topic-tree` (promotion/demotion lifecycle) and `simulator-participant-walk` (so registrations actually arrive and grow the tree).

## What it records

```ts
interface DepthSample {
	t: VTime;
	topicId: TopicId;
	maxDepth: number;             // deepest instantiated tier for this topic
	coordCount: number;           // distinct (tier, coord) coordinates instantiated
	overCapCount: number;         // coords currently above cap_promote (overshoot)
}

interface ConvergenceResult {
	steadyStateDepth: number;     // observed
	expectedDepth: number;        // ceil(log_F(N / cap_promote))
	convergenceLatency: VTime;    // peak-load → depth-stabilization
	peakOvershoot: number;        // max directParticipants past cap_promote during the window
	oscillations: number;         // depth changes before hysteresis locks
}
```

Every coordinate instantiation and promotion event (emitted by the tree ticket) is timestamped, producing a depth-over-time timeline. From the timeline the validator derives steady-state depth, convergence latency (time from peak load to depth stabilization), promotion-window overshoot past `cap_promote`, and the oscillation/thrashing count before the `cap_promote`/`cap_demote` + `T_demote` hysteresis locks.

## The claim (cohort-topic.md §Tree growth and lookup ~L138)

Steady-state depth `== ⌈log_F(N / cap_promote)⌉` with `F = 16`, `cap_promote = 64`. The validator must confirm this across an N sweep and confirm that the slope-based pre-promotion (`T_promote_lookahead`, from the tree ticket) **reduces overshoot** versus a run with lookahead disabled.

## Doc sync

- `docs/cohort-topic.md` §Tree growth and lookup: forward note that the depth law convergence latency and overshoot bound are simulator-measured (numbers fold back via `fold-simulator-findings-into-design-docs`).

## TODO

### Phase 1 — tracer
- Subscribe to the tree's instantiation/promotion/demotion event stream; build the timestamped depth timeline (`DepthSample[]` per topic).

### Phase 2 — validator
- Compute `ConvergenceResult`: steady-state depth vs `⌈log_F(N/cap_promote)⌉`, convergence latency, peak overshoot, oscillation count.
- Add a lookahead-on vs lookahead-off comparison harness.

### Phase 3 — sweep hooks + doc sync
- Expose the validator so `simulator-metrics-and-scenarios` can run it across the N sweep.
- Add the forward note to `docs/cohort-topic.md` §Tree growth and lookup.

## Done when

- `yarn build` green; ES modules, no `any`, tabs.
- `yarn test` passes, including:
  - **Depth law:** steady-state depth `== ⌈log_F(N/cap_promote)⌉` across N ∈ {10, 100, 1k, 10k, 100k}.
  - **Bounded overshoot:** peak `directParticipants` past `cap_promote` during the promotion window stays within a documented bound.
  - **Lookahead reduces overshoot:** runs with `T_promote_lookahead` enabled show strictly lower peak overshoot than runs with it disabled, same seed/population.
  - **Hysteresis locks:** oscillation count before steady state is finite and small (no perpetual depth flapping).
