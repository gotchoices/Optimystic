description: An INSERT that hit a duplicate primary key always errored, even when the SQL asked to ignore or replace the conflicting row; now "insert or ignore", "insert or replace", and upsert do what the user asked.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts
prereq:
difficulty: medium
----

## What changed

`OptimysticVirtualTable.update`'s `case 'insert'` duplicate-key branch used to
**throw** a `ConstraintError` on any PK collision. That throw bypassed the
Quereus engine's conflict-resolution branches in `dml-executor.processInsertRow`,
so `INSERT OR IGNORE`, `INSERT OR REPLACE`, `ON CONFLICT (pk) DO NOTHING`, and
`ON CONFLICT (pk) DO UPDATE` all errored instead of honoring the requested
semantics. (Default `OR ABORT` only "worked" because a thrown `ConstraintError`
coincidentally produced abort semantics via the statement savepoint.)

The fix rewrites that branch to **return a structured `UpdateResult`** keyed on
`args.onConflict ?? ConflictResolution.ABORT`, mirroring the in-tree memory
module's `performInsert`:

- **IGNORE** → `{ status: 'ok' }` (no `row`). Stages nothing; statistics
  untouched. Engine skips the row.
- **REPLACE** → `markDirtyTrees()` + re-stage `[[insertKey, [insertKey,
  encoded]]]` + `indexManager.updateIndexEntries(existingRow, values, insertKey,
  insertKey, …)` (same PK → only changed indexed columns restage). Returns
  `{ status: 'ok', row: values, replacedRow: existingRow }`. Row count unchanged
  → no statistics bump.
- **ABORT (default) / FAIL / ROLLBACK** → `{ status: 'constraint', constraint:
  'unique', message, existingRow }`. The engine's `translateConflictError` maps
  this to the right subclass, and when an `ON CONFLICT (pk) DO UPDATE/NOTHING`
  clause is present, `matchUpsertClause` drives the upsert from `existingRow`.

Supporting pieces:
- `ConflictResolution` added to the `@quereus/quereus` named import (runtime enum).
- New private `uniqueConstraintMessage()` renders SQLite-style
  `UNIQUE constraint failed: <table>.<pkCol>[, …]` from
  `tableSchema.primaryKeyDefinition` + `tableSchema.columns`, replacing the old
  `… <table> primary key '<key>'` wording. This is the `message` clients see.
- The conflicting row is decoded **once** from the entry already fetched by
  `collection.get` (`existing[1]` is the encoded row) — no second read.
- The no-conflict insert path is unchanged (stage + index insert + increment),
  and the `update`/`delete` cases are untouched.
- The trailing `catch` that rethrows `QuereusError` verbatim stays — it is now
  harmless (the constraint path returns rather than throws) and only re-raises
  genuinely unexpected errors.

## Use cases / behavior to validate

Against the real `local` / `FileRawStorage` transactor (what the spec uses):

| SQL | Expected |
|-----|----------|
| `insert or ignore into T values (dupPk, …)` | no throw; original row intact; row count unchanged |
| `insert or replace into T values (dupPk, …)` | no throw; row overwritten; count unchanged; new value persists across reopen |
| `insert … on conflict (pk) do nothing` | no throw; original preserved |
| `insert … on conflict (pk) do update set v = …` | row updated per clause |
| plain `insert` on dup (default ABORT) | still rejected (statement aborts), original intact |
| `insert … values (k,…),(k,…)` (dup within one statement) | still rejected wholesale, 0 rows |
| REPLACE on a table with a secondary index | indexed lookup on the **new** value returns the new row; old index key no longer resolves |

## Tests

Extended `test/insert-pk-uniqueness.spec.ts`:
- The original 3 ABORT-regression cases are unchanged and still pass (confirms
  the structured-result → engine-throw path preserves abort/statement semantics,
  including same-transaction and multi-row-INSERT cases).
- New `describe('INSERT conflict resolution …')` block adds 5 cases: OR IGNORE,
  OR REPLACE (+ reopen), DO NOTHING, DO UPDATE, and a REPLACE-with-secondary-index
  consistency check. All assert against persisted state and several re-open the
  DB (`reopenScalar`) to prove the result reached storage.

Focused run: 8 passing in this spec. Full package suite: **231 passing, 5
pending, 0 failing**.

## Validation performed

- `npm run build` (tsup) — success.
- `npm run typecheck` (`tsc --noEmit`) — clean; every `update` return matches the
  strict `UpdateResult` union.
- `npm test` — 231 passing / 5 pending / 0 failing. No pre-existing failures
  surfaced (no `.pre-existing-error.md` written).

## Known gaps / where to probe (treat tests as a floor)

- **UPDATE PK-move path is NOT fixed here (out of scope).** `case 'update'`
  (~L824-848) still **throws** a `ConstraintError` when a PK move collides, so
  `UPDATE OR REPLACE` and upsert-via-PK-move remain broken in exactly the way
  INSERT was. A follow-up fix ticket has been filed:
  `optimystic-update-pk-move-onconflict-not-honored`. Confirm the reviewer agrees
  this is a separate concern and the follow-up captures it.
- **Secondary / composite UNIQUE `evictedRows` are out of scope.** Optimystic
  enforces only the PK, so REPLACE reports `replacedRow` (same-PK displacement)
  but never `evictedRows`. A REPLACE that would collide on a *secondary* UNIQUE
  is not detected/resolved — there is no secondary UNIQUE enforcement at all.
- **DO UPDATE coverage is shallow.** The test uses a literal
  `set v = 'updated'`; it does **not** exercise `set v = excluded.v` (referencing
  the proposed new row) or a `WHERE` predicate on the upsert clause. Worth a
  reviewer probe.
- **Message wording is not asserted.** No test checks the exact
  `UNIQUE constraint failed: T.id` text surfaced via the structured result's
  `message`. If client-facing compatibility matters, add an assertion.
- **REPLACE with an unchanged indexed column** (only a non-indexed column
  changes) exercises the `updateIndexEntries` no-restage branch; the added test
  changes the indexed column (delete-old + insert-new branch). The no-restage
  branch is covered only indirectly.
- **Cross-node conflict** remains a consensus-layer concern — enforcement here is
  scoped to locally-visible state (committed + staged), exactly as the prior
  `collection.get` already was.
