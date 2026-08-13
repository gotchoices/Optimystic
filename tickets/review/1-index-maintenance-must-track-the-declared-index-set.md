----
description: A table could route queries through a secondary index that nothing keeps up to date — writes silently skipped it and lookups returned nothing. The vtab now reconciles its maintained index set on a re-declared CREATE INDEX, and a query planned onto an unmaintained index fails with an error naming the table and index.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-maintenance-invariant.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts
----

# Index maintenance now tracks the declared index set — review handoff

## What was built

Two arms at the vtab/IndexManager boundary, per the implement ticket. All changes are in
`packages/quereus-plugin-optimystic/src/optimystic-module.ts`; no other source file changed.

**Arm 1 — `addIndex`'s already-persisted early return reconciles instead of assuming.**
The branch (previously `return` after an optional unique-flag upgrade) now calls a new
`reconcileMaintainedIndexes(storedSchema, transactor)`: for every index the persisted schema
declares, it folds the descriptor into the IndexManager's schema when absent, opens and
registers the index tree when absent, and registers the collection with the transaction
bridge — the same three things the full build path does. Idempotent: on a warm re-declare it
is a map lookup per index plus a keyed re-set of the bridge registry. It reconciles ALL
persisted indexes, not just the re-declared one, so a manager that had drifted on several
indexes heals in one pass. As a side effect this also fixes a latent hazard in the
unique-upgrade sub-branch, which used to fold the upgraded schema into the manager without
guaranteeing the tree was open (next write would have thrown `Index tree not found`).

Supporting refactor: the index-tree-opening lambda that existed in three near-identical
copies (doInitialize's IndexManager factory, addIndex's build path, and now the reconcile
path) is extracted into one private `openIndexTree(indexName, transactor)`.

**Arm 2 — a query planned onto an unmaintained index fails loudly.**
`getBestAccessPlan` now asserts, at the moment a secondary index wins plan selection, that
the target table actually maintains it (`OptimysticModule.assertIndexMaintained` → new public
vtab method `indexMaintenanceState(name)`, which requires both the descriptor in the
manager's schema and an open tree). Violation throws a `QuereusError`:
`Table 'X' does not maintain index 'Y': the catalog offers it to query planning, but this
table instance's writes do not keep it up to date…`. A vtab not yet (even provisionally)
initialized reports `unknown` and the guard deliberately passes — the scan-time backstop in
`resolveIndexTarget` (whose two generic errors, `Index not found` / `Index tree not found`,
were rewritten to the same named `does not maintain index` form) throws after initialization
instead. Legacy `idxNum >= 10` scans only have the backstop, since they bypass
`getBestAccessPlan`'s modern result.

**Collapse-the-two-sets option (from the ticket): considered and declined.** Quereus owns
`TableSchema.indexes` in its catalog, and the vtab initializes lazily/asynchronously while
`getBestAccessPlan` is synchronous — the maintained set may not exist at plan time. The
reasoning is documented in the comment on `assertIndexMaintained`.

## How to validate

From `packages/quereus-plugin-optimystic`: `yarn build`, then `yarn test`. From repo root:
`yarn typecheck` (after the build). All were run: build clean, **448 passing / 11 pending /
0 failing**, typecheck clean.

New specs:

- `test/index-maintenance-invariant.spec.ts`
  - **Early-return reconcile, end-to-end through the real divergence recipe**: writer A
    declares the table and initializes index-less; writer B (same shared storage) declares
    the index; A's schema cache is refreshed (via `plugin.hydrate`, whose `listTables` walk
    reseeds it); A re-declares the index and hits the early return. Asserts A's next insert
    lands in the index tree (committed entry count via a fresh Tree), and that A's and B's
    index seeks both find the row. **Flip verified**: with the reconcile call disabled this
    spec fails exactly as the ticket describes (entry count stays 1 — the silent write-side
    skip); with it enabled it passes.
  - **Warm re-declare**: a fresh Database replaying persisted DDL stays maintained and cheap.
  - **Guard**: constructs the divergent state directly (strips the index from the vtab's
    IndexManager via test-only internal access; tree stays open — the "tree exists but
    nothing maintains it" shape) and asserts the seek now throws an error containing
    `does not maintain index 'guarded_by_token'` and the table name, while full scans and
    primary-key seeks still answer.
- `test/two-node-secondary-index-convergence.spec.ts` — the ticket's Phase 1 regression
  coverage on the 2-node mock mesh (`createMesh(2, …)` + `buildNetworkTransactors`): A
  inserts / B re-declares and index-seeks, and both-declare-then-both-write. Asserts
  committed index entry counts from BOTH nodes' viewpoints via fresh Trees, not just query
  results. These passed before the fix too (the investigation could not reproduce the
  production trigger on the mock mesh) — they are standing regression cover.

## Honest gaps / review considerations

- **The originating production symptom (`fix/secondary-index-update-never-reaches-the-sibling`)
  is NOT verified fixed** — its trigger was never reproducible in this repo. What this work
  guarantees: the known divergence-producing site now heals itself, and any remaining supply
  of divergence surfaces as a named error instead of silently-empty results, which is what
  makes the remaining trigger findable in production.
- **No write-time cross-check.** The invariant is enforced where reads are routed (plan
  selection + scan resolution) and healed at the known producing site. A divergence produced
  by some unknown third path would still let writes skip the index silently until the next
  index-routed read trips the guard. A write-time compare against the catalog isn't
  reachable from the vtab (it doesn't see `TableSchema.indexes` per DML row) without new
  plumbing; judged out of scope.
- **No backfill on reconcile.** Rows committed by a divergent vtab between the sibling's
  index populate and the reconcile are not retro-indexed (NOTE on
  `reconcileMaintainedIndexes` documents this). The guard makes that window loud rather than
  repaired.
- **Transient guard window** (NOTE on `assertIndexMaintained`): a committed read planned
  concurrently with an in-flight CREATE INDEX on the same table can transiently see
  `unmaintained` and fail; the window is the same one `resolveIndexTarget` already had, and a
  retry resolves it.
- The guard spec reaches into module internals (`tables` map, `indexManager.setSchema`) via
  `as unknown as` casts — sanctioned by the ticket ("constructs the divergent state
  directly") since no public path can produce the state anymore, but it is coupling a test to
  private shape.
- The sibling implement ticket `schema-catalog-index-list-is-lossy` (sequence 1.5) owns the
  schema-catalog-side supply of divergence; nothing here depends on it, but its review should
  confirm the two fixes compose.
