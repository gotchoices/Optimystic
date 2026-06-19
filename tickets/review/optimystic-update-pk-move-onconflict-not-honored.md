description: A primary-key-changing UPDATE that lands on a key another row already holds no longer throws a hand-rolled error; it now reports the clash through the engine's normal channel so the database engine can decide what to do, the same way INSERT already does.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts
difficulty: medium
----

## What landed

`OptimysticVirtualTable.update`'s PK-move branch (the `oldKey !== newKey` path
in `case 'update'`, `src/optimystic-module.ts`) no longer **throws** an ad-hoc
`ConstraintError` when the moving row collides with a row already at `newKey`.
It now decodes the displaced row once and switches on
`args.onConflict ?? ConflictResolution.ABORT`, returning a structured
`UpdateResult` exactly as the INSERT branch (~L760–L802) does:

- **IGNORE** (`optimystic-module.ts:854`) — stage nothing, no `markDirtyTrees()`,
  `return { status: 'ok' }`.
- **REPLACE** (`optimystic-module.ts:861`) — `markDirtyTrees()`; stage
  `[[oldKey, undefined], [newKey, [newKey, encodedRow]]]`; then **in this order**
  `indexManager.deleteIndexEntries(existingRow, newKey, …)` followed by
  `indexManager.updateIndexEntries(oldKeyValues, values, oldKey, newKey, …)`;
  `statisticsCollector?.decrementRowCount()`;
  `return { status: 'ok', row: values, replacedRow: existingRow }` (L897).
- **ABORT / FAIL / ROLLBACK** (default) (`optimystic-module.ts:905`) —
  `return { status: 'constraint', constraint: 'unique',
  message: this.uniqueConstraintMessage(), existingRow }`. No trees touched.

The non-collision PK-move (falls through to the shared
`markDirtyTrees` + delete-old/insert-new + `updateIndexEntries`) and the
in-place `oldKey === newKey` update are **unchanged**.

The now-dead `ConstraintError` / `StatusCode` imports were dropped (verified
nothing else referenced them; the catch block rethrows `QuereusError`, which is
separate and stays). The stale catch-block comment that named `ConstraintError`
was updated.

### Observable behavior change (the part that IS reachable from SQL)

A default-mode (`ABORT`) PK-move collision is still rejected, but the
client-facing message changed from the old hand-rolled
`UNIQUE constraint failed: <table> primary key '<key>'` to the SQLite-style,
column-qualified `UNIQUE constraint failed: T.id` (via the shared
`uniqueConstraintMessage()` helper), matching the INSERT path. This is the only
externally-observable difference of this change and is covered end-to-end.

## ⚠️ Major finding the reviewer must weigh: REPLACE/IGNORE are NOT reachable from SQL

The ticket assumed `UPDATE OR REPLACE` / `UPDATE OR IGNORE` SQL would drive the
new REPLACE/IGNORE branches. **They cannot, in the current engine.** Confirmed
against the in-tree quereus dist (`C:\projects\quereus`):

1. **No grammar.** The parser's `updateStatement`
   (`packages/quereus/dist/src/parser/parser.js:2148`) jumps straight from
   `UPDATE` to `tableIdentifier()` — there is no `OR <conflict>` clause. `update
   or replace T set …` raises `QuereusError: Expected table name. (at line 1,
   column 8)`.
2. **Planner hard-codes undefined.** `src/planner/building/update.js:290–304`
   builds the UPDATE executor node with `onConflict = undefined` and the explicit
   comment "UPDATE has no statement-level OR clause; per-constraint defaults
   apply". `dml-executor.js:617` then passes `args.onConflict = plan.onConflict`
   (= undefined) to the vtab.
3. **Optimystic reads no per-constraint default.** It resolves
   `args.onConflict ?? ConflictResolution.ABORT` and never inspects a column-/
   table-level `ON CONFLICT` directive (grep `defaultConflict|onConflict` in
   `src/` → only the two `?? ABORT` fallbacks). So even `… PRIMARY KEY ON
   CONFLICT REPLACE` + a plain UPDATE arrives as ABORT.

Net: a PK-moving UPDATE against optimystic **always** arrives as ABORT today.
The asymmetry vs. INSERT is entirely the parser — `INSERT OR REPLACE` parses, so
`plan.onConflict` is set and the INSERT REPLACE/IGNORE tests pass; UPDATE has no
such clause.

**Why the REPLACE/IGNORE code was kept anyway** (reviewer: confirm you agree, or
downgrade to ABORT-only):
- It implements the full `UpdateResult` contract and is byte-for-byte parallel
  with the already-reviewed, SQL-reachable INSERT path and the memory-module
  reference (`performUpdateWithPrimaryKeyChange`, manager.js L701–L722).
- The moment the engine supplies a non-ABORT onConflict for updates (a quereus
  parser change, or optimystic learning to resolve per-constraint defaults), the
  branch is correct and consistent — no future vtab edit needed.
- The branches reuse only primitives already exercised by passing tests
  (`markDirtyTrees`, `collection.stage`, `indexManager.delete/updateIndexEntries`,
  `statisticsCollector.decrementRowCount`).

The trade-off: it is **currently-unreachable code** (a dead-code smell). The
defensible alternatives, if the reviewer prefers, are (a) leave as-is for
contract parity, (b) collapse the UPDATE collision branch to ABORT-only and file
a backlog ticket to add the REPLACE/IGNORE branch alongside whichever feature
makes it reachable, or (c) open a follow-up to make optimystic honor
per-constraint `ON CONFLICT` defaults (would also affect INSERT) — that is a new
feature, explicitly out of this ticket's scope.

## Tests

Added a `describe('UPDATE PK-move conflict resolution …')` block to
`test/insert-pk-uniqueness.spec.ts` (reuses the existing `createDb` /
`selectScalar` / `selectCount` / `reopenScalar` / `captureThrowMessage` /
`expectThrows` helpers against the real `local` / `FileRawStorage` transactor).
Because only ABORT is SQL-reachable, the three tests cover:

- **default UPDATE collision → rejected with `UNIQUE constraint failed: T.id`**,
  both rows intact in-session and across reopen. This is the genuine regression
  guard — pre-fix the message was `… primary key '2'`, which would not contain
  `T.id`.
- **non-colliding PK-move still succeeds** (control: the shared/unchanged
  non-collision path), verified across reopen.
- **collision with a secondary index is rejected and the index is left intact**
  (both `idx_cat` entries still resolve to their original rows), verified across
  reopen.

The four originally-drafted `UPDATE OR REPLACE` / `UPDATE OR IGNORE` tests were
**removed** — they fail at parse time (see the major finding) and cannot pass
without an engine change. The spec's describe-block doc-comment records the full
reachability analysis inline.

### Coverage gap to scrutinize (tests are a floor)

- **REPLACE / IGNORE branches have ZERO direct test coverage** — they are not
  SQL-reachable and a direct `table.update({onConflict: REPLACE})` unit test was
  deliberately avoided: it would bypass the engine's commit/transaction
  orchestration that `update()` relies on ("flushed at commit / restored on
  rollback"), testing the method in a context it is never invoked in. So
  REPLACE/IGNORE correctness currently rests on (a) inspection against the INSERT
  path and memory reference, and (b) the order-sensitivity argument below — not
  on an executed test. If the reviewer wants real coverage, options: build a
  minimal harness that drives a full begin → `update()` → commit lifecycle
  through the txn bridge, or treat it as blocked on engine reachability.
- **Index-staging ORDER in REPLACE is the subtlest unverified bit.** When the
  displaced row and moving row share an indexed value, both stagings touch the
  identical tree key `<idx>\x00<newKey>`; delete-then-update is required so the
  surviving entry remains. This ordering is argued in code comments but **not**
  exercised by any running test (the drafted shared-index test used the
  unparseable `UPDATE OR REPLACE`). Re-verify by reading
  `index-manager.ts:127–178` against `optimystic-module.ts:861–897`.

## Validation performed

In `packages/quereus-plugin-optimystic`:
- `npm run build` (tsup) — clean. (Specs import from `dist/plugin.js`; the build
  must precede tests.)
- `npm run typecheck` (`tsc --noEmit`) — clean. The `UpdateResult` union is
  strict; the REPLACE branch is the only one carrying `replacedRow`, no branch
  emits `evictedRows`.
- `npm test` (full mocha suite) — **236 passing, 5 pending, 0 failing**. No
  pre-existing failures surfaced; no `.pre-existing-error.md` filed.

## Suggested review focus

1. Decide the REPLACE/IGNORE question (keep for contract parity vs. collapse to
   ABORT-only + follow-up). This is the headline call.
2. Confirm the delete-then-update index ordering in the REPLACE branch
   (`optimystic-module.ts:884–893`) against the treeKey format in
   `index-manager.ts:127–178`, especially the shared-indexed-value case.
3. Confirm `decrementRowCount()` belongs only on REPLACE (the one count-reducing
   update) and is absent from IGNORE/ABORT and the non-collision path.
4. Sanity-check that nothing else in the file relied on the removed
   `ConstraintError` / `StatusCode` imports.
