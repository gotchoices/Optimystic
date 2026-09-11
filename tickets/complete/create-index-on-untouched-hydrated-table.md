description: After a process loaded its tables from storage, adding an index to a table nothing had used yet failed with "table not found … Cannot create index". The index hook now finds or loads the table the same way a query does, and a failed first attempt can simply be retried.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (OptimysticModule.createIndex, lookupOrInstantiate, resolveConnectedTable), packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (describe "an index added to a hydrated table that no statement has touched yet")
----
# CREATE INDEX on a hydrated table that nothing has touched yet

## What was wrong

`hydrateCatalog` registers each persisted table's schema with the Quereus engine but builds no `OptimysticVirtualTable` instance; instances are created lazily on first `connect`. `createIndex` only looked in the instance cache, so a lone CREATE INDEX (a plain `create index`, or an `apply schema` whose only change is a new index) against a hydrated-but-untouched table threw `Optimystic table 't0' not found in schema 'main'. Cannot create index.`

## What changed

- New private `OptimysticModule.lookupOrInstantiate` returns the cached instance (`fresh: false`) or a new uninitialized one built from the engine's catalog entry (`fresh: true`), or `undefined` if neither knows the table. `resolveConnectedTable` now uses it (behaviour unchanged).
- `createIndex` resolves through it. A fresh instance runs `initialize()` + `ensureConnectionRegistered()` inside the statement's batch checkpoint, then `addIndex`. The "Cannot create index" error remains for truly unknown tables.
- `destroy` deliberately still uses `instantiateForTeardown` (initializing a table being dropped would re-persist its record).

## Review findings

Checked the implement diff (`f8b27aab`) first, then the handoff.

- **Correctness of the "pre-index shape" claim:** verified. In Quereus `dist/src/schema/manager.js`, `SchemaManager.createIndex` calls the module hook (line 2114) before `appendIndexToTableSchema` (line 2121). So the schema a first-touch initialize sees does not yet list the new index, and it cannot persist the index before the index tree is built. If the hook throws, the engine's catalog is left unchanged, so a retry plans the same statement.
- **Failed first-touch initialize (handoff gap):** now covered. I added the test "a first touch that fails to initialize leaves nothing stuck: the retried CREATE INDEX builds it". It fails every storage read during the first `create index` on the hydrated, untouched table, confirms nothing reached storage (`{ tables: 1, indexes: 0 }` on reopen), clears the failure, retries, and asserts the index is complete and used for seeks in both this Database and a freshly hydrated one. This works because `initialize()` does not memoize a rejection.
- **Connection registration keyed on `fresh` (handoff gap):** not a defect. A cached instance that was never registered (made by the committed-read connect path, or left behind by a failed first touch) registers itself on its first live read (`runQuery`, `ensureConnectionRegistered` at ~line 1077) and on its write paths (~lines 2249, 3167). `addIndex` writes through the bridge's current transactor, not the connection. No action.
- **Checkpoint withdrawal of a first-touch re-persist (handoff gap):** still not exercised directly. The mechanism is the same `underBatchCheckpoint` restore that is already covered by "a create refused AFTER its schema reached the overlay is rolled back by the checkpoint". The harness has no cheap way to make the persisted and hydrated shapes differ, so I didn't file a ticket. The reasoning is recorded in `createIndex`'s doc comment.
- **Session mode for the untouched-hydrated path (handoff gap):** not added. Once initialized, the path is identical to the cached-table `addIndex` path, which "session mode: an index added to a POPULATED table …" already covers. I declined this as low value.
- **DRY/modularity:** the lookup-or-instantiate logic now lives in one helper shared by connect and createIndex, which is good. `createIndex` computes `tableKey` and then the helper computes it again, a trivial duplicate I left alone. Keeping `destroy` off the helper is deliberate and documented on both sides.
- **Error handling / resource cleanup:** a failed first touch leaves an uninitialized instance in the cache. That matches the existing failed-connect behaviour and is now tested. Unlike `create()`, it does not need eviction, because there is no "already exists" check to trip on a retry.
- **Docs:** the package README and `docs/` never described the limitation (grepped for "Cannot create index", "untouched", "hydrated table"; the only README hit is the unrelated index-adoption guard message). The `resolveConnectedTable` NOTE and the `instantiateTable` comment were updated in the implement pass and are accurate.
- **Source hygiene:** `optimystic-module.ts` is about 4,360 lines (read to EOF at line 4361). This change added about 20 net lines to an already very large file. I didn't file anything; it's pre-existing size debt that this change doesn't make materially worse.
- **Tripwires:** none new.
- **Validation:** `npx tsc --noEmit` clean. `npx tsup` then `npm test` in `packages/quereus-plugin-optimystic` gave 799 passing, 13 pending, smoke ok (run before adding the new case). `test/schema-batch.spec.ts` run in full after adding it gave 30 passing.
