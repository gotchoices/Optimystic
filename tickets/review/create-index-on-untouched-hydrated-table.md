description: After a process loads its tables from storage, adding an index to a table that nothing had used yet used to fail with "table not found … Cannot create index". The index hook now finds or loads the table the same way a query does; this needs a review pass.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (OptimysticModule.createIndex, new private lookupOrInstantiate, resolveConnectedTable and its NOTE, instantiateTable comment), packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (describe "an index added to a hydrated table that no statement has touched yet"; case "a deferred index tree that fails to land …")
----
# CREATE INDEX on a hydrated table that nothing has touched yet: review handoff

## What was wrong

`hydrateCatalog` registers each persisted table's `TableSchema` with the Quereus engine but creates no `OptimysticVirtualTable` instance. Instances are built lazily on the first `connect`. `createIndex` looked only in the instance cache (`this.tables`) and threw `Optimystic table 't0' not found in schema 'main'. Cannot create index.` when nothing was there. That broke the ordinary "open the app, hydrate, apply the new schema" flow whenever the new schema only added an index (the migration plan is then a lone CREATE INDEX), and it broke a plain `create index` the same way.

## What changed

- **New private `lookupOrInstantiate(db, schemaName, tableName, tableSchema?)`**. It returns `{ table, fresh }`: the cached instance (`fresh: false`), or a new **uninitialized** instance built from `tableSchema` or else `db.schemaManager.findTable(...)` (`fresh: true`). It returns `undefined` when neither the cache nor the engine's catalog knows the table. This is the lookup-or-instantiate half that used to be inline in `resolveConnectedTable`.
- **`resolveConnectedTable`** now uses the helper. Behaviour is unchanged: a cached table is initialized (live or committed-read); a fresh one is initialized and, on the live path only, gets `ensureConnectionRegistered()`.
- **`createIndex`** resolves through the helper; the "not found … Cannot create index" error is kept for the `undefined` case. Inside the existing `underBatchCheckpoint` closure, a **fresh** instance runs `initialize()` then `ensureConnectionRegistered()` (connect's live-path pair) before `addIndex`. A cached instance goes straight to `addIndex`, as before (it initializes itself when needed).
- Doc comments: `createIndex` explains why initializing from the engine's catalog entry is safe (Quereus's `SchemaManager.createIndex` calls the module hook **before** appending the new index to the table schema, so the first-touch initialize sees the pre-index shape and cannot persist the index before its tree is built). The NOTE on `resolveConnectedTable` now says createIndex's first-touch initialize runs under the checkpoint while plain connects still do not. `instantiateTable`'s comment lists createIndex among the callers that initialize.
- `destroy` is intentionally untouched. It still builds an uninitialized instance via `instantiateForTeardown`, because initializing a table on its way out would re-persist the record being deleted.

## Tests

- `schema-batch.spec.ts`, "a deferred index tree that fails to land …": the corrected re-apply now runs from the hydrated `stale.db` (plan: a lone CREATE INDEX). The workaround that used a fresh un-hydrated `Database`, and its comment naming this ticket, are gone.
- New describe block "an index added to a hydrated table that no statement has touched yet", inside "index trees: …". It seeds a populated `t0` (rows 1 alice, 2 bob, 3 bob) from one Database, then opens a second Database whose catalog tree is instrumented onto the case's trail and hydrates it (asserts `{ tables: 1, indexes: 0 }`):
  - **apply schema**: `declaration(1, ['t0'])` gives exactly one catalog commit and one commit carrying `/index/t0_by_name`, and the index commit comes before `catalog-sync` in `h.trail.events`.
  - **plain CREATE INDEX**: `create index t0_by_name on t0 (name)`.
  - Both then assert that `name = 'bob'` returns ids [2, 3] **through** the index (`seeks` includes `t0_by_name`) in that Database, and that `h.reopen()` hydrates `{ tables: 1, indexes: 1 }` and answers the same query through the index.
- **Red check done**: I temporarily put the old cache-only lookup back, rebuilt, and ran these three cases. All three failed with the ticket's exact error (`… not found in schema 'main'. Cannot create index.`). I then restored the fix and rebuilt.
- Results with the fix: `npx tsc --noEmit` is clean. `npm test` in `packages/quereus-plugin-optimystic` gives 799 passing, 13 pending, and the smoke check passes (`smoke ok quereus@4.19.0`). The focused `schema-batch.spec.ts` + `catalog-hydration.spec.ts` run is green.
- To reproduce: tests import from `../dist`, so run `npx tsup` in the package first, then `npm test`. For a focused run: `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/schema-batch.spec.ts --reporter spec --grep "touched yet|cancels the catalog commit" --exit`.

## Known gaps: please probe these

- **Checkpoint withdrawal of a first-touch re-persist is not tested.** The reason for initializing inside `underBatchCheckpoint` is that on a first touch, `initialize` may re-persist the table's record (when the persisted shape differs from the hydrated one). If the CREATE INDEX then throws inside `APPLY SCHEMA`, that write should be withdrawn. I found no cheap way to make the persisted and hydrated shapes differ in the harness, so this arm is reasoned, not exercised.
- **A failed first-touch initialize in `createIndex` is not tested.** Intended behaviour: the instance stays cached uninitialized and the next touch retries (`initialize` does not memoize a rejection), the same as a failed `connect`.
- **Session mode** (TransactionCoordinator) is not covered for the untouched-hydrated path; only the legacy bridge is.
- **Connection registration keys on `fresh`, not on whether a connection exists.** This mirrors `resolveConnectedTable`: a cached instance never gets `ensureConnectionRegistered` from connect or createIndex. So an instance that was first created by the committed-read connect path (which deliberately registers nothing), or left cached by a failed first touch, stays unregistered on later live touches. That behaviour predates this ticket and I did not change it. A reviewer may want to judge whether it matters, but it is outside this fix's scope.
