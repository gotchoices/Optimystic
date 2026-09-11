description: A process that loads its tables from storage and then adds an index — through `apply schema` or a plain `create index` — fails with "table not found … Cannot create index" unless some earlier statement happened to touch that table first.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (OptimysticModule.createIndex — its `this.tables.get(tableKey)` lookup; hydrateCatalog; resolveConnectedTable; destroy for comparison)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (the case "a deferred index tree that fails to land …" works around this)
repro: verified
----
# CREATE INDEX on a hydrated table that nothing has touched yet

## What happens

`OptimysticModule.hydrateCatalog` registers each persisted table's `TableSchema` with the engine but creates no `OptimysticVirtualTable` instance. Instances are created lazily, by `connect` → `resolveConnectedTable`, the first time a statement uses the table. `OptimysticModule.createIndex` only looks the instance up (`this.tables.get(tableKey)`) and throws when none is cached:

```
Optimystic table 't0' not found in schema 'main'. Cannot create index.
```

Verified: new `Database`, register the plugin, `hydrate`, then `declare schema main { table t0 {…} index t0_by_name on t0 (name) } apply schema main;` where `t0` is already persisted without the index. The migration plan is a lone `CREATE INDEX`, and the apply fails with the error above. Seen while writing `schema-batch.spec.ts`: that case's corrected re-apply now runs from a Database that has not hydrated (whose plan re-declares the table and then creates the index) instead of from the hydrated one.

A plain `create index` on such a table goes through the same hook, so it should fail the same way (inferred from the code, not run).

This is the ordinary "open the app, hydrate, apply the new schema" flow whenever the new schema adds an index to an existing table.

## Expected

`CREATE INDEX` works on any table the engine lists, whether or not an earlier statement touched it: `createIndex` resolves the instance the way `connect` does before calling `addIndex`.

## Notes for the fix

- `destroy` already copes with an untouched hydrated table: `schema-batch.spec.ts` re-applies a DROP from one. Its resolution is the model to follow.
- `resolveConnectedTable` initializes the table and may re-persist its schema. Inside an `APPLY SCHEMA` batch, that write lands outside the per-statement checkpoint (see the NOTE on `resolveConnectedTable`). Resolving inside `underBatchCheckpoint` keeps it covered.
- Once fixed, point that `schema-batch.spec.ts` case back at the hydrated Database (`stale.db`), drop its workaround comment, and add a direct regression case for both entry points (`apply schema` and plain `create index`).
