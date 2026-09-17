description: When a collection refreshes and then fails partway through re-applying its unsaved changes, it is left holding only some of those changes while still listing all of them as pending. Nothing cleans that up when the failure comes back as a partial save, so a later commit could write a log entry that does not match the data it writes.
files: packages/db-core/src/collection/collection.ts (`updateInternal`'s NOTE above `replayActions`, `replayActions`), packages/db-core/src/transaction/coordinator.ts (`reportSaved`, `refreshBetweenAttempts`), packages/db-core/src/transaction/errors.ts (`CoordinatorPartialCommitError.failedCollections` doc), packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitTransaction`'s `CoordinatorPartialCommitError` branch)
tradeoffs: Only session-mode commits reach it, no host in this repository turns session mode on, and it needs a tear, a rival's conflicting key and a second collection all in one commit, so a maintainer may reasonably wait until session mode is wired somewhere.
----
# A refresh that throws while re-applying leaves a collection half re-staged

## The state

A collection keeps two records of its unsaved work: the tracker (the block changes the actions produced) and `pending` (the list of actions). When a refresh adopts a newer revision, `Collection.updateInternal` calls `replayActions`, which clears the tracker and runs every pending action again against the new revision. If one of those actions throws partway through (for example a guarded insert whose key a rival has just taken, `TreeKeyTakenError`), the tracker holds only the changes from the actions that ran before the throw, while `pending` still lists every action. A commit built from that collection would write a log entry naming all the actions, but block changes for only some of them.

The NOTE at that site accepts this on one condition: whoever catches the error must throw the collection's staged state away (abort or reset) rather than keep using it.

## Why that condition no longer always holds

Since `a-half-saved-multi-collection-commit-is-reported-as-not-saved`, `TransactionCoordinator.commit` turns any failure into a `CoordinatorPartialCommitError` once a refresh between attempts has saved some other participant of the commit. The refresh round visits every collection, so collection A can be saved in the same round in which collection B's replay throws. The Quereus bridge treats a partial commit as "cannot roll back": it latches the degraded state and clears its transaction bookkeeping, but it does not restore any collection. B's half re-staged tracker and full `pending` list therefore stay in place, and `failedCollections`' doc ("local state reverted for retry — their staged actions are still in place") is not true for B.

Before that change the same failure came back as a bare error, the bridge rolled back, and the rollback restored B from its snapshot, so the condition held.

## How to confirm

Static reading only (`repro: static`). A db-core test could confirm it: two participants, where the first attempt stores A's log tail but reports a loss, and a rival then commits to B something that makes B's replay throw. Assert that `commit()` throws a partial error naming B as failed, and that B's tracker no longer matches its `pending` list (for example, re-running `replayActions` on a copy changes the transforms).

## Expected

The mismatched state should not be representable. A collection's tracker and `pending` list should always agree, whoever catches the error. The fix the existing NOTE already names, re-applying into a scratch tracker and swapping it in only when every action succeeded, does that for every caller, not just this path. A replay that throws then leaves B exactly as it was before the refresh, which is what `failedCollections` promises.
