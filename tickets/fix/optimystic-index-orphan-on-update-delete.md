description: A committed UPDATE or DELETE of an indexed row leaves the old secondary-index entry orphaned in the index tree, in BOTH legacy and session/consensus commit modes. Queries stay correct (the index scan re-looks-up the main row and Quereus re-checks the predicate, filtering the orphan), but the index tree accumulates dead entries — storage bloat and a latent correctness hazard for any index-only path that trusts index contents.
files: ../optimystic/packages/quereus-plugin-optimystic/src/schema/index-manager.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-module.ts, ../optimystic/packages/db-core/src/collections/tree/tree.ts, ../optimystic/packages/quereus-plugin-optimystic/test/index-support.spec.ts
----

# Orphaned secondary-index entries after committed UPDATE/DELETE

## Symptom

Given a table with a secondary index, committing an UPDATE that changes the indexed column (or a DELETE) leaves the OLD index entry behind in the index tree. Reproduced identically in:

- **legacy** flush-at-commit mode (`tree.sync()` per dirty tree), and
- **session/consensus** mode (`TransactionCoordinator.commit`).

Example (one indexed table, `cat` indexed): insert rows {1:'a', 2:'b', 3:'c'}; then `update set cat='z' where id=2`; then `delete where id=3`. The main table correctly becomes {1:'a', 2:'z'}, and `select … where cat='b' | 'c'` correctly return nothing. But the index tree retains 4 composite entries — `a\x001`, `b\x002` (orphan), `c\x003` (orphan), `z\x002` — instead of the expected 2 (`a\x001`, `z\x002`). The same orphaning happens whether the insert+delete are in one transaction or across separate committed transactions.

## Why queries still pass

`IndexManager.findByIndex` yields the primary key from each matching index entry, then `OptimysticVirtualTable.executeIndexScan` re-fetches the main row by PK and yields it; Quereus then re-applies the WHERE predicate. So an orphan index entry pointing at a deleted PK (no main row) or a stale value (predicate fails on re-check) is filtered out — masking the orphan at the query layer. This is why existing suites are green.

## Root cause (to confirm in fix stage)

`IndexManager.updateIndexEntries` / `deleteIndexEntries` stage the removal as `tree.stage([[oldTreeKey, undefined]])`, whose Tree `replace` handler runs `btree.deleteAt(await btree.find(oldTreeKey))`. The staged delete does not end up reflected in the committed index leaves. Likely in the btree delete-of-a-staged-or-committed-composite-key path or how the staged delete transform is flushed — NOT in the transaction-composition layer (it predates and is independent of session mode).

## Expected behaviour

After a committed UPDATE/DELETE of an indexed row, the index tree contains only the live entries (no orphan for the removed/old value), in both legacy and session modes.

## Scope note

Discovered while building session-mode commit coverage (`session-mode-commit.spec.ts`). Confirmed pre-existing and mode-independent (legacy reproduces it), so it was deliberately left out of the session-mode-commit-composition fix; that suite asserts exact index-entry counts only for insert-only and rollback cases, and asserts query/main-table correctness for the update/delete case. Add an `index-support.spec.ts` case asserting exact index-tree contents after UPDATE/DELETE as the regression once fixed.
