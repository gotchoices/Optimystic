description: Fix shipped — `OptimysticVirtualTable.doInitialize()` short-circuits the schema write when the local DDL matches what's already persisted, and `OptimysticModule` shares a single `SchemaManager` per (transactor, key-network, network-name, port, raw-storage-factory-present) tuple so hydrate's `listTables`/`getSchema` warmup populates the same `schemaCache` consulted by each table's later `doInitialize`.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
----

## Outcome

Implementation commit `99f59f1`. Validation: `tsc --noEmit` clean, 106 mocha
assertions passing across `catalog-hydration`, `schema-support`,
`schema-migration`, `index-support`, `row-codec`, `quereus-engine` suites
(105 from the implement stage + 1 new probe added in review).

## Review findings

### What was checked

- **Implement-stage diff**: Read `git show 99f59f1` end to end against the
  surrounding code before consulting the implementer's handoff.
- **Correctness of the short-circuit (`schemasEqual` + `stableStringify`)**:
  walked the round-trip identity for every field `tableSchemaToStored`
  emits — columns (incl. `logicalType.name` ↔ `getTypeOrDefault`), primary
  key definition, indexes (incl. `undefined`-vs-`[]` handling),
  `vtabModuleName`, `vtabArgs`, `isTemporary`, `estimatedRows`, and
  `defaultValue` (via `serializeExpression`).
- **Local-DDL-wins semantics**: confirmed the multi-node test path
  (`distributed-transaction-validation > should demonstrate local schema
  enforcement`) is preserved — Node 2's 2-col DDL produces a different
  `candidateStored` than Node 1's persisted 3-col schema, so the
  short-circuit cannot fire and the write path takes over.
- **`SchemaManager` cache key (fingerprint)**: walked the inputs against
  both `parseTableSchema` (per-table USING args + plugin defaults) and
  `deriveDefaultOptions` (plugin defaults only) to confirm hydrate and
  per-table init produce the same fingerprint for the default-config case.
- **Lifecycle interactions with the shared SchemaManager**: traced
  `addIndex` (writes through `storeSchema` which updates the same
  `schemaCache`), `destroy` (calls `deleteSchema` which invalidates only
  the one entry), and `connect`/`create` (route through `instantiateTable`
  → `createSchemaManager`).
- **Lint/type/tests**: `tsc --noEmit` and the six mocha suites listed in
  the handoff, plus the new probe spec.

### Findings — minor (fixed in this pass)

- **Missing direct probe for the short-circuit firing**. The implementer
  noted this as a gap. Added
  `test/catalog-hydration.spec.ts > "doInitialize skips storeSchema when
  local DDL matches the persisted schema"`: hydrates session B against
  data created in session A, wraps `storeSchema` on the shared
  SchemaManager instance, runs a SELECT, and asserts zero writes. This is
  the regression guard the handoff called out.

### Findings — observations (no action — premise holds)

- **`stableStringify` round-trip identity**: each field round-trips
  cleanly under the current schema. `columnSchemaToStored.affinity` is set
  to `logicalType.name`, which is uppercase canonical (`INTEGER`, `TEXT`,
  etc.); `getTypeOrDefault` keys upper-case (see
  `node_modules/@quereus/quereus/dist/src/types/registry.js:68`) and
  returns the same instance. `JSON.stringify` consistently drops
  `undefined` properties on both sides. `vtabArgs` values come through
  Quereus's parser as primitive `SqlValue | number` — JSON-roundtrip safe.
- **`vtabArgs` order**: `stableStringify`'s replacer sorts object keys,
  so `{port:0, transactor:'x'}` and `{transactor:'x', port:0}` stringify
  identically. Fine.
- **Local-DDL-wins still wins**: any structural divergence (added column,
  added/dropped index, changed primary-key direction, changed vtabArgs)
  fails `schemasEqual` and falls through to the existing
  store-then-read-back path. The semantics promised at lines 156–163 of
  `optimystic-module.ts` are intact.

### Findings — accepted limitations (documented; no change)

- **Fingerprint divergence between hydrate and per-table init.** If a host
  calls `plugin.hydrate(db)` with one set of defaults and then a table's
  per-table `USING optimystic(networkName='other')` overrides them, the
  fingerprints diverge and the table gets its own SchemaManager — losing
  the cache-share win for that one table. Correctness is unaffected (the
  underlying schema tree URI `tree://optimystic/schema` is the same), only
  the extra tree walk. The implementer flagged this; agreed it's not
  worth a doc/warning right now.
- **Fingerprint does not include `tableOptions.libp2p` or
  `bootstrapNodes`.** In current usage neither `parseTableSchema` nor
  `deriveDefaultOptions` sets a `libp2p` instance, and the
  `bootstrapNodes` field is always `[]`. If either becomes meaningful per
  table later, the fingerprint needs to grow — but adding fields now would
  be speculative.
- **`SchemaManager.getSchema` still calls `await tree.update()` on cache
  miss** (`schema-manager.ts:103`). With the cache-share, the cache hits
  on hydrated tables and the update doesn't run on the hot post-hydrate
  path. So the parent ticket's suggested follow-up (gating `update()` on a
  session flag) loses urgency. Leaving as-is.

### Findings — major

None. No new fix/plan/backlog tickets opened.

### What the review test exercises

`test/catalog-hydration.spec.ts > "doInitialize skips storeSchema when
local DDL matches the persisted schema"`:

1. Session A creates `widgets(id INTEGER PRIMARY KEY, name TEXT NOT
   NULL, price REAL)` and persists its schema.
2. Session B hydrates against the shared transactor + storage; the
   plugin's internal `schemaManagers` map ends up with exactly one entry
   (asserted), populated by hydrate's `listTables`/`getSchema` warmup.
3. The SchemaManager's `storeSchema` is monkey-patched on the instance to
   count calls. A `SELECT` triggers `connect()` → `doInitialize()`.
4. Asserts `storeCalls === 0` — confirming the candidate
   `StoredTableSchema` built from the hydrated `TableSchema` matches the
   persisted bytes and the short-circuit fires.
5. A second SELECT confirms no late writes occur on subsequent queries.

This locks in both the no-write path *and* the cache-share assumption
that made it cheap.

### References

- Implementation commit: `99f59f1 ticket(fix):
  hydrated-vtab-doinitialize-redundant-schema-write`.
- Implement-stage commit: `4203ccf` (review-handoff doc only).
- Parent ticket:
  `tickets/complete/quereus-plugin-skips-catalog-hydration-on-startup.md`
  (the deferred follow-up at lines 102–110 is exactly this change).
- Related backlog: `tickets/backlog/6.5-schema-versioning.md` — a stable
  schema hash is the same primitive used here; that ticket can lift
  `stableStringify`/`schemasEqual` from `optimystic-module.ts` if it
  wants a single source of truth.
