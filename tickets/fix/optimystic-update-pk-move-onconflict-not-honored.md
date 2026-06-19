description: When an UPDATE changes a row's primary key onto a key another row already occupies, it always errors out, even when the SQL asked to replace the conflicting row — so "update or replace" and upsert-via-key-change fail instead of doing what the user asked.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
----

## Problem

`OptimysticVirtualTable.update`'s `case 'update'` PK-move branch
(`packages/quereus-plugin-optimystic/src/optimystic-module.ts`, ~L838-850)
**throws** a `ConstraintError` whenever a PK-changing UPDATE lands on a key that
a *different* row already occupies:

```ts
const existing = await this.collection.get(newKey);
if (existing !== undefined) {
  throw new ConstraintError(
    `UNIQUE constraint failed: ${this.tableName} primary key '${newKey}'`,
    StatusCode.CONSTRAINT,
  );
}
```

This is the exact same conformance gap that
`optimystic-vtab-onconflict-not-honored` just fixed on the INSERT path: throwing
bypasses the Quereus engine's conflict-resolution branches, so any conflict mode
other than the default `OR ABORT` is broken for a PK-moving UPDATE. The throw
predates conflict-resolution support — it was introduced by
`optimystic-update-pk-move-silent-overwrite` purely to stop a silent overwrite,
and ABORT happens to fall out of a thrown `ConstraintError` via the statement
savepoint.

This ticket is intentionally scoped to the UPDATE path only; the INSERT path is
already conformant.

## Expected behavior

A PK-moving UPDATE that collides with an existing row at `newKey` must honor the
statement's conflict resolution instead of unconditionally erroring. Per the
Quereus vtab contract (`UpdateResult` union in `@quereus/quereus`
`common/types.d.ts`, and `dml-executor.processUpdateRow` / `performUpdate` in the
memory module), `update()` should **return** a structured result rather than
throw:

- `UPDATE OR IGNORE` (or upsert DO NOTHING) on a PK-move collision → keep the
  existing target row, leave the moving row in place / unchanged as SQLite does,
  return a `status:'ok'` result that stages nothing for the conflicting move.
- `UPDATE OR REPLACE` → displace the row already at `newKey` (delete it), move
  the row there, and report the displacement to the engine so its delete
  pipeline (change-tracking, FK actions, auto-events) runs. The memory module's
  `performUpdate` reports this via `replacedRow` / `evictedRows`; match whichever
  channel fits optimystic's PK-only enforcement.
- `UPDATE OR ABORT` (default) / `FAIL` / `ROLLBACK` → return
  `{ status: 'constraint', constraint: 'unique', message, existingRow }`; the
  engine's `translateConflictError` maps it to the right subclass. Reuse the same
  `uniqueConstraintMessage()` helper the INSERT path added so the client-facing
  message stays consistent (`UNIQUE constraint failed: <table>.<pkCol>[, …]`).

The non-PK-move UPDATE branch (`oldKey === newKey`, a simple in-place update) is
already correct and should stay as-is — it has no collision to resolve.

### Reference

- The just-landed INSERT fix in the same file is the closest in-tree pattern:
  decode the conflicting row once from the entry value `[pk, encoded]`, branch on
  `args.onConflict ?? ConflictResolution.ABORT`, return structured results, wire
  REPLACE through `markDirtyTrees` + re-stage + index maintenance.
- The canonical engine-side contract is the memory module's `performUpdate`
  (`C:\projects\quereus\packages\quereus\dist\src\vtab\memory\layer\manager.js`,
  ~L657-735) and `dml-executor.processUpdateRow`.

### Open design question for the implementer

SQLite's `UPDATE OR REPLACE` semantics on a UNIQUE collision (delete the
conflicting row, then write the updated row) interact with optimystic's PK-only
enforcement and its delete-old + insert-new staging of a PK move. Confirm the
correct `replacedRow` vs `evictedRows` reporting and the exact staging order
(the displaced target row is at `newKey`; the moving row vacates `oldKey`) so the
engine's post-write pipeline fires the right number of delete/update events.

## Use cases to cover in tests

Extend `test/insert-pk-uniqueness.spec.ts` (or a sibling sharing its `createDb` /
`selectScalar` / `reopenScalar` helpers, against the real `local` /
`FileRawStorage` transactor):

- `UPDATE OR REPLACE` that moves row A's PK onto row B's PK → B is displaced, A's
  data lands at the target PK, exactly one row remains at that PK, persists across
  reopen.
- `UPDATE OR IGNORE` on the same collision → no throw, both original rows intact.
- Default `UPDATE` (ABORT) on the collision → still rejected, both rows intact
  (regression guard — this is the only mode that works today).
- A PK-move collision on a table with a secondary index → index entries for the
  displaced row are removed and the surviving row's index entry is correct.

## Validation

- `npm run build` (tsup) in `packages/quereus-plugin-optimystic` before tests
  (tests import from `dist/plugin.js`).
- `npm test` and `npm run typecheck` in that package; the `UpdateResult` union is
  strict, so confirm every `update` return matches it.
