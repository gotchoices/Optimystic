description: Dropping an index on an Optimystic table now removes it from the record on disk as well as from the running database, so the next process no longer brings it back; the same hook is what Quereus 4.20's migration rollback uses to take back a created index, and the plugin's ranges now declare 4.20.
architecture: docs/transactions.md#apply-schema-coalesces-catalog-writes
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticVirtualTable.removeIndex` beside `addIndex`; `OptimysticModule.dropIndex` beside `createIndex`; `endSchemaBatch` doc comment rewritten for 4.20; NOTEs on `createIndex`, `endSchemaBatch` and `reconcileMaintainedIndexes` updated)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`withoutIndex`, `SchemaManager.removeIndex`, `removeIndexInBatch`; the `mergeIndexLists` doc bullet that said no removal path exists)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (`removedIndexes`, `excludeIndexAtCommit`, `withoutRemovedIndexes`; checkpoint/restore carry the set)
  - packages/quereus-plugin-optimystic/src/schema/index-manager.ts (`unregisterIndex`)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`forgetTree`)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (four rewritten cases, three new ones, helpers `engineCatalog` / `expectCatalogsAgree` / `catalogManagerOf`, header prose)
  - packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json (seven ranges to `^4.20.0`)
  - docs/transactions.md, section "APPLY SCHEMA coalesces catalog writes" (buffer-not-transaction paragraph rewritten; new "DROP INDEX subtracts by name" paragraph; end-commit-failure paragraph amended)
  - packages/quereus-plugin-optimystic/README.md (the record paragraph and the leftover-tree bullet under Limitations)
  - tickets/backlog/bug-stale-index-entry-causes-false-unique-refusal.md (one arm appended: DROP INDEX then re-create is a fourth producer of leftover entries)
difficulty: hard
repro: verified
----
# A dropped index stays in the plugin's catalog — implemented

## What was built

**The hook.** `OptimysticModule.dropIndex` resolves the table exactly as `createIndex` does (a hydrated, untouched table is instantiated, then initialized and registered inside the statement's batch checkpoint) and runs `OptimysticVirtualTable.removeIndex` under `underBatchCheckpoint(table, 'written', …)`, so an open `APPLY SCHEMA` batch coalesces the write and a throw withdraws it. After the drop succeeds it removes the index's tree from the batch's `deferred` map, so a `CREATE INDEX` that Quereus 4.20's undo journal takes back never lands its tree as an unlisted orphan.

**The four parts of the removal**, in the vtab's `removeIndex`: the catalog write first (a refused write leaves the instance maintaining the index as before), then `IndexManager.unregisterIndex` (descriptor out of `schema.indexes`, tree out of the registry), then `TransactionBridge.forgetTree` (tree out of the dirty set, and its collection out of the shared registry while the registered instance is this tree's), then the index and its `derivedFromIndex` UNIQUE constraint filtered off the instance's own `tableSchema` so a later re-initialize cannot write them back. Names are matched case-insensitively throughout; the record and manager keep whatever casing they hold.

**The catalog write that shrinks.** `SchemaManager.removeIndex` reads the latest live record and writes it back with the index moved from `indexes` to `orphanedIndexes` (`withoutIndex`), never through `storeStoredSchema`, whose write-time union would put it straight back. The batched half stages the subtracted record into the overlay AND names the index to the batch (`CatalogBatch.excludeIndexAtCommit`); at commit the re-merge against the latest committed record strips those names from the committed side before the union. The exclusion set is snapshotted with `pending`, so a checkpoint restore withdraws a DROP INDEX's subtraction along with its write.

**Ranges.** `@quereus/quereus` is `^4.20.0` in all four manifests, including both plugins' peer ranges and `engines.quereus`. The lockfile keys the package on its portal, not on the range, so no `yarn install` was needed; `yarn lint:deps` (constraints, installed majors, undeclared imports) passes. The build regenerated `src/transaction/quereus-version.ts`, which already said 4.20.0, so that file is unchanged.

**Docs.** `docs/transactions.md` now explains commit-on-error against the undo journal and the irreversible-step exception, cites the review NOTE on `endSchemaBatch` in `@quereus/quereus/src/vtab/module.ts`, and has a paragraph on why DROP INDEX subtracts by name; the `endSchemaBatch` doc comment in the module says the same. The README says a dropped index leaves its description in the record as leftover storage and what a re-create over a tree with deleted-row entries means.

## Use cases to validate

- `create index` then `drop index` on a populated table, then open a fresh `Database` over the same storage and `hydrate`: no index. Before this ticket the fresh one hydrated it back.
- An `apply schema` whose declaration no longer names an index the record lists: the plan is a lone `drop index` inside the batch, and the committed record still lists the index at commit time. This is the path the commit-time exclusion exists for. With `excludeIndexAtCommit` disabled (checked by hand) the fresh Database hydrates the index back; with it, both catalogs agree.
- A failing `apply schema` in which one `create index` landed (populated table, tree deferred) and a later step fails: the journal unwinds `drop index if exists`, no index-tree commit happens, one catalog commit lands the record subtracted again, both catalogs agree, and the corrected re-apply builds every index complete. Checked in session mode too by a throwaway probe (deleted): the abandoned tree rides neither the failed apply nor the next INSERT's coordinator commit.
- Every other failure shape of `apply schema` (a statement refused mid-loop, a create refused after its schema reached the overlay, a `CREATE INDEX` that fails inside the batch, a drop-then-create over one URI): the live `Database`'s catalog and a fresh hydrated one describe the same tables and indexes.
- A re-create after a drop adopts the leftover tree and answers seeks with every current row, including rows written after the drop.

## Tests

Rewritten (all assert both catalogs through `expectCatalogsAgree`, which compares Quereus's in-memory catalog of `main` on the live `Database` and on a fresh hydrated one, and the hydrate counts):

- *a statement refused mid-loop: the engine unwinds what landed before it, and the one catalog commit lands the restored state* — the unwound `create table a` costs one commit (create then gravestone, not elided), the error is the step's own (not "partially migrated"), both catalogs are empty, and the corrected re-apply creates both tables.
- *a create refused AFTER its schema reached the overlay: the checkpoint withdraws it, the engine unwinds the create before it* — two arms. Arm 1 declares only the failing table, so the undo journal is empty and the batch commits **nothing**: zero catalog commits is the checkpoint's contribution shown on its own. Arm 2 puts a table before it: one commit (its gravestone), both catalogs empty.
- *a CREATE INDEX that fails inside the batch: the checkpoint withdraws the index, the engine unwinds the table under it* — one commit, no index-tree commit, both catalogs empty, the re-apply builds both.
- *drop then create over the same URI in one apply sees the PENDING gravestone* — unchanged shape, now also asserts the "partially migrated … cannot be undone" wording (the differ marks `drop table` irreversible, so nothing is unwound) and that both catalogs keep the drop.

New, under a `DROP INDEX` describe:

- *a dropped index stays dropped: both catalogs agree, the tree is left in storage, and a re-create adopts it* — the plain round trip. Pins: one catalog commit and no index-tree commit for the drop; neither Database seeks through the index; an INSERT after the drop rides no index-tree commit (the live instance stopped maintaining it); the record's `indexes` is empty and `orphanedIndexes` names the dropped index; a re-create adopts the tree and answers with every row, the post-drop one included.
- *an apply that no longer declares an index drops it: the batched subtraction survives the commit-time re-merge* — the third case, beyond the ticket's two, added because neither of those exercises the exclusion against a committed listing (in the unwound case the committed record never listed the index). Verified load-bearing by disabling the exclusion.
- *a CREATE INDEX unwound inside a failing apply: the drop reaches the record, and its deferred tree never lands* — the 4.20-specific arm: the step's own error, no orphan tree commit, one catalog commit, both catalogs agree, the re-apply builds both indexes with every row.

Both new DROP INDEX cases were run with the hook renamed away and failed at their first assertion (no catalog commit; an orphan tree commit), then passed with it restored.

## Validation run

From the root unless noted, all green: `yarn lint`, `yarn lint:docs` (181 anchored citations resolve), `yarn lint:deps`, `yarn test:harness` (65), `yarn check:rn` (Metro + hermesc), `yarn workspace @optimystic/quereus-plugin-optimystic test` (999 passing, 13 pending, smoke ok on quereus@4.20.0), the plugin's two integration specs with `OPTIMYSTIC_INTEGRATION=1` (5 passing), `yarn workspace @optimystic/quereus-plugin-crypto test` (125), `yarn workspace @optimystic/upgrade-check test` (59), `tsc --noEmit` in both plugin packages. Not run: the whole-repo `yarn test` and `yarn test:integration` fan-out over db-core, db-p2p and the other packages this ticket does not touch, and the whole-repo `yarn build` (only the plugin was rebuilt; no other package's source changed).

## Judgment calls the reviewer should weigh

- **`forgetTree` on the bridge is beyond the ticket's list.** Without the registry half, a session-mode coordinator, which commits every registered collection with unsynced changes, would carry an unwound index's staged entries into a tree nothing lists on the next commit. It removes the collection only while the registered instance is the dropped tree's, so a re-created index's new instance is untouched. Open savepoints keep the snapshot they captured for the abandoned tree, which changes nothing anyone reads.
- **The description always moves to `orphanedIndexes`**, even for an unwound index whose tree was never flushed. The guard probes the tree for emptiness before refusing, so a description of an absent tree costs one open and one probe at a later CREATE INDEX of that name, while a missing description is the silent mismatched adoption the guard exists for. The narrower rule (describe only when `tree.committedRevision()` is defined) is a one-line change if the record noise from a failed apply is judged worse. Note `orphanedIndexes` was already sticky: a re-created index's description stays there, as it does for a re-declared dropped table's indexes.
- **`removeIndex` initializes an uninitialized instance**, like `addIndex` and `addCheckConstraint` and unlike `destroy`. For an instance whose record never landed this re-persists the record with the index and then subtracts it, net without; one overlay write inside a batch.
- **A drop by a sibling process** narrows the record while this process's manager keeps maintaining the tree until it re-initializes (entries into a tree nothing lists; harmless). The NOTE on `reconcileMaintainedIndexes` now says so; the union it suggests is still the remedy if that ever matters.
- **A DROP INDEX inside an open user transaction** commits its catalog write immediately, as CREATE INDEX does; DML already staged into the dropped tree this transaction is abandoned rather than flushed. Unchanged non-transactional DDL, now with one fewer orphan commit.
- **Sibling race window** on `excludeIndexAtCommit`: a sibling that dropped and re-created the same index while the batch was open has its re-creation stripped at commit, the batch's existing staleness contract widened from adds to drops (NOTE at the method).

## Known gaps

- No test drops a UNIQUE index (the derived-constraint filter) or drops with a case-divergent name; both are straight-line code, and Quereus hands the stored casing anyway.
- No unit-level test of `excludeIndexAtCommit` against a sibling that adds a *different* index during the batch (drop `ix_a`, sibling adds `ix_c`, commit keeps `ix_c`); the logic is the one-line filter in `withoutRemovedIndexes`, and the end-to-end case covers the commit-time path.
- The plain-DROP-INDEX and unwound cases run in legacy commit mode; the session-mode shape was only probed by hand (passing), not committed as a test.

## Tripwires and residuals

- NOTE on `OptimysticVirtualTable.removeIndex`: the tree stays in storage; entries for rows deleted between a drop and a re-create survive it (a seek skips them, a uniqueness probe counts them). Deleting the tree needs a collection-delete primitive that does not exist; `DROP TABLE` leaves its trees the same way. Rather than a new ticket, this landed as a fourth-producer arm on `bug-stale-index-entry-causes-false-unique-refusal`, which already owns the user-visible effect and the decision about where leftovers go. A `feat-` ticket for a collection-delete primitive (serving DROP TABLE and DROP INDEX alike) is worth filing only if a maintainer wants the trees gone independently of that decision.
- NOTE on `CatalogBatch.excludeIndexAtCommit`: the sibling drop-then-re-create window above.
- NOTE on `reconcileMaintainedIndexes`: a sibling's drop leaves this manager maintaining a tree nothing lists until re-initialize.
