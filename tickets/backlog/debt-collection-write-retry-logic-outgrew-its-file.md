description: The code that retries a write and recovers a half-saved one has grown into one very long function inside one very long file, mostly comments, which makes each new fix to it harder to review than the last.
files:
  - packages/db-core/src/collection/collection.ts (`syncAttempts`, `syncInternal`, `completeOwnEntry`, `settleUnfinished`, `dischargeOwnPendings`, `lineageOfOwnEntry`, `throwTorn`, `actAndSync`, `unstage`, `consumeOwnEntry`, `beginInFlightAction`, `retainInFlightAttempt`, the `inFlightActionId` / `inFlightAttempt` fields)
  - packages/db-core/src/transaction/coordinator.ts (`commit` — a second copy of the same "retry the refresh while finishing is refused" loop)
difficulty: medium
tradeoffs: The code is correct and heavily tested, the comments are what make its subtle rules survivable, and moving it risks regressions in the most delicate path in the package for no change in behaviour — a maintainer could reasonably wait until the next functional change to this path and restructure then.
----

# Measured

Re-measured 2026-10-25 (`wc -l`, after ticket `a-writer-refuses-a-block-too-large-to-copy`): `packages/db-core/src/collection/collection.ts` 2534 lines, `packages/db-core/src/transaction/coordinator.ts` 2149 lines. The figures below are the original measurement.

`wc -l packages/db-core/src/collection/collection.ts` → 1559 lines (2026-09-16, after ticket `a-write-whose-log-entry-landed-alone-is-reported-saved`, which added about 280 of them). `syncAttempts` alone runs from roughly line 1199 to line 1450 — about 250 lines in one function, with a retry loop nested inside a retry loop, and more comment than code. `packages/db-core/src/transaction/coordinator.ts` is 1536 lines and its `commit` now carries a near-copy of the inner loop ("back off, refresh, and if finishing the half-saved write was refused for a cause that can clear, count it against the budget and refresh again").

# What is wanted

The write-retry machinery is a cohesive unit with its own state (the in-flight action id, the retained failed attempt, the failure counters, the stall check). It should read as a handful of short, named steps — *make an attempt*, *retain it*, *refresh until finished or refused*, *account for the failure* — rather than one function the reader has to hold in their head, and the collection path and the multi-collection path should share the "refresh until finished or refused" step instead of each spelling it out. Behaviour must not change; the existing specs (`own-entry-completes-the-action.spec.ts`, `collection-own-action-replay.spec.ts`, `coordinator-own-action-replay.spec.ts`, the sync retry and stall specs) are the safety net.

The long explanatory comments mostly restate rules that are also in `docs/internals.md`. Where a step gets a name that says what it does, the comment at the call site can shrink to a pointer.

# Re-measured by `a-write-reported-torn-can-already-be-saved` (2026-09-17)

`wc -l packages/db-core/src/collection/collection.ts` → 1965 lines: that ticket added the settlement of an unfinished write (`settleUnfinished`, `dischargeOwnPendings`, `lineageOfOwnEntry`, `throwTorn`) and the stage-and-flush bracket `Tree.replace` / `Diary.append` use (`actAndSync`, `unstage`). The retry loop itself did not grow; the new methods sit beside it and are small. The argument for this ticket is unchanged and a little stronger.

# Re-measured by `debt-a-write-after-another-handles-commit-refetches-the-log-tail` (2026-09-23)

`wc -l packages/db-core/src/collection/collection.ts` → 2118 lines. That ticket added about 60 of them to the REFRESH path (`keepWhatTheRefreshRead`, plus an argument on `forgetAndAdopt`), not to the retry machinery this ticket is about, so the retry loop itself is unchanged. The evidence it adds is only that the file keeps growing from more than one direction: a split that moves the retry machinery out would also give the refresh path room.

# Re-measured by `bug-a-retried-write-can-store-two-versions-of-one-log-revision` (2026-09-24)

`wc -l packages/db-core/src/collection/collection.ts` → 2203 lines (from 2118). That ticket added `logAppendBlockIds` and the `mintedLogBlockIds` field, which belong squarely to the state this ticket already names — they are cleared by `beginInFlightAction` and its disposer alongside `inFlightActionId` and `inFlightAttempt`, and they are read from inside `syncAttempts`' loop. So the in-flight/retry unit now has four pieces of state rather than two, and a fifth thing the loop has to get right. `packages/db-core/src/transaction/coordinator.ts` is 1839 lines and its `applyActionsToCollection` now reaches into the same state, which is a second caller for the extracted unit to serve.

`wc -l packages/db-core/src/collection/collection.ts` → 2262 lines (2026-09-29, after ticket `a-refresh-after-a-refused-write-asks-for-the-confirmed-revision`, which added about 60: the tail-floor plumbing through `updateInternal` / `readLogEnds` / `readLogTail` and two small static helpers, `tailFloorField` and `reportTailBelowFloor`). The log-ends reading helpers (`readLogEnds`, `readLogTail`, `checkedLogTail`, `tailFloorField`, `reportTailBelowFloor`) are self-contained statics and a natural first piece to move out.

# Re-measured by `a-transaction-pends-and-commits-its-collections-together` (2026-10-24)

`wc -l packages/db-core/src/transaction/coordinator.ts` → 2102 lines. That ticket added the batched pend and commit (`pendTogether`, `commitTogether`, `commitEach`) and split the request builders out of `pendCollection` / `commitCollection` (`pendRequestFor`, `commitRequestFor`, and the module-level `pendRefusalError`, `pendFailure`, `collectionCommitOutcome`). Those are small and sit in the pend and commit phases, not in the retry loop this ticket is about, but they are a cohesive unit of their own — "send one attempt's pends and commits" — that a split of this file could move out together with the retry machinery's second caller in `commit`.

# Re-measured by `offline-sync-collection-segments` (2026-10-26), which did the first cut of this split

`wc -l packages/db-core/src/collection/collection.ts` → 2769 lines (from 2783); `packages/db-core/src/collection/write-attempts.ts` → 457 lines (new); `packages/db-core/src/transaction/coordinator.ts` → 2193 lines (unchanged). That ticket added a second caller of the retry machinery (`Collection.commitHead`, which commits the head sealed segment) and so extracted what the two callers share into `write-attempts.ts`: `AttemptCycle` (the failure counters, the stall check, the three stop-by-name refusals, the budget, and the "back off, refresh, and keep refreshing while finishing is refused for a cause that can clear" loop), `stageAttempt` (the per-attempt tracker, the log append under a fixed identity, the digests and the size check) and `retainedAttempt`. `syncAttempts` is now about forty lines and `commitHead`'s cycle about thirty, each saying what an attempt is built from and what to do with a commit.

What remains of this ticket: `TransactionCoordinator.commit` still carries its own copy of the refresh-until-settled loop and its own failure accounting — it was not moved onto `AttemptCycle` because its budget, its per-participant refresh and its partial-commit reporting differ in shape, and the ticket that extracted the module was told to do only what its two callers needed. The own-entry machinery (`completeOwnEntry`, `settleUnfinished`, `dischargeOwnPendings`, `lineageOfOwnEntry`, `throwTorn`, `consumeOwnEntry` and its head arm) and the in-flight state (`inFlightActionId`, `inFlightAttempt`, `mintedLogBlockIds`, now also `headCommitEntry` and `headInFlight`) stay in `collection.ts`, as do the log-ends readers the earlier re-measurement named as a natural first piece to move. `collection.ts` is a net fourteen lines shorter only because the head commit it gained is about the size of what left.

# Re-measured by `offline-sync-head-commit-handle` (2026-10-26), which moved the head-commit loop out

`wc -l packages/db-core/src/collection/collection.ts` → 2838 lines (from 2777); `packages/db-core/src/collection/head-commit.ts` → 145 lines (new); `packages/db-core/src/collection/write-attempts.ts` → 460 lines; `packages/db-core/src/transaction/coordinator.ts` → 2194 lines. That ticket re-expressed `Collection.commitHead` over a step-by-step handle (`HeadCommitHandle`, `driveHeadCommit` in `head-commit.ts`) so the coordinator's per-entry commit can drive several collections in lock-step: the attempt loop itself left `collection.ts`, but the handle is a closure over the collection's private state and so is built inside it (`Collection.headCommitHandle`), and the prose that explained the head commit's target, latch and refusal re-checks moved onto `Collection.openHeadCommit` rather than leaving. Net, the file grew by about sixty lines — the handle's twelve closures and their latch-state assertions outweigh the thirty-line loop and the latch helper that left. The in-flight state the earlier re-measurements named (`inFlightActionId`, `inFlightAttempt`, `mintedLogBlockIds`, `headCommitEntry`, `headInFlight`) is now also what the handle closes over, which is one more reason a split of this file should move that state and the methods that read it together.

Re-measured by the review of that ticket (2026-10-26): `wc -l packages/db-core/src/collection/collection.ts` → 2821 lines, after the review moved the `InFlightAttempt` type into `packages/db-core/src/collection/struct.ts` (413 lines), where `HeadCommitOptions` names it, so `struct.ts` no longer imports a type from `collection.ts`.
