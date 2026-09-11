description: After a process loads its tables from storage, adding an index to a table that no earlier statement has used fails with "table not found … Cannot create index", both through `apply schema` and through a plain `create index`. The index hook should find or load the table the same way a query does.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (OptimysticModule.createIndex ~L3925; resolveConnectedTable ~L3802 and its NOTE; instantiateTable ~L3678; underBatchCheckpoint ~L3605; destroy/instantiateForTeardown ~L4268 for comparison), packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (case "a deferred index tree that fails to land …" ~L669-707, its workaround comment at ~L691-694)
repro: verified
----
# CREATE INDEX on a hydrated table that nothing has touched yet

## The bug

`OptimysticModule.hydrateCatalog` registers each persisted table's `TableSchema` with the Quereus engine, but creates no `OptimysticVirtualTable` instance. Instances are created lazily: `connect` → `resolveConnectedTable` builds one the first time a statement uses the table. `OptimysticModule.createIndex` only looks in the instance cache (`this.tables.get(tableKey)`) and throws when nothing is there:

```
Optimystic table 't0' not found in schema 'main'. Cannot create index.
```

This is the ordinary "open the app, hydrate, apply the new schema" flow whenever the new schema adds an index to an existing table.

## Reproduction (run during fix, verified)

I seeded storage with a populated `t0` (`id integer primary key, name text`) from one `Database`, then opened a second `Database` over the same storage, registered the plugin, called `plugin.hydrate(db)`, and then ran either:

- `declare schema main { table t0 {…} index t0_by_name on t0 (name) } apply schema main;`: the migration plan is a lone CREATE INDEX, and it fails with the error above, **or**
- `create index t0_by_name on t0 (name)`: same failure (wrapped by the engine as `createIndex failed for index 't0_by_name' on table 't0': …`).

Both reproduced, using the `local` transactor over one `MemoryRawStorage` (the harness pattern in `schema-batch.spec.ts`).

## Root cause and fix (hypothesis validated)

The one site: `OptimysticModule.createIndex`'s cache-only lookup. Fix: when the instance is not cached, build it the way `connect` does, and initialize it **inside** the per-statement batch checkpoint.

- **Resolve**: `this.tables.get(tableKey) ?? await this.instantiateTable(db, db.schemaManager.findTable(tableName, schemaName))`. If `findTable` returns nothing, keep today's "not found … Cannot create index" error.
- **Initialize inside `underBatchCheckpoint`**: run `table.initialize()`, then `table.ensureConnectionRegistered()` (the live-path pair `resolveConnectedTable` uses), then `table.addIndex(indexSchema, deferFlush)`, all in the one checkpointed closure. On a first touch, `initialize` may re-persist the table's record (when the persisted shape differs from the hydrated one). Inside `APPLY SCHEMA`, that write must be withdrawn if the statement throws, which is what the checkpoint does. `addIndex` already calls `initialize()` itself when needed; the explicit call just makes the order and connection registration match `connect`.
- **Why using the engine's catalog entry is safe**: Quereus's `SchemaManager.createIndex` (`@quereus/quereus` `dist/src/schema/manager.js` ~L2107-2123) calls the module hook **before** it appends the new index to the table schema. So `findTable` at hook time returns the pre-index shape, and initializing from it cannot persist the new index early (before its tree is built).
- **Suggested shape**: pull the lookup-or-instantiate half of `resolveConnectedTable` (everything before its initialize calls) into a small private helper, and use it from both `resolveConnectedTable` and `createIndex`, so the two cannot drift. `destroy` intentionally stays different: it builds an **un**initialized instance via `instantiateForTeardown`, because initializing a table on its way out would re-persist the record being deleted.
- **Failure behaviour**: if `initialize` throws on the uncached path, the new instance stays cached but uninitialized, exactly as when `connect` fails. The next touch retries (`initialize` does not memoize a rejection). That is acceptable; no cleanup needed.
- **Update the NOTE on `resolveConnectedTable`**: it says the checkpoint "wraps create, createIndex and destroy only". Keep it accurate: createIndex's first-touch initialize now runs under the checkpoint, while plain connects still do not.

I validated this during the fix stage with a throwaway patch of exactly this shape: both reproductions passed, and `schema-batch.spec.ts` plus `catalog-hydration.spec.ts` stayed green (34 passing). I then reverted the patch; the source is unchanged at HEAD.

## Tests

- **`schema-batch.spec.ts`, "a deferred index tree that fails to land cancels the catalog commit; …"** (~L691-706): run the corrected re-apply from the hydrated `stale.db` again, not from the fresh un-hydrated `clean` Database, and delete the workaround comment that names this ticket. `stale.db` still needs `pragma default_vtab_module='optimystic'` first (see the ~L529 pattern). With `stale.db` hydrated to `{ tables: 1, indexes: 0 }`, its plan is the lone CREATE INDEX, which is exactly this bug's path.
- **New direct regression cases**, one for each entry point (`apply schema`, and plain `create index`): seed a populated `t0` from one Database; open a second, hydrated Database; add the index there without touching `t0` first. Assert that a `name = …` query returns the right rows **through** the index (`queryWithSeeks(...).seeks` includes `t0_by_name`), and that `h.reopen()` hydrates `{ tables: 1, indexes: 1 }` and answers the same query through the index. For the `apply schema` case, also assert that the deferred tree lands before the catalog sync (`h.trail.events` ordering, as in the "POPULATED table" case), since this path runs inside the batch.
- Tests import from `../dist`, so rebuild (`npx tsup` in the package) before running mocha. Package test command (from `packages/quereus-plugin-optimystic`): `npm test`, or for a focused run `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/schema-batch.spec.ts test/catalog-hydration.spec.ts --reporter dot --exit`.

## TODO

- Extract the lookup-or-instantiate helper from `resolveConnectedTable`; use it in `createIndex` (keep the not-found error when the engine has no entry either).
- In `createIndex`, run `initialize` → `ensureConnectionRegistered` → `addIndex` inside the `underBatchCheckpoint` closure.
- Update the NOTE on `resolveConnectedTable` (and the `createIndex` doc comment) to describe the new resolution.
- Point the `schema-batch.spec.ts` "fails to land" case's re-apply back at `stale.db`; remove its workaround comment.
- Add the two regression cases (apply schema, plain create index) on an untouched hydrated populated table.
- Rebuild, run `npm test` in the plugin package, and run `npx tsc --noEmit` (typecheck).
