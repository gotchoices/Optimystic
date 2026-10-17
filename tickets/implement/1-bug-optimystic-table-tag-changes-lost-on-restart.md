description: Changing a table's tags after it was created works for the rest of the session but is not saved for Optimystic-backed tables, so after a restart the table has its original tags again. Save every tag change to the table's stored catalog record, including the ones `apply schema` makes, which Sereus relies on to keep its control-schema version in a tag.
architecture: packages/quereus-plugin-optimystic/README.md
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/schema-manager.ts, packages/quereus-plugin-optimystic/src/plugin.ts, packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts, packages/quereus-plugin-optimystic/README.md, docs/internals.md, .release-notes.pending.md, ../quereus/packages/quereus/src/runtime/emit/alter-table.ts, ../quereus/packages/quereus/src/schema/manager.ts, ../quereus/packages/quereus-store/src/common/store-module-schema-sync.ts
repro: static
----

# Save tag changes on Optimystic tables to the catalog record

## The defect

Quereus applies every tag edit — `alter table t set|add|drop tags (…)`, `alter table t alter column c set|add|drop tags`, `alter table t alter constraint k set|add|drop tags`, `alter index i set|add|drop tags`, and the `set tags` statement the `apply schema` differ emits for a tag-only change — by swapping its own in-memory `TableSchema` and firing `table_modified` on `db.schemaManager.getChangeNotifier()` (`commitTagUpdate` in `@quereus/quereus/src/schema/manager.ts`). It never calls the module's `alterTable`. The NOTE above `runSetTableTags` in `@quereus/quereus/src/runtime/emit/alter-table.ts` says a store-backed module must recover the change by listening to that event; the reference implementation is the `table_modified` arm of `dispatchSchemaChange` in `@quereus/quereus-store/src/common/store-module-schema-sync.ts`.

The Optimystic module already listens (`OptimysticModule.followTagChanges` in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`), but only to start or stop the network watch (`OptimysticVirtualTable.followTags`). It never rewrites the table's record in the catalog tree `tree://optimystic/schema`, and `hydrate` rebuilds tags from that record (`copyTags` in `packages/quereus-plugin-optimystic/src/schema/schema-manager.ts`). So the edit is lost at restart.

Three further gaps sit next to that one and are part of this fix:

- **The listener is subscribed too late.** `followTagChanges(db)` is called from `instantiateTable`, so a session that only hydrated (no statement has touched an Optimystic table yet) is not listening, and its first `alter table … set tags` is never seen.
- **The vtab keeps the old tags.** `OptimysticVirtualTable.tableSchema` is never updated by a tag change. `doInitialize` rewrites the record from `tableSchema` whenever the two differ (a re-initialize after a failed `apply schema` batch commit, see `markSchemaUnpersisted`), so it would write the old tags back over a saved change.
- **An uninstantiated table has no vtab.** A hydrated table no statement has touched is not in `OptimysticModule.tables`, so the save cannot live on the vtab; it lives on the module.

## Design

### Module listener (`OptimysticModule`)

Subscribe from a new `onRegister(db)` (Quereus's `VirtualTableModule.onRegister`, available since 4.10; it is synchronous and runs before any table hook). Keep the `followedDatabases` WeakSet so the subscription stays once per `Database`, and drop the call from `instantiateTable`.

On `table_modified`:

1. **Ownership.** Act only when `event.newObject` belongs to this module: `newObject.vtabModule ?? db.schemaManager.getModule(newObject.vtabModuleName)?.module` is `this` — the same test `verifyIndexes` makes. Every other table is ignored.
2. **Refresh the vtab, if one exists.** `this.tables.get(key)?.followSchemaTags(event.newObject)` (rename of `followTags`, taking the new `TableSchema`). It copies the tag fields of the new schema onto `this.tableSchema` (see *Tag overlay* below — never replace `tableSchema` wholesale: it carries folded unique constraints and withheld indexes the engine's object does not) and then reconciles the network watch exactly as today.
3. **Queue the save.** Append one step to a module-level serial chain, `catalogTagWrites: Promise<void>`, that calls `SchemaManager.persistTags(schemaName, tableName, newObject, txnState?.transactor)` on the table's manager: the vtab's `catalogManager` when instantiated, otherwise `this.createSchemaManager(this.parseTableSchema(newObject))` (both synchronous; `createSchemaManager` is cached by fingerprint and joins an open batch). The step catches and logs a failure (`WARN: failed to save tag change on '<schema.table>': …`), so the chain never rejects. The listener is synchronous — Quereus does not await it — so it must not await anything itself.
4. **Inside `apply schema`.** When `this.schemaBatch` is open, add the table key to `schemaBatch.written` for that manager, so a failed batch commit marks the instance unpersisted like any other table the batch altered.

Every structural `table_modified` (rename column, the engine's follow-up after an ADD CONSTRAINT) also arrives here. The save then finds the record's tags already equal and writes nothing.

### Ordering: drain the chain before anything reads the catalog to write it

A catalog write elsewhere reads the record and writes it back whole (for example `addIndex` reads `getSchemaFresh`, appends an index and stores; `storeStoredSchema` takes the incoming record as authoritative for every field except `indexes`). If such a read runs before a queued tag save lands, its write puts the old tags back. Quereus runs statements one at a time, and the listener fires during statement N, so it is enough that each hook that writes the catalog waits for the chain before it starts:

- `create`, `createIndex`, `dropIndex`, `alterTable`, `destroy` — await the chain at entry, before any catalog read and before `underBatchCheckpoint` takes its checkpoint (a save that staged into the batch after the checkpoint would be withdrawn by a later failing statement's `restoreBatch`).
- `endSchemaBatch` — await the chain before the per-manager loop, so a tag-only `apply schema` stages its saves before `commitBatch` and lands them in the apply's one catalog commit.

Lazy first-touch initialization (`initialize` from `connect`/`query`) does not need to wait: its candidate is built from the refreshed `tableSchema`, so whichever of the two writes lands second writes the same tags.

### `SchemaManager.persistTags`

`persistTags(schemaName, tableName, source: TableSchema, transactor?)`:

- Read the live record — through the batch overlay when a batch is open (`batch.readEntry`, as `storeInBatch` does), otherwise fresh (`tree.update()` then `find`, as `storeStoredSchema` does).
- No live record (a gravestone, or a record that never landed — `markSchemaUnpersisted`): log and write nothing. An instantiated table re-persists from its refreshed `tableSchema` on next touch.
- Overlay the tags of `source` onto the record (below). If the result equals the record, write nothing — the common case for structural events and for a second machine that already saved the same change. Otherwise write it the way `storeStoredSchema` / `storeInBatch` do (staged in the batch, or `tree.replace` plus the `schemaCache` update after the write succeeds).

### Tag overlay

One generic function used for both targets (the persisted record and the vtab's `TableSchema`), producing new arrays rather than mutating (Quereus freezes its arrays):

- table `tags` ← `source.tags`;
- each column's `tags` ← the `source` column of the same name (case-insensitive);
- each **named** CHECK, foreign key and non-derived UNIQUE constraint's `tags` ← the `source` constraint of the same name (case-insensitive) in the same class; unnamed constraints keep their tags (ALTER cannot address them);
- each index's `tags` ← the `source` index of the same name.

Absent or empty tags are omitted (`copyTags`), so a tag-free object stays byte-identical with records written before.

### Draining from outside

`OptimysticModule.whenCatalogPersisted(): Promise<void>` resolves once the chain is empty. The plugin exposes it as `plugin.whenCatalogPersisted()`, and `plugin.dispose()` awaits it first. This is the one behavioural difference from other DDL: an imperative `alter … set tags` returns before its save lands. A host that closes a `Database` and reopens the same storage in-process must call `whenCatalogPersisted()` or `dispose()` in between; a process that exits right after the statement can lose the change. A tag change made by `apply schema` lands before `apply schema` returns.

## Edge cases & interactions

- **Two consecutive tag statements in one exec** (`set tags (a=1); set tags (a=2)`): the serial chain lands them in order; the record ends at `a=2`. Inspection.
- **Tag edit followed by `create index` in one exec**, no drain call between: the hook-entry drain makes `addIndex` read the tag-updated record, so both survive. Covered by the first test.
- **`apply schema` with only a tag change**: staged in the batch and committed in the apply's one catalog commit. Covered by the third test.
- **`apply schema` unwind**: an undo step for a tag change is another `set tags`, so it is saved through the same path, in order. Inspection.
- **A failing statement inside `apply schema`** after a tag statement: the drain before `underBatchCheckpoint`'s checkpoint keeps the earlier statement's staged save out of the withdrawn range. Inspection.
- **Failed batch commit**: the tag table is in `schemaBatch.written`, so an instantiated table is marked unpersisted and re-persists from its refreshed `tableSchema`. `markSchemaUnpersisted` rebuilds `tableSchema.indexes` from the IndexManager, whose descriptors carry creation-time tags: carry each index's current tags over by name from the previous `tableSchema.indexes`, or an `alter index … set tags` is undone by the re-persist. A hydrated table no statement touched has no instance to mark; its change is lost with the commit, and the next `apply schema` re-emits it (the differ sees the old tags on the hydrated table). Note this in the `endSchemaBatch` log line or doc comment. Inspection.
- **Hydrated, untouched table**: saved through the module-level manager, no vtab needed. Covered by the second test.
- **Table of another module** (a memory table, the engine's MV backing tables): ownership test skips it. Inspection.
- **DDL inside an explicit transaction**: the catalog write commits immediately, as every Optimystic catalog write does (the `transactor` argument only selects a cache); Quereus does not roll back its in-memory tag swap either, so the two agree. Inspection.
- **Two machines making the same tag change**: the second finds the record already equal and writes nothing. Different changes: the last record written wins, as for every other catalog write today. Inspection.
- **Save failure**: logged with the table name; the chain continues; the drain resolves. Record the decline at the catch site as `// NOTE: accepted tradeoff — a failed tag save is logged, not reported: Quereus has no channel back from a schema-change listener, the same as the store module; revisit if Quereus gives listeners an async or error-reporting seam.`
- **Index-derived UNIQUE constraints**: they have no slot in the record (rebuilt from their index on hydrate), so a tag edit addressed to one through `alter constraint` cannot be saved. Add a `NOTE:` at the overlay's UNIQUE arm. Tags on the index itself are saved.
- **Network watch**: `followSchemaTags` keeps today's watch reconciliation; behaviour unchanged. Inspection (the integration spec `network-change-notification.integration.spec.ts` still covers it).

## Tests

Add to the "Warm restart" suite in `packages/quereus-plugin-optimystic/test/hydrate-restores-declared-table.spec.ts`, reusing `openEra`, `declarationView`, `tableOf`, `countingTransactor` and `catalogRecordBytes`:

- **Imperative tag edits survive a restart (the reproduction).** era1 creates a table with table tags `(a = 1)`, a tagged column, a named CHECK, a named non-derived UNIQUE constraint and an index, each with tags. One `exec`: `alter table … set tags (a = 2)`, an `alter column … set tags`, an `alter constraint … drop tags` on the CHECK, an `alter constraint … set tags` on the UNIQUE, `alter index … set tags`, then `create index` of a second index. `await plugin.whenCatalogPersisted()`. era2 over the same storage hydrates. Expected: `declarationView` of the hydrated table equals `declarationView` of era1's live catalog table — every edited tag, and both indexes. Fails today on the tags.
- **A hydrated table no statement has touched.** era2 hydrates, runs only `alter table … set tags (b = true)`, drains. era3 hydrates: the table's tags are `{ b: true }`. Pins the `onRegister` subscription and the no-vtab branch.
- **A tag-only `apply schema` saves in its one catalog commit.** Declare version 1, apply; declare version 2 differing only in a table tag; reset the counting transactor's counts; `apply schema`. Expected: `counts.commit === 1`, and a fresh era's hydrate shows the new tag, with no `whenCatalogPersisted()` call.

## TODO

- Add `onRegister(db)` to `OptimysticModule`, subscribing through `followTagChanges`; remove the `instantiateTable` call.
- Rework the `table_modified` handler: ownership test, `followSchemaTags`, the serial `catalogTagWrites` chain, `schemaBatch.written`.
- Rename `OptimysticVirtualTable.followTags` to `followSchemaTags(schema: TableSchema)`; overlay tags onto `tableSchema`, then reconcile the network watch.
- Carry index tags across `markSchemaUnpersisted`'s index refresh.
- Add the tag overlay function and `SchemaManager.persistTags` (batched and unbatched arms, compare-skip, no-record log).
- Drain `catalogTagWrites` at entry of `create`, `createIndex`, `dropIndex`, `alterTable`, `destroy` (before `underBatchCheckpoint`) and of `endSchemaBatch`.
- Add `OptimysticModule.whenCatalogPersisted()`; expose `plugin.whenCatalogPersisted()` with a doc comment; await it at the top of `plugin.dispose()`.
- The three tests above.
- README: in the hydrate paragraph, say tag changes (`alter table/column/constraint/index … set|add|drop tags`, and `apply schema`'s tag-only changes) are saved in the record, and when an imperative change lands (`whenCatalogPersisted`); drop "note that this plugin does not yet persist a tag change across a restart" from *Network change notification*.
- `docs/internals.md` *Reactive Watch Bridge* (*Host requirement* bullet): every `table_modified` the module hears also saves the table's tags to its catalog record.
- `.release-notes.pending.md`: one entry under Unreleased.
- `yarn build` then `yarn test` in `packages/quereus-plugin-optimystic`; `yarn typecheck`; `yarn lint:docs`.
