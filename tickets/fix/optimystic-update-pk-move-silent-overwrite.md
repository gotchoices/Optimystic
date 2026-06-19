description: Changing a row's primary key to one another row already uses silently destroys that other row instead of being rejected, causing quiet data loss.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
difficulty: medium
----

## Problem

`OptimysticVirtualTable.update` (`case 'update'`) handles a primary-key change by
staging delete-old + insert-new with **no uniqueness check on the new key**:

```ts
if (oldKey !== newKey) {
  await this.collection.stage([
    [oldKey, undefined],
    [newKey, [newKey, encodedRow]]   // overwrites whatever already lives at newKey
  ]);
}
```

Because staging into the collection B-tree is an upsert, an
`UPDATE t SET pk = <pk already used by a different row>` **silently overwrites**
that other row — quiet data loss. This is the same class of bug that
`optimystic-insert-pk-uniqueness-not-enforced` fixed for the INSERT path, but the
UPDATE-moves-onto-occupied-PK case was never covered and is still broken. The
engine delegates PK-uniqueness enforcement to the vtab (that delegation is the
whole reason the insert bug existed), so nothing upstream catches it.

## Required behavior

When an UPDATE changes the PK (`oldKey !== newKey`) and `newKey` already exists
(committed or staged) for a *different* row, the move must be treated as a
uniqueness conflict rather than silently overwriting. Implement this consistently
with whatever conflict-handling approach the insert path adopts — ideally the
structured `UpdateResult` + `onConflict` contract (see prereq below): honor
`IGNORE` (skip the move), `REPLACE` (overwrite + report `replacedRow`), and
`ABORT`/`FAIL`/`ROLLBACK` (return `{status:'constraint', constraint:'unique',
existingRow}`).

If this lands before the conflict-resolution work, a minimal interim fix is to
mirror the insert path: `get(newKey)` and throw a `ConstraintError` on collision
before staging. Note the index-entry staging
(`indexManager.updateIndexEntries`) must also be guarded so a rejected move
stages nothing.

## Relationship

Shares root cause and fix mechanism with `optimystic-vtab-onconflict-not-honored`
(both are "vtab doesn't enforce PK uniqueness / honor the conflict contract").
Deliberately **not** chained as a prereq: this is quiet data loss and should be
fixable independently (the interim throw approach needs no foundation). If the
conflict-resolution ticket lands first, reuse its structured-return path instead
of the interim throw.

## Tests

Against the real `local`/`FileRawStorage` transactor:

- `UPDATE t SET id = <existing other id>` is rejected (default ABORT); both rows
  intact in-session and after reopen.
- Same move inside an explicit transaction — offending statement aborts, txn
  continues, both rows survive commit.
- (If conflict modes are implemented) `UPDATE OR REPLACE` move overwrites the
  target row and reports it correctly; `UPDATE OR IGNORE` leaves both rows.
- A PK-change to a genuinely unused key still succeeds (regression guard).
