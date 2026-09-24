description: When a coordinator gave up re-sending a commit to a cohort member that stayed unreachable, it kept that transaction's bookkeeping in memory for the rest of the process's life; it now releases it, as the other two ways a transaction can end already did.
architecture: packages/db-p2p/docs/cluster.md#commit-retry-loop
files: packages/db-p2p/src/repo/cluster-coordinator.ts (`releaseTransaction`, `clearRetry`, `scheduleCommitRetry`, `executeClusterTransaction`'s `finally`, the `ReleaseReason` type), packages/db-p2p/test/cluster-coordinator.spec.ts (`ClusterCoordinator retry logic (TEST-5.2.1)`), docs/debugging.md (the `cluster-tx:complete` entry), packages/db-p2p/docs/cluster.md (`Commit Retry Loop`)
----
# An abandoned commit retry now releases its transaction

## What changed

`ClusterCoordinator` keeps one entry per in-flight transaction in its `transactions` map. A transaction can end three ways — the commit finished with no retry pending, a live retry caught every peer up, or a retry gave up with peers still missing — and only the first two used to remove the entry. The third, the `cluster-tx:retry-abort` branch of `scheduleCommitRetry`, removed nothing: the `finally` of `executeClusterTransaction` had already run and skipped cleanup because a retry was pending at that moment, and `clearRetry` never fires on that path. The entry, its dead `retry` object and the persisted coordinator state stayed for the life of the process, and the hash kept appearing in the key list every later `cluster-tx:transaction-store` and `cluster-tx:transaction-remove` line prints.

All three exits now go through one new private `releaseTransaction(messageHash, reason)`. It cancels and clears any armed retry, then — on the same 100 ms deferral the completion path has always used, so an in-flight member response still finds a live entry to merge into — deletes the map entry and the persisted coordinator state and logs `cluster-tx:transaction-remove`. The new `reason` field on that line says which exit released it: `complete`, `retry-finished`, or `retry-abandoned`.

Both existing guards are unchanged and load-bearing:

- the `finally`'s `if (!stored?.retry)` — a live retry still owns the release;
- `clearRetry`'s `if (!state?.retry) return` — the ordinary all-peers-committed path calls `clearRetry` with no retry ever armed, and the `finally` releases moments later, so without this guard that path would release twice and print two removal lines.

No timer leaked before this change and none leaks now; this was a memory and bookkeeping leak only.

## How to check it

`yarn workspace @optimystic/db-p2p test --grep "ClusterCoordinator"` is the fast loop (36 tests, ~80 ms — the whole block runs on the fake clock).

The load-bearing manual check, which the reviewer should repeat rather than take on trust: comment out the `releaseTransaction` call in the abort branch of `scheduleCommitRetry` and re-run. The new test must fail with `the abandoned retry released the transaction entry: expected { …(5) } to equal undefined`. That was verified during implementation.

Worth a reviewer's eye:

- **The `clearRetry` guard.** Try removing it and confirm `completes without retry when all peers commit` still passes — it does, because the assertions there count `updateCalls`, not removal lines. The double release is only visible in the log, and nothing asserts on logs. So that guard is protected by reasoning and a comment, not by a test. Deliberate (a test that asserts on a debug log line is worse than the risk), but it is the weakest spot in this change and it should be looked at rather than assumed.
- **Release with no entry held.** `releaseTransaction` arms its deferred delete whether or not `transactions` currently holds the hash, because the persisted state still has to go for a hash already gone from memory. That is what the old `finally` did and it must not regress. It has no direct test; the reviewer can read the two call sites that can reach it entry-less (`executeClusterTransaction`'s `finally` after a concurrent release, and `clearRetry` — which cannot, since its guard requires an entry).
- **`recoverTransactions` also calls `scheduleCommitRetry`**, so a recovered transaction whose persisted `retryState.attempt` is already at the budget hits the abort branch and now releases — which is the right answer (it deletes the persisted state that would otherwise be re-read on every restart), but it is a path this change touches without a test.

## Tests

| test | what it verifies |
| --- | --- |
| `releases the transaction when the retry budget runs out` (new, in `ClusterCoordinator retry logic (TEST-5.2.1)`) | the reproduction: three-member cohort, third member's commit always throws, driven through all five default attempts (250, 500, 1000, 2000, 4000 ms) and then past the 100 ms deferral. Asserts the entry is held while the retry is pending, and afterwards that the `transactions` entry is gone, the persisted coordinator state is gone, and no timers are left armed. |
| `retry succeeds when peer recovers` (one line added) | the finished-retry exit still releases — the assertion that keeps the refactor honest about the path that already worked. |

The completed-with-no-retry exit needed nothing new: the existing block drives it end to end.

The shared `beforeEach` now builds the coordinator with an `InMemoryStateStore` (declared lower in the same file) in place of the `undefined` state store, which is what lets the new test assert on the persisted state. It is inert for the other tests in the block — map writes, no timers — and all 36 still pass.

## Docs

- `docs/debugging.md`, the `cluster-tx:complete` entry: the sentence that named this ticket's slug and said the entry is never removed on `cluster-tx:retry-abort` is replaced by the new behaviour, and the entry now mentions the `reason` field.
- `packages/db-p2p/docs/cluster.md`, `Commit Retry Loop`: the closing sentence said the coordinator keeps the transaction in memory while any peers remain unfixed. It now says the entry is held while the retry is live and released when the retry ends, whichever way, and names `releaseTransaction` as the single site.

## Validation run

- `yarn workspace @optimystic/db-p2p test` — 3113 passing, 63 pending (pre-existing env-gated skips), 0 failing.
- `yarn lint:docs` — 47 documents, all citations and links resolve.
- `yarn workspace @optimystic/db-p2p build` and `yarn lint` — both clean.

Not run: `yarn test:integration` and `yarn check:rn`, neither of which this change plausibly touches (no wire format, no new import, no node-startup path).

## Out of scope, unchanged

Abandoning a retry stays silent to the cohort: no abandonment broadcast, no reputation penalty for the member that stayed away. `cluster-tx:retry-abort` remains the operator's signal. The backlog ticket `feat-long-lived-pend-completes-as-members-appear` also names `scheduleCommitRetry` and `recoverTransactions`, but it wants these transactions to live *longer*; nothing here was shaped around it.
