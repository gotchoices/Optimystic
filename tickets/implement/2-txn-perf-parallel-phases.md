description: Independent per-collection commit steps currently run one after another; run them together instead, and cancel everything cleanly if any one fails.
prereq: txn-perf-authoritative-notfound
files:
  - packages/db-core/src/transaction/coordinator.ts (pendPhase ~lines 612-665, commitPhase ~lines 674-746, cancelPhase ~lines 754-763)
  - packages/db-core/src/transactor/network-transactor.ts (get:retry loop ~lines 133-163)
difficulty: medium
----

# Perf (b): parallelize independent per-collection phases and per-batch retries

Prereq note: chained after `txn-perf-authoritative-notfound` only because both
edit `network-transactor.ts` — serialize the edits to avoid a merge conflict.
There is no logical dependency; assume (a) has landed.

## Problem

Two spots do independent work strictly serially:

**1. `TransactionCoordinator.pendPhase` / `commitPhase`** (`coordinator.ts`).
`pendPhase` loops `collectionTransforms` and `await`s `transactor.pend` one
collection at a time (lines 627-662). `commitPhase` loops `pendedBlockIds` and
`await`s `transactor.commit` one collection at a time (lines 688-743). The pends
are independent of each other; so are the commits. Serial awaits mean total
latency = sum over collections instead of max.

**2. `NetworkTransactor.get()` second-chance retry** (`network-transactor.ts`).
The retry loop (lines 136-158) iterates `retryable` batches with an `await`
inside the `for`, so each retryable batch's `findCoordinator` + `get` happens
after the previous one finishes. Independent per batch.

## Fix direction

Parallelize each, with a **cancel-all-on-failure** policy (not
cancel-only-those-before-the-failure, which is today's serial behavior).

### pendPhase

Replace the serial loop with a concurrent fan-out (`Promise.allSettled` over the
collections). On *any* rejection/failure, cancel **every** collection that
successfully pended — collect the pended block-id lists from the settled results
first, then cancel them. Today's code only cancels the collections pended *before*
the failing one (lines 649-658); with concurrency, several may have pended in
parallel, so all successful ones must be cancelled.

Preserve the existing return contract: `{ success, error?, pendedBlockIds? }`,
`pendedBlockIds` keyed by collectionId. Keep the "Collection not found" guard as
a per-collection failure.

### commitPhase

Fan out the per-collection commit-with-retry (the inner 3-attempt loop, lines
728-742) concurrently across collections. Aggregate `committedCollections` /
`failedCollections` from the settled results. If any collection ultimately fails,
return `success:false` with the partitioned sets so the existing `cancelPhase`
(coordinator.ts:754-763) can do its targeted cancel of not-yet-committed
collections. `cancelPhase` itself can also fan out its per-collection cancels.

### get:retry

Wrap the per-batch retry body (lines 137-158) in `Promise.allSettled` over
`retryable` so the retry rounds proceed concurrently. Each batch already builds
its own excluded-peer set and attaches `subsumedBy`; that is independent per
root batch, so concurrent execution is safe. Preserve the existing
`if (!error) error = e` first-error-wins behavior on the aggregate.

## Interactions / cautions

- **tx-2** (parallel pend cleanup) and **tx-9** (retry policy): keep the
  cancel-on-failure semantics consistent with those. If tx-2 introduces a shared
  cleanup helper, prefer reusing it over a second ad-hoc cancel path.
- `structuredClone`/tracker state in the coordinator is touched *before* these
  phases (during apply), not during pend/commit, so parallel pend/commit does not
  race collection tracker state. Verify no shared mutable state is written inside
  the fanned-out bodies.
- Cancels are best-effort (background microtasks elsewhere in the code). Keep the
  cancel failures from masking the original pend/commit error.

## Expected behavior

Independent per-collection pends and commits proceed concurrently; a failure in
any one cancels all successfully-pended collections. Per-batch get retries run
concurrently. No change to success/failure outcomes, only to latency and to the
breadth of the cancel-on-failure sweep.

## TODO

- Rewrite `pendPhase` to fan out per-collection pends (`Promise.allSettled`);
  on any failure cancel every successfully-pended collection.
- Rewrite `commitPhase` to fan out per-collection commit-with-retry; aggregate
  committed/failed sets; keep the partitioned return for `cancelPhase`.
- Optionally fan out `cancelPhase`'s per-collection cancels.
- Parallelize the `get:retry` loop in `network-transactor.ts` with
  `Promise.allSettled`; preserve first-error-wins.
- Add/extend a coordinator test asserting: N independent collections pend
  concurrently (e.g. count overlapping in-flight pends via a mock transactor),
  and a mid-fan-out failure cancels all successful pends.
- Build + test db-core; stream output with `tee`.
