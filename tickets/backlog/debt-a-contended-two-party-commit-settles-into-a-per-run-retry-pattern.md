description: When two parties write concurrently over a relay, each test run settles at bring-up into one pattern of who loses the race and how many times the loser re-drives its commit, and every pair in that run repeats it. Identical work can therefore cost up to 3.5 times as much in one run as in another. Nothing fails; it is a cost that a stable choice (coordinator, tie-break or retry backoff) appears to decide once per run rather than per race.
files:
  - packages/db-core/src/collection/collection.ts (the sync retry loop)
  - packages/db-core/src/transaction/coordinator.ts (stale-loss re-drive)
  - packages/db-core/src/transactor/network-transactor.ts (coordinator choice for a block)
repro: measured
severity: performance
likelihood: common
tradeoffs: Some loss is inherent to optimistic concurrency when two parties write the same collection at once. The question is only why the loser needs three re-drives in some runs, and why the same side always loses within a run.
----
# A contended two-party commit settles into a per-run retry pattern

## Observed (sereus, relay measurement at optimystic `9e5c1e85`)

Sereus ran 3 runs of 4 concurrent pairs for each of two configurations (both parties transact, storage joiner). Sequential pairs were steady in every run: 114–168 ms, 4 `/cluster` per side per rep.

Concurrent pairs vary between runs, not between configurations. Each run settles into one contended-commit pattern, and every pair in that run repeats it: the same side loses, and it re-drives the same number of times. Each re-drive costs 6 extra `/cluster` streams.

- one side re-drives once: 4 and 10 `/cluster`, 250–330 ms
- both sides re-drive: 16 and 10, 480–560 ms
- one side re-drives three times: 22, 907 ms on its first pair

The joiner's `/repo` versus `/db-p2p/sync` split is also fixed for the whole of a run.

## To find out

Break the contended path down by phase: which re-drives are pend and which are commit, and which follow a `held` or a `conflict` answer. Then find what, fixed at bring-up, decides the loser and its retry count. Candidates are the coordinator each party picks for the shared blocks, a deterministic tie-break, and retry backoff. Sereus has an opt-in scenario for this: `RELAY_RRT_MEASURE=1` on `packages/integration-tests/src/scenarios/relay-round-trip-measure.integration.ts` (sereus repo; its `docs/testing.md` has "Where measurements live"). Sereus has offered to add a per-phase breakdown on request.
