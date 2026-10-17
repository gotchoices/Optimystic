description: Changing a table's tags after it was created now lasts across a restart for Optimystic-backed tables, including the tag changes `apply schema` makes, which Sereus relies on to keep its control-schema version in a tag. Review the save path, its ordering against other catalog writes, and the byte layout of the saved record.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/schema/tag-overlay.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md, .release-notes.pending.md
repro: verified
----

# Save tag changes on Optimystic tables to the catalog record

## What was wrong

Quereus applies every tag edit (`alter table … set|add|drop tags`, the column, named-constraint and index forms, and the `set tags` statements `apply schema` emits for a tag-only change) to its own in-memory catalog and announces it as `table_modified`; it never calls the module's `alterTable`. The module heard the event only to start or stop the network watch, so the table's record in `tree://optimystic/schema` kept the old tags and `hydrate` brought them back after a restart. Verified: with the save disabled, all three new tests and the new migration path fail.

## What changed

- **`src/schema/tag-overlay.ts` (new).** `withTagsOf(target, source)`: copies every tag `source` can address onto `target` — table tags, columns by name, NAMED CHECK / foreign key / non-derived UNIQUE constraints by name within their class, indexes by name, all case-insensitive. Unnamed constraints and derived UNIQUE constraints keep their tags (NOTE at the UNIQUE arm). New objects throughout; absent/empty tags omitted. One function for both targets (the vtab's `TableSchema` and the persisted record). `copyTags` moved here from `schema-manager.ts`.
- **`SchemaManager.persistTags(schema, table, source, transactor?)`** returns `'saved' | 'unchanged' | 'no-record'`. Batched: reads through `batch.readEntry`, stages with `batch.write`. Unbatched: open-only catalog, `tree.update()` + `find`, `tree.replace`, cache updated after the write. Compare-skip via db-core's `structuralEquals`, so structural `table_modified` events and a second machine saving the same edit write nothing.
- **`withTableTagsPlaced` (schema-manager.ts).** Not in the plan. The record's table-level `tags` key sits in the middle of the record (`tableSchemaToStored` emits `synthesizedPrimaryKey`, `generatedColumnDependencies`, `generatedColumnTopoOrder` after it; writes append `orphanedIndexes` / `droppedAt`). A plain overlay appended `tags` at the end, so a record that gained tags through ALTER would hold different bytes from a fresh declaration — breaking the byte-identity property the migration-path tests pin. This puts the key back where a fresh write puts it. Coupled by hand to the literal in `tableSchemaToStored` (comment at both sites). Element-level tags are last in every converter, so appending there is already canonical.
- **`OptimysticModule`:**
  - `onRegister(db)` subscribes (`followTagChanges`); the call in `instantiateTable` is gone.
  - Listener: ownership test (`ownsTable`, now shared with `verifyIndexes`), then `followTableTags`: the instance (if any) gets `followSchemaTags(newObject)`; a save joins the serial `catalogTagWrites` chain, through the instance's manager or, for an uninstantiated hydrated table, `createSchemaManager(parseTableSchema(newObject))`. Inside a batch the table key goes into `schemaBatch.written`. Transactor captured when the save is queued. A throw in the synchronous part is caught and logged. The save step catches and logs (accepted-tradeoff NOTE at the catch).
  - `whenCatalogPersisted()` loops until the chain tail stops moving.
  - Drain at entry of `create`, `createIndex`, `dropIndex`, `alterTable`, `destroy`, `endSchemaBatch` — and `beginSchemaBatch` (not in the plan: a save already running reads and writes the catalog directly, and the batch could otherwise read the old record and write it back at commit).
- **`OptimysticVirtualTable.followTags` → `followSchemaTags(schema)`**: overlays tags onto `tableSchema`, then reconciles the network watch as before.
- **`markSchemaUnpersisted`**: after rebuilding `tableSchema.indexes` from the IndexManager (creation-time tags), overlays the tags of the ENGINE's current catalog entry (`this.db.schemaManager.findTable`). The plan said "from the previous `tableSchema.indexes`", but that list never holds indexes created after the instance was built (CREATE INDEX does not append to it), so it would have lost an `alter index … set tags` on any index this session created.
- **Plugin**: `plugin.whenCatalogPersisted()` (doc comment), and `plugin.dispose()` awaits it first.
- **Docs**: README Warm Restart paragraph (what is saved, when an imperative change lands, derived-UNIQUE exception), Network change notification (dropped "does not yet persist"), `dispose()` paragraph; `docs/internals.md` Reactive Watch Bridge *Host requirement* bullet; release-notes entry.

## Tests (all in `test/hydrate-restores-declared-table.spec.ts`, "Warm restart" suite)

- **keeps every tag an imperative ALTER changed, through a restart** — the reproduction. Table, column, named CHECK (`drop tags`), named non-derived UNIQUE, index tags, then `create index` in the same exec; drain; a new session hydrates and `declarationView` equals the writer's live table. Also pins the hook-entry drain: with the drain removed from `createIndex` it fails.
- **saves a tag change on a hydrated table no statement has touched** — pins the `onRegister` subscription and the no-instance branch: with subscription moved back to `instantiateTable` it fails (so `alter … set tags` does not instantiate the table).
- **a tag-only apply schema saves the tag in its one catalog commit** — `counts.commit === 1`, and a fresh session's hydrate shows the new tag with no drain call.
- **New `MIGRATION_PATHS` entry** "from a version without its table and column tags" (`everyFeatureDeclare` gained a `tagged` flag). Runs through the three existing path-iterating tests: byte-identical record vs a fresh apply (pins `withTableTagsPlaced`), hydrated table equals the declared one, re-declaring commits nothing. One test title widened to "…adds a CHECK or tags".

Runs: `yarn build`, `yarn test` in the package (1018 passing, 14 pending, smoke ok), root `yarn typecheck`, `yarn lint:docs`, eslint on the touched files, and `network-change-notification.integration.spec.ts` with `OPTIMYSTIC_INTEGRATION=1` (passes).

## Known gaps / for the reviewer

- **The failed-batch-commit path** (`markSchemaUnpersisted` tag carry, `schemaBatch.written` registration) is inspection-only, as the plan said.
- **Network watch flip on a runtime tag change** has no test, before or after: the integration spec declares the tag and never alters it. Logic unchanged apart from reading `tableSchema.tags` after the overlay.
- **Every structural `table_modified`** (CREATE INDEX, ADD CONSTRAINT, RENAME COLUMN, likely ANALYZE) now costs one catalog read when unbatched (`tree.update()` + `find`), and writes nothing. DDL-rate only; not measured.
- **Without `registerModule`** (a caller driving `module.create` directly) nothing subscribes now. Every real path, and every test, registers.
- **Record key placement** depends on keeping `withTableTagsPlaced`'s list in step with `tableSchemaToStored`'s literal. The migration-path byte test catches a drift only for keys that test's table has (`synthesizedPrimaryKey`, generated-column fields; not `orphanedIndexes`).
- The accepted-tradeoff NOTE at the save's catch site is one long line, as the plan worded it.
