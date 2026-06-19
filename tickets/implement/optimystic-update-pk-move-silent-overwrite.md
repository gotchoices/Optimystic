description: Changing a row's primary key to one another row already uses silently destroys that other row instead of being rejected; reject the move as a uniqueness conflict so no data is lost.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/update-pk-move-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts
difficulty: easy
----

## Confirmed reproduction

A reproducing spec is already in the tree at
`packages/quereus-plugin-optimystic/test/update-pk-move-uniqueness.spec.ts`
(runs against the real `local`/`FileRawStorage` transactor). Built + run against
current `main`, two of its three cases FAIL and one passes:

- ✗ `UPDATE T SET id = 2 WHERE id = 1` (where id=2 exists) resolves instead of
  throwing — row 2 is silently overwritten.
- ✗ Same move inside a transaction resolves instead of aborting the statement.
- ✓ PK-move to an unused key succeeds (regression guard — must keep passing).

Run from `packages/quereus-plugin-optimystic`:

```
yarn build
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/update-pk-move-uniqueness.spec.ts" --colors --reporter spec --exit
```

## Root cause

`OptimysticVirtualTable.update`, `case 'update'`
(`src/optimystic-module.ts:773`–`812`) handles a PK change as delete-old +
insert-new with **no uniqueness check on the new key**:

```ts
if (oldKey !== newKey) {
  await this.collection.stage([
    [oldKey, undefined],
    [newKey, [newKey, encodedRow]]   // upsert — overwrites whatever lives at newKey
  ]);
}
```

Staging into the collection B-tree is an upsert (the exact reason the INSERT bug
existed — see `optimystic-insert-pk-uniqueness-not-enforced`, fixed at
`src/optimystic-module.ts:736`–`753` with a pre-stage `get()` + `ConstraintError`).
The engine delegates PK-uniqueness enforcement to the vtab, so nothing upstream
catches the colliding move. `indexManager.updateIndexEntries`
(`src/schema/index-manager.ts:149`) likewise stages the new index entry
unconditionally, so a rejected move must stage nothing in either tree.

## Fix approach — interim throw (mirror the INSERT path)

The structured `UpdateResult` + `onConflict` work
(`optimystic-vtab-onconflict-not-honored`) is still in `fix/` — NOT landed — and
the source ticket deliberately does not chain it as a prereq (this is quiet data
loss and must be fixable independently). So implement the minimal interim fix:
when the PK changes and `newKey` is already occupied by a *different* row, throw
a `ConstraintError` **before** `markDirtyTrees()`/`stage()`, exactly as the
insert path does. Placing the check before `markDirtyTrees()` guarantees a
rejected move stages nothing in the main collection or any index tree (nothing
is marked dirty, nothing is staged), so in-session and post-reopen state is
untouched and a transaction's other statements still commit.

Because `oldKey !== newKey` already gates the move branch, a positive `get(newKey)`
necessarily means a *different* row occupies the target — no same-row false
positive is possible. (`get` sees rows committed by prior transactions and rows
staged earlier in this one, matching the insert-path guarantee.)

Sketch (inside the existing `if (oldKey !== newKey)` branch, before `markDirtyTrees()`):

```ts
const existing = await this.collection.get(newKey);
if (existing !== undefined) {
  throw new ConstraintError(
    `UNIQUE constraint failed: ${this.tableName} primary key '${newKey}'`,
    StatusCode.CONSTRAINT,
  );
}
```

Note `markDirtyTrees()` is currently called once at the top of the `update`
block (line ~786), *before* the `oldKey !== newKey` test. Move the uniqueness
check ahead of that call (or restructure so the throw precedes any
`markDirtyTrees`/`stage`/`updateIndexEntries` for the PK-change branch) so a
rejected move leaves the trees unmarked and unstaged. The simple-update branch
(`oldKey === newKey`) keeps its existing ordering. `ConstraintError`/`StatusCode`
are already imported (`src/optimystic-module.ts:14`); the existing `catch`
rethrows `QuereusError` verbatim so the constraint classification survives.

## If the conflict-resolution ticket lands first

Reuse its structured-return path instead of the interim throw: honor `IGNORE`
(skip the move), `REPLACE` (overwrite + report `replacedRow`), and
`ABORT`/`FAIL`/`ROLLBACK` (`{status:'constraint', constraint:'unique',
existingRow}`). The two `UPDATE OR REPLACE` / `UPDATE OR IGNORE` cases in the
"Tests" section below become live then; until that lands they're out of scope.

## TODO

- In `src/optimystic-module.ts` `case 'update'`, add a pre-stage `get(newKey)`
  uniqueness check inside the `oldKey !== newKey` branch, throwing a
  `ConstraintError` on collision. Ensure the throw precedes `markDirtyTrees()`,
  the main-collection `stage()`, and `indexManager.updateIndexEntries()` so a
  rejected move stages nothing.
- Build the package (`yarn build`) and run
  `test/update-pk-move-uniqueness.spec.ts` — all three cases must pass.
- Run the full package test suite (`yarn test`) to confirm no regression,
  especially `test/insert-pk-uniqueness.spec.ts` and any update/transaction specs.
- (Deferred — only if `optimystic-vtab-onconflict-not-honored` has landed) add
  `UPDATE OR REPLACE` (overwrites target, reports it) and `UPDATE OR IGNORE`
  (leaves both rows) cases to the spec and wire the structured-return path.
