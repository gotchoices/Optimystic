description: A failed commit used to leave behind a half-written local record, so retrying it recorded the same change twice (and sometimes the undo step did nothing); the commit now snapshots each collection's staged state and restores it on any failure so a retry is clean.
prereq:
files:
  - packages/db-core/src/transaction/coordinator.ts (commit() snapshot/restore ~141-207; execute() NOTE ~378-388)
  - packages/db-core/src/collection/collection.ts (snapshotPending/restorePending/CollectionSnapshot — unchanged)
  - packages/db-core/src/testing/test-transactor.ts (FlakyCommitTransactor — unchanged)
  - packages/db-core/test/transaction.spec.ts (3 regression tests — 2 from implement + 1 added in review)
difficulty: medium
----

# Failed commit no longer leaves a staged log entry behind (COMPLETE)

## What was wrong

`TransactionCoordinator.commit()` appended a log entry into **each collection's local
tracker** *before* distributed consensus (PEND/COMMIT) was reached. On any throw after
that append — a later collection failing to apply, or the consensus phase failing — the
appended entry and the un-cleared pending queue were left in the tracker (they were only
cleared on the success path). Consequences: a retryable `session.commit()` re-appended a
**second** log entry for the same work (double-log), and for a directly-staged tree (the
vtab deferred-DML path with no `stampData` entry) `rollback(stampId)` no-op'd, leaving no
recovery path.

## The fix (local tracker state only)

`commit()` now snapshots every participating collection's staged state
(`collection.snapshotPending()`) **before** the append loop, wraps `append loop + hash +
coordinateTransaction` in a `try`, and on any `catch` calls `collection.restorePending(...)`
for every snapshot before rethrowing. The success-path fold (recordCommitted /
applyCommittedToCache / tracker.reset / clearPendingActions / stampData.delete) stays
**outside** the try, reached only on a clean run. Remote/consensus cleanup was already
correct (`coordinateTransaction` → `cancelPhase`) and was not touched.

Result: a failed commit leaves each tracker exactly as it was pre-attempt, so a retry
re-appends cleanly (one log entry) and a directly-staged tree's rollback has nothing
poisoned to undo.

## Review findings

**Scope reviewed:** the implement diff (`c9589f5`) — `coordinator.ts` commit()
snapshot/restore + the execute() NOTE, and the 2 regression tests; plus the surrounding
`applyActionsToCollection`, `coordinateTransaction`, `applyActions`/`rollback`, and
`Collection.snapshotPending/restorePending` to confirm the restore is complete.

- **Correctness of the restore — CONFIRMED complete.** Traced every state the failing
  path mutates. The try block mutates only `tracker.transforms` (via
  `applyActionsToCollection` → `Log.addActions`, which operates on the tracker's Atomic)
  and never `pending`; `coordinateTransaction` touches only the remote transactor (GATHER/
  PEND/COMMIT + `cancelPhase`), no local collection state. `snapshotPending` deep-clones
  transforms and copies the pending queue; `restorePending` resets the tracker to a fresh
  clone and restores pending. So restore reverts 100% of the local state a failed commit
  mutated. The success-path mutations (rev bump, cache fold, reset, clear, stampData
  delete) are all sync and outside the try — no partial-success window. **No defect.**

- **Test coverage gap the ticket flagged — FIXED inline (minor).** The 2 shipped tests
  cover only N=1 collection, so the "restore the 0..N appended collections" branch ran
  with a single collection. Added
  `multi-collection: a failed commit restores EVERY appended tracker, not just one`
  (transaction.spec.ts): two Trees on one `FlakyCommitTransactor(inner, Infinity)`, both
  append in the loop, consensus fails at COMMIT → catch restores both; asserts BOTH
  trackers' transforms + pending are restored and `committedActions.size === 0`. Fails
  without the restore loop (posts assertions would trip), so it is non-vacuous.

- **execute() asymmetry — tripwire re-confirmed, correctly parked (no ticket).** The
  implementer left `execute()`'s append-inside-loop unfixed and documented it with a
  `NOTE:` at coordinator.ts ~378. Verified the reasoning holds: `execute()` is not the
  retryable entry point, and its actions are tracked via `applyActions()` which registers
  a `stampData.preSnapshot` captured *before* execute()'s log-append — so `rollback(stampId)`
  restores past the append and unwinds it (unlike commit()'s directly-staged path). The
  NOTE's "if execute() ever becomes retryable, mirror the commit() fix" condition is the
  right tripwire. Left as the code comment; indexed here per the tripwire rule. **No ticket.**

- **Minor test-strength observation — no action.** The pending snapshot is a shallow copy
  (`[...this.pending]`), so the `deep.equal` pending assertions would not catch an
  *in-place* mutation of an action object by `addActions`. `addActions` does not mutate
  action objects (it serializes them into log blocks), so this is not a real defect —
  noted only so a future reader doesn't over-trust the pending assertion as a mutation
  guard.

- **Empty categories:** No security, resource-cleanup, or type-safety findings — the
  change adds no I/O, no new allocation lifecycle beyond the pre-existing
  `structuredClone` in `copyTransforms` (unchanged assumption, called out in the implement
  notes), and is fully typed (`tsc --noEmit` clean). No docs touched by the change and
  none needed updating — the behavior is internal to the coordinator and already described
  by the inline comments.

## Validation performed

- `npx tsc --noEmit` in `packages/db-core` → exit 0.
- `yarn workspace @optimystic/db-core test` (full suite) → **1156 passing, 0 failing**
  (1155 from implement + the 1 multi-collection test added in review).
