description: Review the fix that skips redundant schema rewrites in `OptimysticVirtualTable.doInitialize()` when the in-memory DDL matches the persisted schema, and the SchemaManager-sharing change that lets hydrate's warmup populate the cache that per-table init paths consult.
prereq: none
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
  - packages/quereus-plugin-optimystic/test/schema-support.spec.ts
  - packages/quereus-plugin-optimystic/test/schema-migration.spec.ts
  - packages/quereus-plugin-optimystic/test/distributed-transaction-validation.spec.ts
----

## What landed

Two related changes in commit `99f59f1`:

1. **Schema-write short-circuit in `doInitialize`** (`optimystic-module.ts:147-238`).
   When `hasLocalColumns` and a persisted schema exists, build a candidate
   `StoredTableSchema` from the local DDL (via the newly-public
   `SchemaManager.tableSchemaToStored`) and compare it structurally to the
   persisted one with a `stableStringify`-based equality check. On match, adopt
   the persisted schema directly — skipping `storeSchema` and the post-write
   read-back. Any structural divergence falls through to the existing
   write-then-read-back path, preserving "local DDL wins" semantics.

2. **Shared `SchemaManager` across hydrate + table init** (`optimystic-module.ts:772-811`).
   `OptimysticModule` now caches `SchemaManager` instances in a `Map` keyed
   by a fingerprint of the schema-tree-affecting options (`transactor`,
   `keyNetwork`, `networkName`, `port`, `rawStorageFactory`-present).
   `instantiateTable` and `hydrateCatalog` both route through `createSchemaManager`,
   so `hydrate`'s `listTables`/`getSchema` warmup populates the same in-memory
   `schemaCache` that each table's later `doInitialize` will consult.

`SchemaManager.tableSchemaToStored` was promoted from `private` to public to
support (1).

## Validation done

- `./node_modules/.bin/tsc --noEmit` — clean (exit 0).
- `mocha test/catalog-hydration.spec.ts test/schema-support.spec.ts test/schema-migration.spec.ts` — 34 passing.
- `mocha test/index-support.spec.ts test/row-codec.spec.ts test/quereus-engine.spec.ts` — 71 passing.
- Combined 105 passing assertions matching the implementation status.

## Gaps the reviewer should treat as starting points

- **No new tests** were added for the short-circuit path itself. The reviewer
  should consider adding a spec that asserts: (a) cold `doInitialize` with
  matching persisted schema makes zero `storeSchema` calls, and (b) `doInitialize`
  with a column-add / index-add / vtabArgs-change still fires the write. The
  existing schema-migration suite covers correctness of write-on-divergence
  semantics; what's missing is a direct probe of the no-write path.
- **Distributed-transaction-validation suite was not run** (it's a libp2p
  integration suite). The reasoning that `should demonstrate local schema
  enforcement` still passes is in the original ticket's TODO list — Node 2's
  smaller-column DDL still differs structurally from Node 1's 3-col persisted
  schema, so the short-circuit doesn't fire. Worth confirming by reading the
  diff against that test, or running the suite if the reviewer has the rigging.
- **`stableStringify` on `vtabArgs`**: `vtabArgs` is `Record<string, any>`. If
  a value is `undefined` (which `JSON.stringify` drops anyway) or contains
  non-plain objects, the sorted-output is still stable but worth a sanity
  check — confirm that two equivalent vtabArgs always stringify identically.
  If not, consider excluding `vtabArgs` from the comparison.
- **Index-only schema changes**: walk through `tableSchemaToStored` to confirm
  added/dropped indexes, column reorders inside an index entry, and renamed
  indexes all propagate into the stringified form so the write path fires.
- **Fingerprint divergence**: if `hydrateCatalog` is invoked with a config that
  produces a *different* fingerprint than what per-table `parseTableSchema`
  derives (e.g. host calls `hydrate(db, {})` with no defaults while tables
  override via `USING optimystic(...)`), the cache-sharing win is silently
  lost. Not a correctness bug; flag if you want a warning or doc note.
- **`SchemaManager.getSchema` `await tree.update()`** (`schema-manager.ts:103`)
  remains in the hot path. The parent ticket's follow-up suggested gating it on
  a session-flag. Not done here because the cache-share already hits the fast
  path. If the reviewer finds residual cost in the hot path, this is the next
  lever.

## Use cases to cover

- **Warm restart, unchanged DDL** — `hydrate(db); apply schema X;` on an
  existing DB. Expect zero schema-tree writes during `executeSchema`.
- **Warm restart, additive DDL** — host adds a column or index between runs.
  Expect the write path to fire for changed tables only.
- **Cold start, no persisted state** — first-ever `CREATE TABLE`. Expect normal
  store-then-read-back path (no persisted schema to match against).
- **Multi-node "local DDL wins"** — see `distributed-transaction-validation
  > should demonstrate local schema enforcement`. Node 2's local 2-col DDL
  must override Node 1's persisted 3-col schema. Short-circuit must not fire.

## References

- Implementation commit: `99f59f1 ticket(fix): hydrated-vtab-doinitialize-redundant-schema-write`.
- Parent: `tickets/complete/quereus-plugin-skips-catalog-hydration-on-startup.md`
  — the deferred follow-up at lines 102–110 is exactly this change.
- Related backlog: `tickets/backlog/6.5-schema-versioning.md` — a stable schema
  hash is the same primitive used here; that ticket can lift
  `stableStringify`/`schemasEqual` if it wants a single source of truth.
