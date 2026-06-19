description: An INSERT that hit a duplicate primary key always errored, even when the SQL asked to ignore or replace the conflicting row; now "insert or ignore", "insert or replace", and upsert do what the user asked.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/insert-pk-uniqueness.spec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts
prereq:
----

## What shipped

`OptimysticVirtualTable.update`'s `case 'insert'` duplicate-key branch now
**returns a structured `UpdateResult`** keyed on `args.onConflict ??
ConflictResolution.ABORT` instead of unconditionally throwing a
`ConstraintError`. This lets the Quereus engine's `processInsertRow` apply SQL
conflict semantics:

- **IGNORE** → `{ status: 'ok' }` (no `row`) — engine skips the row, statistics untouched.
- **REPLACE** → `markDirtyTrees()` + re-stage `[[insertKey, [insertKey, encoded]]]`
  + `indexManager.updateIndexEntries(existingRow, values, insertKey, insertKey, …)`,
  returns `{ status: 'ok', row, replacedRow: existingRow }`. Same PK → no row-count bump.
- **ABORT / FAIL / ROLLBACK** → `{ status: 'constraint', constraint: 'unique',
  message, existingRow }`. Engine `translateConflictError` maps it; an
  `ON CONFLICT (pk) DO UPDATE/NOTHING` clause drives the upsert from `existingRow`.

Supporting: `ConflictResolution` runtime enum added to the import; new
`uniqueConstraintMessage()` renders `UNIQUE constraint failed: <table>.<pkCol>[, …]`;
the conflicting row is decoded once from the already-fetched entry. The
no-conflict insert path and the `update`/`delete` cases are unchanged.

## Review findings

**Verdict: implementation is contract-correct and lands cleanly. No major findings; two minor test gaps fixed inline; the one out-of-scope concern already has a follow-up ticket.**

### Contract conformance (checked against the actual engine on disk)
- Verified the returned shapes against `@quereus/quereus`'s `UpdateResult` union
  (`dist/src/common/types.d.ts` L173-183): the success and constraint variants
  match exactly, including the optional `replacedRow`/`existingRow` fields. Typecheck
  is clean, confirming this.
- Traced `dml-executor.processInsertRow` (`dist/src/runtime/emit/dml-executor.js`
  L444-520) to confirm the engine consumes each branch correctly:
  - IGNORE / `{status:'ok'}` with no `row` → `if (!result.row) return undefined` skips it. ✔
  - REPLACE / `replacedRow` → `_recordUpdate(replacedRow → newRow)` (update-in-place,
    no double-write since the vtab already staged). ✔
  - constraint → `matchUpsertClause` drives DO UPDATE/DO NOTHING, else rethrows
    `new ConstraintError(result.message …)` so the SQLite-style message reaches the
    client verbatim (ABORT path of `translateConflictError`). ✔
- Confirmed `existing[1]` decode is correct: `collection.get` returns the staged
  value `[pk, encoded]` (same `[string, EncodedRow]` shape the read path at
  `optimystic-module.ts:513`/`994` already decodes via `entry[1]`), so the
  decode-once optimization is sound and reads the right bytes.

### Edge / error / interaction paths
- markDirtyTrees ordering: REPLACE snapshots before staging (rollback-safe);
  IGNORE and the constraint path stage nothing and never mark dirty. Correct.
- Statistics: neither IGNORE nor REPLACE touches the row count (same-PK / skip).
  Correct — only the genuine-insert path increments.
- Regression: the three original ABORT cases (separate-txn, same-txn, dup-within-
  one-multi-row-INSERT) still pass — the structured-result → engine-throw path
  preserves statement-savepoint abort semantics.

### Tests added in this review pass (minor — fixed inline)
The implementer flagged DO UPDATE coverage as shallow and the message wording as
unasserted. Both addressed:
- **`DO UPDATE SET v = excluded.v`** — proves the engine resolves `excluded` from
  the proposed row while the vtab only supplies `existingRow`. Asserts `v='b'`
  persists across reopen.
- **Message wording** — asserts the default-ABORT duplicate surfaces
  `UNIQUE constraint failed: T.id` to the client (via a new `captureThrowMessage`
  helper).

### Out of scope — verified deferral, not silently dropped
- **UPDATE PK-move on conflict still throws** (`case 'update'`, L838-850) — same
  conformance gap on the UPDATE path. Confirmed the follow-up fix ticket
  `optimystic-update-pk-move-onconflict-not-honored` exists in `tickets/fix/` and
  accurately scopes it (REPLACE/IGNORE/ABORT for PK-move, `replacedRow` vs
  `evictedRows` open question, reuses `uniqueConstraintMessage()`). Agree this is
  a separate concern.
- **Secondary / composite UNIQUE `evictedRows`** — optimystic enforces only the
  PK, so REPLACE reports `replacedRow` (same-PK displacement) and never
  `evictedRows`; a secondary-UNIQUE collision is not detected because there is no
  secondary UNIQUE enforcement at all. This is a pre-existing engine-vs-substrate
  capability boundary, not a regression introduced here; out of scope for a
  PK-uniqueness fix.
- **Cross-node conflict** remains a consensus-layer concern; enforcement here is
  scoped to locally-visible (committed + staged) state, exactly as the prior
  `collection.get` already was.

### Categories with nothing to report
- **Resource cleanup**: no new resources acquired; the conflict branches return
  without opening handles. Nothing to clean up.
- **Type safety**: strict `UpdateResult` union satisfied; typecheck clean.
- **DRY / modularity**: the REPLACE/constraint branches mirror the in-tree memory
  module's `performInsert`, and `uniqueConstraintMessage()` is the shared message
  source the follow-up UPDATE ticket will reuse. No duplication introduced.

## Validation performed (this review pass)
- `npm run build` (tsup) — success.
- `npm run typecheck` (`tsc --noEmit`) — clean.
- `npm test` — **233 passing / 5 pending / 0 failing** (was 231; +2 new tests).
  No `.pre-existing-error.md` needed — no unrelated failures surfaced.
