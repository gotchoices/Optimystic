description: Replacing an existing row with "insert or replace" fails with a duplicate-value error whenever the replacement takes a value some other row already holds in a column declared unique; it should remove that other row instead, the way every other write path in the table does.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, docs/internals.md
repro: verified
difficulty: medium
----

# `insert or replace` on an existing primary key never resolves secondary UNIQUE constraints

## What happens today (one handle, no concurrency)

```sql
create table T (id integer primary key, v text not null unique) using optimystic('tree://…');
insert into T values (1, 'a'), (2, 'b');
insert or replace into T values (1, 'b');   -- throws: UNIQUE constraint failed: T.v
select id, v from T order by id;            -- [{id:1,v:'a'},{id:2,v:'b'}] — unchanged
```

SQLite resolves *every* uniqueness conflict the replacement row raises: row 2 is evicted and row 1 becomes `(1,'b')`. Here the statement is refused instead, and the refusal is permanent — re-running it refuses again.

Every shape of the same write was reproduced against the in-memory `test` transactor and behaves identically (refused, table unchanged): a synthesized enforcement tree (`v text not null unique`), a declared `create unique index ux_v on T (v)`, a table-level `unique (x, y)`, the rival row committed by an earlier statement, and the rival row merely staged in the same open transaction.

Two further arms of the same gap, also reproduced:

- **A secondary constraint declared `on conflict ignore` refuses instead of swallowing.** `create table T (id integer primary key on conflict replace, v text not null unique on conflict ignore)`, rows `(1,'a')` and `(2,'b')`, then `insert into T values (1,'b')` → `UNIQUE constraint failed: T.v`. The write should have been swallowed with nothing changed.
- **When the resolution genuinely is ABORT, the outcome is right but arrives through the wrong mechanism, and the error a client sees is the wrong type.** With `id integer primary key on conflict replace` and a default-ABORT `v … unique`, the fresh-insert path throws `ConstraintError` (`code=19`), while this branch throws a bare `Error` with `code=undefined` — the `TreeRangeTakenError` the index tree's concurrency guard raised at staging time, rendered by `mapCommitRefusal`. An application catching `ConstraintError` / code 19 does not recognise it. The table is left intact only because the engine's statement-level savepoint rolls back what was already staged.

## Root cause — one site

`OptimysticVirtualTable.update`, the `'insert'` arm's primary-key-collision branch: once `this.collection.get(insertKey)` finds a row and the resolved action is `ConflictResolution.REPLACE`, the branch stages the replacement and calls `IndexManager.updateIndexEntries` directly. It never calls `resolveSecondaryUniqueDecision`, so no secondary UNIQUE constraint is probed and no conflict action is resolved for one.

What the caller sees is then produced by the *concurrency* guard rather than by any decision: `guardedUniqueIndexes(values)` attaches an `absentRange` guard to the new index entry, and because nothing evicted the rival first, the guard fires against the rival's still-present entry. That guard's own contract — stated on `guardedUniqueIndexes` and in `docs/internals.md` — is explicitly *"every collision this snapshot CAN see is still settled by the pre-stage probe, so sequential IGNORE/REPLACE semantics are untouched"*, and its refusal is justified by *"the application-level retry re-probes and honours the disposition sequentially"*. Both statements are false for this branch: there is no pre-stage probe, so the retry re-refuses forever.

The two neighbouring paths already do this correctly and are the model:

- the fresh-insert branch a few lines below (probes every binding constraint, evicts REPLACE collisions via `applyUniqueEvictions`, returns the structured `{status:'constraint'}` for ABORT and `{status:'ok'}` for IGNORE — all before anything is staged);
- the `'update'` arm, which probes with `excludeKeys` so a row cannot conflict with itself, covered by `packages/quereus-plugin-optimystic/test/update-pk-move-uniqueness.spec.ts` and the `on conflict` matrix in `packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts`.

## The fix

Route the REPLACE-on-PK branch through `resolveSecondaryUniqueDecision` before it stages anything, with the replaced row's own primary key excluded from the probe:

```ts
// PK resolved REPLACE. The replacement is a new row image at the SAME key, so it
// must clear every secondary UNIQUE constraint exactly as a fresh insert does —
// excluding the row it is overwriting, which is on its way out and cannot conflict
// with its own replacement (the UPDATE arm excludes oldKey for the same reason).
const uniqueDecision = await this.resolveSecondaryUniqueDecision(
  values, args.onConflict, new Set([insertKey]));
if (uniqueDecision.kind === 'blocked') return uniqueDecision.result;
if (uniqueDecision.kind === 'swallow') return { status: 'ok' };

this.markDirtyTrees();
const evictedRows = uniqueDecision.kind === 'evict'
  ? await this.applyUniqueEvictions(uniqueDecision.collisions, txnState?.transactor)
  : [];
// … existing stage + updateIndexEntries(…, this.guardedUniqueIndexes(values)) …
return {
  status: 'ok', row: values, replacedRow: existingRow,
  ...(evictedRows.length > 0 ? { evictedRows } : {}),
};
```

Points the implementation must respect:

- **`excludeKeys` is not optional.** Without `insertKey` in it, a value-preserving replacement (`insert or replace into T (id, v, w) values (1, 'a', 'y')` where row 1 already holds `v='a'`) would probe up its own entry and then refuse or self-evict. That statement works today and must keep working.
- **Evict before staging the new index entry.** `applyUniqueEvictions` stages the rival's main-table clear and its index deletions, so the new entry's `absentRange` guard then finds the range free. This is the ordering the fresh-insert path already uses, which is why its REPLACE arm passes with the guard in place — do not drop the guard to make the eviction work.
- **Nothing is staged on a blocking decision**, `markDirtyTrees` included, so the ABORT arm keeps the module's "statement atomicity never depends on undoing a partial eviction" invariant instead of leaning on the engine's savepoint.
- **`evictedRows` must be reported** so the DML executor runs its delete pipeline (change tracking, row-time maintenance, FK cascade, delete events) for each evicted row, as `applyUniqueEvictions`'s contract states.
- Nothing about the concurrency guard changes: `guardedUniqueIndexes(values)` stays on the `updateIndexEntries` call, so a *concurrent* rival taking the value is still refused at replay.

## Expected behaviour after the fix

Each secondary UNIQUE constraint resolves under its own effective action (`resolveConflictAction`: statement clause first, then the constraint's declared action, else ABORT):

- **REPLACE** (statement-level `insert or replace`, or a constraint declared `on conflict replace`): the colliding row(s) are evicted and reported in `evictedRows`, the replacement lands, and the enforcing index holds exactly one entry for the value — `select id from T where v = 'b'` returns only the replacement.
- **ABORT** (reachable when the PK collision resolves REPLACE from the PK's own declared action while the statement carries no clause; FAIL and ROLLBACK are honoured as ABORT): the ordinary structured result `{status: 'constraint', constraint: 'unique', message: 'UNIQUE constraint failed: T.v'}` with `existingRow`, so the engine raises `ConstraintError` code 19 and nothing is staged.
- **IGNORE**: the write is swallowed and nothing changes (the mixed-action divergence documented on `resolveSecondaryUniqueDecision` continues to apply).

## The ticket that filed this had two premises wrong — read before starting

- **The symptom is a refusal, not a duplicate.** The earlier ticket recorded `insert or replace` *succeeding* and leaving two rows under one unique value. That was the behaviour before `concurrent-secondary-unique-guard` landed; the guard it added turned the silent duplicate into the refusal above. So this is no longer a corruption bug — it is a wrong-rejection bug, plus an error-type mismatch on the ABORT arm.
- **The engine's in-memory module is not a correct reference here.** It has the identical gap at the identical shape: `performInsert` in `@quereus/quereus/src/vtab/memory/layer/manager.ts` returns straight out of its `pkAction === ConflictResolution.REPLACE` arm, and `checkUniqueConstraints` only runs on the fall-through where no row existed. With no tree guard behind it, the memory module *does* commit the duplicate — both repro shapes above leave `[{id:1,v:'b'},{id:2,v:'b'}]` there. Take SQLite's semantics as the target, not memory-module parity, and expect the two modules to disagree until the upstream arm lands (`blocked/quereus-memory-vtab-pk-replace-skips-unique-check`).

## Test coverage to add

`test/secondary-unique.spec.ts` already carries a `declared conflict-action matrix (secondary UNIQUE)` — {ignore, replace, abort, fail, rollback} × {statement-level, constraint-level} — but it only exercises the **fresh-insert** write shape. Generalize it over the write shape rather than adding one point test, so the whole class stays covered as these arms are edited:

- shape `fresh insert` — today's cases, unchanged;
- shape `replace on existing PK` — the same table plus a pre-existing row at the target PK, written as `insert or <action>` for the statement-level spelling and as `id integer primary key on conflict replace` + plain `insert` for the constraint-level spelling (that is the only way to reach a *rejecting* secondary action through this branch, since a statement-level clause would resolve the secondary constraint too).

Assert per arm: the surviving row set, which primary key owns the unique value *through an index lookup* (`expectIndexAgreesWithScan` in `packages/quereus-plugin-optimystic/test/query-helpers.ts` covers index/scan agreement), and — on the rejecting arms — that the thrown error is the engine's `ConstraintError`, not a bare `Error`. Matching only on the `UNIQUE constraint failed` message is what let the wrong error type through unnoticed.

Regression arms that pass today and must keep passing: value-preserving `insert or replace` (same PK, same unique value, another column changed), `insert or replace` moving to a free unique value (old index entry dropped, new one added), and `packages/quereus-plugin-optimystic/test/concurrent-secondary-unique-refusal.spec.ts` unchanged.

## TODO

- Add the `resolveSecondaryUniqueDecision` call, the eviction, and the structured returns to the REPLACE-on-PK branch of the `'insert'` arm in `OptimysticVirtualTable.update`, with `excludeKeys = {insertKey}`.
- Report `evictedRows` alongside `replacedRow` from that branch.
- Generalize the conflict-action matrix in `test/secondary-unique.spec.ts` over the two write shapes; assert `ConstraintError` on the rejecting arms.
- Add the regression arms for value-preserving replace and replace-to-a-free-value.
- Correct the claim in `docs/internals.md` that IGNORE/REPLACE-guarded refusals are honoured sequentially by an application-level retry: say that the pre-stage probe is what makes it true, so a future write path added without one is recognisably broken rather than silently refusing forever.
- Build before running specs (they import `dist/`): `yarn workspace @optimystic/quereus-plugin-optimystic build`, then `yarn workspace @optimystic/quereus-plugin-optimystic test`.
