description: Review the doInitialize fix that stops the short-circuit's fall-through path from clobbering persisted indexes with `indexes: []` when the local CREATE TABLE DDL arrives ahead of its CREATE INDEX siblings.
prereq: none
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
----

## Summary of change

The parent ticket diagnosed that the `doInitialize` short-circuit added in
`hydrated-vtab-doinitialize-redundant-schema-write` compared a DDL-derived
candidate (`indexes: []`) against a persisted schema with indexes, hit
`schemasEqual=false` every time, and fell through to a write that overwrote
the persisted index list with `[]`. Downstream `addIndex()` calls then lost
their dedupe and re-created every index from scratch — restoring the
pre-fix transaction count even though per-transaction throughput had
improved.

The fix mutates `doInitialize` to treat persisted indexes as authoritative
whenever the local candidate has none, on both sides of the
equality check:

- **Comparison**: build a `mergedCandidate` that inherits the persisted
  `indexes` array whenever `candidateStored.indexes.length === 0`. Compare
  the merged form against `persistedSchema`. Now the no-op restart hits
  the short-circuit on every table, including the indexed ones.
- **Write**: when the merged comparison still fails (real column/PK/vtab
  change), pass the merged candidate to `storeStoredSchema(...)` so the
  persisted indexes survive the local-DDL-wins overwrite. The local DDL
  retains its authority over columns; `addIndex()` retains its authority
  over the index set.

To keep `SchemaManager`'s storage interface honest, `storeSchema` was
refactored to delegate to a new `storeStoredSchema(stored, transactor)`
that accepts a fully-formed `StoredTableSchema`. This avoids reconverting
through `tableSchemaToStored` (which would re-strip the merged indexes).

## Regression coverage

`test/catalog-hydration.spec.ts` gains a new case:
`"doInitialize preserves persisted indexes when local DDL has none"`.

It reproduces the bug end-to-end:

1. Session 1 (pluginA): `CREATE TABLE gadgets (...)` followed by
   `CREATE INDEX idx_gadgets_category ON gadgets(category)` against
   shared storage. After this, the persisted `StoredTableSchema` has
   `indexes: [{ name: "idx_gadgets_category", ... }]`.
2. Session 2 (pluginB, fresh `Database`, no hydrate): re-issue the bare
   `CREATE TABLE gadgets (...)`. This is the exact codepath that
   `apply schema` exercises — the catalog is empty, so the differ emits
   CREATE TABLE first, and `module.create()` runs `doInitialize` with a
   `TableSchema` whose `indexes` field is `[]`.
3. Immediately read the persisted schema back via the same SchemaManager
   and assert `idx_gadgets_category` is still in `indexes`. Pre-fix this
   assertion fails (persisted is clobbered to `indexes: []`); post-fix it
   holds.
4. As a tighter check, wrap `storeSchema` AND `storeStoredSchema`, then
   re-issue `CREATE INDEX IF NOT EXISTS`. With the fix, `addIndex`'s
   dedupe hits (the persisted index is still there), so neither writer
   fires. Pre-fix, the dedupe missed and `storeSchema` fired again.

All 4 catalog-hydration tests pass; the full plugin suite (189 passing, 4
pending) also passes.

## Build + test status

- `yarn build` — clean.
- `yarn test` — 189 passing, 4 pending, 0 failing.

## Suggested review focus

- The `mergedCandidate` policy: is there a scenario where a host
  legitimately *wants* a local CREATE TABLE without indexes to drop
  remote-added indexes? The ticket's analysis argues no — local-DDL-wins
  is about column shape, not indexes (which travel through `addIndex()`).
  If the reviewer disagrees, the override would need to be threaded
  through a config flag.
- `SchemaManager.storeStoredSchema` is now part of the public surface
  (the wrapping in the new test depends on it). If the reviewer would
  rather keep `storeSchema(schema: TableSchema)` as the single
  entrypoint, the alternative is to convert the merged
  `StoredTableSchema` back to a synthetic `TableSchema` before storing —
  uglier and still leaves the merge logic in `optimistic-module.ts`.
- The regression test reads the SchemaManager's `getSchema` AFTER
  `CREATE TABLE` to assert the persisted index survived. The
  SchemaManager's `schemaCache` shortcuts a stale read here in principle,
  but the cache was populated by `doInitialize`'s `getSchema` call *before*
  the (now-skipped) write, so the cached value IS the persisted value. The
  reviewer may want to add a `clearCache()` call before the assertion to
  force a tree round-trip and verify nothing reached storage either — I
  considered this but felt the existing assertion is sufficient given the
  short-circuit either persists nothing (good) or persists `indexes: []`
  (bad, and would show up in the cached value).
- The fix does not touch the `else if (persistedSchema)` branch (no local
  columns — the `xConnect` against hydrated catalog path). That branch
  already uses `persistedSchema` directly without writing, so it's
  unaffected. Worth a glance to confirm.

## Out-of-band verification

The downstream `sereus-health` cold-start probe described in the parent
ticket's Reproduction section is what motivated this fix; that
verification needs to happen against a real device build and is not
agent-runnable. The unit-level reproduction in `catalog-hydration.spec.ts`
covers the structural correctness; the perf claim ("zero
`storage-repo pend` between `Applying sApp schema` and
`sApp schema applied` on warm restart") still wants a human-driven
device-trace pass.
