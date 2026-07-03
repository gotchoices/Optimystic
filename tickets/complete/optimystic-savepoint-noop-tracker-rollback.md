description: Failed or aborted SQL statements now actually throw away their partial rows in single-node mode, instead of letting those discarded rows quietly slip into the next commit.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, packages/quereus-plugin-optimystic/test/savepoint-rollback.spec.ts, packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts, packages/quereus-plugin-optimystic/README.md
----

# Complete: real savepoints (stop silent no-op tracker rollback)

## Summary of the landed work

`OptimysticVirtualTableConnection`'s savepoint methods were empty no-ops. Quereus
uses savepoints internally for statement- and row-level atomicity (a
`__stmt_atomic` savepoint around every non-FAIL DML statement, a `__or_fail`
savepoint around every `OR FAIL` row), broadcasting create/rollback/release by
numeric depth to every connection. Because `rollbackToSavepoint` did nothing, a
statement Quereus *thought* it rolled back left its staged rows in the collection
tracker, and they flushed at the next `commit`.

The fix implements savepoints in the shared `TransactionBridge` as a depth-indexed
stack of collection snapshots, reusing `Collection.snapshotPending()` /
`restorePending()` (the same mechanism whole-transaction rollback already uses):

- **createSavepoint(depth)** — snapshot the staged state of every registered
  collection (main table + all index trees across every table sharing the bridge).
- **rollbackToSavepoint(depth)** — `restorePending` each captured collection; drop
  savepoints nested above `depth`; preserve the target (can be rolled back to
  again).
- **releaseSavepoint(depth)** — drop the target and everything above it without
  restoring (changes absorbed into the enclosing scope). Never flushes.
- Cleared in `beginTransaction` / `commitTransaction` / `rollbackTransaction` so
  savepoints never leak across transactions.
- Gated on `!this.session`: legacy/single-node mode only. Session mode is a
  documented no-op (see the deliberately-deferred gap below).
- Dead code removed: the bridge's throwing string-named `savepoint(name)` /
  `releaseSavepoint(name)` / `rollbackToSavepoint(name)` (never called) are gone.

New suite `test/savepoint-rollback.spec.ts` (real `local` transactor +
`FileRawStorage`, in-session and reopen assertions, 7 tests): primary ABORT repro,
autocommit variant, `INSERT OR FAIL`, nested user `SAVEPOINT`/`ROLLBACK TO`, user
`RELEASE`, repeated `ROLLBACK TO`, and a savepoint spanning a still-clean index
tree. `adapter-integration.spec.ts`'s obsolete "not yet implemented" throw test was
replaced with a check of the new numeric surface.

## Review findings

### What was checked

- **Implement diff read fresh first** (`git show b142088`) before the handoff
  summary — `txn-bridge.ts`, `vtab-connection.ts`, both test files.
- **Snapshot/restore semantics** — confirmed against db-core:
  `Collection.snapshotPending()` deep-clones `{transforms, pending}` and
  `restorePending()` resets both, so savepoint capture/restore is identical to the
  `DirtyTree.snapshot/restore` used by whole-transaction rollback. Snapshotting +
  restoring the `pending` action queue as well as tracker transforms is correct for
  legacy mode (DML stages via `Tree.stage` → `collection.act` → `pending`, flushed
  at commit).
- **Bridge lifetime** — confirmed one `TransactionBridge` per plugin registration
  (`plugin.ts:29`), shared across all tables/connections, so the per-depth
  idempotency guard and full-registry snapshot are correct and necessary (Quereus
  broadcasts each depth once per connection).
- **Depth semantics** — `rollbackToSavepoint` preserves the target and drops
  `> depth`; `releaseSavepoint` drops `>= depth` without restoring. Matches SQL
  standard (ROLLBACK TO leaves the savepoint live; RELEASE removes it and nested).
- **Leak safety** — `savepoints.clear()` added next to every `dirtyTrees.clear()`
  (begin/commit/rollback + commit's catch→rollback path); no cross-transaction
  leak.
- **Multi-table over-capture** — snapshotting all tables per savepoint is harmless
  (untouched tables restore to their own unchanged snapshot = no-op) and is
  actually *more* correct for a multi-statement user savepoint that spans several
  tables.
- **Dead-code removal** — grepped for callers of the removed string-named methods:
  none remain.
- **Build + tests** — `yarn ... run build` (tsup + DTS type-check) green;
  `yarn ... run test` → **291 passing, 11 pending, 0 failing**. Pre-existing
  `deferred-constraint-rollback.spec.ts` still passes.

### Minor — fixed in this pass

- **Stale doc.** `README.md` Limitations listed "Savepoints are not implemented",
  now false for legacy mode. Rewritten to state savepoints work in single-node mode
  and are no-ops in session mode (with the mid-statement-abort consequence spelled
  out).

### Tripwires (conditional; parked, not ticketed)

- **createSavepoint depth-reuse dedup.** The `savepoints.has(depth)` guard keeps
  only the first capture per depth. This is correct only while Quereus releases /
  rolls back a savepoint before a later savepoint reuses its depth — which the
  primary-repro test verifies (two statements in one txn reuse the same
  `__stmt_atomic` depth and row 1 survives). If Quereus ever left statement
  savepoints open and reused a depth, the dedup would hand back a stale snapshot.
  Recorded as a `NOTE:` at the guard site in `txn-bridge.ts` (`createSavepoint`).
- **Per-statement re-snapshot cost.** Every statement-level savepoint re-snapshots
  every registered collection (O(collections × staged-transforms) per statement).
  Fine at current scale; the dirty-set + copy-on-first-dirty mitigation is recorded
  in the existing `NOTE:` on the `savepoints` field.

### Major — already filed (no new ticket)

- **Session-mode statement-level atomicity is not fixed.** In distributed-consensus
  mode the savepoint methods are no-ops, so the same class of bug (a failed/aborted
  statement leaving partial rows) still exists there; the coordinator only rolls
  back whole transactions. Deliberately out of scope, documented at the code site,
  and filed by the implementer as
  `backlog/debt-optimystic-session-mode-statement-savepoint-gap` — reviewed, the
  ticket is accurate and well-scoped. No new ticket.

### Not found / empty categories

- **No correctness defects** in the legacy-mode implementation: snapshot/restore,
  depth arithmetic, idempotency, and lifecycle clearing all check out against the
  db-core primitives and the shared-bridge model, and are exercised by the 7 new
  tests (happy path, ABORT, OR FAIL, nested/repeated user savepoints, index-tree
  revert, autocommit, reopen).
- **No new resource-cleanup, type-safety, or DRY issues.** The `unknown` snapshot
  values are cast back per originating collection (safe by construction); the
  implementation reuses the existing snapshot primitives rather than duplicating
  them.
- **Multi-table FK-cascade breadth remains untested** — noted by the implementer;
  not a defect (no FK-cascade path in this diff), so no ticket. Left as a coverage
  gap the session-mode-gap follow-up can absorb if it adds cross-table cases.
