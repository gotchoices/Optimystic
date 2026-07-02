description: When a commit fails, the local record of what was about to be written is left behind instead of being undone; retrying the commit then records the same changes a second time, and in some cases the cleanup step does nothing at all — leaving the local state corrupted.
files:
  - packages/db-core/src/transaction/coordinator.ts (commit() log-append before consensus ~lines 147-158; rollback() ~lines 223-224)
  - packages/db-core/src/collection/collection.ts (snapshotPending/restorePending helpers added by prior session-mode work)
difficulty: medium
----

# Failed commit leaves the staged log entry; retry double-logs; rollback can no-op

## The bug

`commit()` appends a log entry into each collection's tracker *before* consensus is
reached. On failure it throws without undoing that append. A legal retry of
`session.commit()` then appends a *second* log entry for the same actions.

For directly-staged trees, `rollback(stampId)` finds no `stampData` and returns
immediately, so it never cleans up the appended entry — leaving poisoned tracker
state with no recovery path.

## Expected behavior

A failed commit leaves the tracker exactly as it was before the commit attempt, so a
retry re-appends cleanly (no duplicate entries) and rollback fully reverts the staged
state for directly-staged trees.

## Suggested direction (hint, not a mandate)

Snapshot each tracker's state before the log-append loop and restore it on any
failure path. The `snapshotPending`/`restorePending` helpers on `Collection` (added
by the completed `optimystic-session-mode-commit-composition` work) may be reusable
here.

## Relation to completed work

`optimystic-session-mode-commit-composition` (in complete/) reworked
`coordinator.commit()` log-materialisation and added snapshot/restore helpers, but it
targeted the *success/durability* path and single-session rollback timing — it did
**not** add the pre-append snapshot + restore-on-failure that this bug requires. Treat
that ticket's snapshot helpers as building blocks, not as a fix already delivered; do
not modify the completed ticket file.

Severity: MEDIUM.
