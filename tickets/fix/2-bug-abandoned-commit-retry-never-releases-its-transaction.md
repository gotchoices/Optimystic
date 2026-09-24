description: When a coordinator gives up re-sending a commit to a cohort member that stayed unreachable, it keeps that transaction's bookkeeping in memory for the rest of the process's life instead of releasing it, so a long-running node with flaky peers slowly accumulates dead entries.
files: packages/db-p2p/src/repo/cluster-coordinator.ts (`scheduleCommitRetry`, `clearRetry`, `retryCommits`, `executeClusterTransaction`'s `finally`), docs/debugging.md (the `cluster-tx:complete` entry mentions this ticket by slug — update it when fixed)
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: Each leaked entry is one cluster record, and it only happens when a member stays unreachable for the whole retry budget (about 8 s with the defaults), so a node that restarts now and then may never notice; a maintainer could reasonably defer it until memory growth shows up.
----
# An abandoned commit retry never releases its transaction entry

## What happens

`ClusterCoordinator` keeps one entry per in-flight transaction in its `transactions` map. After a commit, if some cohort members missed the broadcast, `scheduleCommitRetry` keeps re-sending it on a backoff timer. There are exactly two places that remove an entry from `transactions`, both on a 100 ms timer that also logs `cluster-tx:transaction-remove`:

- the `finally` of `executeClusterTransaction`, but only when no retry is pending (`!stored?.retry`);
- `clearRetry`, which runs when the retry finishes (`cluster-tx:retry-finished`, every pending peer reached) or when there is nothing left to retry.

When the retry budget runs out (`commitBroadcastRetryMaxAttempts`, default 5), `scheduleCommitRetry` logs `cluster-tx:retry-abort` and returns. It does not call `clearRetry` or remove the entry. The `finally` already ran long ago and skipped cleanup because a retry was pending then. So nothing ever removes that entry, and it stays in memory, holding the whole `ClusterRecord`, until the process exits. It also keeps appearing in every later `cluster-tx:transaction-store` / `transaction-remove` line's list of keys.

The persisted copy (`persistCoordinatorState` with phase `broadcasting`) is not deleted either. It is bounded, though: on restart `recoverTransactions` drops it once the message's expiration (30 s after creation by default) has passed, or otherwise resumes the retry with a fresh budget.

## How it would be confirmed

Static reading only. A unit test would confirm it: drive a commit through a `ClusterCoordinator` where one member's `update` always throws, advance timers past the whole retry budget, and assert that the `transactions` entry for that `messageHash` is gone (today it would still be there) and that a `cluster-tx:transaction-remove` was logged.

## Expected behavior

Giving up on a retry is a terminal outcome, just as finishing one is. The entry, and its persisted state, should be released on that path too, and `cluster-tx:transaction-remove` should follow `cluster-tx:retry-abort` the way it follows `cluster-tx:retry-finished`.

A shape to consider, rather than a third ad-hoc delete site: route every terminal outcome through one release function, so that a future exit cannot forget cleanup again.
