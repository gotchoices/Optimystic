description: Review the patience-budget threading for the multi-cohort sweep — both legs of quorum discovery now honour the caller's time budget.
files:
  - packages/db-core/src/matchmaking/multi-cohort-seeker.ts
  - packages/db-p2p/src/matchmaking/module.ts
  - packages/db-core/src/matchmaking/voting-quorum.ts
  - packages/db-core/test/matchmaking/multi-cohort-seeker.spec.ts
  - packages/db-p2p/test/matchmaking/module.spec.ts
----

## What was done

Implemented the patience-budget threading for the multi-cohort sweep leg of voting-quorum discovery, mirroring the walk leg's wall-clock deadline model.

### db-core — `runMultiCohortSweep` (`multi-cohort-seeker.ts`)

Two optional fields added to `MultiCohortSweepOptions`:
- `patienceMs?: number` — patience budget for the entire sweep fan-out
- `clock?: () => number` — injectable clock for tests

In `runMultiCohortSweep`:
- When `patienceMs` is set, a `deadline = clock() + patienceMs` is fixed at entry and `remaining()` is computed before each shard query.
- If the budget is **already drained on entry** (`remaining() <= 0`), `fetchAggregate` is skipped entirely and an empty result is returned immediately.
- The shard loop breaks as soon as `remaining() <= 0` — stopping *starting* new queries (in-flight RPCs are not cancelled, as noted in the docstring).
- When `patienceMs` is absent, all elected shards are queried unchanged.

### db-p2p — `module.ts`

Two call sites updated:

1. **`createMatchmakingQuorumDiscovery.sweep`** (primary): now passes `patienceMs: req.patienceMs` and `clock` from `deps.clock`. The assembler already passes `remaining()` as `req.patienceMs` so the draining slice correctly gates the sweep.

2. **`MatchmakingSeekerSession.walk`**: now passes `patienceMs: want.patienceMs` and `clock`. Comment notes this is a fresh (coarser) bound rather than a draining remainder, since the SeekerWalkClient ran on its own deadline — still strictly better than unbounded.

### db-core — `voting-quorum.ts`

`assembleQuorum` docstring updated to reflect the stronger guarantee: both the walk and sweep now honour `patienceMs`, with the residual being at most one in-flight shard RPC.

## Tests added

**`packages/db-core/test/matchmaking/multi-cohort-seeker.spec.ts`** (3 new tests):
- `already-drained budget (patienceMs: 0) skips fetchAggregate and queries zero shards`
- `budget that drains mid-fan-out stops querying further shards` — virtual clock advances 100 ms per shard; patienceMs=150 → 2 of 3 shards queried
- `generous budget queries all selected shards (parity with today)` — large patienceMs → all shards queried

**`packages/db-p2p/test/matchmaking/module.spec.ts`** (1 new test):
- `sweep threads req.patienceMs — a tight budget stops querying shards early` — same virtual-clock pattern via `createMatchmakingQuorumDiscovery`, confirms the budget is wired through end-to-end

## Test results

- `db-core`: 827 passing
- `db-p2p`: 733 passing, 27 pending (integration tests, expected)

## Known gaps / reviewer notes

- **No in-flight RPC cancellation**: once a `queryShard` call is started, it runs to completion even if the deadline passes mid-flight. The docstring is honest about this. True cancellation would require threading an `AbortSignal` into `MultiCohortSweepPorts.queryShard` — deferred to a follow-up if needed.
- **`MatchmakingSeekerSession.walk` uses a fresh budget** (not a draining remainder). This is weaker than the quorum path but still bounded. The comment in the code flags this tradeoff.
- The `aggregateTrusted` logic (lines 190-193 of `multi-cohort-seeker.ts`) has a subtle: `aggregateTrusted` is set to `true` when a `verifyAggregate` function exists, regardless of whether it passed. The `false` branch is the early-return on failure, so the actual logic is correct — but the variable name/placement may deserve a second look.
