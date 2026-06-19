description: Review the primary-key uniqueness enforcement fix for duplicate-key inserts in the local/bootstrap transactor.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
----

## Implementation summary

`OptimysticVirtualTable.update` (`case 'insert'`) now calls `this.collection.get(insertKey)` before staging. If the key is already present (committed or staged earlier in the same transaction), a `ConstraintError` is thrown — **before** `markDirtyTrees()`/`stage()`, so the row is never staged. The surrounding catch block was updated to rethrow any `QuereusError` verbatim (previously it re-wrapped every error in a plain `Error`, erasing constraint classification).

### Test coverage

Three cases in `test/insert-pk-uniqueness.spec.ts` (all against a real `FileRawStorage` / `local` transactor):

1. Duplicate-key INSERT in a **separate transaction** — rejected; original row intact in-session and after reopen.
2. Duplicate-key INSERT staged **earlier in the same explicit transaction** — rejected; `commit` still succeeds and persists the original value.
3. Duplicate key within a **single multi-row INSERT** — rejected wholesale; table stays empty.

All three assert OR ABORT semantics (offending statement rolls back, surrounding transaction continues).

### Validation

- `yarn test` in `packages/quereus-plugin-optimystic`: **215 passing, 5 pending** (same counts as before the fix, no regressions).
- `optimystic-module.ts` typechecks clean for this change.
- `yarn build` (tsup+dts) and `yarn typecheck` remain broken due to the pre-existing libp2p dep-skew tracked as `optimystic-db-p2p-libp2p-dep-skew` — unrelated to this diff, not filed again here.

## Known intentional gap (scope note)

This fix enforces PK uniqueness against **locally-visible** state (committed + staged). It does **not** cover concurrent cross-node conflicts: two nodes inserting the same key before they sync is a consensus-layer concern handled by `filterConflict` / transactor commit, and is out of scope for this ticket.

## Review focus areas

- **Comment verbosity.** The insert branch and the catch block carry multi-line block comments explaining the fix rationale. The coding style preference is for minimal comments (WHY only, when non-obvious). The reviewer should decide whether the comments add enough value for future maintainers or should be trimmed — especially the 10-line explanation above the `get` call.
- **Error message format.** Current: `UNIQUE constraint failed: <tableName> primary key '<insertKey>'`. SQLite's format for UNIQUE violations is `UNIQUE constraint failed: <table>.<column>`. The optimystic primary key is composite or a serialized tuple, not a column name, so an exact SQLite match isn't possible — but the reviewer should decide whether the wording is close enough, or whether a closer approximation (e.g. `UNIQUE constraint failed: <tableName>.<pkColumn(s)>`) is worth pursuing for client-code compatibility.
- **`QuereusError` rethrow pattern.** The catch re-throws `QuereusError` instances unwrapped. Confirm this is idiomatic with the rest of the codebase (no other catch site accidentally re-wraps them now that the OR ABORT path depends on the type surviving).
- **Atomicity claim.** The ticket asserts that rows staged *earlier* in the statement/transaction are reverted by the deferred-rollback snapshot in `txn-bridge.ts`. The multi-row INSERT test (case 3) verifies this for the multi-row case. The reviewer may want to trace the snapshot/restore path to confirm it holds for the same-explicit-transaction case (case 2) as well, or accept the empirical evidence from the tests.
