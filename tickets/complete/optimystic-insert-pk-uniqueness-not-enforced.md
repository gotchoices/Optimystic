description: Inserting a row whose primary key already exists used to silently overwrite the existing row instead of being rejected; this enforces uniqueness so duplicate inserts now fail.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
----

## Summary

`OptimysticVirtualTable.update` (`case 'insert'`) now calls
`this.collection.get(insertKey)` before staging and throws a `ConstraintError`
if the key already exists (committed or staged earlier in the same transaction),
before `markDirtyTrees()`/`stage()`, so the duplicate row is never staged. The
catch block was updated to rethrow `QuereusError` instances verbatim so the
constraint classification survives to the engine. Three regression tests against
a real `FileRawStorage`/`local` transactor cover separate-transaction,
same-transaction, and single-multi-row-statement duplicates.

The implementation landed in commit `11f4f17` (the `fix` stage), not the
`implement` commit `287599b` (which only moved the ticket file). The code and
tests were already committed and present at review time.

## Review findings

### Validation performed
- **Full test suite** (`node --import ./register.mjs mocha "test/**/*.spec.ts"`
  in `packages/quereus-plugin-optimystic`): **215 passing, 5 pending** — matches
  the pre-fix baseline, no regressions.
- **Targeted spec** `insert-pk-uniqueness.spec.ts`: 3 passing.
- Traced the duplicate-detection mechanism: `collection.get` → `btree.get` →
  `at(find(key))` reads the in-memory tree, so it sees both committed rows and
  rows staged earlier in the same transaction (confirms the same-transaction
  case). Atomicity of the multi-row case relies on `TransactionBridge.markDirty`
  snapshotting pre-stage state (legacy mode) and `rollbackTransaction` restoring
  it; the throw happens *before* any staging for the offending row, so the
  conflict path stages nothing and earlier rows revert via the snapshot. Verified
  empirically by the passing tests.
- `lint`: no dedicated lint script in the package (`typecheck`/`build` are
  blocked by the pre-existing libp2p dep-skew — see Known gaps); no separate
  linter to run.

### Minor — fixed inline this pass
- **Comment verbosity.** The 10-line block above the `get` call and the
  multi-line catch-block comment were condensed to concise WHY-only comments,
  matching the project's minimal-comment preference. No behavior change.

### Major — filed as new fix tickets (out of scope to fix inline)
- **`optimystic-vtab-onconflict-not-honored`** — The insert path **throws**
  `ConstraintError` and **ignores `args.onConflict`**, diverging from Quereus's
  documented vtab contract, which says modules should *return*
  `{status:'constraint', constraint:'unique', existingRow}` and honor
  `onConflict`. Tracing `dist/src/runtime/emit/dml-executor.js`
  (`processInsertRow`, `translateConflictError`) confirms this **breaks
  `INSERT OR IGNORE`, `INSERT OR REPLACE`, and `ON CONFLICT DO NOTHING/UPDATE`
  (UPSERT)** — only the default `OR ABORT` works. `OR REPLACE` is a regression
  (it previously worked via the now-removed silent upsert). The error-message
  wording (`UNIQUE constraint failed: <tableName> primary key '<insertKey>'`,
  raised in the review focus areas) is folded into that ticket, since it becomes
  the structured result's `message` field.
- **`optimystic-update-pk-move-silent-overwrite`** — Discovered during review:
  the **UPDATE** path (`case 'update'`, `oldKey !== newKey`) stages
  delete-old + insert-new with **no uniqueness check on the new key**, so
  `UPDATE ... SET pk = <existing other pk>` silently overwrites that other row —
  the same data-loss class as the original bug, on the update path, never covered
  by this ticket's tests.

### Checked and OK (no action)
- **`QuereusError` rethrow pattern.** The new catch rethrows `QuereusError`
  verbatim; this is the only insert/update/delete catch site, and no other catch
  re-wraps these errors. The OR-ABORT path depends on the type surviving, which
  it does.
- **Deleted-then-reinserted key.** A deleted key is staged as `[key, undefined]`,
  so `get` returns `undefined` and a re-insert is correctly allowed.
- **Atomicity (review focus).** Same-transaction case (case 2) needs no rollback
  of staged data — the duplicate throws before staging anything, so the first
  row simply remains staged and commits. Multi-row case (case 3) reverts the
  earlier-staged row via the deferred snapshot. Both verified by tests.

## Known intentional gaps (carried forward)
- PK uniqueness is enforced against **locally-visible** state only (committed +
  staged). Concurrent cross-node duplicate inserts before sync remain a
  consensus-layer concern (`filterConflict` / transactor commit) — out of scope.
- `yarn build` (tsup+dts) and `yarn typecheck` remain broken due to the
  pre-existing libp2p dep-skew tracked as `optimystic-db-p2p-libp2p-dep-skew` —
  unrelated to this diff. Tests run against the already-built `dist/`; the
  inline comment trims do not affect behavior or the built output.
