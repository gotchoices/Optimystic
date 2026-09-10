description: "Insert or replace" over an existing row now clears other rows' unique values the way every other write does, instead of refusing with a duplicate-value error. Review the fix and its tests.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, docs/internals.md
difficulty: medium
----

# Review: `insert or replace` on an existing primary key now resolves secondary UNIQUE constraints

## What was wrong

With `create table T (id integer primary key, v text not null unique)`, rows `(1,'a')` and `(2,'b')`, the statement `insert or replace into T values (1, 'b')` threw `UNIQUE constraint failed: T.v` and left the table unchanged. It failed again on every retry. SQLite evicts row 2 and makes row 1 `(1,'b')`.

The cause was one site. In `OptimysticVirtualTable.update`, the `'insert'` arm's primary-key-collision branch staged the replacement directly once the PK action resolved REPLACE. It never called `resolveSecondaryUniqueDecision`. The only thing that then noticed the rival was the concurrency guard (`absentRange`, attached through `guardedUniqueIndexes`), and that guard is built to refuse, not resolve. Its refusal came through `mapCommitRefusal` as a bare `Error` with no code, not the engine's `ConstraintError` (code 19).

## What changed

- **`optimystic-module.ts`, REPLACE-on-PK branch of the `'insert'` arm.** Before anything is staged, the branch now calls `resolveSecondaryUniqueDecision(values, args.onConflict, new Set([insertKey]))`, excluding the row being overwritten.
  - A `blocked` result is returned as is, as the structured `{status:'constraint'}`, so the engine raises `ConstraintError`. Nothing is staged, and `markDirtyTrees` does not run.
  - A `swallow` result returns `{status:'ok'}`.
  - An `evict` result stages `applyUniqueEvictions` after `markDirtyTrees` and before the replacement's main-table stage and `updateIndexEntries`. The new index entry's guard therefore finds its range free.
  - The result now reports `evictedRows` alongside `replacedRow`. The engine's `common/types.ts` documents that the pair can co-occur, and its DML executor runs `processEvictions` before the `replacedRow` update bookkeeping.
  - The concurrency guard is unchanged: `guardedUniqueIndexes(values)` is still passed to `updateIndexEntries`.
- **Same file, doc comments.** The NOTE on `resolvePkMoveDecision` claimed the INSERT path deliberately kept the memory module's short-circuit. It now states that both paths resolve secondary constraints, and that the memory module disagrees until `blocked/quereus-memory-vtab-pk-replace-skips-unique-check` lands. The `guardedUniqueIndexes` doc now says its "sequential semantics untouched" claim holds only because every guarded write path runs the pre-stage probe first.
- **`docs/internals.md`** ("Conflict replay re-makes the uniqueness decision"). This section had said the application-level retry honours the IGNORE/REPLACE disposition. It now says the pre-stage probe on every guarded write path is what makes that true, names the three paths, and says a path added without the probe refuses forever.

## Tests (`test/secondary-unique.spec.ts`)

- **The conflict-action matrix is generalized.** It was {ignore, replace, abort, fail, rollback} × {statement, constraint}. It is now also × write shape {`fresh insert`, `replace on existing PK`} × enforcing tree {`synthesized` (`_uniq_` tree), `declared` (plain `create index` over the same column, which becomes the enforcing tree and makes lookups index-routed)}, for 40 cases.
  - Per case, the test asserts the whole surviving row set.
  - Rejecting arms must throw `ConstraintError` with `code === StatusCode.CONSTRAINT` and an exact message, via the new helper `expectConstraintError`.
  - The declared-tree cases run `expectIndexAgreesWithScan`.
  - Every case ends by deleting the value's owner and re-inserting the value under a fresh PK. This proves the enforcing tree held exactly one live entry: an index entry an eviction left behind would make the guard refuse.
  - In the replace shape, the statement-level spelling (`insert or <action>`) also resolves the PK collision. So only REPLACE reaches the secondary decision there, and the rejecting arms name `T.Id`. The constraint-level spelling uses `id … primary key on conflict replace` plus a plain insert, which is the only way to reach a rejecting or ignoring secondary action through this branch.
- **New group "insert or replace on an existing primary key (secondary UNIQUE)":**
  - value-preserving replacement, with both statement-level REPLACE and a PK declared `on conflict replace` under a default-ABORT unique (the self-exclusion case);
  - the ticket's default-ABORT repro, which must now throw `ConstraintError`;
  - a move to a free value (old entry dropped, new one taken);
  - a rival staged earlier in the same open transaction;
  - a `create unique index` table;
  - a composite `unique (X, Y)`;
  - one write that replaces its own PK slot and evicts two other rows through two constraints;
  - a data-change-event test proving `evictedRows` reaches the executor. It expects a `delete` event for the rival followed by an `update` event for the replaced row. Optimystic has no native events, so both come from the executor.
- **Negative check, done during implement.** With the new probe call temporarily replaced by `{kind:'clear'}`, exactly the 20 new PK-replace arms failed. The rejecting arms failed on `got Error (code=undefined)`, not only on the message. The value-preserving arms passed either way, as regression arms should. The fix was restored and rebuilt afterwards.

## Validation run

- `yarn workspace @optimystic/quereus-plugin-optimystic build`: clean.
- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck`: clean.
- Full plugin mocha suite (`test/**/*.spec.ts`): 768 passing, 13 pending (skips that were already there, none added), 0 failing. That includes `concurrent-secondary-unique-refusal.spec.ts`, `update-pk-move-uniqueness.spec.ts` and `insert-pk-uniqueness.spec.ts`, all unchanged.

## Known gaps and things to look at

- **Concurrent refusals still arrive as a bare `Error`.** This ticket fixes the error type only for the sequential path. A refusal raised by the concurrency guard is still rendered by `mapCommitRefusal` (`src/optimystic-adapter/txn-bridge.ts`) as a plain `Error` with `code === undefined`. That covers a real concurrent rival at commit, and a rival a mesh tracker fetches at staging time. The negative-check output showed this for the staging-time case (`Error: UNIQUE constraint failed: T.Stamp`, caused by `TreeRangeTakenError`). The commit-time case goes through the same function: `static`, not run here. `docs/internals.md` says such a refusal is "indistinguishable from a sequential duplicate to clients", which is true of the message but not the error type. The reviewer should decide whether that deserves a ticket, and should check `mapCommitRefusal` before filing.
- **Only the in-memory `test` transactor runs the new arms.** No local/FileRawStorage persistence-and-reopen case exists for the REPLACE-on-PK eviction. The UPDATE-arm equivalents in `insert-pk-uniqueness.spec.ts` do reopen. Add one if the reviewer wants persistence coverage of the combined replace-plus-evict write.
- **The eviction's delete pipeline is proven through data-change events only.** No foreign-key cascade test exists; none of the plugin's specs exercise FKs today.
- **The memory module still disagrees.** The engine's in-memory vtab commits the duplicate in the same shape until `blocked/quereus-memory-vtab-pk-replace-skips-unique-check` lands. Optimystic now follows SQLite, not the memory module.
- **The mixed-action divergence documented on `resolveSecondaryUniqueDecision` now applies to this branch too.** If an earlier constraint resolves REPLACE and a later one IGNORE, the whole write is swallowed with no evictions. It is not pinned for the PK-replace shape specifically; the fresh-insert test covers the rule.
