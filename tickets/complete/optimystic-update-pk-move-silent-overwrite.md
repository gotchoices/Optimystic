description: Changing a row's primary key onto a key another row already uses no longer silently destroys that other row — the move is now rejected as a uniqueness conflict, preserving both rows.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/update-pk-move-uniqueness.spec.ts
----

## Summary

`OptimysticVirtualTable.update` (`case 'update'`, `src/optimystic-module.ts`)
now performs a pre-stage `collection.get(newKey)` uniqueness check inside the
`oldKey !== newKey` (PK-move) branch. A positive hit throws a `ConstraintError`
(`UNIQUE constraint failed: <table> primary key '<newKey>'`) **before**
`markDirtyTrees()` / `stage()` / `updateIndexEntries()`, so a rejected move
stages nothing in the main collection or any index tree and leaves in-session
and post-reopen state untouched. This mirrors the prior INSERT-path fix
(`optimystic-insert-pk-uniqueness-not-enforced`). The simple-update branch
(`oldKey === newKey`) is unchanged; `markDirtyTrees()` was split out of the
shared preamble into each branch independently.

## Review findings

**Verdict:** implementation accepted as-is. No major findings, no inline changes
required.

### What was checked

- **Diff correctness (vs. implement commit `6f4d6ad`).** Read the diff with fresh
  eyes before the handoff. The check is placed correctly — `get(newKey)` and the
  throw precede `markDirtyTrees()`, the main `stage()`, and
  `indexManager.updateIndexEntries()`, so a rejected move marks nothing dirty and
  stages nothing in either tree. Confirmed against the INSERT path (lines 736–771)
  that it is a faithful mirror in error type, wording, and ordering.
- **Same-row false positive.** Impossible: the `oldKey !== newKey` gate guarantees
  a positive `get(newKey)` is a *different* row. `update T set id = 1 where id = 1`
  takes the `else` branch and is never uniqueness-checked. Verified.
- **Key representation / composite keys.** `rowCodec.extractPrimaryKey`
  (`src/schema/row-codec.ts:87`) returns a serialized **string** (single value, or
  parts joined with `\x00` for composite keys). Therefore `oldKey !== newKey` is a
  correct value comparison and `collection.get(newKey)` is correctly keyed for both
  single and composite primary keys — no reference-equality hazard.
- **Error classification survives.** The `catch` (lines 855–864) rethrows
  `QuereusError` verbatim, so the `ConstraintError`/`StatusCode.CONSTRAINT`
  classification reaches the engine and yields SQL ABORT-level (statement, not
  transaction) semantics. The in-transaction test confirms the statement aborts
  while the surrounding txn still commits.
- **Type check + build.** `yarn build` and `yarn typecheck` both clean.
- **Tests.** Full package suite via `yarn test`: **226 passing, 5 pending,
  0 failing.** The three `update-pk-move-uniqueness.spec.ts` cases pass (collision
  rejected in-session + after reopen; collision rejected inside a txn that still
  commits with both rows surviving; move-to-unused-key regression guard).

### Minor observations (noted, not actioned)

- **DRY:** the INSERT and UPDATE pre-stage uniqueness blocks are near-identical
  (~6 lines each). Deliberately mirrored and individually readable; extracting a
  shared helper for two short blocks would not clearly improve clarity. Left as-is.
- **Spec coverage:** the spec has no dedicated `oldKey === newKey` (non-PK-change)
  regression case (use case 4 in the handoff). That path is exercised by numerous
  existing specs (e.g. the multi-node UPDATE integration test) and by the
  move-branch's `else`, so coverage is adequate; not worth a one-off case.

### Examined and explicitly clear (no findings)

- **Transaction-replication statement log.** `update()` calls
  `txnBridge.addStatement(mutationStatement)` at the top (lines 724–726), *before*
  the operation can throw, so a rejected PK-move statement is still appended to the
  accumulated/replicated statement log. This is **not a defect**: (a) it is
  pre-existing and shared identically with the INSERT-path fix, not introduced
  here; and (b) it is consistent for deterministic replay — a statement that throws
  on the origin (staging nothing) also throws on a replica (staging nothing),
  producing identical state. No ticket filed.
- **Index-tree consistency.** `updateIndexEntries` runs only after a clean check
  and the main-table stage; if it throws, the already-marked snapshot rolls it
  back. Unchanged by this fix.
- **Docs.** No package or repo docs describe UPDATE/PK-uniqueness behavior
  (grep over `*.md` for uniqueness/upsert/UNIQUE-constraint wording found nothing
  in the package), so nothing is stale. Nothing to update.

## Known gaps / deferred (carried forward, unchanged)

- `UPDATE OR REPLACE` / `UPDATE OR IGNORE` conflict semantics are not wired —
  deferred until `optimystic-vtab-onconflict-not-honored` lands. Until then the
  interim ABORT-level throw is the correct, safe behavior.
