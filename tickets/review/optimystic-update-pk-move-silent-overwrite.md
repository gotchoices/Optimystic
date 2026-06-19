description: Review the fix that makes UPDATE reject a primary-key move onto an already-occupied key instead of silently overwriting the target row.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/update-pk-move-uniqueness.spec.ts
----

## What was done

Added a pre-stage uniqueness check in the `case 'update'` block of `OptimysticVirtualTable.update` (`src/optimystic-module.ts`), mirroring the existing INSERT path fix.

**Change summary** — inside the `if (oldKey !== newKey)` branch:
1. Call `this.collection.get(newKey)` before touching any trees.
2. If the result is non-undefined, throw `ConstraintError` (`UNIQUE constraint failed: … primary key '${newKey}'`) — same error type and wording as the INSERT path.
3. Only after a clean check call `this.markDirtyTrees()` and then `stage()`.

The simple-update branch (`oldKey === newKey`) is unchanged; `markDirtyTrees()` was split out of the shared preamble and placed inside each branch independently.

## Test results

- `test/update-pk-move-uniqueness.spec.ts` — all **3 cases pass** (previously 2 failing):
  - Rejects collision in-session and confirmed no overwrite after reopen.
  - Rejects collision inside a transaction; transaction still commits, both rows survive.
  - Allows move to a genuinely unused key (regression guard).
- Full suite: **226 passing, 5 pending, 0 failing.**

## Use cases for reviewer validation

1. `UPDATE T SET id = 2 WHERE id = 1` where `id=2` already exists → must throw, both rows intact before and after reopen.
2. Same inside `BEGIN … COMMIT` → statement aborts, transaction commits, both rows intact.
3. `UPDATE T SET id = 99 WHERE id = 1` where `99` is unused → succeeds, row moves cleanly.
4. `UPDATE T SET v = 'x' WHERE id = 1` (no PK change) → unaffected, still commits normally.

## Known gaps / deferred

- `UPDATE OR REPLACE` / `UPDATE OR IGNORE` semantics are not wired yet — deferred until `optimystic-vtab-onconflict-not-honored` lands.
- The check uses `collection.get(newKey)` which sees rows staged earlier in the same transaction. That matches the INSERT-path guarantee and is correct SQL ABORT-level semantics; no gap here.
