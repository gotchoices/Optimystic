----
description: When the storage backend keeps rejecting a save, the collection's save routine retries forever, freezing every other read and write on that collection; give it a retry limit, a growing pause between tries, and a clear error when it gives up.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/collection/struct.ts, packages/db-core/src/collection/index.ts, packages/db-core/src/index.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/test-transactor.ts
difficulty: medium
----

## Problem (confirmed by reproduction)

`Collection.syncInternal` (packages/db-core/src/collection/collection.ts:253-294) drives a
`while (this.pending.length || !isTransformsEmpty(this.tracker.transforms))` loop. Each iteration
snapshots pending, builds the log transform, and calls `this.source.transact(...)`. On a
`StaleFailure` return it:

- sleeps `PendingRetryDelayMs` (100 ms, fixed) **only when `staleFailure.pending` is set**, then
- calls `updateInternal()` (which may `replayActions()` on conflict) and loops again.

There is no attempt cap, no deadline, no exponential backoff, and no abort signal. A transactor
that *persistently* rejects the sync (returns a `StaleFailure` with `pending` undefined — e.g. a
`{ success: false, reason }` commit failure, or a `missing` conflict that `updateInternal` can't
clear because the pending set never drains) turns `sync()` into a tight async loop with **zero
delay** (the 100 ms sleep is skipped when `pending` is absent). The loop holds the collection latch
(`Latches.acquire(this.latchId)` in `sync()` at collection.ts:245) for its entire duration, so every
concurrent `act()` / `update()` / `sync()` / `updateAndSync()` on that collection blocks forever.

### Reproduction (verified during fix stage)

A `FlakyCommitTransactor` wrapping `TestTransactor` whose `commit()` returns
`{ success: false, reason: 'forced stale' }` the first N times, then delegates. Pointed a fresh
`Collection` at it, staged one action, called `sync()`, and asserted the commit-attempt count. With
N = 25 the current code sailed past 25 retries and still resolved with **no error** — proving the
retry budget is unbounded. (A stub that *always* fails was deliberately avoided as a fix-stage probe:
under the current code it infinite-loops, and because the no-`pending` path never yields a macrotask,
a `setTimeout`-based test timeout can be starved and hang the runner. Once the cap lands, an
always-fail stub terminates and is the right shape for the regression test — see TODO.)

## Fix

Add a bounded retry budget with exponential backoff, an optional abort signal, and a typed error
thrown on exhaustion. Thread an optional options bag through `sync()` / `updateAndSync()`.

### Critical design nuance — cap *consecutive no-progress retries*, not loop iterations

The `while` loop is **not** purely a retry loop. On a *successful* `transact`, it slices the
committed batch off `pending` (collection.ts:284) and loops again to commit whatever pending/transforms
remain — a legitimate large multi-batch sync iterates many times making forward progress. So a naive
"max N iterations" cap would falsely trip on big syncs.

The budget must therefore track **consecutive stale-failure retries that made no progress**:
- increment a counter each time `transact` returns a `StaleFailure`;
- **reset the counter to 0 on every successful `transact`** (the success branch, collection.ts:282-292);
- throw the typed error when the counter exceeds `maxAttempts`.

A wall-clock **deadline** is an acceptable *additional* bound (and is progress-agnostic, so it can
coexist), but the count-based bound must use the consecutive-failure semantics above.

### Backoff on every stale failure, not just `pending`

Move the backoff sleep so it runs on **any** `StaleFailure` (the `reason` / `missing` cases included),
using exponential growth from a base delay, capped at a max. Keep the `pending` case covered too. The
current "sleep only if `pending`" is exactly what makes the persistent-`reason` case a hot spin.

### Suggested shape (hint, not prescription)

```ts
// collection/struct.ts (or a new options module) — exported type
export interface SyncOptions {
  /** Max consecutive no-progress stale-failure retries before giving up. Default e.g. 10. */
  maxAttempts?: number;
  /** Optional wall-clock deadline in ms from sync start; independent of attempt count. */
  deadlineMs?: number;
  /** Base backoff delay in ms (first retry). Default 100 (current PendingRetryDelayMs). */
  baseBackoffMs?: number;
  /** Upper bound on a single backoff sleep. Default e.g. 5000. */
  maxBackoffMs?: number;
  /** Abort the retry loop cooperatively. Checked at loop top and during backoff sleep. */
  signal?: AbortSignal;
}

// A typed, catchable error — export from collection/index.ts and packages/db-core/src/index.ts
export class SyncRetryExhaustedError extends Error {
  constructor(
    readonly collectionId: CollectionId,
    readonly attempts: number,
    readonly lastReason?: string,
  ) {
    super(`sync for collection ${collectionId} exhausted ${attempts} retries` +
      (lastReason ? `: ${lastReason}` : ''));
    this.name = 'SyncRetryExhaustedError';
  }
}
```

Backoff sleep should be abortable — race the `setTimeout` against `signal`'s abort so an aborted sync
rejects promptly (with an abort error) instead of finishing the current sleep. Check `signal?.aborted`
at the top of each loop iteration too.

Interface impact: `ICollection` (collection/struct.ts:8-15) declares `sync()` and `updateAndSync()`;
widen both to accept an optional `SyncOptions`. `updateAndSync()` (collection.ts:296-304) should pass
the options through to `syncInternal`. `sync()` (collection.ts:244-251) likewise. Existing callers
(`tree.ts:75,91`, `diary.ts:35`) call with no args and keep working via the default budget.

### Preserve existing behavior

- A single successful sync (no failures) must behave exactly as today.
- A legitimate large multi-batch sync (e.g. the existing "should handle large number of actions" and
  100-action tests) must still pass — this is the guard that the cap counts consecutive failures, not
  total iterations.
- On exhaustion / abort, the `finally` in `sync()` still runs and releases the latch (it already does),
  so the collection is not left latched after the throw. Confirm the throw propagates out of
  `syncInternal` → `sync()`/`updateAndSync()` and the latch releases.
- Keep `PendingRetryDelayMs` semantics as the default `baseBackoffMs` so unconfigured behavior only
  changes by *adding* a ceiling, not by changing the first-retry delay.

## TODO

- Add `SyncOptions` type and a `SyncRetryExhaustedError` class (export from
  `collection/index.ts` and `packages/db-core/src/index.ts`).
- Rework `syncInternal` (collection.ts:253-294): track consecutive no-progress stale-failure count,
  reset on success, back off exponentially (base → cap) on **every** stale failure, honor `deadlineMs`
  and `signal`, and throw `SyncRetryExhaustedError` when the budget is exhausted.
- Widen `ICollection.sync` / `ICollection.updateAndSync` (collection/struct.ts) and the concrete
  `sync()` / `updateAndSync()` to accept optional `SyncOptions`; thread through to `syncInternal`.
- Make the backoff sleep abortable via `signal`.
- Add regression tests in `packages/db-core/test/collection.spec.ts`:
  - A stub transactor that **always** returns a `StaleFailure` → `sync({ maxAttempts: 3 })` rejects
    with `SyncRetryExhaustedError` and the transactor saw a bounded number of commit attempts (now
    safe to use an always-fail stub since the cap terminates the loop). Consider adding the stub as a
    reusable helper near `test-transactor.ts` or inline in the spec.
  - An abort test: pass an `AbortSignal`, abort mid-retry, assert `sync()` rejects promptly.
  - A guard test: 100-action / multi-batch sync against a healthy transactor still succeeds with a
    small `maxAttempts` (proves the cap is on consecutive failures, not total iterations).
- Run `yarn test` (or `npm test`) in `packages/db-core` and stream output
  (`... 2>&1 | tee /tmp/db-core-test.log`); confirm the full suite passes.
- Note: the test suite has an import-order quirk — running a single collection spec file in isolation
  fails with `Cannot access 'collectionTypes' before initialization` (a `diary.ts` ↔
  `collection-type-registry.ts` init cycle). Run the whole suite, or pair with
  `collection-type-registry.spec.ts` first, when spot-checking. Not in scope for this ticket.
