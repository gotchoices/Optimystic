description: Review the node option and pure calculation that decide how long a storage write may wait before it is forced onto disk, based on how many machines would all have to lose power at once for the write to be lost. Only a start-up log line uses it so far.
prereq: storage-flushes-once-per-write-group
architecture: docs/correctness.md#theorem-6-durability
files: packages/db-p2p/src/storage/durability-window.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/readme.md, packages/db-p2p/test/durability-window.spec.ts
difficulty: easy
----

# Durability window from cohort size — review handoff

First of five tickets from the plan `durability-window-scales-with-cohort-size` (GitHub #37). Siblings `storage-flush-takes-a-sync-deadline`, `nodes-apply-the-durability-window`, `file-store-syncs-by-the-earliest-deadline` and `durability-docs-match-the-window` consume what this builds.

## What was built

- `packages/db-p2p/src/storage/durability-window.ts` (new): `StorageDurabilityOptions`, `DurabilityWindowPolicy` (readonly: `independentFailures`, `lossRatePerHour`, `lossTarget`, `maxWindowMs`, `superMajorityThreshold`, `declaredCohortSize`), the constants `DEFAULT_DURABILITY_LOSS_RATE_PER_HOUR` (1/720), `DEFAULT_DURABILITY_LOSS_TARGET` (1e-9), `DEFAULT_DURABILITY_MAX_WINDOW_MS` (5000), `resolveDurabilityWindowPolicy(options, { superMajorityThreshold, clusterSize })` (throws `RangeError` naming the field) and the pure `durabilityWindowMs(cohortSize, policy)`. Rules: `n = min(cohortSize, declaredCohortSize)`; `n ≤ 1` → 0; `m = max(1, ceil(t·n) + floor(n/2) + 1 − n)`; `m = 1` → 0; `independentFailures: false` → 0; otherwise `floor(min((ε / C(h,m))^(1/m) / p · 3.6e6, maxWindowMs))`, `C` as a product of ratios. Exported from `src/index.ts` and `src/rn.ts`.
- `NodeOptions.storageDurability?: StorageDurabilityOptions`, documented on the type.
- `createLibp2pNodeBase`: `resolveClusterPolicy(...)` (with its whole comment block) **moved up** to right after the link-deadline resolution, ahead of storage acquisition, so the durability policy reads the one resolved `clusterSize`/`superMajorityThreshold` and a bad value throws with nothing acquired. `consensusConfig` depends only on `options` and `linkDeadlines`, so the move changes no value; its one side effect, the `repair-fault-tolerance` advisory log, now prints earlier. The policy lives in the local `durabilityWindowPolicy` for `nodes-apply-the-durability-window` to pass on.
- `logStorageDurability(durability, policy)` appends `durabilityWindowClause`: windows for `n = 1 … min(clusterSize, 10)` on `'power-loss'` with independent failures; "every write is synced before it is reported held" with `independentFailures: false`; the cannot-sync sentence on `'process-crash'`; nothing on `'none'`.
- Readme subsection "How long a write may wait for its sync (`storageDurability`)" under Usage Examples. It describes the window as if applied; nothing applies it until `nodes-apply-the-durability-window` lands — the docs ticket may want to re-read it.

## Tests

`packages/db-p2p/test/durability-window.spec.ts`:
- defaults table `n = 1 … 10` → `[0, 5000 × 9]`;
- `lossRatePerHour: 1` → 113 ms at `n = 2`, 65 ms at `n = 4` (formula below the cap);
- `independentFailures: false` → 0 for `n = 0 … 10`;
- `lossTarget: 1e-3` still 0 at `n = 1` (the `m = 1` rule);
- `cohortSize: 10` with `clusterSize: 3` equals the `n = 3` window;
- `resolveDurabilityWindowPolicy` throws `RangeError` for zero rate, `lossTarget: 1`, negative cap.

No test for the log line (wiring). Ran: db-p2p `yarn build`, full `yarn test` (3369 passing, 71 pending, 0 failing), root `yarn lint`, `yarn lint:docs` — all clean.

## For the reviewer

- `n` is not rounded; a non-integer `cohortSize` would compute a window from fractional arithmetic. Callers pass `record.peers` counts, so integers in practice.
- `superMajorityThreshold ≤ 0.5` clamps `m` to 1 → 0, by inspection only.
- `independentFailures` non-boolean is validated at runtime (for JS callers); `clusterSize`/threshold come from the already-validated cluster policy and are not re-checked here.
