description: Simulator metrics engine, scenario runner, and scale/sensitivity sweep — aggregates metrics to JSON/CSV, orchestrates e2e scenarios, runs N-scale and parameter sweeps producing per-claim pass/fail reports. The gate before implementation commits parameters.
prereq: simulator-participant-walk, simulator-churn-and-willingness, simulator-promotion-convergence, simulator-reactivity-replay, simulator-matchmaking-hangout
files:
  - docs/cohort-topic.md
  - docs/reactivity.md
  - docs/matchmaking.md
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts
effort: high
----

# Simulator metrics engine, scenario runner, and scale/sensitivity sweep

The capstone of the simulator phase. Folds three concerns — metrics aggregation, scenario orchestration, and the scale/sensitivity sweep — into one ticket because they are one pipeline: scenarios produce events, the metrics engine aggregates them, the sweep parameterizes the scenarios. **This is the gate**: per PROGRAM INTENT, the simulator must answer the design's quantitative claims before any subsystem implementation commits to parameters or structure. Its outputs feed `fold-simulator-findings-into-design-docs`, which all parameter-dependent implement tickets prereq.

Builds on all five sequence-4/5 model tickets (walk, churn+willingness, promotion-convergence, reactivity-replay, matchmaking-hangout) and reuses FRET's `getDiagnostics` accumulation pattern (`C:/projects/Fret/packages/fret/src/service/fret-service.ts`) for metric collection.

## Metrics engine

```ts
interface MetricsSink {
	counter(name: string, by?: number, tags?: Tags): void;
	histogram(name: string, value: number, tags?: Tags): void;   // tags: { tier, topic, ... }
	timeline(name: string, t: VTime, value: number): void;
	exportJson(): string;
	exportCsv(): string;
}
```

Aggregations to support: RPC-count and load histograms per tier; walk-hop CDF; promotion-convergence time; jitter effectiveness (peak accepted/sec vs the `cap_promote / T_rejoin_jitter` bound); replay-coverage CDF; hang-out duration + success rate; willingness rejection rate. Export JSON and CSV for offline analysis.

## Scenario runner

```ts
interface Scenario {
	name: string;
	seed: number;
	setup(world: SimWorld): void;          // population, topics, churn, latency model
	run(world: SimWorld): void;            // drives the event clock to completion
	validate(metrics: MetricsSink): ClaimReport;  // pass/fail per design claim
}

interface ClaimReport {
	scenario: string;
	claims: { id: string; expected: string; observed: string; pass: boolean }[];
}
```

Scenarios (from docs §Worked scenarios across all three subsystems):
- **Cold-start storm** — 10k+ subscribers arrive in a burst; validate anti-flood (root not overloaded, walks fan, promotion fires in time).
- **Churn recovery** — 20% per-cohort turnover; validate failover + heal convergence with no lost registrations.
- **Tail rotation under load** — reactivity rotation during steady subscription load; validate `T_drain` / jitter / `cap_promote_fast` burst bound and revision continuity.
- **Voting-quorum assembly on a hot proposal** — flash registration of a large eligible-voter population; validate tree promotion absorbs the herd (root not overloaded).
- **Adversarial traffic reporting** — lying primary; validate bounded harm (≤ +1 hop/tier under-report, ≤ patienceMs over-report).

## Scale + sensitivity sweep

- **Scale sweep:** N ∈ {100, 1k, 10k, 100k, 1M} confirming O(log N) walk hops and the `⌈log_F(N/cap_promote)⌉` depth law (1M reachable thanks to the virtual clock + event batching from `simulator-event-clock`).
- **Parameter sensitivity:** sweep `cap_promote`, `F`, `d_max_cap`, `W` / `W_checkpoint`, `contention_factor_cap`; report each parameter's effect on convergence time, walk hops, re-registration rate, replay coverage, and hang-out success.

## Doc sync

This ticket produces the *evidence*; the fold-back lands the numbers. Still, weave in:
- `docs/cohort-topic.md`, `docs/reactivity.md`, `docs/matchmaking.md`: add a "Simulator scenarios" forward pointer in each §Worked scenarios noting that the listed scenarios are executed by the simulator scenario runner and that measured numbers are folded in by `fold-simulator-findings-into-design-docs`. (The actual measured-number substitutions are that downstream ticket's job, not this one.)

## TODO

### Phase 1 — metrics engine
- Implement `MetricsSink` (counters, histograms, timelines) reusing the FRET `getDiagnostics` accumulation pattern; JSON + CSV export.
- Subscribe the engine to the event streams emitted by the walk / churn / convergence / replay / hangout models.

### Phase 2 — scenario runner
- Implement `Scenario` / `ClaimReport` and the five scenarios above, each emitting a pass/fail claim-validation report.

### Phase 3 — sweep
- Implement the N-scale sweep ({100…1M}) and the parameter-sensitivity sweep; emit aggregated reports (JSON/CSV).
- Confirm 1M-node scenarios complete within the runner's time budget (stream output via `tee`; if a single sweep exceeds ~10 min wall-clock, gate it behind an env flag and document the deferral so it runs out-of-band).

### Phase 4 — doc sync
- Add the "Simulator scenarios" forward pointers to the three §Worked scenarios sections.

## Done when

- `yarn build` for the simulator package is green; ES modules, no `any`, tabs.
- `yarn test` passes, including:
  - Each of the five scenarios produces a `ClaimReport` with all claims passing (or an explicit, documented variance feeding the fold-back).
  - The scale sweep confirms walk hops are O(log N) and steady-state depth `== ⌈log_F(N/cap_promote)⌉` across N ∈ {100, 1k, 10k, 100k, 1M}.
  - The sensitivity sweep produces a JSON/CSV report quantifying each parameter's effect (this is the input artifact `fold-simulator-findings-into-design-docs` consumes).
- The agent-runnable subset finishes within the runner time budget; any sweep too long for an agent run is env-gated and documented.
