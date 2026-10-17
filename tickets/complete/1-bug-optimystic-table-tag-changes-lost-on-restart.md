description: Changing a table's tags after it was created now lasts across a restart for Optimystic-backed tables, including the tag changes `apply schema` makes, which Sereus relies on to keep its control-schema version in a tag.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/schema/tag-overlay.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md, .release-notes.pending.md
repro: verified
----

# Save tag changes on Optimystic tables to the catalog record

## What was wrong

Quereus applies every tag edit (`alter table … set|add|drop tags`, the column, named-constraint and index forms, and the `set tags` statements `apply schema` emits for a tag-only change) to its own in-memory catalog and announces it as `table_modified`. It never calls the module's `alterTable`. The module used the event only to start or stop the network watch, so the table's record in `tree://optimystic/schema` kept the old tags and `hydrate` brought them back after a restart.

## What landed (`ticket(implement): bug-optimystic-table-tag-changes-lost-on-restart`)

- `withTagsOf` in `src/schema/tag-overlay.ts` copies every tag a schema can address (table, columns by name, named CHECK / foreign key / non-derived UNIQUE constraints, indexes) onto another schema. It is used for both the vtab's own `tableSchema` and the persisted record.
- `SchemaManager.persistTags` saves a table's tags into its record, batched or not, and writes nothing when the record already carries them. `withTableTagsPlaced` moves the table-level `tags` key back to where a fresh write puts it, so the bytes match a fresh declaration.
- `OptimysticModule` subscribes in `onRegister`, so a hydrated table that no statement has touched is covered too. Saves go through a serial chain (`catalogTagWrites`), and every catalog-writing hook, `beginSchemaBatch` and `endSchemaBatch` drain it first. `plugin.whenCatalogPersisted()` is new, and `plugin.dispose()` waits for it.
- `markSchemaUnpersisted` carries the engine's current tags onto a re-persist after a failed batch commit.
- README, `docs/internals.md` and the release notes are updated.

## Review findings

**Read first:** the implement diff, then Quereus's tag primitives (`commitTagUpdate`, `updateConstraintTags` and `resolveIndexTagSwap` in `@quereus/quereus/src/schema/manager.ts`), every `table_modified` emitter, `onRegister` in `@quereus/quereus/src/core/database.ts`, and the plugin's own catalog writers (`doInitialize`, `addIndex`, `addCheckConstraint`, `storeStoredSchema`, `mergeIndexLists`, `createSchemaManager`, the batch hooks).

**Correctness: checked, no defect found.**
- Addressability: `withTagsOf` reaches exactly what Quereus's ALTER forms reach. Constraints resolve check → unique → foreign key by name; hidden covering indexes are not addressable. The one gap is the derived-UNIQUE case, which the implementer documented.
- Batch membership: a manager created for a table with no instance comes from `createSchemaManager`. That function caches managers by binding and enrolls a new one in an open batch, so the no-instance save stages into the apply's batch rather than writing around it.
- Drain ordering against `underBatchCheckpoint`: a later statement that fails cannot withdraw an earlier statement's tag save.
- Other catalog writers: `addIndex` and `addCheckConstraint` build their write from a fresh catalog read. The two writers that build from the instance's `tableSchema` (the declared-columns arm of `doInitialize`, and the re-persist after `markSchemaUnpersisted`) both see the new tags, because `followSchemaTags` overlays them in the same synchronous step that fires the event. `markSchemaUnpersisted` also overlays the engine's current tags.
- Byte layout: element-level `tags` is the last key in every to-stored converter, so `withTags` appending it is canonical. The keys that `withTableTagsPlaced` moves after `tags` match the `tableSchemaToStored` literal and the `StoredTableSchema` fields.
- `hydrate` does not fire `table_modified`; only DDL does. So cold start pays nothing extra.

**Test coverage: one gap found and fixed.** None of the tests covered the host's actual upgrade path: restart, `hydrate`, then a tag-only `apply schema` on a table no statement has touched. That save goes through the batched no-instance branch. I rewrote the existing one-commit test as "a tag-only apply schema after a restart saves the tag in its one catalog commit", so it covers that path at no extra test cost. To confirm it pins the branch, I temporarily removed the no-instance branch: both that test and "saves a tag change on a hydrated table no statement has touched" failed. The other two new tests and the new migration-path entry meet the bar (they reproduce the bug or pin byte identity) and were kept.

**Docs: one defect found and fixed.** In the README Warm Restart paragraph, the tag sentences had been inserted between the CHECK sentences and "Like Quereus's own tables, rows already stored are not re-checked against it", so "it" read as the tags. I moved the tag sentences to the end of the CHECK discussion. The `docs/internals.md` and release-notes text are accurate.

**Performance: one tripwire.** Each structural `table_modified` (CREATE INDEX, ADD CONSTRAINT, RENAME COLUMN, and ANALYZE once per table) costs one catalog read outside a batch. That is only DDL-rate, and it buys self-healing: the next DDL re-saves tags an earlier failed save left out. Parked as a `NOTE:` on `OptimysticModule.followTableTags`, naming the remedy (compare the event's `oldObject` and `newObject` tags) and what it gives up.

**Error handling: nothing new.** A failed save is logged under the implementer's accepted-tradeoff `NOTE:`, and the outer synchronous `try` logs too. A tag value JSON cannot encode (a bigint beyond the safe-integer range) fails the save and is only logged. The same value already fails loudly on CREATE, and Quereus has no persistability veto for table tags. This is a contrived input, so no ticket was filed.

**Accepted gaps from the handoff, re-checked and left as they are:** the failed-batch-commit path is covered by inspection only; there is no test for the network watch flipping on a runtime tag change, and its logic is unchanged; nothing subscribes when no `registerModule` is involved, and every real path registers; key placement is coupled by hand to `tableSchemaToStored`, with a comment at both sites.

**Hygiene:** `tag-overlay.ts` is small and single-purpose. Comments state constraints rather than narrating steps. `optimystic-module.ts` was already large before this change; the new code is a few small methods.

**Runs:** package `yarn build`, `yarn test` (1018 passing, 14 pending, smoke ok), eslint on the touched files, root `yarn typecheck`, `yarn lint:docs`. The integration suite was not re-run: the review changed only a comment, a test and the README.
