description: When a coordinator gives up re-sending a commit to a cohort member that stayed unreachable, it keeps that transaction's bookkeeping in memory for the rest of the process's life instead of releasing it, so a long-running node with flaky peers slowly accumulates dead entries.
architecture: packages/db-p2p/docs/cluster.md#commit-retry-loop
files: packages/db-p2p/src/repo/cluster-coordinator.ts (`executeClusterTransaction`'s `finally`, `scheduleCommitRetry`, `clearRetry`), packages/db-p2p/test/cluster-coordinator.spec.ts (the `ClusterCoordinator retry logic (TEST-5.2.1)` describe already has the whole harness), docs/debugging.md (the `cluster-tx:complete` entry names this ticket by slug), packages/db-p2p/docs/cluster.md (the `Commit Retry Loop` section's closing sentence)
repro: verified
----
# An abandoned commit retry never releases its transaction entry

## Confirmed

Reproduced with a unit test against `ClusterCoordinator` on the existing fake-clock harness: a three-member cohort where one member's `update` always throws on the commit phase, driven past the whole default retry budget. At the end, the coordinator still holds the transaction entry, still holds a stale `retry` object on it, and the persisted coordinator state is still in the store. No timers leak — this is a memory and bookkeeping leak only.

Observed end state after the budget ran out, versus what should be there:

| | today | wanted |
| --- | --- | --- |
| entry in the `transactions` map | present | gone |
| `state.retry` on that entry | present (a dead retry, its timer already fired) | gone |
| persisted coordinator state (`broadcasting` phase) | present | gone |
| armed timers | none | none |

## Why

`ClusterCoordinator` keeps one entry per in-flight transaction in its `transactions` map, and there are exactly two places that remove one — both on a 100 ms timer that also logs `cluster-tx:transaction-remove`:

- the `finally` of `executeClusterTransaction`, but only when no retry is pending (`!stored?.retry`);
- `clearRetry`, which runs when the retry finishes (`cluster-tx:retry-finished`) or when there is nothing left to retry.

Giving up is the third terminal outcome and it takes neither of those exits. When the budget runs out, `scheduleCommitRetry` logs `cluster-tx:retry-abort` and returns. The `finally` already ran, back when a retry was still pending, and skipped cleanup on that basis. So nothing removes the entry, and it holds the whole `ClusterRecord` until the process exits. It also keeps appearing in the key list that every later `cluster-tx:transaction-store` and `cluster-tx:transaction-remove` line prints.

The persisted copy is bounded rather than unbounded: on restart `recoverTransactions` drops it once the message's expiration has passed, or else resumes the retry with a fresh budget. The in-memory entry has no such backstop. That recovery path is also the one place where a leak has no fallback at all — a recovered transaction has no enclosing `executeClusterTransaction`, so there is no `finally` for that entry at any point in its life.

## The change

Route all three terminal outcomes through one release function, rather than adding a third ad-hoc delete site, so a terminal path added later cannot forget the cleanup again. This shape was prototyped and verified against the reproduction and the existing coordinator specs.

Add a private `releaseTransaction(messageHash, reason)` to `ClusterCoordinator` that cancels any armed retry, clears `state.retry`, and then — on the existing 100 ms deferral, which is there to let any in-flight member responses still arrive — deletes the map entry and the persisted coordinator state and logs `cluster-tx:transaction-remove`. It must schedule that deferred delete whether or not an entry is currently held, so the persisted state is still deleted for a hash already gone from memory; that is what today's `finally` does, and it should not regress.

Then point the three exits at it:

- the `finally` of `executeClusterTransaction`, keeping its `if (!stored?.retry)` guard — a live retry still owns the release;
- `clearRetry`, keeping its own `if (!state?.retry) return` guard, so the ordinary all-peers-committed path (where `clearRetry` is called with no retry ever armed, and the `finally` does the release moments later) does not start releasing twice and printing two removal lines;
- the abort branch of `scheduleCommitRetry`, which is the leak.

Give the log line a `reason` field naming which exit it came from, so an operator reading a log can tell a completed transaction from a finished retry from an abandoned one.

One ordering fact worth having in mind while editing: both calls into `scheduleOrClearRetry` happen inside `commitTransaction`, which the `finally` awaits, so a retry is always armed (or not) before the `finally` looks. There is no path today where the `finally` and a retry exit race to release the same entry.

## Tests

The reproduction belongs in the existing `ClusterCoordinator retry logic (TEST-5.2.1)` describe in `packages/db-p2p/test/cluster-coordinator.spec.ts` — it already has the fake clock, the timer queue, the `flush()` helper, the three-peer cohort and a mock member that can be told to fail its commit. Two changes there:

- Wire an `InMemoryStateStore` (already defined lower in the same file) into the coordinator the shared `beforeEach` builds, in place of the `undefined` state store. This is inert for the other tests in the block — it adds map writes and no timers — and it is what lets the new test assert the persisted state is released too. Referencing the class from a `beforeEach` that runs after module evaluation is fine despite it being declared further down the file.
- One new test: make the third member fail its commit, run the transaction, assert the entry is held while the retry is pending, then advance the fake clock through the five default attempts (250, 500, 1000, 2000 and 4000 ms, each followed by `await flush()` because the retry callback is async), then past the 100 ms deferral. Assert the `transactions` entry is gone, the persisted coordinator state is gone, and no timers are left armed.

Add one assertion to the existing `retry succeeds when peer recovers` test — after its final `clock.advance(5000)`, the entry should be gone. That path already fires the release; the assertion is what keeps the refactor honest about the finished-retry exit, and it costs a line.

Nothing else needs a new test: the completed-with-no-retry exit is the one the existing block already drives end to end.

## Docs

Both of these state the current behaviour as the leak, so both move with the code:

- `docs/debugging.md`, the `cluster-tx:complete` entry — the sentence naming this ticket's slug says that on `cluster-tx:retry-abort` the entry is never removed from memory. Replace it with the new behaviour: a `cluster-tx:transaction-remove` follows the abort just as it follows `cluster-tx:retry-finished`. Mention the `reason` field while the entry is being edited.
- `packages/db-p2p/docs/cluster.md`, the `Commit Retry Loop` section — its closing sentence says the coordinator keeps the transaction in memory while any peers remain unfixed. That should say the entry is held while the retry is live and released when the retry ends, whichever way it ends.

## Not in scope

Abandoning a retry stays silent to the cohort: no abandonment broadcast, no reputation penalty for the member that stayed away. The commit already reached a simple majority by the time any retry is armed, and a member that missed it heals on its own reads. `cluster-tx:retry-abort` remains the operator's signal, as `packages/db-p2p/docs/cluster.md` says.

The backlog ticket `feat-long-lived-pend-completes-as-members-appear` also names `scheduleCommitRetry`, `retryCommits` and `recoverTransactions`, but it is about making a pend survive and complete across restarts — it wants these transactions to live longer, not to be released differently. There is no overlap with this change, and nothing here should be shaped around it.

## TODO

- [ ] Add `releaseTransaction(messageHash, reason)` to `ClusterCoordinator`: cancel and clear any armed retry, then schedule the existing 100 ms deferred delete of the map entry and the persisted coordinator state, logging `cluster-tx:transaction-remove` with the reason. Schedule the deferred delete even when no entry is held.
- [ ] Point `executeClusterTransaction`'s `finally` at it, keeping the `!stored?.retry` guard.
- [ ] Point `clearRetry` at it, keeping its `!state?.retry` guard.
- [ ] Call it from the abort branch of `scheduleCommitRetry`, right after the `cluster-tx:retry-abort` line.
- [ ] Wire an `InMemoryStateStore` into the coordinator built by the `ClusterCoordinator retry logic (TEST-5.2.1)` `beforeEach`.
- [ ] Add the abandoned-retry reproduction test described above to that describe block.
- [ ] Add the release assertion to `retry succeeds when peer recovers`.
- [ ] Update the `cluster-tx:complete` entry in `docs/debugging.md` (it names this ticket's slug).
- [ ] Update the closing sentence of `Commit Retry Loop` in `packages/db-p2p/docs/cluster.md`.
- [ ] `yarn workspace @optimystic/db-p2p test` green; `yarn lint:docs` green.
