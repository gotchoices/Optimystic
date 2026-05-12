description: The Quereus Optimystic plugin now exposes a `hydrate(db)` entrypoint that primes Quereus's in-memory catalog from persisted vtab schemas, so warm restarts skip per-table CREATE round-trips through the schema tree.
files:
  - packages/quereus-plugin-optimystic/src/plugin.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
  - packages/quereus-plugin-optimystic/test/adapter-integration.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
  - packages/quereus-plugin-optimystic/README.md
----

## What was built

A new `hydrate(db)` entrypoint on the plugin's registration result lets a host
prime Quereus's in-memory catalog from the persisted Optimystic vtab schemas
**before** issuing any DDL. After hydration, `apply schema` (or
`CREATE TABLE IF NOT EXISTS`) diffs against a populated catalog and emits zero
per-table CREATE / CREATE INDEX, so warm restarts no longer pay one
schema-tree round-trip per table.

### Public API

```ts
const plugin = register(db, { default_transactor: 'local', ... });
for (const v of plugin.vtables) db.registerModule(v.name, v.module, v.auxData);
for (const f of plugin.functions) db.registerFunction(f.schema);
await plugin.hydrate(db);                                       // ← new
await db.exec(`declare schema App { ... } apply schema App;`);  // → no-op after hydrate
```

`hydrate(db)` resolves to `{ tables: number; indexes: number }` (counts of
newly-added catalog entries; already-present tables are skipped). Idempotent
and a no-op against empty storage. Documented in
[packages/quereus-plugin-optimystic/README.md](../../packages/quereus-plugin-optimystic/README.md)
under "Warm Restart".

### Key files

| File | Change |
|---|---|
| `src/plugin.ts` | Adds `hydrate(db)` to the registration result; delegates to `OptimysticModule.hydrateCatalog`. |
| `src/optimystic-module.ts` | Adds `hydrateCatalog()`, `instantiateTable()`, `deriveDefaultOptions()`; `connect()` honors a column-bearing `TableSchema` argument from Quereus and lazily instantiates an `OptimysticVirtualTable` when the module cache is empty; `destroy()` also clears the persisted schema entry so DROP-then-re-CREATE picks up the new shape. |
| `src/schema/schema-manager.ts` | `storeSchema` now writes `[name, stored]` tuples (matching `collection-factory.ts`'s `keyExtractor` and the read path); `getSchema` and `listTables` `await tree.update()` so a fresh `SchemaManager` pulls log state from storage; new public `storedToTableSchema()` reconstructs a complete Quereus `TableSchema` from a persisted record. |
| `src/optimystic-adapter/collection-factory.ts` | unchanged — the read/write asymmetry is fixed on the producer side (`storeSchema`). |
| `test/catalog-hydration.spec.ts` | New spec — verifies populate-from-storage, idempotent re-hydrate, empty-storage cold start, and query-after-hydrate through `module.connect()`. |
| `README.md` | New "Warm Restart" section documents the recommended call order. |

### Underlying schema-tree fix

The schema-tree's `keyExtractor`
(`packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:47-49`)
treats entries as `[name, StoredTableSchema]` tuples — keying on `entry[0]` —
and `getSchema` / `listTables` cast reads back to that shape. But `storeSchema`
was writing the bare `StoredTableSchema` object instead of the tuple, so
`entry[0]` was undefined inside the btree. Cross-instance reads (and
`listTables`) couldn't see the entries even after a clean sync. The
schema-cache hit path masked this for single-instance reads, which is why no
existing test caught it. Fixed by writing `[schema.name, stored]`.

### `doInitialize()` schema reconciliation

`OptimysticVirtualTable.doInitialize()` splits its persisted-schema handling
by `tableSchema.columns.length`:

- **`> 0`** (xCreate / hydrated path with columns): keep the local schema and
  (re-)write it. Multi-node hosts that intentionally CREATE the same table
  with a different shape get their local DDL honored — preserves the
  `distributed-transaction-validation > should demonstrate local schema
  enforcement` test's semantics.
- **`= 0`** (xConnect with a column-less placeholder): load the persisted
  schema and stamp it onto the placeholder so query planning sees the real
  columns.

## Testing notes

- `npm run build --workspace @optimystic/quereus-plugin-optimystic` — clean.
- `npm test --workspace @optimystic/quereus-plugin-optimystic` —
  **187 passing, 4 pre-existing pending, 0 failing.**

Direct regression coverage:

- `test/catalog-hydration.spec.ts` — populate-from-storage, idempotent
  re-hydrate, empty-storage cold start, and query-after-hydrate through
  `module.connect()`. Exercises the public registration surface
  (`plugin.hydrate`, `plugin.vtables`, `plugin.functions`) and Quereus
  public APIs (`db.exec`, `db.eval`, `db.schemaManager.findTable`) — does
  not reach into module internals.
- `test/adapter-integration.spec.ts > should support DROP TABLE and
  re-CREATE with different schema` — confirms `destroy()` clears the
  persisted schema so the second CREATE writes the new shape.
- `test/distributed-transaction-validation.spec.ts > should demonstrate
  local schema enforcement` — confirms the `hasLocalColumns` branch in
  `doInitialize()` still lets local DDL win over a peer's prior write.

## Usage

Hosts opening a `Database` against existing Optimystic storage should call
`plugin.hydrate(db)` once after registering the plugin's vtables and
functions, and **before** running `apply schema` or
`CREATE TABLE IF NOT EXISTS`. See the README for the full call order.

## Follow-ups (out of scope, can be picked up later)

- After hydrate, the first `module.connect()` for a hydrated table still
  re-writes the (byte-identical) schema back to storage because
  `doInitialize` takes the `hasLocalColumns` branch. Cold-start total
  writes are O(connect-count) rather than O(tables) — better than the
  original O(tables × DDL-emits) but still one avoidable write per
  connect. Worth a guard: skip `storeSchema` when the persisted schema
  matches the in-memory one. Low-impact, deferred.
- `hydrateCatalog`'s `/not found|missing|empty/i` regex is defensive — in
  practice `listTables` against fresh storage returns `[]` rather than
  throwing, so the catch-and-return branch may be dead code. Worth
  confirming and removing if so.
- `plugin.hydrate(db)` currently passes `config` to `hydrateCatalog`
  twice (once as `config`, once as `auxData`). They are the same shape;
  the second parameter could be collapsed into the first. Cosmetic.
