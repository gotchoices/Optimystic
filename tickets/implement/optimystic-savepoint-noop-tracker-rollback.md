description: SQL statement rollbacks (including ordinary failed inserts) don't actually undo the affected rows in Optimystic tables, so discarded rows can wrongly survive to commit; make savepoints really roll back the staged changes.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/deferred-constraint-rollback.spec.ts
difficulty: medium
----

# Implement: real savepoints (stop silent no-op tracker rollback)

## Problem (reachable now, not just user `ROLLBACK TO`)

`OptimysticVirtualTableConnection.createSavepoint` / `releaseSavepoint` /
`rollbackToSavepoint` (`vtab-connection.ts:50-65`) are empty no-ops. The original
fix ticket framed this as only affecting a user's explicit
`ROLLBACK TO <savepoint>`. Research shows it is worse: **Quereus uses savepoints
internally for statement- and row-level atomicity**, so the no-op
`rollbackToSavepoint` silently fails to revert staged DML in ordinary SQL.

Evidence — Quereus's DML executor
(`../quereus/packages/quereus/src/runtime/emit/dml-executor.ts:432-519`):

- Every **non-FAIL** DML statement is wrapped in a `__stmt_atomic_N` savepoint
  (`_createSavepointBroadcast` at line 443; released at 503; rolled back at 507
  on any mid-statement failure).
- Every **OR FAIL** row is wrapped in a `__or_fail_N` per-row savepoint
  (created 467, rolled back 477, released 487).
- `Database._createSavepointBroadcast` / `_rollbackToSavepointBroadcast` /
  `_releaseSavepointBroadcast` (`../quereus/packages/quereus/src/core/database.ts:1515-1547`)
  fan the call out to **every** registered connection via
  `connection.createSavepoint(depth)` etc. Depth is a stack index (number), and
  the same depth is broadcast to all connections.

Because our connection stages DML into the collection tracker but
`rollbackToSavepoint` does nothing, a statement Quereus *thinks* it rolled back
leaves its staged rows in the tracker, and they flush at the next
`commitTransaction()`.

### Concrete failure (no fault injection needed)

Default ON CONFLICT is ABORT: on a mid-statement violation the **statement** is
undone but the **transaction survives and continues** (SQLite semantics). With a
unique primary key `id`:

```sql
BEGIN;
INSERT INTO t(id) VALUES (1);         -- ok, row 1 staged
INSERT INTO t(id) VALUES (2), (1);    -- row 1 dup PK -> ABORT: whole statement rolled back
COMMIT;
SELECT count(*) FROM t;               -- EXPECTED 1; BUG yields 2 (row 2 survived)
```

Quereus rolls back to the `__stmt_atomic` savepoint expecting row `2` (staged
before the conflicting `1`) to be undone. Our no-op `rollbackToSavepoint` keeps
`2` staged, so `COMMIT` flushes it. Same class of bug affects
`INSERT OR FAIL`'s per-row unwind of the failing row.

## Fix

Implement savepoints as a **depth-indexed stack of tree snapshots**, reusing the
existing `DirtyTree.snapshot()` / `restore()` mechanism (`tree.ts:110-122`,
already used by transaction-level rollback and `markDirty`). The state lives in
`TransactionBridge` (it owns `dirtyTrees` and the collection registry); the
connection delegates.

### Semantics (keyed by numeric depth)

- **createSavepoint(depth)** — capture a snapshot of the current staged state of
  **every tree** the bridge could flush this transaction (main collection + all
  index trees — the same set `markDirtyTrees()` covers, `optimystic-module.ts:740`).
  Store as `Map<depth, Map<DirtyTree, snapshot>>` (or a stack). Snapshot trees
  that aren't dirty yet too: their snapshot is the clean staged state, and
  rollback returns them to clean — harmless and correct.
- **rollbackToSavepoint(depth)** — for each tree captured at `depth`, call
  `tree.restore(snapshot)`; then discard all savepoint entries at depth `>= depth`
  (the savepoint remains open in SQLite until released, but re-created snapshots
  above it are gone). Also ensure any tree that became dirty *after* the savepoint
  is reverted to its pre-savepoint (clean) state — capturing the full tree set at
  create time (previous bullet) gives this for free for trees that already
  existed. A tree *created* after the savepoint (e.g. a new index mid-statement)
  is an accepted edge case — document it; it is not reachable through the DML
  executor's per-statement savepoints (schema is stable within a statement).
- **releaseSavepoint(depth)** — discard the snapshot(s) at depth `>= depth`
  without restoring (changes are absorbed into the enclosing scope). Do NOT flush.

### Idempotency (shared bridge!)

`plugin.ts:29` constructs **one** `TransactionBridge` shared by all table
connections. `_createSavepointBroadcast` calls `connection.createSavepoint(depth)`
once **per connection**, so the bridge sees the same depth N times per savepoint.
Make each bridge op idempotent per depth: `createSavepoint` for an already-present
depth is a no-op (keep the first snapshot); `rollbackToSavepoint`/`releaseSavepoint`
for an absent depth is a no-op. Do the snapshotting in the **bridge**, not the
connection, so N connections sharing one bridge snapshot the tree set exactly once.

### Interaction with transaction-level rollback

`rollbackTransaction()` (`txn-bridge.ts:257-304`) already restores each dirty
tree from its `markDirty` snapshot in legacy mode and clears `dirtyTrees`. Clear
the savepoint stack there too (and in `commitTransaction` / `beginTransaction`
alongside `dirtyTrees.clear()`), so savepoints don't leak across transactions.
In session mode the coordinator owns tracker rollback — savepoints are a
legacy-mode / staged-tracker concern; verify (test) that opening savepoints in
session mode does not corrupt the coordinator's snapshot replay, or scope
savepoint capture to the legacy path only and document the session-mode gap.

### Delete dead code

The bridge's own string-named `savepoint(name)` / `releaseSavepoint(name)` /
`rollbackToSavepoint(name)` (`txn-bridge.ts:407-428`) `throw` and are **never
called** (the connection never delegates to them). Delete them; replace with the
depth-keyed methods the connection now delegates to.

## Signatures

`VirtualTableConnection` declares the connection methods as returning `void`
(sync) but Quereus `await`s them (`database.ts:1518`). Snapshot/restore are
synchronous in-memory ops, so keep them sync (`void`) — no need to make them
async.

## Edge cases to cover in tests

- Statement-level ABORT unwind inside a surviving multi-statement transaction
  (the repro above) — the primary regression.
- `INSERT OR FAIL` per-row unwind: failing row reverted, earlier rows kept.
- Nested savepoints (create at depth d, then d+1; rollback to d must also drop
  d+1's changes).
- `SAVEPOINT` / `RELEASE` / `ROLLBACK TO <name>` user SQL round-trip.
- Interaction with the existing deferred-constraint whole-transaction rollback
  (`deferred-constraint-rollback.spec.ts`) — must still pass.
- Savepoint that spans a tree becoming dirty (tree clean at savepoint create,
  dirtied after, rolled back to the savepoint) — returns to clean.

## TODO

- [ ] Write a failing regression test first: the fault-injection-free repro above
  (`BEGIN; INSERT ok; INSERT that ABORTs; COMMIT;` → `count == 1`). Model it on
  `deferred-constraint-rollback.spec.ts` (real `local` transactor + `FileRawStorage`).
  Confirm it fails on current `main`.
- [ ] Add an `INSERT OR FAIL` per-row-unwind regression case.
- [ ] Add a depth-indexed savepoint snapshot stack to `TransactionBridge`
  (`createSavepoint`/`rollbackToSavepoint`/`releaseSavepoint` keyed by number,
  idempotent per depth, snapshotting the full main+index tree set).
- [ ] Clear the savepoint stack in `beginTransaction`, `commitTransaction`, and
  `rollbackTransaction` next to `dirtyTrees.clear()`.
- [ ] Delete the dead string-named `savepoint`/`releaseSavepoint`/
  `rollbackToSavepoint` methods from `txn-bridge.ts`.
- [ ] Wire `OptimysticVirtualTableConnection.createSavepoint`/`releaseSavepoint`/
  `rollbackToSavepoint` to delegate to the bridge.
- [ ] Decide + document session-mode scope (savepoints are legacy/staged-tracker;
  either verified-safe or explicitly out of scope with a `NOTE:` at the site).
- [ ] Build `@optimystic/db-core` then `@optimystic/quereus-plugin-optimystic`
  (tsup + DTS type-check) and run the plugin test suite (stream with `tee`);
  confirm the new regressions pass and nothing regresses.
