description: Review the reactivity replay-buffer (W) / checkpoint (W_checkpoint) / dedupe coverage model, resume classification, rotation-burst, and coverage-window measurements added to substrate-simulator.
files:
  - packages/substrate-simulator/src/reactivity.ts
  - packages/substrate-simulator/test/reactivity.spec.ts
  - packages/substrate-simulator/src/index.ts
  - docs/reactivity.md
effort: medium
----

# Review: simulator reactivity replay-buffer & checkpoint coverage model

Adversarial review of the reactivity timing model added under `packages/substrate-simulator`. It
models the replay ring (`W = 256`), rolling parent checkpoint (`W_checkpoint = 4096`), sliding
dedupe window (`dedupe_window = 64`), resume classification, the tail-rotation re-registration
burst, and the coverage-window math that informs the `W` vs `W_checkpoint` ratio and the adaptive-`W`
question. All against `docs/reactivity.md`.

## What was implemented

**`src/reactivity.ts`** (new, ~430 lines, fully exported via `index.ts`):

- `ReplayRing` — `W`-entry ring buffer; `append` returns the retired entry past capacity; `covers`,
  `range`, `lowest/highestRevision`.
- `RollingCheckpoint` — sits immediately below the ring; `advanceTo(ringLow)` rolls the
  `W_checkpoint`-span window forward as revisions retire.
- `DedupeWindow` — sliding `(revision, sigDigest)` set, **evicted by revision age** (not insertion
  order) so a late retransmit of an in-window revision is still caught.
- `CohortPushState` — wires ring + checkpoint + dedupe; `ingest()` returns `'forwarded'|'duplicate'`,
  appends only on a new head, rolls retired revisions into the checkpoint.
- Resume classification — `classifyResume`/`traceResume` → `ResumeKind` +
  `rpcCount` + `latency` (`ResumeTrace`). `ResumeCost` is the per-round-trip cost model.
- Coverage math — `coverageSeconds`, `measureCoverage`, `assessAdaptiveW` (returns the recorded
  adaptive-`W` finding incl. `recommendedW`).
- `measureRepeatedWakeThrash` — drives repeated lag-≈-`W` wakes, returns kind sequence + transition
  count (no-thrash check).
- `simulateRotationBurst` — reuses the modeled `TopicTree` (eager promotion, hot root load) to drive
  the jittered re-registration wave at the new tail and measure the peak root direct count.

**`test/reactivity.spec.ts`** — 168 total package specs pass (`yarn build` + `yarn test` green).

## Done-when status (all passing)

- **One-RPC backfill:** lag `< W` → `Backfill` rpcCount 1; lag `[W, W_checkpoint)` → `CheckpointWindow`
  rpcCount 1; lag `≥ W_checkpoint` → `OutOfWindow` (chain read); stale `tailId` → `TailRotated`. ✅
- **Coverage windows:** ≈ 4 min (`W`) and ≈ 1 h (`W_checkpoint`) at 1 cps; ≈ 2.5 s (`W`) at 100 cps,
  asserted and recorded via `assessAdaptiveW`. ✅
- **Rotation burst bound:** peak new-root direct ≤ `cap_promote_fast = 32`, all re-registrations
  inside `T_drain = 60 s` (jittered over `T_rejoin_jitter = 30 s`), across `{100, 1k, 10k}`. ✅
- **No thrash:** 50 repeated lag-`(W−1)` wakes stay `Backfill`, single-RPC, zero kind transitions;
  steady stream never double-forwards a revision. ✅

## Reviewer focus areas / known gaps (treat tests as a floor)

1. **Resume threshold simplification — verify this is acceptable.** `docs/reactivity.md` layers the
   checkpoint span *on top of* the replay buffer (recoverable ≈ `W + W_checkpoint`). The model
   follows the ticket's `ResumeKind` definition instead: `W` and `W_checkpoint` are the two
   **absolute lag bounds**. This is documented in the module header. Confirm the single-bound form is
   the intended semantics for fold-back, or flag for a doc/ticket reconciliation. The `CheckpointWindow`
   boundary test pins lag `== W` → checkpoint and lag `== W_checkpoint − 1` → checkpoint.

2. **`rpcCount`/`latency` are a stipulated cost model, not measured from the event clock.** Resume
   latency is `roundTripMs`-based arithmetic per kind (`DEFAULT_RESUME_COST`), not drawn through the
   `LatencyModel`/scheduler like the rotation burst is. If the reviewer wants resume traces to ride
   the real latency model (e.g. for RPC-count *distributions* under stochastic latency, which the doc
   forward-note mentions), that is a deliberate extension point left open — the current tests only
   assert the deterministic per-kind costs.

3. **Rotation burst uses eager promotion → the root cap is deterministic.** `simulateRotationBurst`
   drives `TopicTree.register` (eager), so the root promotes the instant it hits `cap_promote_fast`
   and `peakRootDirect == 32` exactly regardless of jitter ordering. This is a *tight* check but means
   jitter timing doesn't influence the cap result — it only influences `lastArrivalAt`. A
   lagged-promotion variant (à la `routeArrival` in promotion-convergence) would expose a real
   overshoot past `cap_promote_fast`; consider whether the burst should measure that overshoot rather
   than assert the eager floor. Tier-1+ cohorts are *not* marked hot, so they promote at the slow
   `cap_promote = 64`; only the root cap is exercised.

4. **Checkpoint/ring gossip and `queue_max` backpressure are not modeled.** The ring is assumed
   cohort-converged (no gossip lag), and the per-subscriber bounded queue / drop-oldest backpressure
   (reactivity.md §Slow-subscriber backpressure) is out of scope here — `queue_max` is carried in
   `ReactivityConfig` but unused. Flag if coverage of the drop-oldest → backfill path is wanted.

5. **Adaptive-`W` floor is a chosen constant.** `assessAdaptiveW` takes `minCoverageSeconds` as a
   parameter; the test uses 60 s. The 100-cps `recommendedW = 6000` is a direct function of that
   floor, not an independently-derived target. The *finding* (fixed `W` too shallow at hot cps) is
   robust; the specific recommended number depends on the chosen recovery floor.

## Validation commands

```
cd packages/substrate-simulator
yarn build        # tsc, green
yarn test         # 168 passing
yarn test:verbose # see the reactivity describe blocks individually
```
