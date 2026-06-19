description: An INSERT that hits a duplicate key always errors out, even when the SQL asked to ignore or replace the conflicting row — so "insert or ignore", "insert or replace", and upsert all fail instead of doing what the user asked.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts
difficulty: medium
----

## Problem

The PK-uniqueness fix (`optimystic-insert-pk-uniqueness-not-enforced`) made
`OptimysticVirtualTable.update` (`case 'insert'`) **throw** a `ConstraintError`
on a duplicate key. That is correct for the default `OR ABORT`, but it diverges
from Quereus's documented vtab contract and breaks every other conflict mode.

The Quereus `VirtualTable.update` contract (see
`@quereus/quereus` `dist/src/vtab/table.d.ts` and `common/types.d.ts`):

> Modules should **return** constraint violations rather than throwing
> `ConstraintError` for expected violations (unique, check, not_null). This
> allows the engine to handle UPSERT and other conflict resolution strategies.
> Unexpected errors (network, bugs) should still throw exceptions.

`UpdateArgs` carries `onConflict?: ConflictResolution`
(`ROLLBACK | ABORT | FAIL | IGNORE | REPLACE`), and `UpdateResult` is:

```ts
type UpdateResult =
  | { status: 'ok'; row?: Row; replacedRow?: Row; evictedRows?: readonly Row[] }
  | { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row };
```

The optimystic insert path **ignores `args.onConflict` entirely** and throws.
Tracing the engine's DML executor (`dist/src/runtime/emit/dml-executor.js`,
`processInsertRow` ~L444 and `translateConflictError` ~L257) confirms the
consequences:

- **`INSERT ... ON CONFLICT DO NOTHING / DO UPDATE` (UPSERT)** — handled only
  when the vtab *returns* `{ status: 'constraint', constraint: 'unique',
  existingRow }`; `matchUpsertClause` needs `existingRow`. A thrown error
  bypasses this branch entirely → UPSERT is impossible.
- **`INSERT OR IGNORE`** — expected to skip the row (vtab returns `{status:'ok'}`
  with no `row`, or engine skips on the structured constraint). `translateConflictError`
  passes a thrown `ConstraintError` through unchanged for IGNORE, so the
  statement-scope savepoint rolls back and the statement **aborts** instead of
  skipping.
- **`INSERT OR REPLACE`** — expected to overwrite (engine consumes
  `replacedRow` / `evictedRows`). The vtab throws → aborts. This is a
  **regression**: before the uniqueness fix, OR REPLACE "worked" by accident
  via the silent upsert that the fix (correctly) removed.

Only default/explicit `OR ABORT` works today, because a thrown `ConstraintError`
under ABORT happens to produce abort semantics via the statement savepoint.

## Required behavior

Bring the insert path into conformance with the Quereus conflict-resolution
contract:

- On a duplicate PK, **return** `{ status: 'constraint', constraint: 'unique',
  existingRow }` rather than throwing — where `existingRow` is the decoded
  conflicting row (decode the entry already fetched by `collection.get`), so the
  engine can drive `ON CONFLICT DO NOTHING / DO UPDATE`.
- Honor `args.onConflict`:
  - `IGNORE` — do not stage; return `{ status: 'ok' }` with no `row` (engine
    skips it).
  - `REPLACE` — overwrite the existing row and report it via `replacedRow` so the
    engine runs the displaced-row bookkeeping (change-tracking, FK actions,
    events). (Composite/secondary-unique `evictedRows` are likely out of scope —
    optimystic enforces only the PK today.)
  - `ABORT` (default) / `FAIL` / `ROLLBACK` — surface the structured `constraint`
    result; the engine's `translateConflictError` maps it to the right subclass.
- Continue to throw only for genuinely unexpected errors (network, bugs).

Keep the change scoped to locally-visible state (committed + staged); concurrent
cross-node conflicts remain a consensus-layer concern, as before.

While here, reconsider the error/message wording (`UNIQUE constraint failed:
<tableName> primary key '<insertKey>'`) — once the result is structured, the
`message` field can move closer to SQLite's `UNIQUE constraint failed:
<table>.<column(s)>` using the PK column names for client-code compatibility.

## Tests

Extend `test/insert-pk-uniqueness.spec.ts` (or a sibling) to cover, against the
real `local`/`FileRawStorage` transactor:

- `INSERT OR IGNORE` on a duplicate — statement succeeds, original row unchanged,
  no error.
- `INSERT OR REPLACE` on a duplicate — row overwritten, exactly one row, new
  value persisted across reopen.
- `INSERT ... ON CONFLICT (pk) DO NOTHING` — original preserved.
- `INSERT ... ON CONFLICT (pk) DO UPDATE SET ...` — row updated per the clause.
- Default `OR ABORT` regression (existing 3 cases) still pass.
