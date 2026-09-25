description: Dropping an index on an Optimystic table removes it from the running database but not from the record on disk, so the next process brings it back. Quereus 4.20 makes this reachable on an ordinary path: a schema migration that fails part-way now takes back the steps that already ran, and taking back a created index is exactly the drop the plugin never hears about.
architecture: docs/transactions.md#apply-schema-coalesces-catalog-writes
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (the missing `dropIndex` hook; `createIndex` and `addIndex` are the shapes to mirror; `endSchemaBatch` holds the `deferred` map an unwound CREATE INDEX must be removed from)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`storeStoredSchema` / `mergePersistedSchemas` — the write path UNIONS index lists, so it cannot express a removal; `orphanedIndexes` is where a dropped index's description belongs)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (the three cases that pin 4.19's partial-commit behaviour, the one that passes, and the file header prose)
  - packages/quereus-plugin-optimystic/package.json, packages/quereus-plugin-crypto/package.json, packages/rn-bundle-check/package.json, packages/upgrade-check/package.json (seven `^4.19.4` ranges, including peer ranges and `engines.quereus`)
  - docs/transactions.md, section "APPLY SCHEMA coalesces catalog writes" (describes the old partial-commit failure behaviour)
  - ../quereus/packages/quereus/src/runtime/emit/schema-declarative.ts (`runStepsWithUndoJournal`, `unwindJournal`, `describeIrreversible` — the 4.20 rollback)
  - ../quereus/packages/quereus/src/vtab/module.ts (the `endSchemaBatch` contract and its review NOTE)
difficulty: hard
repro: verified
----
# A dropped index stays in the plugin's catalog

## What is wrong

Quereus asks a virtual-table module to drop an index through a `dropIndex` hook. `OptimysticModule` does not implement one (grep `dropIndex` under `packages/quereus-plugin-optimystic/src`: no hit). So `DROP INDEX` removes the index from Quereus's in-memory catalog and nothing else: the plugin's own catalog record for the table still lists it, and the next process that calls `hydrate` brings the index back.

Verified against the working tree at `main` (`c3cb76cd`) with `@quereus/quereus` 4.20.0, on the `local` transactor over one `MemoryRawStorage`:

    create table t0 (id integer primary key, name text);
    insert into t0 values (1, 'alice'), (2, 'bob');
    create index t0_by_name on t0 (name);   -- a fresh Database hydrates: 1 table, 1 index
    drop index t0_by_name;                  -- the live Database: t0 has no indexes
                                            -- a fresh Database hydrates: 1 table, 1 index  <- back

That is the whole defect, and it has been there since well before Quereus 4.20. What 4.20 changed is how easily an application reaches it.

## Why 4.20 makes it matter

Through 4.19 a migration that failed part-way left the steps that had already run in place. Quereus 4.20 (ticket `apply-schema-rollback-journal` in that repository) runs the migration under an undo journal: when a step fails, each landed step's undo DDL runs in reverse, the catalog is checked against its pre-apply rendering, and the apply reports the schema as restored. The undo runs **inside** the module batch, through the module's ordinary DDL hooks, and before `endSchemaBatch` fires.

For everything the plugin does hook this works out exactly right and needs nothing from us: the undo's `DROP TABLE` reaches `destroy`, stages its gravestone in the same overlay the forward `CREATE TABLE` wrote to, and the one catalog commit at the end lands the pre-apply state. Checked on all four failure shapes the plugin's own suite exercises, the stored catalog and Quereus's in-memory catalog agree afterwards.

The exception is the undo of a `CREATE INDEX`, which the differ renders as `DROP INDEX IF EXISTS <name>` — the one undo statement that reaches a hook the plugin does not implement. Verified, with `t0` already existing and populated:

    declare schema main {
      table t0 { id integer primary key, name text, tag text }
      index t0_by_name on t0 (name)
      index t0_by_tag  on t0 (tag)     -- this one is made to fail
    }
    apply schema main;

`t0_by_name` lands, `t0_by_tag` fails, the journal unwinds `DROP INDEX IF EXISTS t0_by_name`. Afterwards the live database lists no index on `t0`, and the record on disk lists `t0_by_name` — so a fresh `Database` hydrates the index the apply just took back. The two catalogs disagree, which is what this repository's `yarn check` is being held on.

The damage today is bounded but real. The tree the deferred flush landed is still populated, and every process that hydrates the resurrected index also maintains it, so reads through it were correct in every shape tried. What is wrong is that a drop does not stick: the running process and the next process describe the same table differently, a re-apply of the corrected declaration plans against a catalog the engine does not have, and the accepted-tradeoff reasoning elsewhere in the module (a later `CREATE INDEX` adopts a leftover tree and re-stages every row) is being leaned on by a path nobody wrote it for.

## What to build

**One new module hook.** `OptimysticModule.dropIndex(db, schemaName, tableName, indexName)`, shaped like `createIndex` directly above it: resolve the table through `lookupOrInstantiate`, then do the work inside `underBatchCheckpoint(table, 'written', tableKey, ...)` so an open `APPLY SCHEMA` batch coalesces it and a throw withdraws it, exactly as every other catalog write in the batch does. Quereus hands the hook the *stored* casing of the index name (`storedIndexName` in `@quereus/quereus/src/schema/manager.ts`), so match case-insensitively but write what the record already holds.

The removal has four parts, and one of them is not obvious:

- **The record cannot be written through `storeStoredSchema` alone.** That path merges through `mergePersistedSchemas`, which unions the incoming `indexes` with the persisted list by name — deliberately, so an index a sibling writer added since our read survives. A removal expressed as "write the record without it" is therefore unioned straight back in. The removal needs a write path that subtracts by name. Adding one is fine; folding the subtraction into the existing merge is not, because the union is what protects concurrent adds.
- **The descriptor belongs in `orphanedIndexes`.** That field already means "leftover storage, not schema": it is never unioned into `indexes`, it survives every write, and `guardIndexAdoption` reads it to refuse a later `CREATE INDEX` of the same name over different columns. Moving a dropped index's description there keeps that guard honest about the tree the drop leaves behind. It is produced today only by `guardStorageAdoption`; this is a second producer of the same shape.
- **The live instance must stop maintaining it.** Unregister the tree from the table's `IndexManager`, and drop any `uniqueConstraints` entry derived from the index off the instance's own `tableSchema` (the mirror `mirrorDerivedUniqueConstraint` installed). Without this the running process keeps writing entries into a tree nothing lists.
- **An open batch's `deferred` entry for that tree must go.** `endSchemaBatch` flushes every tree in `schemaBatch.deferred`; an unwound `CREATE INDEX` would otherwise land its tree as an unlisted orphan and cost a commit. The `NOTE:` in `endSchemaBatch`'s body already anticipates exactly this ("then have destroy remove the table's `deferred` entries") — the same removal, reached by `dropIndex` rather than by `destroy`.

**The tree itself stays in storage.** `destroy` does not delete index trees and neither should this; a later `CREATE INDEX` of the same name adopts it and re-stages every row idempotently (entries are keyed `indexColumns` concatenated with the primary key). The residual is that entries for rows deleted between the drop and the re-create are left behind, and the re-created index then answers a seek with a row that is gone. That is the same residual the existing failed-flush path already accepts, but a deliberate `DROP INDEX` can sit in front of it for much longer. Deleting the tree instead is a bigger change (nothing in the plugin deletes a collection today) and is not part of this ticket — record the residual as a `NOTE:` at the new hook, and say in the handoff whether it deserves a backlog ticket of its own.

**Then pin 4.20's behaviour in the suite.** Three cases in `test/schema-batch.spec.ts` assert 4.19's partial commit and fail today; the fourth passes for a reason the file does not state. All four need rewriting to assert **both** catalogs — the live `Database`'s `schemaManager` and a reopened, hydrated one — because checking only storage after a reopen is what let the index gap go unnoticed:

- *"a statement refused mid-loop leaves no catalog trace of its own; what landed before it commits"* — the surviving `create table a` is now unwound. Both sides end with neither `a` nor `b`. One catalog commit still happens (the overlay's create-then-gravestone is not elided), so the existing commit-count assertion still holds; it is `hydrated.tables` that is now 0. The title no longer describes the case.
- *"a create refused AFTER its schema reached the overlay is rolled back by the checkpoint"* — `ok` is unwound too, so both sides end empty. The checkpoint still does its own job (it is what withdraws `u`), but the case no longer demonstrates that on its own: either give it an arm that shows the checkpoint's contribution distinctly, or rename it to what it now pins.
- *"a CREATE INDEX that fails inside the batch withdraws only the index from the pending record"* — `t0` is unwound with it; both sides end empty.
- *"drop then create over the same URI in one apply sees the PENDING gravestone"* — still passes, and the reason is worth writing down: the differ marks `DROP TABLE` irreversible (`dropping table "old" also discards its rows`), so it poisons the journal before it runs and nothing is unwound. The apply reports `The schema is partially migrated and could not be restored: the earlier step ... cannot be undone`, both catalogs keep the drop, and the plugin's commit-on-error is what keeps them agreeing. This is the case the review `NOTE:` on `endSchemaBatch` in `@quereus/quereus/src/vtab/module.ts` warns about — and the warning is for a module that *discards* its overlay. The plugin commits, so it lands on the correct side of that note by construction. Say so in the plugin's `endSchemaBatch` doc comment, which today justifies commit-on-error only against 4.19's semantics.

Two new cases, one per newly-pinned behaviour: the plain `DROP INDEX` round trip above (the lowest layer that reproduces the defect), and the unwound `CREATE INDEX` inside a failing apply (the 4.20-specific arm — assert both catalogs, and that no orphan tree commit happens). Nothing beyond those two; the four rewritten cases already cover the failure shapes.

**Then move the range.** `@quereus/quereus` goes from `^4.19.4` to `^4.20.0` in all four manifests, and in the same pass the `peerDependencies` range and `engines.quereus` of both plugin packages, which `yarn.config.cjs` requires to equal the dev range. This changes declared ranges only; publishing is the maintainer's release. The sibling is portal-resolved from the repository root, so the installed tree does not move — run `yarn lint:deps`, and `yarn install` if the lockfile objects.

**Then the docs.** `docs/transactions.md`, section "APPLY SCHEMA coalesces catalog writes", describes the 4.19 world in two places: the paragraph beginning "The batch is a write-coalescing buffer, not a transaction" (which explains commit-on-error entirely in terms of Quereus keeping what landed) and the end-commit-failure paragraph. Both need the undo journal: the engine now normally unwinds inside the batch, so committing the overlay lands the *restored* state rather than a partial one, and the exception is a step the differ marks irreversible. The plugin's `README.md` paragraph on what a record persists should say that a dropped index leaves its description in the record as leftover storage.

## Expected outcome

- A `DROP INDEX` on an Optimystic table removes the index from the record, so a fresh `Database` does not hydrate it back.
- After every failure shape of `apply schema`, the plugin's stored catalog and Quereus's in-memory catalog describe the same tables and the same indexes. Where they cannot (a step Quereus marks irreversible), the apply already says so in its own error and both sides keep the same partial state.
- `yarn check` green from the root.

## TODO

- Read `createIndex`, `addIndex` and `endSchemaBatch` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`, and `storeStoredSchema` / `mergePersistedSchemas` / `orphanedIndexes` in `src/schema/schema-manager.ts`, before writing anything — the union rule is the part that will silently defeat a naive fix.
- Add a subtract-by-name catalog write to `SchemaManager`, batch-aware: it must work through `CatalogBatch` when a batch is open, like every other write.
- Add `OptimysticVirtualTable` support for removing a maintained index: unregister the tree from the `IndexManager`, drop the derived `uniqueConstraints` mirror, move the descriptor to `orphanedIndexes`.
- Add `OptimysticModule.dropIndex`, wrapped in `underBatchCheckpoint(..., 'written', ...)`, and remove the index's tree from `schemaBatch.deferred`.
- Add a `NOTE:` at the new hook: the tree is left in storage, and entries for rows deleted before a later re-create survive it.
- Rewrite the four failure-shape cases in `test/schema-batch.spec.ts` to assert both catalogs; retitle the ones whose titles no longer describe them; update the file header prose, which still says the batch keeps what landed on a part-way failure.
- Add the two new cases: the plain `DROP INDEX` round trip, and the unwound `CREATE INDEX` inside a failing apply.
- Update the `endSchemaBatch` doc comment to justify commit-on-error against 4.20's unwind and the irreversible-step exception, citing the review `NOTE:` in `@quereus/quereus/src/vtab/module.ts`.
- Bump `@quereus/quereus` to `^4.20.0` in the four manifests, moving both plugins' peer ranges and `engines.quereus` with it; run `yarn lint:deps`.
- Update `docs/transactions.md` and the plugin `README.md` paragraph named above.
- `yarn check` from the root.
