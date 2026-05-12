description: Hydrate Quereus's in-memory catalog from the persisted Optimystic vtab schemas so warm restarts skip per-table CREATE round-trips through the schema tree
prereq: none
files:
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/plugin.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
----

## Status: implementation already landed in the fix stage

The fix-stage agent reproduced the issue, found Quereus already exposes the
right hydration surface (`db.schemaManager.getSchema(name).addTable(...)`),
and shipped the changes end-to-end. Build and the package's full test suite
(`npm test --workspace @optimystic/quereus-plugin-optimystic`) pass: 187
passing, 4 pre-existing pending, 0 failing. The implement stage is largely a
validation pass — re-run `npm test`, sanity-check the API shape below, then
hand off to review.

## What changed

### Public API addition: `plugin.hydrate(db)`

`register(db, config)` now returns an additional async method `hydrate(db)`.
Hosts that re-open a `Database` against existing storage call this once after
registering vtables and BEFORE running any DDL / `apply schema`. It walks
`SchemaManager.listTables()`, converts each `StoredTableSchema` back to a
Quereus `TableSchema`, and adds it to `db.schemaManager.getSchema('main')`.
Returns `{ tables: number; indexes: number }` (count of newly-added entries;
already-present tables are skipped).

```ts
const plugin = register(db, { default_transactor: 'local', ... });
for (const v of plugin.vtables) db.registerModule(v.name, v.module, v.auxData);
for (const f of plugin.functions) db.registerFunction(f.schema);
await plugin.hydrate(db);          // ← new
await db.exec(`declare schema App { ... } apply schema App;`); // emits no-op
```

After hydration, Quereus's `apply schema` diff sees the existing tables in
its catalog and emits zero `CREATE TABLE` / `CREATE INDEX` statements. The
schema-tree round-trip per table is paid once (during hydration's
`listTables` scan), not once per DDL statement on every cold start.

### `SchemaManager.storedToTableSchema(stored, vtabModule, vtabAuxData?)`

New public method on the plugin-internal `SchemaManager` that builds a
complete Quereus `TableSchema` from a `StoredTableSchema` (resolves
`logicalType` from the stored affinity name via Quereus's `getTypeOrDefault`,
re-derives `columnIndexMap`, rebuilds `indexes` and `primaryKeyDefinition`).
Used by `hydrateCatalog`.

### `OptimysticModule` refactors

- `instantiateTable(db, tableSchema)` extracted from `create()` so `connect()`
  can construct an `OptimysticVirtualTable` when the module's local
  `this.tables` cache is empty (post-hydration, post-restart, etc.). Takes
  the catalog's `TableSchema` as the source of truth.
- `connect(db, ..., tableSchema?)` now uses the 7th `tableSchema` argument
  Quereus passes from `importCatalog` / runtime queries, falling back to
  `db.schemaManager.findTable(name, schema)` if absent. Previous behavior
  (throw when not in `this.tables`) was a hard block on hydration-then-query.
- `hydrateCatalog(db, config, auxData?)` is the workhorse behind
  `plugin.hydrate(db)`. Idempotent — skips tables already in the target
  schema.
- `destroy()` now also calls `schemaManager.deleteSchema(tableName)` so
  DROP-then-re-CREATE picks up the new shape rather than the persisted old
  one. (Pre-fix this worked accidentally because the schema-tree write path
  was broken; see below.)

### Underlying schema-tree fix

The schema-tree's `keyExtractor` (in `collection-factory.ts`) treats entries
as `[name, StoredTableSchema]` tuples — keying on `entry[0]` — and
`getSchema` / `listTables` cast reads back to that shape. But `storeSchema`
was writing the bare `StoredTableSchema` object instead of wrapping it in
the tuple, which made `entry[0]` undefined inside the btree. Cross-instance
reads (and `listTables`) couldn't see the entries even after a clean sync,
which is why `hydrateCatalog` initially returned zero tables in the test.

`storeSchema` now writes the entry as `[schema.name, stored]`. The
schema-cache hit path masked this for single-instance reads, which is why
no test exercised it before.

`SchemaManager.listTables` and `getSchema` also now call `await tree.update()`
before reading, so a fresh `SchemaManager` (post-restart, or a new plugin
instance against shared storage) actually pulls log state from storage
instead of iterating an empty in-memory btree.

### `doInitialize()` schema reconciliation

`OptimysticVirtualTable.doInitialize()` previously had a single branch:
"if persisted schema exists, override local `tableSchema.columns` with the
stored shape." Pre-fix this branch effectively never ran (because the read
path was broken), so each node kept its own DDL-supplied columns. Post-fix,
the branch fires for real and broke the existing
`distributed-transaction-validation > should demonstrate local schema
enforcement` test (Node 2 was overriding its `(id, name)` schema with Node
1's `(id, name, extra_field)`).

Resolution: split the branch by `tableSchema.columns.length`:
- `> 0` (xCreate path with DDL columns): keep local schema and (re-)write
  it. Multi-node hosts that intentionally CREATE a table with a different
  shape get their local DDL honored.
- `= 0` (xConnect / hydrated minimal placeholder): load the persisted
  schema and stamp it onto the placeholder.

This preserves both the cold-restart-via-CREATE flow and the local-schema
enforcement semantics the existing distributed test relies on.

## Use cases for review / validation

1. **Cold-start hydration.** Open `Database`, register plugin against
   storage that already contains persisted schemas, call `plugin.hydrate(db)`.
   Verify `db.schemaManager.findTable(name, 'main')` returns the table
   before any DDL runs. Covered by `test/catalog-hydration.spec.ts` →
   "populates Quereus catalog from persisted vtab schemas before any DDL".
2. **Idempotent re-hydration.** Calling `plugin.hydrate(db)` twice in a row
   returns `{ tables: 0, indexes: 0 }` on the second call. Covered.
3. **Empty storage cold start.** `plugin.hydrate(db)` against fresh storage
   returns `{ tables: 0, indexes: 0 }`. Covered.
4. **Query through hydrated catalog.** After `hydrate`, `SELECT` against a
   hydrated table goes through `module.connect()` (which now lazily
   instantiates `OptimysticVirtualTable` from the catalog's `TableSchema`)
   and returns rows from the data tree. Covered.
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

## TODO

- Run `npm test --workspace @optimystic/quereus-plugin-optimystic`; expect
  187 passing, 4 pending, 0 failing.
- Skim the diff for the `doInitialize` reconciliation logic and the
  schema-tree write/read symmetry; both are subtle.
- Move to `review/`.
