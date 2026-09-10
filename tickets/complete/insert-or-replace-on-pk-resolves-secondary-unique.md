description: "Insert or replace" over an existing row now clears other rows' unique values the way every other write does (evicting, ignoring or rejecting per the declared action), instead of refusing forever with a duplicate-value error.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, docs/internals.md
----

# Complete: `insert or replace` on an existing primary key resolves secondary UNIQUE constraints

## What was wrong

With `create table T (id integer primary key, v text not null unique)`, rows `(1,'a')` and `(2,'b')`, the statement `insert or replace into T values (1, 'b')` threw `UNIQUE constraint failed: T.v` and left the table unchanged. It failed again on every retry. SQLite evicts row 2 and makes row 1 `(1,'b')`.

The REPLACE-on-PK branch of the `'insert'` arm in `OptimysticVirtualTable.update` staged the replacement without calling the pre-stage probe `resolveSecondaryUniqueDecision`. The only thing that then noticed the rival was the index tree's concurrency guard. That guard is built to refuse, not resolve, and its refusal reached the client as a plain `Error` with no code.

## What changed

- **`optimystic-module.ts`, REPLACE-on-PK branch.** The branch now calls `resolveSecondaryUniqueDecision(values, args.onConflict, new Set([insertKey]))` before staging anything, excluding the row being overwritten.
  - `blocked` returns the structured constraint result (the engine raises `ConstraintError`).
  - `swallow` returns ok and stages nothing.
  - `evict` stages `applyUniqueEvictions` after `markDirtyTrees` and before the replacement.
  - The result reports `evictedRows` alongside `replacedRow`.
  - This mirrors the UPDATE arm's order exactly.
- **Doc comments.** The notes on `resolvePkMoveDecision` and `guardedUniqueIndexes` now say every guarded write path runs the probe.
- **`docs/internals.md`.** The "Conflict replay re-makes the uniqueness decision" section now says the probe is what makes retries honour IGNORE/REPLACE, and names the three paths that run it.
- **Tests (`test/secondary-unique.spec.ts`).**
  - The conflict-action matrix now covers both write shapes (fresh insert, replace on existing PK) and both enforcing trees (synthesized `_uniq_` tree, declared index), for 40 cases. Each asserts the whole surviving row set and the exact `ConstraintError` type, code and message.
  - A dedicated group covers value-preserving replacement, the original repro, a move to a free value, an in-transaction rival, `create unique index`, a composite unique, multi-constraint eviction, and data-change events.

## Review findings

- **Diff read first, then compared with the UPDATE arm.** The new branch has the same decision-before-staging order as UPDATE (probe → blocked/swallow return → `markDirtyTrees` → evictions → main stage → `updateIndexEntries` with the guard). `excludeKeys` correctly contains only `insertKey`: the replaced row cannot rival its own replacement. The evicted rows are at other PKs, so their index-entry deletes cannot touch the replaced row's entries. `args.onConflict` (statement level) is what's passed to the secondary probe, so a PK declared `on conflict replace` combined with a plain insert lets each unique constraint's own declared action apply. This matches SQLite precedence. No defects found in the source change.
- **Correctness: mixed-action shape was not pinned for this branch.** Fixed inline by adding a test in which the PK resolves REPLACE, constraint A resolves REPLACE and constraint B resolves IGNORE. The whole write is swallowed and row 1 is not evicted, per the documented NOTE on `resolveSecondaryUniqueDecision`.
- **Error handling: concurrent refusals still surface as a plain `Error`.** `mapCommitRefusal` returns `new Error(message)`, not the engine's `ConstraintError`. The earlier guard tickets settled on message-only parity; no accepted-tradeoff `NOTE:` declines the type gap. That is reachable on multi-writer deployments, so it is not a tripwire. Filed as `backlog/bug-concurrent-unique-refusal-is-not-a-constraint-error` (repro `static` for the commit-time path). `mapCommitRefusal` is the single seam every refusal passes through, so the fix there covers every write path.
- **Docs.** `docs/internals.md` claimed a refused concurrent insert is "indistinguishable from a sequential duplicate to clients". That is true of the message but not the error type. Fixed inline to state the gap plainly. I grepped `docs/` for other descriptions of insert-or-replace/`replacedRow` semantics and found none that needed changing. `yarn lint:docs` passes.
- **Source hygiene / size.** `optimystic-module.ts` is 4015 lines (`wc -l`). That is already tracked by `backlog/debt-optimystic-vtab-class-is-too-big-to-review`, so nothing new was filed. The new branch comment is long but explains why the probe must precede the guard, which is the non-obvious invariant, so I kept it.
- **Type safety / resource cleanup / performance.** Nothing found. The branch reuses the existing typed `SecondaryUniqueDecision` union and helpers. The extra probe costs one lookup per binding unique constraint on the REPLACE path only, the same cost the fresh-insert and UPDATE paths already pay.
- **Test gaps considered and declined.**
  - Persistence-and-reopen for the combined replace-plus-evict write: `applyUniqueEvictions` and the staging path are shared with the fresh-insert and UPDATE arms, so a reopen case would exercise no new code.
  - FK cascade on eviction: no plugin spec exercises foreign keys. The data-change-event test proves the executor runs the delete pipeline for `evictedRows`.
- **Memory-module divergence.** Optimystic now follows SQLite. The engine's in-memory vtab disagrees until `blocked/quereus-memory-vtab-pk-replace-skips-unique-check` lands, as already documented in the NOTE on `resolvePkMoveDecision`. No action needed.
- **Tripwires.** None recorded; nothing conditional came up.
- **Validation.**
  - `yarn workspace @optimystic/quereus-plugin-optimystic build`: clean.
  - `typecheck`: exit 0.
  - Full plugin `test`: 768 passing, 13 pending (pre-existing skips), 0 failing; smoke ok. That run was before the added test.
  - After adding the test, `test/secondary-unique.spec.ts` alone: 72 passing.
  - `eslint` on the changed source and spec: clean.
