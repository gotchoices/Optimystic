description: Add the node option and the pure calculation that decide how long a storage write may wait before it is forced onto disk, based on how many machines would all have to lose power at once for the write to be lost. Nothing uses the number yet beyond a start-up log line; later tickets apply it.
prereq: storage-flushes-once-per-write-group
architecture: docs/correctness.md#theorem-6-durability
files: packages/db-p2p/src/storage/durability-window.ts (new), packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/src/cluster/cluster-policy.ts, packages/db-p2p/readme.md, packages/db-p2p/test/durability-window.spec.ts (new)
difficulty: easy
----

# Durability window from cohort size

First of five tickets from the plan `durability-window-scales-with-cohort-size` (GitHub #37). The maintainer decided (2026-10-15) that how long a node may leave a write unsynced is computed per write from the size of the cohort the write's consensus ran on, assuming by default that machines fail independently. This ticket builds only the calculation, the option and the start-up log line. `storage-flush-takes-a-sync-deadline` builds the storage seam, `nodes-apply-the-durability-window` passes the computed window to storage, `file-store-syncs-by-the-earliest-deadline` makes the file store honour it, and `durability-docs-match-the-window` rewrites `docs/correctness.md` Theorem 6.

## The rule

A write is lost only if every holder a rival write would need to out-vote loses it within the window `w` during which it sat unsynced. For a cohort of `n` members at promise threshold `t` (`superMajorityThreshold`, default 0.75):

- approvals a rival needs: `a = ceil(t·n)`
- holders when the write is acknowledged, at minimum: `h = floor(n/2) + 1` (the acknowledgement gate's strict majority)
- holders that must lose it together: `m = a + h − n` (every member still holding the revision refuses the rival), clamped to at least 1

With `p` the per-machine rate of power cuts and operating-system crashes and `ε` the accepted chance of losing one acknowledged write, independence gives a loss chance of about `C(h, m)·(p·w)^m`, so

  `w = (ε / C(h, m))^(1/m) / p`, then `min(w, maxWindowMs)`, floored to whole milliseconds.

Rules on top of the formula:

- `n` is `min(cohortSize, declaredCohortSize)`, where `declaredCohortSize` is the node's resolved `clusterSize`. The cohort size passed in comes from the consensus record (`record.peers`), and the cap stops a record listing more peers than the deployment has from widening the window.
- `n ≤ 1` (including 0, an unrouted write) → `w = 0`.
- `m = 1` → `w = 0`. At the defaults the formula gives 2.6 ms for `m = 1`, which is below what a sync itself costs, so 0 is the same answer; the explicit rule keeps it 0 when an operator raises `lossTarget`. This is decision rule 5: a write only one machine would hold is synced before it is reported held.
- `independentFailures: false` → `w = 0` for every `n` (every write strict, today's behaviour).

## The option

```ts
/** NodeOptions.storageDurability */
export interface StorageDurabilityOptions {
	/** Whether this deployment's machines lose power and crash independently of each other. Default true. False makes every write sync before it is reported (two machines on one circuit, say). */
	independentFailures?: boolean;
	/** Power cuts plus operating-system crashes per machine per hour. Default 1/720 (one per 30-day month). */
	lossRatePerHour?: number;
	/** Accepted chance that an acknowledged write is lost. Default 1e-9. */
	lossTarget?: number;
	/** Hard cap on any computed window, in ms. Default 5000. */
	maxWindowMs?: number;
}
```

In `packages/db-p2p/src/storage/durability-window.ts`:

- `resolveDurabilityWindowPolicy(options: StorageDurabilityOptions | undefined, context: { superMajorityThreshold: number; clusterSize: number }): DurabilityWindowPolicy` — fills defaults and validates, throwing `RangeError` naming the field: `lossRatePerHour` finite and > 0; `lossTarget` finite, > 0 and < 1; `maxWindowMs` finite and ≥ 0; `independentFailures` boolean when present. `DurabilityWindowPolicy` is a readonly record of the six resolved numbers/flags.
- `durabilityWindowMs(cohortSize: number, policy: DurabilityWindowPolicy): number` — the rule above. Pure; no logging.
- Export both, the two types, and the default constants from `src/index.ts` and `src/rn.ts` (the entry-parity spec fails otherwise).

`createLibp2pNodeBase` resolves the policy at the top, beside `resolveLinkDeadlines`, before anything is acquired, so a bad value throws with nothing to release. `clusterSize` and `superMajorityThreshold` come from the same resolved values the rest of the node uses (`resolveClusterPolicy` / the resolved `consensusConfig`); if the consensus config is resolved later than the top, resolve the policy right after it, still before storage is acquired, or move the threshold resolution up — do not read a second copy.

`NodeOptions` gains `storageDurability?: StorageDurabilityOptions`, documented on the type and in `packages/db-p2p/readme.md` (one short subsection: what it controls, the defaults, `independentFailures: false` for machines that share power, and that the window applies only on storage that can sync — see the log line below).

## The start-up log line

`logStorageDurability` in `packages/db-p2p/src/libp2p-node-base.ts` is the ONE line about what storage survives (its doc says so); extend it rather than logging elsewhere. It takes the policy as well and appends:

- `'power-loss'` store, independent failures: the windows for `n = 1 … min(declaredCohortSize, 10)`, e.g. `…; a write may wait for its sync up to: n=1 0ms, n=2 5000ms, …, n=10 5000ms (independent failures assumed; storageDurability.independentFailures=false makes every write sync first)`.
- `'power-loss'` store, `independentFailures: false`: `…; every write is synced before it is reported held`.
- `'process-crash'` store: `…; this backend cannot sync, so a power cut may lose any write the operating system has not yet written out, whatever the window` (decision rule 4: the node still starts).
- `'none'`: unchanged.

## Table at the defaults (`t = 0.75`, `p = 1/720 per hour`, `ε = 1e-9`, cap 5000 ms)

| n | a | h | m | C(h,m) | uncapped w (ms) | w (ms) |
|---|---|---|---|---|---|---|
| 1 | 1 | 1 | 1 | 1 | (2.6, m = 1 → 0) | 0 |
| 2 | 2 | 2 | 2 | 1 | 81 966 | 5000 |
| 3 | 3 | 2 | 2 | 1 | 81 966 | 5000 |
| 4 | 3 | 3 | 2 | 3 | 47 323 | 5000 |
| 5 | 4 | 3 | 2 | 3 | 47 323 | 5000 |
| 6 | 5 | 4 | 3 | 4 | 1 632 857 | 5000 |
| 7 | 6 | 4 | 3 | 4 | 1 632 857 | 5000 |
| 8 | 6 | 5 | 3 | 10 | 1 203 099 | 5000 |
| 9 | 7 | 5 | 3 | 10 | 1 203 099 | 5000 |
| 10 | 8 | 6 | 4 | 15 | 7 406 485 | 5000 |

So at the defaults the cap binds for every cohort of two or more: under independence, two machines losing power within the same five seconds is already far below one write in 10^9. The plan's earlier guess of "about a second" for three members was wrong; the docs ticket publishes this table. With `lossRatePerHour: 1` the formula is visible below the cap: `n = 2` → 113 ms, `n = 4` → 65 ms.

## Edge cases & interactions

- `cohortSize` larger than `clusterSize` → capped (by the test below).
- `superMajorityThreshold` at or below 0.5 makes `m` reach 0 or 1 → clamped to 1 → `w = 0` (by inspection; the cluster policy may already refuse such thresholds).
- `maxWindowMs: 0` → every window 0, same as `independentFailures: false` (by inspection).
- Floating-point: compute `C(h, m)` as a product of ratios (sizes are small); floor the result (by the table test).
- The resolved policy is not yet used by anything except the log line; `nodes-apply-the-durability-window` consumes it. Keep it in a local beside `linkDeadlines` so that ticket can pass it on.

## Tests

`packages/db-p2p/test/durability-window.spec.ts` — the function has real branching and the numbers are the specification the docs will publish:

- The defaults table above, `n = 1 … 10`, exact `w` values (all 0 or 5000), plus `lossRatePerHour: 1` giving 113 ms at `n = 2` and 65 ms at `n = 4` (pins the formula below the cap).
- `independentFailures: false` → 0 for every `n`; `lossTarget: 1e-3` still gives 0 at `n = 1` (the `m = 1` rule); `cohortSize: 10` with `clusterSize: 3` gives the `n = 3` window.
- `resolveDurabilityWindowPolicy` throws `RangeError` for a zero rate, a `lossTarget` of 1, and a negative cap (one test).

No test for the log line (wiring).

## TODO

- Write `durability-window.ts` with the two functions, types and defaults; export from both entries.
- Add `NodeOptions.storageDurability`; resolve it at node start with the node's own `clusterSize` and threshold.
- Extend `logStorageDurability` with the policy as described.
- Readme subsection for the option.
- The spec above; run db-p2p build and tests, `yarn lint`, `yarn lint:docs`.
