description: After the catalog is saved once per schema apply, each new index still saves its own storage separately — even when the table is empty and there is nothing in the index to save. Skip that save for empty new indexes (as we already do for empty new tables) and defer the rest to the end of the apply, so a cold schema apply costs one commit instead of one per index.
prereq: schema-batch-catalog-coalescing
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (backfillIndexTrees / flushDirtyTrees ~2889-2991; OptimysticModule.endSchemaBatch from the prereq)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (from the prereq — the end-of-batch commit this ordering hangs off)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (from the prereq — extend)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (re-baseline gate 2 to "one commit per cold apply")
  - packages/db-core/src/collections/tree/tree.ts (stage / sync / hasUnsyncedChanges / committedRevision)
difficulty: medium
----

# Defer or skip index-tree flushes inside an `APPLY SCHEMA` batch

## Where this sits

Once `schema-batch-catalog-coalescing` lands, a cold `APPLY SCHEMA` of T tables and I indexes over empty tables costs **1 + I** commits: one catalog commit, plus one per index. The per-index commit comes from `addIndex` → `backfillIndexTrees` → `flushDirtyTrees`, which syncs the new index tree whenever `hasUnsyncedChanges()` is true. For a brand-new ("invented") tree that is always true, because its header and root blocks sit uncommitted in the tracker even when no entry was staged. The method's own doc comment says so.

A main table's tree is deliberately **not** committed at CREATE TABLE: a created-but-never-written table has no committed header, and reading it through `createOrGetCollection` invents it locally as an empty tree (see the NOTE in `OptimysticVirtualTable.doInitialize`). An invented, empty index tree is the same situation and can be left the same way. Its first real write rides the next DML commit, because `reconcileMaintainedIndexes` has already registered it with the transaction bridge, exactly as the main tree is registered.

## Behaviour inside a schema batch (outside one, nothing changes)

In `backfillIndexTrees`, when the module has a schema batch open, each target tree is handled like this:

- **Nothing staged and invented** (the row scan was skipped because the table has no rows, and `tree.committedRevision() === undefined`): **do not flush and do not defer.** Leave it like an unwritten main table.
- **Entries staged** (an index added to a populated table through `apply schema`): **defer.** Add the tree to the batch's deferred-flush set instead of syncing now.
- **Nothing to push** (`hasUnsyncedChanges()` is false): skip, as today.

`endSchemaBatch` flushes the deferred trees **before** the catalog commit, each with `sync()` and skipping any with nothing to push. The order is deliberate. If an index-tree flush fails, the catalog is not committed and the error propagates, leaving a populated index tree that no catalog record lists. That is harmless: a later CREATE INDEX of the same name adopts it and re-stages every row idempotently, since entries are keyed on the index columns plus the primary key. The opposite order is worse, and is today's order: the catalog commits the index, then the tree flush fails, leaving an index the planner routes seeks through while its entries are missing. That returns silently wrong results. Record this reasoning with a `NOTE:` at the flush site in `endSchemaBatch`.

The per-statement checkpoint from the prereq does **not** withdraw deferred trees when a later part of the same statement fails. Today the flush had already happened by then, so keeping them preserves today's semantics. Say so in a comment.

The expected result is **one** commit for a cold apply of empty tables, whatever the number of tables and indexes.

## Out of scope

- Direct DDL outside `apply schema` (`create index` on an empty table) still flushes the invented tree immediately. The same skip would be sound there. Leave a `NOTE:` at `flushDirtyTrees` naming that option and the reason it was not taken: behaviour outside the batch stays byte-identical for this change.
- A cross-collection atomic commit of the deferred trees together with the catalog (`feat-cross-collection-atomic-commit`, backlog).

## Edge cases & interactions

- **An empty table plus a new index through apply, then DML** (legacy bridge mode): the first INSERT stages into both trees and the commit sweep flushes both, with the invented headers included. `select` through the index returns the row. Session mode: the coordinator carries both registered collections. Cover both modes.
- **An empty table plus a new index, then a fresh `Database` over the same storage**: hydrate lists the index. Opening the never-committed index tree invents it empty. An index-driven query returns no rows and does not fail.
- **A populated table plus a new index through `apply schema`**: after the apply, an index-driven query returns every pre-existing row. A fresh `Database` over the same storage sees the same, which proves the deferred flush landed.
- **A deferred index-tree flush fails at end of batch**: use a transactor wrapper that fails that collection's commit. The apply rejects; the catalog was **not** committed, so a fresh `Database` does not list the index. A corrected re-apply builds the index and seeks return complete results.
- **A unique index on a populated table with pre-existing duplicate values**: behaviour is unchanged. The build succeeds (see the NOTE on `backfillIndexTrees`); only the flush timing moves.
- **Several indexes on one populated table in one apply**: each tree is deferred once, and `backfillIndexTrees` takes a Set, not a list that grows per call.
- **A statement later in the same apply reads through a deferred index** (for example an assertion body): it reads through the same tree instance, and staged entries are visible to that instance's reads (`Tree.stage` contract), so no flush is needed first.

## TODO

- Add the deferred-flush set to the module's schema-batch state; branch `backfillIndexTrees` on "batch open" with the three cases above.
- Flush deferred trees first in `endSchemaBatch`, before the catalog commit; add the `NOTE:` on ordering.
- Add the `NOTE:` at `flushDirtyTrees` about the non-batch path.
- Extend `test/schema-batch.spec.ts` with every case in "Edge cases & interactions", in both legacy and session bridge modes where the case names both.
- Re-baseline `cold-apply-cost.spec.ts`: gate 2 becomes "a cold apply of empty tables commits exactly once at both scales". Re-measure gates 1, 3, 5 and 6 and update `MEASURED`.
- Build, then run the plugin's full test suite in the foreground; report the before/after figures in the handoff.
