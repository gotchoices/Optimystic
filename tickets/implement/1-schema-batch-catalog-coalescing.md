description: When an app applies a whole database schema at once, our plugin currently saves the table catalog separately after every single table and index, and re-reads the growing catalog each time — so a schema of N objects costs N catalog commits and roughly N² catalog reads. Use the database engine's "these schema changes belong together" signal to hold catalog changes in memory for the whole apply and save them in one commit at the end, which is the part of the cost that dominates on phones.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (OptimysticModule: add beginSchemaBatch/endSchemaBatch; create/createIndex/destroy statement checkpoints; OptimysticVirtualTable: re-init hook after a failed batch commit)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (route every catalog read/write through the batch when one is open)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts (NEW — the batch-scoped catalog overlay)
  - packages/quereus-plugin-optimystic/test/schema-batch.spec.ts (NEW — correctness)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (re-baseline gates 2 and 5; add a round-trip gate)
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts (pattern for "fresh Database over the same storage + hydrateCatalog")
  - packages/quereus-plugin-optimystic/node_modules/@quereus/quereus/src/vtab/module.ts:553-577 (the hook contract)
  - packages/quereus-plugin-optimystic/node_modules/@quereus/quereus/src/runtime/emit/schema-declarative.ts:524-610 (how the engine drives the hooks)
  - packages/quereus-plugin-optimystic/node_modules/@quereus/quereus/test/ddl-schema-event-atomicity.spec.ts:303-334 (engine keeps the statements that landed when an apply fails part-way)
  - docs/transactions.md (add a short section — see TODO)
difficulty: hard
----

# Coalesce the plugin's catalog writes and reads across one `APPLY SCHEMA`

## Background — where a cold apply's cost comes from today

Origin: GitHub issue #8. On a desktop the storage read cache hides most of the cost; on React Native devices three app teams measured multi-minute cold applies. Their evidence showed the number of reads is what costs, not the price of each one: halving the cost of each read moved end-to-end time by only 6–16%. This ticket goes after the count.

Quereus (the SQL engine, `@quereus/quereus` 4.19.0) drives `APPLY SCHEMA` as a loop of ordinary DDL statements. It offers two optional module hooks so a storage module can treat that loop as one unit: `beginSchemaBatch(db, schemaName)` before the first migration statement, and `endSchemaBatch(db, schemaName, error?)` exactly once afterwards. Both run inside the engine's execution lock. They fire only when the migration plan is non-empty, so a no-op re-apply calls neither. `OptimysticModule` implements neither hook today.

Traced through the code, a cold apply of T tables and I indexes over empty tables costs:

- **Commits: T + 2·I.** `SchemaManager.storeStoredSchema` ends in `Tree.replace`, which is stage-then-sync, so each CREATE TABLE commits the catalog tree once. Each CREATE INDEX commits the catalog once (`addIndex` → `storeStoredSchema`), and then again when `backfillIndexTrees` → `flushDirtyTrees` syncs the invented index tree. For 9 + 13 that is 9 + 26 = 35, and for 54 + 13 it is 80 (1.19/object). Both match the measured baselines in `cold-apply-cost.spec.ts`. A main table's own tree is *not* committed at create; a created-but-never-written table has no committed header by design (see the NOTE in `OptimysticVirtualTable.doInitialize`).
- **Catalog reads that grow with the catalog.** Every `SchemaManager` call opens a *fresh* catalog tree: outside a transaction the collection factory caches nothing, and the `txnState` the manager builds has a new empty `collections` map each call. Each such tree calls `tree.update()` before its lookup. Worse, every cold CREATE TABLE takes the "no persisted record" arm of `doInitialize`, and that arm runs `guardStorageAdoption` → `SchemaManager.findRecordForUri`, which walks **every catalog entry**. The catalog grows by one entry per create, so total catalog work is quadratic. That is the measured `ITransactor.get` per object of 41 / 55 / 81 at 22 / 67 / 250 objects (gate 5 in `cold-apply-cost.spec.ts`).

On a device every one of those transactor reads and commits is a cohort consult plus a native-bridge crossing, which a read cache can only partly absorb.

## What this ticket builds

A **catalog batch**: while `APPLY SCHEMA` runs, catalog writes collect in an in-memory overlay rather than committing. Catalog reads are served from the overlay plus one catalog tree opened once for the batch. At `endSchemaBatch` the overlay is merged against the latest committed catalog and flushed in **one** catalog commit. Index-tree flushes are *not* in scope here; they are ticket `schema-batch-index-tree-flush-deferral`.

Expected result for a cold apply of empty tables: commits go from T + 2·I to 1 + I (the catalog commit, plus the index-tree flushes the next ticket removes), and catalog reads go from quadratic to linear. The implementer measures the real figures and records them in the spec (see TODO).

### Lifecycle

```
OptimysticModule.beginSchemaBatch(db, schemaName)
  └─ opens a SchemaBatch on the module (no I/O)
       every SchemaManager that exists, or is created while the batch is open, joins it
DDL loop (engine-driven) — each create / createIndex / destroy call:
  ├─ cp = batch.checkpoint()          before the statement's work
  ├─ ...statement runs; catalog reads/writes go through CatalogBatch...
  └─ on throw: batch.restore(cp), rethrow   (the failed statement leaves no catalog trace)
OptimysticModule.endSchemaBatch(db, schemaName, error?)
  └─ for each joined SchemaManager: commit its CatalogBatch (ONE catalog commit each)
       — on success AND on error (see "End semantics")
     then close the batch; on commit failure: mark batch-written tables for re-initialization, throw
```

### Types and interfaces (shape, not signatures to copy blindly)

```ts
// src/schema/catalog-batch.ts
/** Catalog changes held for one APPLY SCHEMA. Owned by one SchemaManager. */
export class CatalogBatch {
  constructor(
    openTree: (transactor?: ITransactor, create?: boolean) => Promise<Tree<string, any> | undefined>,
  );
  /** Committed catalog tree, opened lazily ONCE (open-only; `null` = catalog absent at open). */
  private tree: Tree<string, any> | null | undefined;
  /** The transactor the first caller supplied; reused by the end-of-batch commit. */
  private transactor?: ITransactor;
  /** name → the entry this batch will write: `[name, PersistedTableSchema]` for a live record or
   *  a gravestone, `undefined` for a bare tombstone. Insertion-ordered. */
  private pending: Map<string, [string, PersistedTableSchema] | undefined>;
  /** Built lazily by ONE walk of the committed catalog, then overlaid with `pending`. */
  private uriIndex?: Map<string, { live?: PersistedTableSchema; dropped?: PersistedTableSchema }>;

  readEntry(name: string, transactor?: ITransactor): Promise<unknown | undefined>;   // pending first, then tree.find
  write(name: string, entry: [string, PersistedTableSchema] | undefined): void;      // no I/O
  recordForUri(uri: string, transactor?: ITransactor): Promise<PersistedTableSchema | undefined>;
  checkpoint(): CatalogBatchCheckpoint;          // shallow copy of `pending` (small: one entry per touched table)
  restore(cp: CatalogBatchCheckpoint): void;     // also invalidates or re-derives the uriIndex overlay
  hasWrites(): boolean;
  /** Merge every pending entry with the LATEST committed one and flush once. Returns what was written. */
  commit(): Promise<Map<string, StoredTableSchema | undefined>>;
}
```

`SchemaManager` gets `beginBatch()`, `commitBatch()` (called on both success and error, see below) and a private `batch?: CatalogBatch`. While `batch` is set, each public method routes as follows:

| method | in batch |
|---|---|
| `getSchema` / `getSchemaFresh` / `readSchemaFromCatalog` | `batch.readEntry` → `livePersistedEntry` → `toStoredSchema`. Does **not** populate `schemaCache`; the overlay already answers. |
| `storeStoredSchema` | read the current entry via `batch.readEntry`, then `mergePersistedSchemas(toPersistedSchema(stored), current)` exactly as today, then `batch.write`. Returns the resolved merge, as today. No I/O beyond the first lazy open. |
| `deleteSchema` | build the gravestone from `batch.readEntry` (same rules as today, including the bare-tombstone fallback), then `batch.write`. |
| `getDroppedSchemaRecord` | `batch.readEntry` → `droppedPersistedEntry`. |
| `findRecordForUri` | `batch.recordForUri`: live wins over gravestone, same as today, with pending entries overriding committed ones by name. |
| `listTables` / `catalogEntries` | unchanged (only hydrate uses them, and hydrate is not called inside an apply); leave a NOTE saying so. |

`commit()`: open the tree with `create = true` only when `pending` is non-empty (an apply that touched no optimystic table must do **zero** I/O), then `tree.update()` once. For each pending live record, re-run `mergePersistedSchemas(pendingRecord, latestCommitted)` so an index a sibling node added between the batch's read and now is unioned in, not overwritten. This is the same write-time union guarantee `storeStoredSchema` gives today, and its window is now just the commit. A pending gravestone or tombstone is written as-is. Then one `tree.stage([...all entries])` and one `tree.sync()`. Only after the sync succeeds, seed `schemaCache` with the resolved live records and delete cache entries for dropped names.

`OptimysticModule` gets:

```ts
private schemaBatch?: { managers: Set<SchemaManager>; written: Set<string /* tableKey */> };
async beginSchemaBatch(db: Database, schemaName: string): Promise<void>;
async endSchemaBatch(db: Database, schemaName: string, error?: unknown): Promise<void>;
```

`createSchemaManager` calls `manager.beginBatch()` on a newly created manager when a batch is open, and `beginSchemaBatch` calls it on every existing manager. Tables reach their manager through the constructor, as today. `create`, `createIndex` and `destroy` each wrap their body in a checkpoint/restore over the manager they touch, and record the table key in `written` on success.

### End semantics — commit what landed, even on error (deliberate deviation from the hook docs)

The upstream doc comment says a module "should discard the in-flight overlay" on error. **Do not.** Quereus itself keeps the statements that landed when an apply fails part-way (`ddl-schema-event-atomicity.spec.ts`, "a partially-applied schema keeps the events of the statements that landed": the created table stays in the engine catalog and is usable). Today each of our DDL statements committed on its own, so our catalog matched the engine's. Discarding on error would leave tables in the engine's in-memory catalog, and in `OptimysticModule.tables` as initialized instances, with no persisted record. The next process would not hydrate them, and an `addIndex` on them would find no schema.

So the batch is a **write-coalescing buffer, not a transaction**. The per-statement checkpoint already removes the failed statement's own catalog changes, and `endSchemaBatch` commits the rest whether or not `error` is set. Per-statement atomicity and partial-apply semantics are unchanged from today. Record this with a `NOTE:` at `endSchemaBatch` citing the Quereus spec above.

**End-commit failure.** If the one catalog commit itself fails, throw; the engine rethrows it when there was no loop error and logs and swallows it when there was. The tables created in the batch are then in the engine's catalog and cached initialized in `this.tables`, but unpersisted. Give `OptimysticVirtualTable` a `markSchemaUnpersisted()` that clears `isInitialized`, and call it on every table in `written`. Their next touch then re-runs `doInitialize`, whose declared-columns arm finds no persisted record and writes the schema, including indexes, because `tableSchemaToStored` reads Quereus's `tableSchema.indexes`. Nothing was put in `schemaCache` for them, so no stale cache hit can mask the gap.

### What this does NOT buy — say so in the handoff

- **Index-tree flushes** (I commits) remain until `schema-batch-index-tree-flush-deferral`.
- **Seed data** (`apply schema … with seed`) runs *after* `endSchemaBatch` as ordinary DML, outside the hooks.
- **Work a host does after the apply.** The device report of 56 commits for a four-table, zero-index schema cannot come from the DDL loop, which is 4 commits today. Most of that device cost therefore lies outside what these hooks can reach. This ticket fixes the part of the cost that is ours and measurable here. It should not be reported as the fix for the device symptom.
- **One cross-collection atomic commit.** The catalog and data trees remain separate commits. Genuine all-or-nothing across collections is `feat-cross-collection-atomic-commit` (backlog).
- **Session mode.** In session mode the catalog tree still syncs directly, as it does today; it is not carried by the `TransactionCoordinator`.

## Edge cases & interactions

- **No optimystic DDL in the apply** (the schema's tables belong to another module): begin and end run, no manager joins or writes, and there are **zero** transactor calls. The tree opens lazily, and `commit()` is skipped when `pending` is empty.
- **Cold database, catalog absent at first read**: `tree = null`. Reads fall through to `pending` only, and `commit()` creates the catalog with `create = true`. It must never create the catalog when nothing is pending, which is the same rule as `deleteSchema`'s open-only NOTE.
- **Failed statement mid-loop** (for example, the storage-adoption guard refuses table B after table A landed): B's catalog change is rolled back by the checkpoint, and A is committed at end. `endSchemaBatch` receives `error`. Afterwards a fresh `Database` over the same storage hydrates A and not B, and a corrected re-apply succeeds.
- **`create()` refused after `storeStoredSchema` already wrote to the overlay** (a failure later in `doInitialize`): the checkpoint restore removes the entry. This is the case the checkpoint exists for, so the test must be in exactly this order.
- **Drop and create over the same URI in one apply**: `recordForUri` must see the *pending* gravestone of the dropped table, so the adoption guard still refuses a contradicting re-declare over rows that still exist. Pending entries override committed ones by name, and the uriIndex overlay is keyed by each record's URI, so a restored checkpoint must re-derive or invalidate the overlay.
- **A sibling node writes the catalog during the batch**: the batch reads a catalog that is stale for the length of the apply. That is accepted and matches `getSchema`'s cached-read contract. The end-of-batch `update()` plus re-merge is what protects the sibling's indexes. Test this at unit level against `SchemaManager`: begin a batch on manager A and write table T; add an index to T through an unbatched manager B over the same storage; commit A. T's committed record must carry both index lists.
- **A committed read running concurrently outside the lock** (`readCommittedSnapshot`): it can call `getSchema` on a batched manager and see a pending record. That is acceptable because the engine's in-memory catalog already exposes those tables to the same readers. Add a NOTE at the routing site.
- **Nested or overlapping batches**: impossible under the engine's lock. `beginSchemaBatch` while a batch is open should throw a clear error rather than silently nest.
- **End-commit failure**: covered above. The test uses a transactor wrapper that fails the catalog tree's commit only at end-of-batch time, then asserts that the apply rejects, that a follow-up statement touching a batch-created table re-persists it, and that a fresh `Database` then hydrates it.
- **`schemaName` argument**: the optimystic catalog is plugin-global, not scoped to an engine schema, so it is ignored. Say so in a comment.
- **Multiple SchemaManagers** (tables on different transactor configurations in one apply): each commits its own catalog once, so the commit count is one per manager touched.

## Key tests (write first)

`test/schema-batch.spec.ts`, using the `catalog-hydration.spec.ts` pattern (a shared `rawStorageFactory` or `local` transactor, then a second `Database` plus `hydrateCatalog` to prove durability):

- The hooks fire once per apply that has DDL, and not at all on the idempotent re-apply.
- A cold apply of T empty tables commits the catalog **exactly once**. Count `commit` on a proxied `ITransactor`, as `cold-apply-cost.spec.ts` does, and compare with T commits before this change. Index-free, so ticket 2 does not move the number.
- Durability: tables and indexes created by the batched apply hydrate in a fresh `Database`, and DML against them works.
- The failed-statement, sibling-writer, drop-and-create-over-the-same-URI, no-optimystic-DDL (zero transactor calls) and end-commit-failure cases above.
- Direct DDL outside `apply schema` still commits per statement, exactly as today (`create table` then `create index` with no batch open).

`test/cold-apply-cost.spec.ts`:

- Re-measure all five gates and update `MEASURED` and the thresholds (about 20% headroom, per the file's own rule). Gate 2's commits per object drops to roughly (1 + I)/objects.
- Gate 5 (transactor gets per object): the quadratic catalog walk should be gone. If the measured per-object gets no longer grow from small to large scale, convert gate 5 from per-scale ceilings to a cross-scale "must not grow" assertion like gate 3. If they still grow, keep per-scale ceilings, lower them, and state in the handoff what still grows.
- **Add gate 6, substrate round trips per object: the total of every `ITransactor` method call.** This is the device-relevant figure. Driver calls counted below the read cache (gate 1) cannot see a cache miss that still crosses the native bridge. Assert both a per-scale ceiling and non-growth across scales.
- Update the file-header prose (points 2 and 3) and gate 5's comment, which still points at `tickets/backlog/feat-schema-batch-hooks-for-apply-schema`.

## TODO

- Add `src/schema/catalog-batch.ts` with the `CatalogBatch` shape above.
- Route `SchemaManager`'s catalog methods through `batch` when it is set; add `beginBatch` / `commitBatch`; keep the unbatched paths byte-for-byte unchanged.
- Add `beginSchemaBatch` / `endSchemaBatch` to `OptimysticModule`; join new managers in `createSchemaManager`; add the checkpoint/restore wrappers in `create` / `createIndex` / `destroy`; track `written`.
- Add `OptimysticVirtualTable.markSchemaUnpersisted()` and call it on end-commit failure.
- Add the `NOTE:` at `endSchemaBatch` explaining the commit-on-error deviation and citing the Quereus spec.
- Write `test/schema-batch.spec.ts` covering every case in "Edge cases & interactions".
- Re-baseline `cold-apply-cost.spec.ts`, add gate 6, and fix the stale ticket path in gate 5.
- Add a short `docs/transactions.md` section, "APPLY SCHEMA coalesces catalog writes", covering what is batched, commit-on-error, end-failure recovery and what is not batched.
- Build (`yarn workspace @optimystic/quereus-plugin-optimystic build`; the specs import `../dist/plugin.js`), then run the plugin's full test suite in the foreground.
- In the review handoff, report the before/after commits, gets and round trips at both scales.
