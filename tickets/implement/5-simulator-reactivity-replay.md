description: Simulator reactivity replay-buffer (W=256) and checkpoint (W_checkpoint=4096) coverage model — classifies resumes, measures coverage windows and rotation-burst behavior, informs W vs W_checkpoint ratio.
prereq: simulator-cohort-topic-tree
files:
  - docs/reactivity.md
effort: medium
----

# Simulator reactivity replay-buffer and checkpoint coverage model

Models reactivity's recovery windows to answer the GROUNDING reactivity timing questions and inform the `W` vs `W_checkpoint` ratio (and whether `W` should be adaptive per commit rate). Builds on `simulator-cohort-topic-tree` (forwarder cohort = a promoted topic cohort; rotation re-registration uses the same walk/promotion machinery) and the event clock (commit cadence, subscriber wake events).

## What it models (docs/reactivity.md §Replay window ~L208, §Resume ~L322, §Tail rotation ~L265–281)

- **Tail replay ring buffer**, `W = 256` notifications, gossiped across the cohort so any member can serve a backfill.
- **Parent checkpoint summaries**, span `W_checkpoint = 4096` revisions (16× `W`; ≈ 1 hour at 1 cps), rolled forward as revisions retire from the replay buffer; held primarily at tier `d ≥ 1` cohorts.
- **Sliding dedupe window**, `dedupe_window = 64` over `(revision, sigDigest)`.

## Resume classification (by subscriber wake-lag)

```ts
type ResumeKind =
	| 'Backfill'         // lag < W            → one backfill RPC
	| 'CheckpointWindow' // W ≤ lag < W_checkpoint → one checkpoint RPC
	| 'OutOfWindow'      // lag ≥ W_checkpoint  → chain read
	| 'TailRotated';     // latestKnownTailId stale → re-resolve new tree

interface ResumeTrace {
	subscriber: PeerRef;
	lagRevisions: number;
	kind: ResumeKind;
	rpcCount: number;
	latency: VTime;
}
```

## Tail-rotation re-registration burst (reactivity.md §Tail rotation)

Tail rotates when a block fills (`block_fill_size = 64` transactions); the anchor — and tree root — moves to a new coord. Subscribers re-register over `T_rejoin_jitter = 30s`. Old tail drains for `T_drain = 60s`, accepting renewals/replays but bouncing new subscriptions with a `Promoted`-shaped redirect. The model must confirm the re-registration wave at the new tree stays within `cap_promote_fast = 32` inside `T_drain`, across subscriber populations.

## Coverage-window math to measure

- At 1 cps: `W = 256` ≈ 4 min recovery; `W_checkpoint = 4096` ≈ 1 hour.
- At 100 cps (hot collection): `W` covers ≈ 2.5 s — **flag whether `W` should be adaptive per measured cps**; record the finding for fold-back.
- No replay ping-pong / checkpoint thrashing under bursty commit patterns (subscribers waking with lag ≈ W repeatedly).

## Doc sync

- `docs/reactivity.md` §Replay window / §Configuration: forward note that `W`, `W_checkpoint`, the ratio, and the adaptive-`W` question are simulator-validated (measured coverage times + RPC-count distributions land via `fold-simulator-findings-into-design-docs`).

## TODO

### Phase 1 — buffers
- Implement the `W`-entry replay ring buffer (per cohort, gossiped) and the rolling `W_checkpoint` parent checkpoint, advancing as revisions retire. Implement the `dedupe_window` sliding set.

### Phase 2 — resume classification + rotation
- Implement resume classification (`Backfill`/`CheckpointWindow`/`OutOfWindow`/`TailRotated`) with RPC-count + latency traces, driven by subscriber wake events at configurable lags.
- Model tail rotation at `block_fill_size`, jittered re-registration over `T_rejoin_jitter`, and `T_drain` drain with `Promoted` bounce of new subscriptions.

### Phase 3 — coverage measurement + doc sync
- Measure coverage windows at 1 cps and 100 cps; record the adaptive-`W` finding.
- Add the *Done when* tests; add the forward note to `docs/reactivity.md`.

## Done when

- `yarn build` green; ES modules, no `any`, tabs.
- `yarn test` passes, including:
  - **One-RPC backfill:** a subscriber waking at lag `< W` resolves in exactly one backfill RPC; lag in `[W, W_checkpoint)` resolves in one checkpoint RPC; lag `≥ W_checkpoint` falls to chain read; stale `tailId` yields `TailRotated`.
  - **Coverage windows:** measured coverage ≈ 4 min (`W`) and ≈ 1 hour (`W_checkpoint`) at 1 cps; ≈ 2.5 s (`W`) at 100 cps (assert and record).
  - **Rotation burst bound:** at `T_rejoin_jitter = 30s`, the re-registration wave at the new tree stays within `cap_promote_fast = 32` inside `T_drain = 60s` across subscriber populations.
  - **No thrash:** repeated lag-≈-W wakes under bursty commits do not cause replay ping-pong or checkpoint thrashing.
