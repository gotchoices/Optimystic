----
description: Review the removal of real-time sleeps from db-core coordinator and transaction tests, replaced with condition polling and zero-latency async yields.
prereq: test-wait-helpers
files: packages/db-core/test/coordinator.spec.ts, packages/db-core/test/collection.spec.ts, packages/db-core/test/transaction.spec.ts
----

## What was done

Three test files had real-time `setTimeout`-based sleeps that introduced timing nondeterminism. All were eliminated:

### coordinator.spec.ts
- Removed the top-level `delay` helper and `stepMs` constructor parameter from `InstrumentedTransactor`.
- Both `pend()` and `commit()` mock methods now use `await Promise.resolve()` instead of `await delay(stepMs)`.
- This preserves the async yield needed for `pendMaxInFlight`/`commitMaxInFlight` fan-out tracking (counters increment before the first `await`, so all N calls register concurrently) while removing wall-clock latency.
- Updated two constructor callsites that explicitly passed `5` as `stepMs` to use the new 3-parameter signature.

### collection.spec.ts
- Added `import { waitFor }` from `../src/testing/async-wait.js`.
- "should reject promptly with an AbortError when the signal aborts mid-retry" — replaced `await new Promise(resolve => setTimeout(resolve, 25))` with `await waitFor(() => flaky.commitAttempts >= 1, ...)`. Polls the `FlakyCommitTransactor.commitAttempts` counter to confirm sync has entered backoff before aborting.

### transaction.spec.ts
- Added `import { waitFor }` from `../src/testing/async-wait.js`.
- "keeps every statement even when an early apply is slow" (line ~1697) — the 15ms delay was inside the mock `coordinator.applyActions` override, simulating a slow call. Replaced with `await Promise.resolve()` (async character preserved, no real-time delay).
- "TransactionSession.commit rejects expired transaction" (line ~3655) — replaced `setTimeout(resolve, 5)` (hoping 5ms outlasts a 1ms TTL) with `waitFor(() => isTransactionExpired(session.getStamp()), ...)`. `isTransactionExpired` is already imported.
- "rejects promptly with an AbortError when the signal aborts mid-backoff" (line ~4329) — replaced `setTimeout(resolve, 25)` with `waitFor(() => flaky.commitAttempts >= 1, ...)`. Same pattern as collection.spec.ts.

## Test results

`yarn workspace @optimystic/db-core test` — 1266 passing, 0 failing.

## Use cases to validate

- **Abort-mid-backoff (coordinator):** `coordinator.commit()` with `baseBackoffMs: 60_000` and `maxAttempts: 1000` — after poll fires (first commit attempted), abort signal fires → promise rejects with `AbortError`, not `CoordinatorStaleLossError`.
- **Abort-mid-retry (collection):** `collection.sync()` with large backoff — same abort pattern → `AbortError`.
- **Expiry check:** `TransactionSession.commit()` on an expired session (TTL=1ms) → `{ success: false, error: 'expired' }`.
- **Concurrency fan-out:** `pendPhase`/`commitPhase` with N collections — `pendMaxInFlight`/`commitMaxInFlight` == N (the `Promise.resolve()` yield is sufficient to register all N increments before any decrement).

## Known gaps / review notes

- `Promise.resolve()` in `InstrumentedTransactor` is a microtask yield, not a macrotask (`setTimeout(0)` was a macrotask). The concurrency-tracking counter logic works identically either way because increments happen before any yield, but if a future test ever needs to observe side effects across a full event-loop turn, the mock would need upgrading.
- `waitFor` default timeout is 2s, which is generous for all three of these cases but intentionally not tightened to avoid CI flakiness on slow machines.

## Review findings

- No tripwires filed. The `Promise.resolve()` vs macrotask distinction for the mock transactor is noted inline in the review but is not a defect — noted above as a conditional concern.
