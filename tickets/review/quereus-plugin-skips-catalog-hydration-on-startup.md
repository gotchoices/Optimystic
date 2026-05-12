description: Review catalog hydration for the Quereus Optimystic plugin so warm restarts skip per-table CREATE round-trips through the schema tree
prereq: none
files:
  - packages/quereus-plugin-optimystic/src/plugin.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## What landed

A new `hydrate(db)` entrypoint on the plugin's registration result lets a host
prime Quereus's in-memory catalog from the persisted Optimystic vtab schemas
**before** issuing any DDL. After hydration, `apply schema` (or
`CREATE TABLE IF NOT EXISTS`) diffs against a populated catalog and emits zero
per-table CREATE / CREATE INDEX, so cold restarts no longer pay one schema-tree
round-trip per table.

### Public API addition

```ts
const plugin = register(db, { default_transactor: 'local', ... });
for (const v of plugin.vtables) db.registerModule(v.name, v.module, v.auxData);
for (const f of plugin.functions) db.registerFunction(f.schema);
await plugin.hydrate(db);                          // ← new
await db.exec(`declare schema App { ... } apply schema App;`); // → no-op after hydrate
```

`hydrate(db)` resolves to `{ tables: number; indexes: number }` (counts of
newly-added catalog entries; already-present tables are skipped). Idempotent.

### Supporting changes

- `SchemaManager.storedToTableSchema(stored, vtabModule, vtabAuxData?)` —
  builds a complete Quereus `TableSchema` from a `StoredTableSchema`
  (resolves `logicalType` via `getTypeOrDefault`, re-derives
  `columnIndexMap`, rebuilds `indexes` / `primaryKeyDefinition`).
- `OptimysticModule.instantiateTable(db, tableSchema, options?)` — extracted
  from `create()` so `connect()` can lazily construct an
  `OptimysticVirtualTable` from the catalog's `TableSchema` when the
  module's `tables` cache is empty (e.g. immediately after hydrate, runtime
  query against a hydrated table).
- `OptimysticModule.connect(db, …, tableSchema?)` — honors the 7th
  `tableSchema` argument Quereus passes from `importCatalog` / runtime
  queries, falling back to `db.schemaManager.findTable(name, schema)` if
  absent. No longer throws when the table is missing from the local
  module cache.
- `OptimysticModule.hydrateCatalog(db, config, auxData?)` — workhorse
  behind `plugin.hydrate(db)`. Walks `SchemaManager.listTables()`, skips
  tables already in the target schema, and `addTable`s the rest into
  `db.schemaManager.getSchemaOrFail(getCurrentSchemaName())`. Returns the
  added counts.
- `OptimysticModule.destroy()` — now also calls
  `schemaManager.deleteSchema(tableName)` so DROP-then-re-CREATE picks up
  the new shape rather than the persisted old one.

### Underlying schema-tree fix

The schema-tree's `keyExtractor` (in `collection-factory.ts`) treats entries
as `[name, StoredTableSchema]` tuples — keying on `entry[0]` — and
`getSchema` / `listTables` cast reads back to that shape. But `storeSchema`
was writing the bare `StoredTableSchema` object instead of the tuple, so
`entry[0]` was undefined inside the btree. Cross-instance reads (and
`listTables`) couldn't see the entries even after a clean sync. The
schema-cache hit path masked this for single-instance reads, which is why
no existing test caught it. Fixed by writing `[schema.name, stored]`.

`SchemaManager.listTables` and `getSchema` now `await tree.update()` before
reading, so a fresh `SchemaManager` (post-restart, or a new plugin instance
against shared storage) actually pulls log state from storage instead of
iterating an empty in-memory btree.

### `doInitialize()` schema reconciliation

`OptimysticVirtualTable.doInitialize()` split its persisted-schema branch by
`tableSchema.columns.length`:

- **`> 0`** (xCreate path with DDL columns): keep local schema and (re-)write
  it. Multi-node hosts that intentionally CREATE a table with a different
  shape get their local DDL honored — preserves the
  `distributed-transaction-validation > should demonstrate local schema
  enforcement` test's semantics.
- **`= 0`** (xConnect / hydrated minimal placeholder): load the persisted
  schema and stamp it onto the placeholder so query planning sees the real
  columns.

## Validation surfaces (what to review)

1. **Cold-start hydration.** Open `Database`, register plugin against
   storage that already contains persisted schemas, call `plugin.hydrate(db)`.
   Verify `db.schemaManager.findTable(name, 'main')` returns the table
   before any DDL runs. Covered by `test/catalog-hydration.spec.ts` →
   "populates Quereus catalog from persisted vtab schemas before any DDL".
2. **Idempotent re-hydration.** Calling `plugin.hydrate(db)` twice in a row
   returns `{ tables: 0, indexes: 0 }` on the second call.
3. **Empty storage cold start.** `plugin.hydrate(db)` against fresh storage
   returns `{ tables: 0, indexes: 0 }`.
4. **Query through hydrated catalog.** After `hydrate`, `SELECT` against a
   hydrated table goes through `module.connect()` (which now lazily
   instantiates `OptimysticVirtualTable` from the catalog's `TableSchema`)
   and returns rows from the data tree.
5. **DROP + re-CREATE with different shape.** `destroy` clears the persisted
   schema so the second CREATE writes the new shape rather than reading the
   old one back. Regression coverage in
   `test/adapter-integration.spec.ts` → "should support DROP TABLE and
   re-CREATE with different schema".
6. **Multi-node local schema enforcement.** Two nodes CREATE the same table
   with different columns; each keeps its local schema, queries return
   only locally-known columns. Regression coverage in
   `test/distributed-transaction-validation.spec.ts` → "should demonstrate
   local schema enforcement".

## Build / test status at handoff

- `npm run build --workspace @optimystic/quereus-plugin-optimystic` — clean.
- `npm test --workspace @optimystic/quereus-plugin-optimystic` —
  **187 passing, 4 pre-existing pending, 0 failing.**

## Review focus

- `doInitialize()` reconciliation logic
  (`packages/quereus-plugin-optimystic/src/optimystic-module.ts:124-205`):
  the `hasLocalColumns ? store-local : load-persisted` split is subtle and
  is the load-bearing piece of "preserve local-schema-enforcement semantics
  while still allowing xConnect/hydrate to discover columns from storage."
- Schema-tree write/read symmetry
  (`packages/quereus-plugin-optimystic/src/schema/schema-manager.ts:74-152`):
  `storeSchema` now writes `[name, stored]` tuples to match what
  `getSchema` / `listTables` read and what `keyExtractor` keys on. The
  unwrap path on `getSchema` keys off `entry[1]`.
- `hydrateCatalog` target-schema resolution
  (`optimystic-module.ts:907-951`): uses
  `db.schemaManager.getCurrentSchemaName()` + `getSchemaOrFail()` rather
  than hardcoding `'main'`, and re-stamps `schemaName` on the hydrated
  `TableSchema` so a host with a non-default current schema gets the
  hydrated entries in the right place.
- `deriveDefaultOptions` (`optimystic-module.ts:958-981`) mirrors
  `parseTableSchema`'s default-resolution against the plugin's
  registration config so the hydrator opens the schema tree using the
  same transactor/network the tables themselves use. Worth a sanity
  check against the per-table defaults (`parseTableSchema`,
  `optimystic-module.ts:764-801`).

## TODO

- Verify the build and tests still pass on the reviewer's machine
  (`npm run build && npm test --workspace @optimystic/quereus-plugin-optimystic`).
- Audit `optimystic-module.ts` and `schema-manager.ts` against
  SPP/DRY/modular/scalable/maintainable/performant/resource-cleanup
  criteria. Particular eyes on:
  - `doInitialize()` post-fix logic — confirm both branches are needed
    and that there's no third case (e.g. xConnect with a column-bearing
    `TableSchema` from `importCatalog`) we should split out.
  - `hydrateCatalog()` error handling — the `/not found|missing|empty/i`
    regex catches "no schema tree yet" cold-starts. Confirm that's the
    right shape for what storage actually throws, and that we don't
    accidentally swallow real failures whose messages happen to match.
  - The unused 3rd argument to `register()`'s `hydrate` (passes `config`
    twice — once as `config`, once as `auxData`). Confirm that's the
    intended wiring or simplify.
- Confirm the new `catalog-hydration.spec.ts` exercises the externally-
  visible contract rather than internal state (i.e. uses the public
  registration result + `db.schemaManager.findTable` + `db.eval` rather
  than reaching into module internals).
- If docs/README mention catalog warm-up or first-launch behavior, add a
  short note about `plugin.hydrate(db)` and the recommended call order.
- Move to `complete/` once review is signed off.
