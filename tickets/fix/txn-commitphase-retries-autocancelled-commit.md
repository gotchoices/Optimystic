description: When a commit fails, one layer immediately tears it down while another layer blindly retries the very thing that was just torn down — and it also keeps retrying failures that can never succeed, so retries race the cleanup and are wrong to attempt at all.
files:
  - packages/db-core/src/transaction/coordinator.ts (commitPhase retry loop, ~lines 786-800)
  - packages/db-core/src/transactor/network-transactor.ts (commitBlock fires cancel on failure, ~line 573)
difficulty: medium
----

# commitPhase retries a commit the transactor already auto-cancelled

## The bug

On a failed commit, `NetworkTransactor.commitBlock` immediately fires
`cancel(...)` for the whole action. Yet `commitPhase` retries the same commit request
up to three times — racing against, or following, the cancel of the very pend it
needs to commit against.

Worse, stale failures are *permanent*: blindly re-issuing the identical request can
never succeed, so retrying is wrong for that class of failure regardless of the race.

## Expected behavior

Retries happen only for genuinely transient errors (thrown/network), never for
permanent stale failures, and the retry logic and the transactor's internal
auto-cancel do not fight each other over the same pend.

## Suggested direction (hint, not a mandate)

Retry only thrown/transient errors; do not retry stale failures. Own the retry policy
in exactly one layer — either suppress the transactor's internal auto-cancel while a
coordinator-level retry policy is active, or move retries entirely into the
transactor. Coordinate with tx-5 (the fire-and-forget cancel that must not crash) and
tx-2 (pend-phase cleanup) so cancellation happens exactly once per pend.

Severity: MEDIUM.
