description: An INSERT that hits a duplicate key always errors out, even when the SQL asked to ignore or replace the conflicting row — so "insert or ignore", "insert or replace", and upsert all fail instead of doing what the user asked.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts
difficulty: medium
----

## Reproduction (confirmed)

A throwaway repro spec exercised the four conflict modes against the real
`local` / `FileRawStorage` transactor. **All four currently throw**
`ConstraintError: UNIQUE constraint failed: T primary key '1'` straight out of
`OptimysticVirtualTable.update` (`case 'insert'`), bypassing the engine's
conflict-resolution branches:

- `INSERT OR IGNORE` → throws (should skip the row)
- `INSERT OR REPLACE` → throws (should overwrite)
- `INSERT ... ON CONFLICT (pk) DO NOTHING` → throws (should preserve original)
- `INSERT ... ON CONFLICT (pk) DO UPDATE SET ...` → throws (should update)

Stack confirms the throw site: `optimystic-module.ts` insert path →
`processInsertRow` (`dml-executor.js:461`). Default `OR ABORT` is the only mode
that "works", because a thrown `ConstraintError` under ABORT coincidentally
produces abort semantics via the statement savepoint.

(The repro harness was deleted after confirming — the real coverage goes into
`insert-pk-uniqueness.spec.ts` per the Tests section.)

## Root cause

`OptimysticVirtualTable.update`'s `case 'insert'`
(`packages/quereus-plugin-optimystic/src/optimystic-module.ts`, ~L732-771)
does a pre-stage `collection.get(insertKey)` and, on a hit, **throws** a
`ConstraintError`. The `catch` at the bottom of `update` rethrows
`QuereusError`s verbatim so the throw survives.

The Quereus vtab contract (verified against the sibling checkout at
`C:\projects\quereus\packages\quereus\dist\src`) requires the module to
**return** a structured result instead:

- `vtab/table.d.ts` — `UpdateArgs.onConflict?: ConflictResolution`
  (`ROLLBACK=1 | ABORT=2 | FAIL=3 | IGNORE=4 | REPLACE=5`), and the doc on
  `update()`: *"Modules should return constraint violations rather than throwing
  ConstraintError… This allows the engine to handle UPSERT and other conflict
  resolution strategies. Unexpected errors (network, bugs) should still throw."*
- `common/types.d.ts` — `UpdateResult`:
  ```ts
  type UpdateResult =
    | { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
    | { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };
  ```
- `runtime/emit/dml-executor.js` — `processInsertRow` (~L444-524):
  - On `status:'constraint'` with `constraint:'unique'` + `existingRow`, it runs
    `matchUpsertClause(existingRow, newRow, …)` to drive `ON CONFLICT DO
    NOTHING / DO UPDATE`. **A thrown error never reaches this branch.**
  - On `status:'ok'` with **no** `row`, it skips the row (IGNORE / DO NOTHING).
  - On `status:'ok'` with a `replacedRow`, it runs the displaced-row bookkeeping
    (change-tracking `_recordUpdate`, row-time MV maintenance, FK actions,
    auto-events) — the REPLACE path.
  - `runWithStatementSavepoints.translateConflictError` (~L257) maps a thrown
    `ConstraintError` to FAIL/ROLLBACK subclasses for those modes, but for
    IGNORE/REPLACE/UPSERT the throw just aborts the statement savepoint.

## Reference implementation

The in-tree memory module is the canonical pattern — mirror its
`performInsert` (`C:\projects\quereus\packages\quereus\dist\src\vtab\memory\layer\manager.js`,
~L613-655):

```js
const existingRow = this.lookupEffectiveRow(primaryKey, targetLayer);
if (existingRow !== null) {
  const pkAction = onConflict ?? resolvePkDefaultConflict(schema) ?? ConflictResolution.ABORT;
  if (pkAction === ConflictResolution.IGNORE) return { status: 'ok', row: undefined };
  if (pkAction === ConflictResolution.REPLACE) {
    targetLayer.recordUpsert(primaryKey, newRowData, existingRow);
    return { status: 'ok', row: newRowData, replacedRow: existingRow };
  }
  return { status: 'constraint', constraint: 'unique', message: …, existingRow };
}
```

Optimystic has no per-constraint `defaultConflict`, so the fallback is plain
`ConflictResolution.ABORT`.

## Required behavior

Rewrite the duplicate-key branch of `case 'insert'` so that, on
`existing !== undefined`:

1. Decode the conflicting row once — `existingRow = this.rowCodec.decodeRow(existing[1])`
   (the entry value is `[primaryKey, encodedRow]`; `executePointLookup` already
   decodes the same `entry[1]`). Reuse the entry already fetched by
   `collection.get` — do **not** issue a second read.
2. Branch on `args.onConflict ?? ConflictResolution.ABORT`:
   - **IGNORE** → `return { status: 'ok' }` (no `row`). Stage nothing. Do **not**
     increment statistics.
   - **REPLACE** → overwrite in place: `markDirtyTrees()`, re-stage
     `[[insertKey, [insertKey, encodedRow]]]`, then update index entries from the
     old row to the new via `indexManager.updateIndexEntries(existingRow, values,
     insertKey, insertKey, txnState?.transactor)` (same PK → only changed indexed
     columns restage). Return `{ status: 'ok', row: values, replacedRow:
     existingRow }`. Row count is unchanged → do **not** increment statistics.
   - **ABORT (default) / FAIL / ROLLBACK** → `return { status: 'constraint',
     constraint: 'unique', message, existingRow }`. The engine's
     `translateConflictError` maps the structured result to the right subclass;
     the vtab no longer needs to throw for these.
3. Keep the no-conflict path exactly as today (stage + index insert + increment).
4. Continue to **throw** only for genuinely unexpected errors (network, bugs).
   The existing `catch (error)` that rethrows `QuereusError` verbatim can stay
   (harmless once the constraint path returns), but it is no longer the
   constraint mechanism.

`existing` is typed `as [string, EncodedRow] | undefined` (matching
`executePointLookup`). `ConflictResolution` is a runtime enum re-exported from
`@quereus/quereus` — add it to the existing named import from that package.

### Message wording

Move from `UNIQUE constraint failed: <tableName> primary key '<insertKey>'`
toward SQLite's `UNIQUE constraint failed: <table>.<col>[, <table>.<col>…]`
using PK column names. PK columns come from `this.tableSchema.primaryKeyDefinition`
(each has `.index`) mapped through `this.tableSchema.columns[index].name`. Build
once in a small private helper (e.g. `uniqueConstraintMessage()`) and use it for
the `message` field. This is the value clients see for compatibility.

## Scope / non-goals

- Composite or secondary-UNIQUE `evictedRows` are out of scope — optimystic
  enforces only the PK today, so REPLACE reports `replacedRow` (same-PK
  displacement) but never `evictedRows`.
- Keep enforcement scoped to locally-visible state (committed + staged), exactly
  as the current `collection.get` already does. Cross-node conflicts remain a
  consensus-layer concern.
- The UPDATE PK-move path (`case 'update'`, ~L794-800) *also* throws a
  `ConstraintError` today (its own recently-completed ticket,
  `optimystic-update-pk-move-silent-overwrite`). Bringing that path into the
  same structured-result conformance (so `UPDATE OR REPLACE` / upsert-via-move
  work) is a **related but separate** concern — do not expand this ticket to
  cover it; if it looks worthwhile, file a follow-up fix ticket.

## Tests

Extend `test/insert-pk-uniqueness.spec.ts` (or a sibling spec sharing its
`createDb` / `selectScalar` / `reopenScalar` helpers, against the real `local` /
`FileRawStorage` transactor). The existing 3 ABORT-regression cases must keep
passing. Add:

- `INSERT OR IGNORE` on a duplicate → statement succeeds, original row
  unchanged, exactly one row, no throw.
- `INSERT OR REPLACE` on a duplicate → row overwritten, exactly one row, new
  value persists across reopen (`reopenScalar`).
- `INSERT ... ON CONFLICT (pk) DO NOTHING` → original preserved, no throw.
- `INSERT ... ON CONFLICT (pk) DO UPDATE SET v = …` → row updated per the clause.
- (Optional) a REPLACE on a table with a secondary index, asserting an indexed
  lookup returns the new value (exercises the `updateIndexEntries` path).

## Validation

- `npm run build` (tsup) in `packages/quereus-plugin-optimystic` — tests import
  from `dist/plugin.js`, so the build must precede the test run.
- `npm test` in that package (streams via mocha `min` reporter). Confirm the new
  cases pass and no existing spec regresses.
- `npm run typecheck` (`tsc --noEmit`) — the `UpdateResult` union is strict;
  ensure every `return` in `update` matches it.
- If any failure is clearly unrelated/pre-existing, follow the
  `.pre-existing-error.md` protocol rather than chasing it here.

## TODO

- Add `ConflictResolution` to the `@quereus/quereus` named import in
  `optimystic-module.ts`.
- Add a private `uniqueConstraintMessage()` helper that renders
  `UNIQUE constraint failed: <table>.<pkCol>[, …]` from
  `tableSchema.primaryKeyDefinition` + `tableSchema.columns`.
- Rewrite the duplicate-key branch of `case 'insert'` to return the structured
  result and honor `args.onConflict` (IGNORE / REPLACE / ABORT|FAIL|ROLLBACK) as
  specified above; wire REPLACE through `markDirtyTrees` + re-stage +
  `indexManager.updateIndexEntries(existingRow, values, insertKey, insertKey, …)`.
- Guard statistics: increment only on a real insert (not IGNORE/REPLACE).
- Add the conflict-mode tests to `insert-pk-uniqueness.spec.ts` (or sibling).
- Build, run tests, typecheck; record any deferrals.
