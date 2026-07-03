description: Verify the fix that makes a failed or aborted SQL statement actually throw away its partial rows, instead of letting those discarded rows quietly slip into the next commit.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/vtab-connection.ts, packages/quereus-plugin-optimystic/test/savepoint-rollback.spec.ts, packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
difficulty: medium
----

# Review: real savepoints (stop silent no-op tracker rollback)

## What the bug was

`OptimysticVirtualTableConnection.createSavepoint / releaseSavepoint /
rollbackToSavepoint` were empty no-ops. Quereus uses savepoints internally for
statement- and row-level atomicity: it wraps every non-FAIL DML statement in a
`__stmt_atomic` savepoint (rolled back on any mid-statement violation) and every
`OR FAIL` row in a `__or_fail` per-row savepoint, broadcasting create/rollback/
release (by numeric depth) to every connection. Because our `rollbackToSavepoint`
did nothing, a statement Quereus *thought* it rolled back left its staged rows in
the collection tracker, and they flushed at the next `commit`.

Concrete: with a unique PK,
`BEGIN; INSERT (1); INSERT (2),(1) -- dup ABORT; COMMIT;` should leave one row
(the aborted statement is undone, the transaction survives), but the pre-fix
no-op left row `2` staged, so COMMIT flushed it → count 2.

## What the fix does

Savepoints are now a **depth-indexed stack of collection snapshots** in the shared
`TransactionBridge`, reusing `Collection.snapshotPending()` / `restorePending()`
(the same mechanism `DirtyTree.snapshot()`/`restore()` and whole-transaction
rollback already use). The connection delegates; the bridge does the work once
(idempotent per depth, since one bridge is shared by every table connection and
Quereus broadcasts once per connection).

- **createSavepoint(depth)** — snapshot the staged state of **every registered
  collection** (main table + all index trees, across every table sharing the
  bridge). Snapshotting the *full* registry — not just the trees already marked
  dirty — is what makes a tree that was clean at create time but dirtied inside
  the savepoint revert to clean.
- **rollbackToSavepoint(depth)** — `restorePending` each captured collection;
  drop savepoints nested **above** `depth`; **preserve** the target (SQL standard:
  can be rolled back to again). Mirrors Quereus's own memory-layer connection
  (`quereus/.../vtab/memory/layer/connection.ts`).
- **releaseSavepoint(depth)** — drop the target and everything above it **without**
  restoring (changes absorbed into the enclosing scope). Never flushes.
- Cleared in `beginTransaction` / `commitTransaction` / `rollbackTransaction`
  next to `dirtyTrees.clear()`, so savepoints never leak across transactions.

Dead code removed: the bridge's throwing string-named `savepoint(name)` /
`releaseSavepoint(name)` / `rollbackToSavepoint(name)` (never called) are gone,
replaced by the depth-keyed numeric methods the connection now delegates to.

### Design choices a reviewer should sanity-check

- **Snapshot the collection registry, not `dirtyTrees`.** The ticket sketched
  `Map<depth, Map<DirtyTree, snapshot>>`. I keyed by the registry's `Collection`
  instances instead: the registry is the authoritative *full* main+index set
  (maintained at table init, mode-agnostic), whereas `dirtyTrees` is populated
  lazily and would miss a not-yet-dirty tree. `Collection.snapshotPending` is
  exactly what `DirtyTree.snapshot` delegates to, so the semantics are identical.
- **Legacy-mode gating.** Savepoint capture/restore is gated on `!this.session`,
  mirroring how `rollbackTransaction` already gates its per-tree restore. In
  session (distributed-consensus) mode the savepoint methods are no-ops — see the
  gap below.
- **`restorePending` is idempotent**, so the repeated per-connection broadcast of
  the same depth restoring the full registry N times is harmless.

## Use cases for testing / validation

New suite `test/savepoint-rollback.spec.ts` (real `local` transactor +
`FileRawStorage`, legacy mode; in-session **and** reopen assertions), 7 tests all
passing:

- **Primary repro** — statement-level ABORT unwinds partial rows, transaction
  survives (`BEGIN; INSERT ok; INSERT (2),(1) ABORT; COMMIT;` → count 1).
- Same shape in **autocommit** (no explicit `BEGIN`).
- **INSERT OR FAIL** — earlier rows kept, the per-row savepoint of the failing row
  does not clobber them.
- **Nested user `SAVEPOINT` / `ROLLBACK TO`** — rollback to the outer drops both
  the inner scope and post-savepoint rows.
- **User `RELEASE SAVEPOINT`** — inner changes absorbed into the transaction.
- **Repeated `ROLLBACK TO`** the same savepoint — idempotent, savepoint preserved.
- **Savepoint spanning a still-clean index tree** — the discarded row's index
  entry reverts too (verified via an index-backed `where cat = …` query).

Existing `test/deferred-constraint-rollback.spec.ts` (whole-transaction rollback)
still passes. Obsolete unit test in `adapter-integration.spec.ts` that asserted the
old "not yet implemented" throw was replaced with a check of the new numeric
surface (idempotent no-throws).

Commands run (all green):
- `yarn workspace @optimystic/db-core run build`
- `yarn workspace @optimystic/quereus-plugin-optimystic run build` (tsup + DTS
  type-check — passes, so the source is type-correct)
- `yarn workspace @optimystic/quereus-plugin-optimystic run test` →
  **291 passing, 11 pending, 0 failing**

## Known gaps — reviewer should treat these as the starting point, not done

- **Session-mode statement-level atomicity is NOT fixed** (deliberately out of
  scope, documented at the code site). In session mode the savepoint methods are
  no-ops, so the *same class* of bug — a failed/aborted statement leaving partial
  rows — still exists there; the coordinator only rolls back whole transactions,
  not per-statement. Filed as `backlog/debt-optimystic-session-mode-statement-savepoint-gap`.
- **"Fails on pre-fix `main`" was not re-run.** Reverting the working tree to prove
  it is forbidden here. The pre-fix failure is established by the ticket analysis
  and by direct reading of the deleted no-op methods (no-op `rollbackToSavepoint`
  ⇒ staged row 2 survives ⇒ count 2). A reviewer wanting proof can stub the bridge
  methods back to no-ops and watch `savepoint-rollback.spec.ts` fail.
- **Performance** — `NOTE:` at the `savepoints` field: every statement-level
  savepoint re-snapshots every registered collection across all tables sharing the
  bridge (O(collections × staged-transforms) per statement). Fine at current
  scale; the field comment records the dirty-set + copy-on-first-dirty mitigation
  if it ever shows up as slow.
- **Multi-table breadth is untested.** Snapshotting all tables' collections per
  savepoint is arguably *more* correct (a statement touching several tables via FK
  cascade rolls back all of them), but there's no FK-cascade regression here.
- **Tree created mid-savepoint** (a brand-new index created mid-statement) is not
  captured at an already-open savepoint — accepted per the ticket, unreachable via
  the DML executor's per-statement savepoints (schema is stable within a statement).

## Review findings

_(to be filled during review — parked concerns index)_

- Performance tripwire recorded as a `NOTE:` on the `savepoints` field in
  `txn-bridge.ts` (per-statement full-registry re-snapshot).
- Session-mode statement-level savepoint gap → `backlog/debt-optimystic-session-mode-statement-savepoint-gap`.
