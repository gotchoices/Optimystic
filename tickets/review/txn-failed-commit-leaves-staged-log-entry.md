description: A failed commit used to leave behind a half-written local record, so retrying it recorded the same change twice (and sometimes the undo step did nothing); the commit now snapshots each collection's staged state and restores it on any failure so a retry is clean.
prereq:
files:
  - packages/db-core/src/transaction/coordinator.ts (commit() snapshot/restore, ~lines 141-207; execute() NOTE, ~lines 378-388)
  - packages/db-core/src/collection/collection.ts (snapshotPending/restorePending/CollectionSnapshot — used, not changed)
  - packages/db-core/src/testing/test-transactor.ts (FlakyCommitTransactor — used, not changed)
  - packages/db-core/test/transaction.spec.ts (2 new regression tests at end of file)
difficulty: medium
----

# Failed commit no longer leaves a staged log entry behind

## What was wrong

`TransactionCoordinator.commit()` appends a log entry into **each collection's local
tracker** (via `applyActionsToCollection` → `Log.addActions`) *before* the distributed
consensus (PEND/COMMIT) is reached. On any throw after that append — a later
collection failing to apply, or the consensus phase failing (transactor unavailable,
stale/conflict abort) — the appended entry and the un-cleared pending queue were left
in the tracker, because they were only cleared on the success path. Consequences:

1. **Retry double-logs.** `session.commit()` is retryable (it only marks itself
   committed on success). A retry re-entered the loop, still saw the dirty transforms
   and the same pending actions, and appended a **second** log entry for the same work.
2. **Rollback could no-op.** For a tree staged directly into the tracker (the vtab
   deferred-DML path via `Collection.act`/`Tree.stage`, which never calls
   `coordinator.applyActions`), there is no `stampData` entry, so `rollback(stampId)`
   returns immediately at its `if (!data) return;` guard — leaving the poisoned tracker
   with no recovery path.

## The fix (local tracker state only)

In `commit()`, snapshot every participating collection's staged state
(`collection.snapshotPending()` — deep-clones transforms + copies the pending queue)
**before** the append loop, then wrap `append loop + hash + coordinateTransaction` in a
`try`. On any `catch`, `collection.restorePending(...)` every snapshot and rethrow. The
success-path fold (recordCommitted / applyCommittedToCache / tracker.reset /
clearPendingActions / stampData.delete) stays **outside** the try, reached only when no
throw occurred.

Remote/consensus cleanup was already correct — `coordinateTransaction` cancels pended
blocks on failure (`cancelPhase`). That logic was **not** touched. The snapshot map is
typed `Map<CollectionId, ReturnType<Collection<any>['snapshotPending']>>` to avoid a new
import.

Result: a failed commit leaves each tracker **exactly** as it was pre-attempt, so a
retry re-appends cleanly (one log entry) and a directly-staged tree's rollback has
nothing poisoned to undo (tracker already clean whether or not `stampData` exists).

## Use cases to validate (reviewer)

Two regression tests were added at the end of `packages/db-core/test/transaction.spec.ts`
(describe: *Failed commit restores staged tracker state*):

- **Session path, no double-log.** Stage via `session.execute`, force a COMMIT-phase
  failure with `FlakyCommitTransactor(inner, 3)` (fails all 3 internal commit retries of
  the first `commit()`), assert `session.commit()` rejects, then assert the collection's
  `tracker.transforms` **and** `getPendingActions()` deep-equal their pre-commit
  snapshot. Retry `session.commit()` (4th transactor.commit succeeds) → asserts success
  and `inner.getCommittedActions().size === 1` (no duplicate) and the row is readable.
- **Directly-staged path, rollback no-op.** Stage via `usersCollection.act(...)`
  (bypassing `applyActions`, so no `stampData`), force failure with
  `FlakyCommitTransactor(inner, Infinity)`, assert `coordinator.commit()` rejects and
  the tracker is restored to its pre-commit snapshot; then `coordinator.rollback(stampId)`
  no-ops and the tracker stays clean.

Ideas for the reviewer to push further (tests here are a floor, not a ceiling):
- **Multi-collection partial-append failure.** The append loop runs sequentially; the
  current tests use a single collection, so the "restore the 0..N-1 collections that
  already appended when the Nth fails" branch is exercised only by the
  all-appended-then-consensus-fails case, not by a mid-loop `applyActionsToCollection`
  failure. A two-collection test where the *second* collection's apply fails would cover
  the mid-loop restore directly.
- **Second-commit-on-same-collection.** Both tests use a collection's pristine first
  commit. A collection with prior committed state (pre-synced) that fails then retries
  would confirm the restore interacts correctly with `applyCommittedToCache`/rev logic.
- **`inner.getCommittedActions().size === 1`** is a coarse duplicate check (committed
  actions are keyed by actionId, so a same-actionId duplicate would collapse). It is
  adequate here because the retry uses the same stamp → same actionId, but a reviewer
  wanting a stronger guarantee could assert on committed **revision count** per block.

## Known gaps / honest notes

- `copyTransforms` (behind `snapshotPending`) uses `structuredClone` per block; the fix
  inherits that cost/assumption. Not a regression — `snapshotPending`/`restorePending`
  are the pre-existing building blocks (added by `optimystic-session-mode-commit-composition`).
- The fix is deliberately **local tracker state only**. If the append loop ever needs to
  also undo partial *remote* effects beyond what `cancelPhase` handles, that is out of
  scope here.

## Review findings

- **Parked tripwire — `execute()` has the same append-inside-loop shape, left unfixed.**
  `TransactionCoordinator.execute()` (the engine-driven path) also appends log entries in
  a loop and returns on failure without restoring trackers. It was **intentionally not**
  snapshot/restore-wrapped: it is not the retryable `session.commit()` entry point (a
  failed `execute()` is not re-driven through the same loop) and its actions were tracked
  via `applyActions()`, so `rollback(stampId)` *can* unwind them — unlike `commit()`'s
  directly-staged path. A `NOTE:` comment was added above `execute()`'s apply loop
  (coordinator.ts ~line 378) documenting the asymmetry and the "if execute() ever becomes
  retryable, mirror the commit() fix" condition. Recorded here per the tripwire rule; no
  ticket filed.

## Validation performed

- `npx tsc --noEmit` in `packages/db-core` → exit 0 (clean).
- Full suite `yarn workspace @optimystic/db-core test` → **1155 passing, 0 failing**
  (includes the 2 new regression tests).
