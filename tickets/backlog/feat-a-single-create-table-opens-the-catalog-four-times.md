description: Creating one table outside a schema application re-opens and re-synchronises the schema catalogue four separate times within that single statement, because the one place that remembers an open catalogue is handed a brand-new empty memory on every call. The recently added batching work already fixed this for whole-schema applications; a standalone CREATE TABLE still pays it.
prereq: feat-schema-batch-hooks-for-apply-schema
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts:3374 (the `getSchemaTree` closure handed to `SchemaManager`)
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts:3385 (`collections: new Map()` — a fresh memo per call, so the cache can never hit)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts:148 (`getCachedCollection` — the only collection memo, and it is transaction-scoped)
  - packages/quereus-plugin-optimystic/src/schema/catalog-batch.ts:94 (`private tree` — the handle memo that already solves this for `APPLY SCHEMA`)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts:600,806,907,1016 (the four call sites that each open the tree)
difficulty: medium
tradeoffs: The cost is a large constant per DDL statement, not a growing one, and it is invisible to the workload anyone has complained about — `APPLY SCHEMA` already avoids it. So this is worth doing for the same reason the batch work was, one level down, but it is not on any reported critical path and should not displace work that is.
----

# One standalone `CREATE TABLE` opens the catalog four times and re-syncs it four times

## Measured

Traced on Node against the same composition `cold-apply-cost.spec.ts` uses. A steady-state standalone `CREATE TABLE` (i.e. any after the first) costs:

| | value |
|---|---|
| `ITransactor.get` calls | **56** |
| transactor calls total | 59 |
| `IRawStorage` reads | 376, over **17 distinct keys — all repeated** |
| raw driver calls (below the read cache) | **17**, zero repeated keys |

Flat, not growing: tables 1 through 13 each measured exactly 56 gets. The read cache absorbs **99.2%** of the storage-seam repetition (376 reads → 3 reaching the driver), which is why this never showed up as a storage problem.

The repetition concentrates on two blocks: 94 `getMetadata` on `optimystic/schema` and 67 on the catalog's log-tail block, within one statement.

## Cause — one site

The 56 gets decompose into **four independent catalog operations, each re-opening the catalog tree and then re-syncing it**: `getSchema` → `readSchemaFromCatalog`, `guardStorageAdoption` → `getDroppedSchemaRecord`, `guardStorageAdoption` → `findRecordForUri`, and `storeStoredSchema` → `requireSchemaTree`. Each open costs ~4 gets; each `tree.update()` sync costs 8–13 more, against the same two blocks.

They cannot share a handle because of `optimystic-module.ts:3385`:

```ts
const txnState = transactor
  ? { transactor, isActive: true, collections: new Map(), stampId: '' }
  : undefined;
```

`CollectionFactory.getCachedCollection` is the only collection memo and it reads `txnState.collections`. A **fresh `Map` per call** — or `undefined` outright when no transactor is threaded, which is the common DDL case — means the memo can never hit for the catalog tree. There is no `SchemaManager`-level handle cache and no per-statement one.

## Why it is worth fixing even though `APPLY SCHEMA` is already fixed

`CatalogBatch` (`catalog-batch.ts:94`, `:229`) memoises exactly this handle and serves reads from one tree plus an in-memory overlay. That is why an apply of 14 tables costs 20 gets total — **1.4 per object** — against 56 per object for the same tables created standalone.

So the mechanism is understood and the remedy already exists one level up. This ticket is that remedy hoisted to statement scope: a `SchemaManager`-scoped handle cache, or a per-statement `txnState` that actually persists across the four operations.

**Estimated effect — INFERRED, not measured:** collapsing four opens and four syncs into one each should take a standalone `CREATE TABLE` from ~56 gets to roughly 14. Nobody has built it.

## Why this is `backlog/` and not in the pipeline

The workload every outside report concerns is `APPLY SCHEMA`, which does not take this path. No reported problem is on it. It is real, it is measured, and it is the kind of constant that will matter once someone runs migrations statement-by-statement — but it should not displace the absent-read consult or the routing-coordinate work, both of which are on paths people are actually blocked on.

`prereq:` is set to the schema-batch work because that work owns `CatalogBatch`, and this should reuse its handle-caching rather than inventing a second mechanism beside it.

## Edge cases

- **Handle lifetime versus transaction lifetime.** A memoised tree handle that outlives the statement would serve stale catalog state to the next one. Scope it explicitly and prove the scope with a test that mutates the catalog between statements.
- **`guardStorageAdoption` reads the catalog to decide whether adoption is safe.** Serving it from a memo populated earlier in the same statement is only sound if nothing between the two could have changed the catalog. Establish that rather than assuming it.
- **The first `CREATE TABLE` differs** (cold catalog: 9 gets, 28 driver calls, 4 opens) from steady state (56 gets, 17 driver calls). Any gate needs both, or it will pin the wrong one.
