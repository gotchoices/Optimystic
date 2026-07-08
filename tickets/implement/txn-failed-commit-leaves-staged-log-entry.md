description: When a commit fails, the local record of what was about to be written is left behind instead of being undone; retrying the commit then records the same changes a second time, and in some cases the cleanup step does nothing at all. Snapshot each collection's staged state before the commit's log-append and restore it on any failure path.
prereq:
files:
  - packages/db-core/src/transaction/coordinator.ts (commit() log-append + consensus, ~lines 129-202; rollback() ~lines 213-256)
  - packages/db-core/src/collection/collection.ts (snapshotPending/restorePending/CollectionSnapshot, ~lines 30-37, 181-204)
  - packages/db-core/src/testing/test-transactor.ts (FlakyCommitTransactor, setAvailable — force a commit failure)
  - packages/db-core/test/transaction.spec.ts (integration harness: TestTransactor + real collections + coordinator.commit)
difficulty: medium
----

# Failed commit leaves the staged log entry; retry double-logs; rollback can no-op

## The bug (confirmed)

`TransactionCoordinator.commit()` (coordinator.ts) materialises a log entry into
**each collection's tracker** before consensus is reached:

```
for (const { collectionId, collection } of collectionData) {
    const applyResult = await this.applyActionsToCollection(
        { collectionId, actions: collection.getPendingActions() }, ...);   // <- log.addActions() mutates tracker
    if (!applyResult.success) throw ...;                                    // <- no restore
    ...
}
const coordResult = await this.coordinateTransaction(...);                  // GATHER/PEND/COMMIT
if (!coordResult.success) throw ...;                                        // <- no restore
```

`applyActionsToCollection` → `Log.addActions` appends a log entry into
`collection.tracker`. On **any** throw after that append:

1. The appended log entry stays in the tracker, and `collection.pending` is never
   cleared (both are only cleared on the success path, coordinator.ts ~lines 193-201).
2. A legal retry of `session.commit()` re-enters the same loop: `collectionData`
   still sees the dirty transforms, `getPendingActions()` still returns the same
   actions, so `addActions` appends a **second** log entry for the same actions.
3. For a **directly-staged** tree (the vtab deferred-DML path, which stages straight
   into the tracker via `Tree.stage`/`Collection.act` and never calls
   `coordinator.applyActions`), there is **no `stampData` entry** for the stamp, so
   `rollback(stampId)` returns immediately at its `if (!data) return;` guard and never
   undoes the appended entry — poisoned tracker with no recovery path.

Failure points that reach a throw after the first append:
- a later collection's `applyActionsToCollection` returns `success:false` (earlier
  collections in the loop already appended);
- `coordinateTransaction` returns `success:false` (PEND or COMMIT phase failed — e.g.
  transient transactor unavailability, or a stale/conflict abort).

## Expected behavior

A failed commit leaves each collection's tracker **exactly** as it was before the
commit attempt (transforms + pending queue), so:
- a retry re-appends cleanly with **no duplicate log entry**, and
- `rollback` of a directly-staged tree has nothing poisoned to undo (and the tracker
  is already clean regardless of whether `stampData` exists).

Remote/consensus cleanup is already handled inside `coordinateTransaction`
(`cancelPhase` cancels pended blocks on failure). This fix is **local tracker state
only** — do not touch the consensus cancel logic.

## The fix

Snapshot each participating collection's staged state **before** the append loop, and
restore all of them on any failure path. `Collection.snapshotPending()` /
`restorePending()` (collection.ts, added by the completed
`optimystic-session-mode-commit-composition` work) are exactly the right building
blocks — they deep-clone transforms and copy the pending queue, and `restorePending`
resets both. `CollectionSnapshot<TAction>` is exported from collection.ts.

Sketch (adapt to the real code — declare `collectionTransforms`/`criticalBlocks`
before the try since the success path reads them afterward):

```ts
// Snapshot ALL participating collections up front: the append loop runs
// sequentially, so a failure on the Nth collection must also restore the
// 0..N-1 collections that already appended.
const preCommitSnapshots = new Map<CollectionId, CollectionSnapshot<any>>();
for (const { collectionId, collection } of collectionData) {
    preCommitSnapshots.set(collectionId, collection.snapshotPending());
}

try {
    for (const { collectionId, collection } of collectionData) {
        const applyResult = await this.applyActionsToCollection(...);
        if (!applyResult.success) throw new Error(`Transaction commit failed: ${applyResult.error}`);
        collectionTransforms.set(collectionId, applyResult.transforms!);
        criticalBlocks.set(collectionId, applyResult.logTailBlockId!);
    }
    const operationsHash = await this.hashOperations(...);
    const coordResult = await this.coordinateTransaction(...);
    if (!coordResult.success) throw new Error(`Transaction commit failed: ${coordResult.error}`);
} catch (err) {
    // Leave every tracker exactly as it was pre-append: a retry re-appends
    // cleanly (no duplicate log entry) and a directly-staged tree's rollback
    // has nothing poisoned to undo.
    for (const { collectionId, collection } of collectionData) {
        collection.restorePending(preCommitSnapshots.get(collectionId)!);
    }
    throw err;
}

// success path (unchanged): recordCommitted / applyCommittedToCache /
// tracker.reset / clearPendingActions / stampData.delete
```

Notes:
- Import `CollectionSnapshot` from the collection module, or type the map as
  `Map<CollectionId, ReturnType<Collection<any>['snapshotPending']>>` to avoid a new
  import.
- Keep the existing success-path fold (recordCommitted / applyCommittedToCache /
  tracker.reset / clearPendingActions / stampData.delete) **outside** the catch, only
  reached when no throw occurred.
- `applyActionsToCollection` returns the tracker's **live** transforms reference; that
  is fine because on failure we `restorePending` (which `tracker.reset`s to the
  deep-cloned snapshot) and rethrow.

## Related observation (do NOT expand scope — for the reviewer)

`execute()` (coordinator.ts ~line 331, the engine-driven path) has the same
append-inside-loop shape and also returns on failure (lines ~369-371, ~404-407)
without restoring trackers. It differs from `commit()`: it is not the retryable
`session.commit()` entry point, and its actions were tracked through `applyActions()`
so `rollback(stampId)` *can* clean them. The double-log-on-retry symptom is specific
to `commit()`. Leave `execute()` alone in this ticket; add a one-line `NOTE:` at the
`execute()` failure returns pointing at this asymmetry so a future reader meets it,
and record it in the review's `## Review findings` as a parked tripwire.

## TODO

- [ ] In `coordinator.ts` `commit()`, snapshot each participating collection with
      `snapshotPending()` before the log-append loop.
- [ ] Wrap the append loop + hash + `coordinateTransaction` in a try; on catch,
      `restorePending()` every snapshot and rethrow.
- [ ] Ensure the success-path fold (recordCommitted / applyCommittedToCache /
      tracker.reset / clearPendingActions / stampData.delete) runs only on success.
- [ ] Add a `NOTE:` comment at the `execute()` failure returns describing the
      unfixed-but-lower-risk asymmetry (no scope expansion).
- [ ] Add a regression test in `packages/db-core/test/transaction.spec.ts`:
      - stage a mutation, force commit failure with
        `new FlakyCommitTransactor(inner, Infinity)` (or `inner.setAvailable(false)`),
        assert `session.commit()` rejects.
      - assert the collection's tracker transforms + pending queue equal their
        pre-commit values (no leftover appended log entry).
      - restore the transactor (`FlakyCommitTransactor(inner, 0)` /
        `setAvailable(true)`), retry `commit()`, assert it succeeds and the committed
        log has **exactly one** entry for the action (no duplicate) — e.g. via
        `transactor.getCommittedActions()`.
      - directly-staged variant: after a forced failure with no `applyActions`
        tracking, assert `rollback(stampId)` leaves the tracker clean (or that the
        restore already left it clean).
- [ ] Build + run db-core tests, streaming output:
      `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/dbcore-test.log`
      (confirm exact package name / script from packages/db-core/package.json and the
      repo's test runner in AGENTS.md before running).
