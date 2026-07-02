description: In the default commit path, a table and its indexes (or two tables in one transaction) can end up permanently out of sync if a mid-commit failure occurs, and SQL savepoint rollbacks silently discard nothing.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts
difficulty: medium
----

## Bug

### 1. Legacy-mode commit is not atomic across trees

Legacy (default) commit flushes each dirty tree with a separate
`await tree.sync()` (`txn-bridge.ts:235-249, 400-418`). If sync N+1 fails, the
rollback only restores in-memory snapshots — trees already synced in this commit
stay durably persisted. Result: a table and its secondary index (or two tables
touched in one SQL transaction) diverge **durably**, with no recovery.

### 2. Savepoints are silent no-ops

The connection's `createSavepoint` / `releaseSavepoint` / `rollbackToSavepoint`
(`vtab-connection.ts:50-65`) are empty. `ROLLBACK TO <savepoint>` reports success
while discarding nothing — silent corruption of the user's mental model of what
was rolled back. Separately, the bridge's own savepoint methods `throw` but are
dead code (never called).

## Relationship to prior work

Distinct from the completed `optimystic-session-mode-commit-composition`, which
fixed session/consensus-mode commit silently persisting nothing. That work noted
(correctly) that legacy multi-tree atomicity is a separate concern; this is it.

## Expected behavior

- A commit spanning multiple trees is all-or-nothing durably: either every tree's
  changes persist or none do. Suggested direction: route multi-tree commits
  through the coordinator path even locally (one pend/commit covering all trees).
  If that is not feasible now, the limitation must be documented loudly at the
  commit site and in `docs/transactions.md`.
- Savepoint methods must not silently succeed while doing nothing. Minimum: make
  them `throw` until implemented (so `ROLLBACK TO` fails honestly instead of
  corrupting silently). Preferred: implement via the existing tree
  `snapshot()` / `restore()` mechanism. Delete the dead bridge savepoint methods.

## Edge cases

- Sync failure on the second of two dirty trees; assert no partial persistence.
- `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` behavior; nested savepoints.
- Interaction with deferred-constraint rollback snapshots.
