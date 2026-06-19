description: When an UPDATE changes a row's primary key onto a key another row already occupies, it always errors out, even when the SQL asked to replace the conflicting row — so "update or replace" and upsert-via-key-change fail instead of doing what the user asked.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
----

## Problem (reproduced)

`OptimysticVirtualTable.update`'s `case 'update'` PK-move branch
(`packages/quereus-plugin-optimystic/src/optimystic-module.ts`, currently
**L838–L850**) **throws** an unconditional `ConstraintError` whenever a
PK-changing UPDATE lands on a key a *different* row already occupies:

```ts
if (oldKey !== newKey) {
  const existing = await this.collection.get(newKey);
  if (existing !== undefined) {
    throw new ConstraintError(
      `UNIQUE constraint failed: ${this.tableName} primary key '${newKey}'`,
      StatusCode.CONSTRAINT,
    );
  }
  ...
}
```

Throwing bypasses the Quereus engine's conflict-resolution branches, so every
conflict mode other than the default `OR ABORT` is broken for a PK-moving
UPDATE: `UPDATE OR REPLACE` and `UPDATE OR IGNORE` both error instead of doing
what the SQL asked. This is the exact same conformance gap the just-landed
INSERT fix (`optimystic-vtab-onconflict-not-honored`, same file, INSERT branch
~L760–L802) already closed. The throw predates conflict-resolution support — it
was added by `optimystic-update-pk-move-silent-overwrite` purely to stop a
silent overwrite, and ABORT happens to fall out of the thrown `ConstraintError`
via the statement savepoint.

The non-PK-move branch (`oldKey === newKey`, simple in-place update) has no
collision and is already correct — leave it untouched. Scope is the UPDATE
PK-move path only; the INSERT path is already conformant.

## Engine contract (confirmed against the in-tree quereus dist)

The vtab must **return** a structured `UpdateResult`, never throw, for a
PK-move collision. The canonical reference is the memory module's
`performUpdateWithPrimaryKeyChange`
(`C:\projects\quereus\packages\quereus\dist\src\vtab\memory\layer\manager.js`,
L701–L722) and the UPDATE-path consumer
`processUpdateRow` (`…\dist\src\runtime\emit\dml-executor.js`, L586–L650).

`UpdateResult` (`…\dist\src\common\types.d.ts`, L173–L183) is the strict union:

```ts
type UpdateResult =
  | { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
  | { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };
```

Required behavior per conflict mode, with `onConflict = args.onConflict ??
ConflictResolution.ABORT` (mirrors the INSERT path; optimystic has no
per-constraint default):

| mode | what to do | return |
|------|-----------|--------|
| `IGNORE` (or upsert DO NOTHING) | stage **nothing**; both original rows stay put, moving row unchanged at `oldKey` | `{ status: 'ok' }` (memory returns `row: undefined`) |
| `REPLACE` | displace the row at `newKey`, move the row there, clean up the displaced row's index entries | `{ status: 'ok', row: values, replacedRow: existingRow }` |
| `ABORT` (default) / `FAIL` / `ROLLBACK` | reject; stage nothing, touch no trees | `{ status: 'constraint', constraint: 'unique', message: this.uniqueConstraintMessage(), existingRow }` |

The engine's `translateConflictError` maps the `constraint` result to the right
subclass for FAIL/ROLLBACK. **Reuse the existing `uniqueConstraintMessage()`
helper** (already on the class, L712–L717) — drop the ad-hoc throw string so the
client-facing message matches the INSERT path
(`UNIQUE constraint failed: <table>.<pkCol>[, …]`).

### `replacedRow` is the right channel (open design question — RESOLVED)

`processUpdateRow` (dml-executor.js L637–L643) consumes `result.replacedRow` on
the UPDATE move path by firing it as a **full DELETE of the displaced row**:
`_recordDelete` + row-time maintenance (`op:'delete'`) + FK actions
(`'delete'`) + a delete auto-event. That is exactly the displaced-target
semantics we need, and it is precisely what the memory module returns for this
case (`return { status:'ok', row:newRowData, replacedRow: existingRowAtNewKey }`,
manager.js L713). So:

- **Use `replacedRow`**, not `evictedRows`. `evictedRows` is for rows removed at
  *other* PKs to resolve a *non-PK* UNIQUE conflict — optimystic enforces only
  the PK, so it never produces evictions; always omit `evictedRows`.
- Decode the displaced row **once** from the entry value, exactly like the
  INSERT path: `this.collection.get(newKey)` returns `[pk, encoded]`, so
  `existingRow = this.rowCodec.decodeRow(existing[1])`.

### Main-table + index staging (the subtle part)

The main-table staging for REPLACE is **identical** to the existing
non-collision PK-move: `[[oldKey, undefined], [newKey, [newKey, encodedRow]]]`.
Staging `undefined` at `oldKey` removes the moving row's old slot; staging at
`newKey` (an upsert) overwrites the displaced row with the moving row in one
shot. No separate "delete the displaced main-table row" step is needed.

Index maintenance for REPLACE needs **two** stagings, in this order:

1. `this.indexManager.deleteIndexEntries(existingRow, newKey, txnState?.transactor)`
   — removes the **displaced** row's index entries (its treeKeys are
   `<displacedIndexKey>\x00<newKey>`).
2. `this.indexManager.updateIndexEntries(oldKeyValues, values, oldKey, newKey, txnState?.transactor)`
   — transitions the **moving** row's entries (`<oldIdx>\x00<oldKey>` →
   `<newIdx>\x00<newKey>`), same call the non-collision path already makes.

**Order matters.** When the displaced row and the moving row share the same
indexed value, both stagings touch the identical tree key
`<idx>\x00<newKey>`. Deleting the displaced entry **first**, then letting
`updateIndexEntries` re-insert, leaves the surviving (moving-row) entry in
place. The reverse order would insert then delete, leaving the index entry
wrongly absent. (See `IndexManager.deleteIndexEntries` /
`updateIndexEntries`, `src/schema/index-manager.ts` L127–L178, for the exact
treeKey format.)

Call `this.markDirtyTrees()` once before any staging (snapshot-before-mutate),
exactly as the other branches do. For IGNORE and the constraint result, stage
nothing and do **not** call `markDirtyTrees()` — leave the snapshot untouched so
the rejected/ignored move costs nothing, matching the INSERT path.

### Statistics

The displaced row is removed, so the table's net row count drops by one on a
successful REPLACE. The existing UPDATE branch never touches
`statisticsCollector` (a same-key update is count-neutral), but a REPLACE
PK-move is the one update that is not. Call
`this.statisticsCollector?.decrementRowCount()` on the REPLACE branch so the
collector stays accurate. (Low-stakes — it only feeds cost estimates — but cheap
to keep correct and consistent with the delete path's `decrementRowCount()`.)

## Tests to add

Extend `test/insert-pk-uniqueness.spec.ts` with a new `describe` block (reuse
its `createDb` / `selectScalar` / `selectCount` / `reopenScalar` /
`captureThrowMessage` helpers, against the real `local` / `FileRawStorage`
transactor). Cover:

- **`UPDATE OR REPLACE` PK-move collision** — seed rows A(`id=1`) and
  B(`id=2`); `update or replace T set id = 2 where id = 1`. B is displaced,
  A's non-PK data lands at `id=2`, exactly one row remains, count is 1, and the
  surviving value persists across `reopenScalar`.
- **`UPDATE OR IGNORE` on the same collision** — no throw; both original rows
  intact (A still at `id=1`, B still at `id=2`), count 2, unchanged across
  reopen.
- **Default `UPDATE` (ABORT) on the collision** — still rejected
  (`captureThrowMessage` → contains `UNIQUE constraint failed: T.id`), both rows
  intact (regression guard; this is the only mode that works pre-fix).
- **PK-move collision with a secondary index** — `create index idx_v on T (v)`
  (or a dedicated indexed column); after `UPDATE OR REPLACE` moves A onto B's
  PK, the displaced row B's index entry no longer resolves
  (`select count(*) where <col> = <B's value>` → 0) and the surviving row's
  index lookup returns A's value. Verify across reopen.

## Validation

- `npm run build` (tsup) in `packages/quereus-plugin-optimystic` **before**
  tests — the specs import from `dist/plugin.js`.
- `npm test` and `npm run typecheck` in that package. The `UpdateResult` union
  is strict; confirm every `update` return in the modified branch matches it
  (notably: omit `evictedRows`; `replacedRow` only on the REPLACE branch).
- Stream long output with `… 2>&1 | tee /tmp/…log`, never silent redirection.

## TODO

- [ ] In `optimystic-module.ts` `case 'update'`, inside the `oldKey !== newKey`
      branch, replace the `existing !== undefined` throw with a decode +
      conflict-mode switch on `args.onConflict ?? ConflictResolution.ABORT`.
- [ ] IGNORE: stage nothing, `return { status: 'ok' }` (no `markDirtyTrees`).
- [ ] REPLACE: `markDirtyTrees()`; stage
      `[[oldKey, undefined], [newKey, [newKey, encodedRow]]]`;
      `deleteIndexEntries(existingRow, newKey, …)` **then**
      `updateIndexEntries(oldKeyValues, values, oldKey, newKey, …)`;
      `statisticsCollector?.decrementRowCount()`;
      `return { status: 'ok', row: values, replacedRow: existingRow }`.
- [ ] ABORT/FAIL/ROLLBACK: `return { status: 'constraint', constraint: 'unique',
      message: this.uniqueConstraintMessage(), existingRow }`.
- [ ] Confirm the non-collision PK-move path and the `oldKey === newKey` path are
      unchanged.
- [ ] Drop the now-unused `ConstraintError` / `StatusCode` imports **only if**
      nothing else in the file references them (check before removing — the
      catch block at the end rethrows `QuereusError`, which is separate).
- [ ] Add the four tests above; build, then `npm test` + `npm run typecheck`.
