description: The code that retries a write and recovers a half-saved one has grown into one very long function inside one very long file, mostly comments, which makes each new fix to it harder to review than the last.
files:
  - packages/db-core/src/collection/collection.ts (`syncAttempts`, `syncInternal`, `completeOwnEntry`, `settleUnfinished`, `dischargeOwnPendings`, `lineageOfOwnEntry`, `throwTorn`, `actAndSync`, `unstage`, `consumeOwnEntry`, `beginInFlightAction`, `retainInFlightAttempt`, the `inFlightActionId` / `inFlightAttempt` fields)
  - packages/db-core/src/transaction/coordinator.ts (`commit` — a second copy of the same "retry the refresh while finishing is refused" loop)
difficulty: medium
tradeoffs: The code is correct and heavily tested, the comments are what make its subtle rules survivable, and moving it risks regressions in the most delicate path in the package for no change in behaviour — a maintainer could reasonably wait until the next functional change to this path and restructure then.
----

# Measured

`wc -l packages/db-core/src/collection/collection.ts` → 1559 lines (2026-09-16, after ticket `a-write-whose-log-entry-landed-alone-is-reported-saved`, which added about 280 of them). `syncAttempts` alone runs from roughly line 1199 to line 1450 — about 250 lines in one function, with a retry loop nested inside a retry loop, and more comment than code. `packages/db-core/src/transaction/coordinator.ts` is 1536 lines and its `commit` now carries a near-copy of the inner loop ("back off, refresh, and if finishing the half-saved write was refused for a cause that can clear, count it against the budget and refresh again").

# What is wanted

The write-retry machinery is a cohesive unit with its own state (the in-flight action id, the retained failed attempt, the failure counters, the stall check). It should read as a handful of short, named steps — *make an attempt*, *retain it*, *refresh until finished or refused*, *account for the failure* — rather than one function the reader has to hold in their head, and the collection path and the multi-collection path should share the "refresh until finished or refused" step instead of each spelling it out. Behaviour must not change; the existing specs (`own-entry-completes-the-action.spec.ts`, `collection-own-action-replay.spec.ts`, `coordinator-own-action-replay.spec.ts`, the sync retry and stall specs) are the safety net.

The long explanatory comments mostly restate rules that are also in `docs/internals.md`. Where a step gets a name that says what it does, the comment at the call site can shrink to a pointer.

# Re-measured by `a-write-reported-torn-can-already-be-saved` (2026-09-17)

`wc -l packages/db-core/src/collection/collection.ts` → 1965 lines: that ticket added the settlement of an unfinished write (`settleUnfinished`, `dischargeOwnPendings`, `lineageOfOwnEntry`, `throwTorn`) and the stage-and-flush bracket `Tree.replace` / `Diary.append` use (`actAndSync`, `unstage`). The retry loop itself did not grow; the new methods sit beside it and are small. The argument for this ticket is unchanged and a little stronger.
