description: Fix the doInitialize short-circuit fall-through that clobbered persisted indexes with `indexes: []` when CREATE TABLE arrived ahead of its CREATE INDEX siblings.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts
  - packages/quereus-plugin-optimystic/test/catalog-hydration.spec.ts
----

## Summary

Resolved the regression introduced by
`hydrated-vtab-doinitialize-redundant-schema-write`: when `apply schema`
dispatched `CREATE TABLE` ahead of its `CREATE INDEX` siblings, the local
candidate `StoredTableSchema` arrived with `indexes: []`, lost the
schemasEqual comparison against the persisted (indexed) schema, and fell
through to a write that overwrote the persisted index list with `[]`. The
subsequent `addIndex()` calls then lost their dedupe and re-created every
index tree from scratch, restoring the pre-optimisation transaction count.

The fix treats the persisted index list as authoritative whenever the
local candidate carries no indexes — Quereus emits CREATE INDEX as a
separate DDL statement, so an empty `candidateStored.indexes` always
means "this DDL doesn't carry indexes," not "this table has no indexes."

- **Comparison merge**: build a `mergedCandidate` that inherits
  `persistedSchema.indexes` when `candidateStored.indexes.length === 0`,
  then compare the merged form against persisted. A genuine no-op restart
  now hits the short-circuit on every table, indexed or not.
- **Write merge**: when the merged comparison still fails (real column /
  PK / vtab-args change), pass the merged candidate to the new
  `storeStoredSchema(...)` so persisted indexes survive the
  local-DDL-wins overwrite. Local DDL keeps authority over column shape;
  `addIndex()` keeps authority over the index set.

`SchemaManager.storeSchema(schema: TableSchema)` was refactored to
delegate to a new `storeStoredSchema(stored: StoredTableSchema)`. This
avoids routing the already-merged candidate back through
`tableSchemaToStored()` (which would re-strip the merged indexes) and
gives the test a tight assertion point.

## Review findings

Adversarial review of commit 3225cef.

### Correctness — sound

- **Comparison merge logic** (`optimystic-module.ts:184-189`): the
  branching `mergedCandidate` policy is precise — it only swaps in
  persisted indexes when the candidate has none AND persisted exists,
  otherwise it keeps the candidate verbatim. The candidate→persisted
  comparison via `stableStringify` is deterministic, so the merged
  fallthrough doesn't introduce nondeterminism.
- **Write merge logic** (`optimystic-module.ts:192-200`): the
  storeStoredSchema call writes the merged form, so persisted indexes
  survive even on a real columns/PK change. Read-back via `getSchema`
  hits the cache that `storeStoredSchema` populated, so the in-memory
  view is coherent with the just-written tree state.
- **SchemaManager refactor** (`schema-manager.ts:74-95`): `storeSchema`
  now delegates to `storeStoredSchema`. The cache-set and tree-replace
  both use `stored.name` (was `schema.name`); since `stored =
  tableSchemaToStored(schema)` sets `stored.name = schema.name`, the
  values are identical and no behavioural change leaks here.
- **xConnect-against-hydrated branch unchanged**
  (`optimystic-module.ts:202-224`): the `else if (persistedSchema)`
  branch never writes — it just stamps persisted columns/PK onto the
  placeholder `tableSchema` and uses `persistedSchema` for
  RowCodec/IndexManager. Unaffected by the fix.
- **Other callers of storeSchema** (`addIndex` at
  `optimystic-module.ts:693`): still uses the `TableSchema` overload,
  which is correct — `addIndex` builds a fresh `TableSchema` with the
  updated index list and wants the full `tableSchemaToStored` conversion.

### Edge cases — checked

- **Real column change**: covered analytically. New columns + old
  indexes are persisted. Stale-column-ref-in-old-index is a theoretical
  hazard, but strictly less destructive than the alternative (losing the
  indexes); the user can DROP INDEX explicitly.
- **CREATE TABLE that legitimately wants zero indexes**: not expressible
  through CREATE TABLE alone — that's by Quereus design, since CREATE
  INDEX is a separate DDL statement. Use DROP INDEX. The implementer
  flagged this in the handoff; confirmed it's not a regression because
  the pre-existing code couldn't express it either.
- **Candidate-with-indexes (`candidateStored.indexes.length > 0`)**: the
  merge path doesn't fire; existing behaviour is preserved. This codepath
  fires for `xConnect`-after-hydrate (where `tableSchema.indexes` was
  stamped from the hydrated catalog) — the comparison naturally matches
  persisted with no merge needed.
- **schemaCache coherence**: storeStoredSchema sets cache first, then
  writes to the tree. The subsequent getSchema returns the cached
  mergedCandidate — exactly what was written. ✓

### Tests — pass, with one coverage caveat

- New test `doInitialize preserves persisted indexes when local DDL has
  none` (`test/catalog-hydration.spec.ts:172-268`) reproduces the bug:
  session A creates table+index, session B re-issues bare CREATE TABLE
  (no hydrate), and the assertion at line 234-239 verifies persisted
  indexes survive. Pre-fix this assertion would fail; post-fix it holds.
- **Coverage caveat (minor, not addressed)**: the test wraps
  storeSchema/storeStoredSchema AFTER session B's CREATE TABLE
  completes, so it catches the regression via the persisted-state
  assertion at line 234-239 but doesn't directly count writes during the
  CREATE TABLE itself. The persisted-state assertion is sufficient — a
  spurious write would have clobbered the indexes to `[]` and the
  assertion would fail. Filed as: the "structural-mismatch with
  preserved indexes" path (columns change, indexes survive) is also not
  directly tested, but the merge logic is straightforward and the
  comparison-path test exercises the same `mergedCandidate` construction.
  Not creating a follow-up ticket; documented here.
- Full suite: `yarn workspace @optimystic/quereus-plugin-optimystic test`
  → 189 passing, 4 pending, 0 failing. The pre-existing
  `doInitialize skips storeSchema when local DDL matches the persisted
  schema` test (the original regression guard) still passes, confirming
  the no-write happy path is intact.

### Build + typecheck — clean

- `yarn workspace @optimystic/quereus-plugin-optimystic build` → success
  (ESM + DTS).
- `yarn workspace @optimystic/quereus-plugin-optimystic typecheck` →
  clean (no diagnostics).
- No `lint` script in this package (`npm run lint` is undefined); lint
  is not part of this package's CI surface.

### Style / SPP / DRY — fine

- The `mergedCandidate` is a single-spread immutable construction at
  one site — no duplication.
- Comments at `optimystic-module.ts:174-182` document the WHY (CREATE
  INDEX dispatches separately, so empty-indexes ≠ no-indexes). Concise
  and accurate.
- The new `storeStoredSchema` doc comment at `schema-manager.ts:78-83`
  explains why it exists (precise control over persisted bytes for the
  merge case). Clear without over-explaining.
- Cache key change from `schema.name` to `stored.name` is a no-op
  given `tableSchemaToStored`'s contract — no comment needed.

### Documentation — no user-facing docs reference these internals

`grep storeSchema|tableSchemaToStored|doInitialize` over all `.md`
files in the repo returns only ticket-workflow files (this ticket and
the previous review ticket). No README or design doc references the
schema-manager interface, so nothing to update.

### Findings not addressed inline — none

No major findings. Minor coverage caveat documented; not worth a
follow-up ticket on its own.

## Out-of-band verification still needed

The downstream device cold-start probe described in the original fix
ticket — "zero `storage-repo pend` between `Applying sApp schema` and
`sApp schema applied` on warm restart" — is the perf-level confirmation
that this fix lands the optimisation. It needs a real device build trace
and is not agent-runnable. The unit-level regression here covers the
structural-correctness claim (persisted indexes survive); the perf claim
still wants a human-driven trace.
