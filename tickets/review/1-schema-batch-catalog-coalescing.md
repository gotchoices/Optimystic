description: When an app applies its whole database schema at once, our plugin used to save the table catalog separately after every table and index and re-read the growing catalog each time. It now holds the catalog changes in memory for the whole apply and saves them in one commit at the end, and catalog reads no longer grow with the number of tables. Review the in-memory overlay, its per-statement rollback, and the deliberate choice to commit what landed even when the apply fails part-way.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (NEW — CatalogBatch: the overlay, one committed tree opened once, checkpoint/restore, the one-commit flush with re-merge)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (beginBatch / commitBatch / checkpointBatch / restoreBatch; every catalog read and write routes through the batch while one is open; storedIndexesToIndexSchemas extracted from storedToTableSchema)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (OptimysticModule.beginSchemaBatch / endSchemaBatch / underBatchCheckpoint; create, createIndex, destroy wrapped; OptimysticVirtualTable.markSchemaUnpersisted and catalogManager)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (NEW — 16 cases, module level and SchemaManager unit level)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (re-baselined; gate 5 converted to cross-scale non-growth; gate 6 added; header prose updated)
  - docs/transactions.md (new section "APPLY SCHEMA coalesces catalog writes")
difficulty: hard
----

# Review: catalog writes and reads coalesced across one `APPLY SCHEMA`

## What landed

Quereus fires `beginSchemaBatch` before the first migration statement of an `apply schema` and `endSchemaBatch` once afterwards, inside its execution lock, only when the plan is non-empty. The plugin now implements both. Between them, each `SchemaManager` holds a `CatalogBatch`: writes go into an insertion-ordered overlay keyed by table name; reads (`getSchema`, `getSchemaFresh`, `getDroppedSchemaRecord`, `findRecordForUri`, and the write paths' own re-reads) are answered from the overlay first and otherwise from one committed catalog tree that is opened and refreshed once per batch. `findRecordForUri` (the storage-adoption guard's walk) builds a name-keyed map of the committed catalog in one walk on first use and overlays the pending entries by name per call. At `endSchemaBatch` each manager's batch re-merges every pending live record with the latest committed live record for that name (`mergePersistedSchemas`, the same union the unbatched write does at every write) and stages plus syncs the whole set in one commit. A manager with nothing pending does no I/O; the catalog is created only at that commit and only when something is pending.

Each `create`, `createIndex` and `destroy` runs under a per-statement checkpoint: a throw restores the overlay to what it was before the statement, so a refused `CREATE TABLE` (guard, or a failure later in `doInitialize` after the schema was already staged) or a failed `CREATE INDEX` leaves no trace, while everything that landed before it still commits at the end. The batch commits on error too, on purpose: Quereus keeps the statements that landed when an apply fails part-way, so discarding the overlay would leave tables in the engine's catalog with no persisted record. The reasoning is in a `NOTE:` on `endSchemaBatch` citing the Quereus atomicity spec.

If the end-of-batch commit itself fails, every table that created or altered its schema through that manager is marked unpersisted; its next touch re-runs `doInitialize`, finds no record, and writes the schema. Before writing, the vtab refreshes its own `tableSchema.indexes` from what its `IndexManager` maintains, because Quereus's `CREATE INDEX` replaces the engine's `TableSchema` object rather than mutating the copy the vtab holds. The ticket's assumption that `tableSchema.indexes` already carried them was wrong; the end-commit-failure test asserts the index survives the recovery.

## Before and after (measured, `cold-apply-cost.spec.ts`, 1-node mesh through the coordinated commit path)

| scale | objects | driver calls / object | commits (absolute) | findCluster / commit | transactor gets / object | round trips / object |
|---|---|---|---|---|---|---|
| small, before | 22 (9 T + 13 I) | 32.7 | 35 (T + 2·I) | 2.40 | 40.9 (899) | not counted then; gets + commits were 934 |
| small, after | 22 | 17.6 | 14 (1 + I) | 3.00 | 2.5 (54) | 4.1 (91) |
| large, before | 67 (54 T + 13 I) | 23.5 | 80 | 2.23 | 55.0 (3683) | not counted then; gets + commits were 3763 |
| large, after | 67 | 6.4 | 14 | 3.00 | 1.5 (99) | 2.7 (181) |

Gets per object now fall with scale (2.5 → 1.5), so gate 5 became a cross-scale "must not grow" assertion plus a per-scale ceiling. Gate 6 (every `ITransactor` call) was added with the same two-part shape. Gate 4's ratio rose to exactly 3.00 while its absolute count halved and quartered: the removed per-DDL catalog re-commits cost about two cohort lookups each, the remaining invented index-tree flushes three; the ceiling was moved to 3.6 and the comment says why. All thresholds carry the file's 20% headroom over the new figures.

The remaining 13 commits per apply are the invented index-tree flushes; ticket `schema-batch-index-tree-flush-deferral` removes them.

## How to validate

```
yarn workspace @optimystic/quereus-plugin-optimystic build
cd packages/quereus-plugin-optimystic
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/schema-batch.spec.ts" --reporter spec --exit
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cold-apply-cost.spec.ts" --reporter spec --exit
yarn typecheck
yarn workspace @optimystic/quereus-plugin-optimystic test    # 785 passing, 13 pending, smoke ok (run 2026-09-10)
yarn lint:docs                                               # from the repo root
```

## Test map (`schema-batch.spec.ts`)

- Hooks fire once per apply with DDL, not on the no-op re-apply; the re-apply makes zero transactor calls.
- Cold apply of 5 empty tables: 1 transactor commit, 1 catalog commit, at most 2 catalog opens; fresh `Database` hydrates all 5; DML works on both.
- Tables plus indexes in one apply: 1 catalog commit, 3 total commits (catalog + 2 index trees); fresh `Database` hydrates 2 tables and 2 indexes and an indexed lookup works. This is also the in-batch read of a pending record (`CREATE INDEX` reads the table it was created with a statement earlier).
- Warm apply after hydrate with one new table: 1 catalog open, 1 catalog commit.
- Direct DDL outside apply: `create table` = 1 commit, `create index` = 2 more (catalog + tree), hooks never fire.
- Apply with only memory-module tables: hooks fire, zero transactor calls, zero catalog opens.
- Statement refused mid-loop (adoption guard on `b` after `a` landed): `endSchemaBatch` receives the loop error, exactly one commit, fresh `Database` has `a` not `b`, corrected re-apply adopts the surviving row.
- `create` refused after its schema reached the overlay (unique-enforcement tree open fails after `storeStoredSchema`): only the other table persists; heal and re-apply succeeds and the constraint enforces.
- `CREATE INDEX` fails inside the batch (index-tree flush refused): table commits without the index; re-apply adds it.
- Drop and create over the same URI in one apply: the guard sees the pending gravestone and refuses; the drop still lands; a matching re-declare adopts the rows.
- End-of-batch commit fails: apply rejects with no loop error; nothing reached the catalog; the next `insert` re-persists the table including its index; a fresh `Database` hydrates 1 table, 1 index.
- Two transactor configurations in one apply: 2 managers, 2 catalog commits, the shared transactor saw 1.
- Double `beginSchemaBatch` throws; an empty batch commits nothing.
- Unit level against two `SchemaManager`s over shared storage: a sibling's unbatched write during the batch is unioned in at commit, and the batched manager's cache is seeded with the union; an empty batch does zero I/O and a batch over an absent catalog creates it once for two tables; a checkpoint restore withdraws a gravestone and a create staged after it.

## Known gaps and things worth probing

- Catalog writes made by `doInitialize` on paths other than `create` are not checkpoint-wrapped: a `connect` during the apply (an `ALTER TABLE` reaching the vtab, or any other statement that first-touches a table mid-apply) can stage a schema write that stays in the overlay if that statement later throws. Today that write would already have been committed before the throw, so this is not a regression, but it is a place where "leaves no catalog trace" does not hold. Nothing in the plugin implements the alter/rename hooks, so I could not construct the case.
- The pre-batch round-trip total (gate 6) was never measured; only gets and commits are known for the before column. I did not build the previous revision to recover it.
- Session mode is exercised by the existing suite (green) but no batch case runs in session mode; the catalog tree is not registered with the bridge in either mode, so the batched `sync` is the same direct sync `replace` was. An apply inside an explicit `begin … commit` is likewise untested here.
- A concurrent committed read (`readCommittedSnapshot`) during a batch is reasoned about in a `NOTE:` at the `getSchema` routing site, not tested.
- `endSchemaBatch` throws when no batch is open (a wiring bug rather than a silent no-op). The engine calls it only after a successful begin, so this is unreachable through Quereus; confirm you agree loud is right.
- `CatalogBatch.recordForUri` re-derives the pending overlay per call instead of caching a URI index (the ticket allowed either); it is one map copy per statement, in memory. Recorded as a tripwire `NOTE:` on the method.
- `deleteInBatch` stays open-only: a `DROP TABLE`-only apply on a cold database opens the catalog once (finds it absent) and stages nothing. A table created and dropped in the same apply on a cold database does stage its gravestone, so the commit creates the catalog holding one gravestone, which is what two direct statements produce today.
- Reads through the batch do not consult or fill the per-manager `schemaCache`; the cache is seeded from what the commit wrote. Direct DDL and hydrate keep their cache behaviour byte-for-byte.

## Tripwires and notes recorded in code

- `CatalogBatch.recordForUri`: per-call overlay derivation; cache it if it ever shows in a profile.
- `SchemaManager.catalogEntries`: not routed through the batch because hydrate never runs mid-apply; route it if that changes.
- `SchemaManager.getSchema`: a committed read outside the lock can see a pending record; accepted because the engine's catalog already exposes it.
- `OptimysticModule.endSchemaBatch`: the commit-on-error deviation from the upstream hook doc, with the Quereus spec citation.
- `cold-apply-cost.spec.ts` gate 4: why the findCluster-per-commit ratio rose while the absolute count fell.

## What this does not buy (unchanged from the ticket)

Index-tree flushes (next ticket), seed data (runs after `endSchemaBatch` as DML), work a host does after the apply (the device report of 56 commits for four index-free tables cannot come from the DDL loop, which was 4 commits and is now 1), one cross-collection atomic commit (`feat-cross-collection-atomic-commit`), and session-mode carriage of the catalog tree.
