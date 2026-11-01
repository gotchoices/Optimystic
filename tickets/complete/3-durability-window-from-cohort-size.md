description: Added the node option and pure calculation that decide how long a storage write may wait before it is forced onto disk, based on how many machines would all have to lose power at once for the write to be lost. Only a start-up log line uses it so far.
prereq: storage-flushes-once-per-write-group
architecture: docs/correctness.md#theorem-6-durability
files: packages/db-p2p/src/storage/durability-window.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/index.ts, packages/db-p2p/src/rn.ts, packages/db-p2p/readme.md, packages/db-p2p/test/durability-window.spec.ts
----

# Durability window from cohort size

First of five tickets from the plan `durability-window-scales-with-cohort-size` (GitHub #37). Implemented in `ticket(implement): durability-window-from-cohort-size`.

## What landed

- `packages/db-p2p/src/storage/durability-window.ts`: `StorageDurabilityOptions`, `DurabilityWindowPolicy`, the three defaults (loss rate 1/720 per hour, loss target 1e-9, cap 5000 ms), `resolveDurabilityWindowPolicy` (throws a `RangeError` that names the bad field) and the pure `durabilityWindowMs(cohortSize, policy)`. Exported from `src/index.ts` and `src/rn.ts`.
- `NodeOptions.storageDurability`. `createLibp2pNodeBase` now resolves the cluster policy before it acquires storage, so the durability policy reads the same `clusterSize` and threshold, and a bad value throws before anything has been acquired. The start-up storage log line reports the windows in force.
- A readme subsection, "How long a write may wait for its sync".

## Review findings

- **Math checked by hand.** At t=0.75: n=2 gives m=2, C(2,2)=1, and the window works out to 82 s at the default rate, so the 5000 ms cap applies. At rate 1/h, n=2 gives 113 ms and n=4 gives 65 ms (m=2, C(3,2)=3). This matches the tests. At t ≤ 0.5, m is clamped to 1, which gives 0. At t=1 the formula stays well-defined.
- **Fixed inline: a malformed cohort size.** `durabilityWindowMs` returned `NaN` for a `NaN` size, and a fractional size gave a window built from fractional arithmetic. It now floors the size and returns the strict 0 for anything that is not finite. I added no test: callers pass `record.peers` counts, and this is a defensive guard, not a behaviour in the specification.
- **Moving the cluster policy earlier:** I confirmed that `consensusConfig` depends only on `options` and `linkDeadlines`, both of which are resolved above its new position. The build and typecheck pass. The only thing that changes is that the `repair-fault-tolerance` advisory log now prints earlier, which is harmless.
- **Readme describes behaviour not yet applied:** the subsection describes the window as if it were in force, but nothing applies it until `nodes-apply-the-durability-window` lands. I did not file a ticket, because `durability-docs-match-the-window` already lists `packages/db-p2p/readme.md` and re-reads this subsection, and it runs after the apply ticket.
- **Tests:** the six existing tests each pin a separate rule (default table, formula below the cap, non-independent failures, the m=1 rule, the cohort-size cap, validation). None restate wiring, so I kept them all. No log-line test, which is correct, since the log line is wiring.
- **Type safety and error handling:** a non-boolean `independentFailures` from a JavaScript caller is checked at runtime. No `any`. `clusterSize` and the threshold come from the already-validated cluster policy.
- **Performance and resource cleanup:** not applicable. The calculation is pure, runs on small integers, and holds no resources.
- **Tripwires:** none recorded.
- **Ran:** db-p2p `yarn build`, the focused durability-window tests (6 passing), and root `yarn lint` (clean). The implementer's full db-p2p `yarn test` (3369 passing) and `yarn lint:docs` were clean; my change touches only the guard in the pure function.
