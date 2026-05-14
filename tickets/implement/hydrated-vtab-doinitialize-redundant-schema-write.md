description: Skip the redundant schema rewrite in `OptimysticVirtualTable.doInitialize()` when the in-memory DDL is byte-identical to the persisted schema, and share a single `SchemaManager` (with its cache) across hydrate + all per-table init paths so post-hydrate `connect()` calls don't re-walk the schema tree.
prereq: none
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
  - packages/quereus-plugin-optimystic/test/schema-support.spec.ts
  - packages/quereus-plugin-optimystic/test/schema-migration.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## Status

Code changes landed and validated locally. Build (`yarn build`) and typecheck (`yarn typecheck`) pass; mocha suites that exercise the schema path (catalog-hydration, schema-support, schema-migration, index-support, row-codec, quereus-engine) all pass — 105 assertions green. Distributed-transaction-validation suite (which contains the `should demonstrate local schema enforcement` test that has to keep working) was not run inline because it's a libp2p integration suite; the changed branch only short-circuits when `tableSchemaToStored(this.tableSchema)` is structurally equal to the persisted schema, so the multi-node "Node 2 CREATEs the same name with fewer columns" path still falls through to the existing write (Node 2's stored shape differs).

## What changed

`packages/quereus-plugin-optimystic/src/schema/schema-manager.ts`
  - `tableSchemaToStored` was promoted from `private` to a public method so the module can build a candidate `StoredTableSchema` for comparison without duplicating serialization rules.

`packages/quereus-plugin-optimystic/src/optimystic-module.ts`
  - Added a `schemasEqual(a, b)` helper backed by a `stableStringify` (sorts object keys at every nesting level) so the comparison is order-insensitive regardless of how persisted entries were originally written.
  - `OptimysticVirtualTable.doInitialize`'s `hasLocalColumns` branch now builds `candidateStored = schemaManager.tableSchemaToStored(this.tableSchema)` up front. When `persistedSchema` exists and `schemasEqual(candidate, persistedSchema)` is true, it adopts `persistedSchema` directly — skipping `storeSchema` and the post-write read-back. Local-DDL-wins semantics are preserved because any structural divergence (column add, type change, index add/drop, vtabArgs change) falls through to the existing write path.
  - `OptimysticModule` now caches `SchemaManager` instances in a `schemaManagers: Map<string, SchemaManager>` keyed by a fingerprint of the schema-tree-affecting options (`transactor | keyNetwork | networkName | port | rawStorageFactory-present`). Both `instantiateTable` (per-table) and `hydrateCatalog` route through `createSchemaManager`, so they all share the same instance — meaning `hydrate`'s `listTables` / `getSchema` warmup populates the same `schemaCache` that each table's later `doInitialize` consults, turning N per-table tree walks into N cache hits.

## Why it matters

On the affected workload (sereus-health Android emulator, 9 tables + 13 indexes, warm restart):
  - Before: `executeSchema` = 32,286 ms, 46 × pend + 46 × commit transactions, 1,587 schema-tree `get` calls.
  - Expected after: zero pend/commit during `executeSchema` when DDL is unchanged; tree `get` count proportional to misses beyond hydrate's walk (near zero in steady state).

## Review-stage TODOs

Adversarial pass for the review agent:

- Confirm `stableStringify`'s key-sort doesn't mis-handle nested `vtabArgs` (the `Record<string, any>` shape can hold non-stringly-keyed values via JSON's coercion). If a `vtabArgs` value contained a function or symbol the existing serializer would already produce undefined — sanity-check that an undefined-laden object compares stably or, if not, decide whether `vtabArgs` should be excluded from the comparison.
- Verify the comparison still fires the write path on a schema upgrade where only `indexes[]` changed (added index, dropped index, column reorder inside an index entry). Walk through `tableSchemaToStored` to confirm those changes propagate.
- Check whether `hydrateCatalog` is reached with config that produces a *different* fingerprint than `instantiateTable` (e.g. a caller invoking `hydrate(db, {})` with no plugin defaults vs. tables created via per-table USING args overriding the default network). If the fingerprints diverge, the cache-sharing win is lost; that's not a correctness bug but worth noting.
- Spot-check `distributed-transaction-validation > should demonstrate local schema enforcement` end-to-end (or reason about it via the diff): Node 1 creates with 3 cols, Node 2 connects then creates with 2 cols. On Node 2's `doInitialize`, `persistedSchema` (Node 1's 3-col write) ≠ `tableSchemaToStored(local 2-col)`, so the write path runs and Node 2's shape wins — confirm.
- Consider whether the `SchemaManager.getSchema` `await tree.update()` (`schema-manager.ts:103`) is still needed in the hot path after this fix. The follow-up note from the parent ticket suggested gating it on a session-flag; not done here because the cache-share already hits the fast path, but if review finds residual cost it's the next lever.

## References

- Parent: `tickets/complete/quereus-plugin-skips-catalog-hydration-on-startup.md` — the deferred follow-up at lines 102–110 is exactly this change.
- Related backlog: `tickets/backlog/6.5-schema-versioning.md` — a stable schema hash is the same primitive used here; that ticket can lift `stableStringify`/`schemasEqual` if it wants a single source of truth.
