----
description: A table could route queries through a secondary index that nothing keeps up to date — writes silently skipped it and lookups returned nothing. The vtab now reconciles its maintained index set on a re-declared CREATE INDEX, and a query planned onto an unmaintained index fails with an error naming the table and index.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/index-maintenance-invariant.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/README.md
----

# Index maintenance now tracks the declared index set — complete

## What shipped

Every Optimystic table carries two independent notions of "which secondary indexes exist":
Quereus's catalog (`TableSchema.indexes` — what the planner offers, and therefore what routes
a `where Token = ?` into an index seek) and the vtab's `IndexManager` (what INSERT/UPDATE/
DELETE actually stage into). When the second is missing an index the first still has, writes
silently skip the index tree while reads keep being routed into it: empty results forever,
no error anywhere. Two arms, both in
`packages/quereus-plugin-optimystic/src/optimystic-module.ts`:

**Arm 1 — the known producer of that divergence heals itself.** `addIndex`'s
already-persisted early return (taken when the index is already in the persisted schema —
another writer added it since, or the schema cache was refreshed in between) previously
returned without touching this vtab's `IndexManager`, leaving it permanently index-less for
maintenance. It now calls `reconcileMaintainedIndexes`, which for every index the persisted
schema declares folds the descriptor into the manager's schema, opens and registers the index
tree, and registers the collection with the transaction bridge — the same three wiring steps
the full build path performs. Idempotent, so the common warm re-declare stays a map lookup
per index. It reconciles all persisted indexes, not just the re-declared one. A latent hazard
in the unique-flag upgrade sub-branch (it folded an upgraded schema into the manager without
guaranteeing the tree was open, so the next write would have thrown `Index tree not found`)
falls out fixed.

Supporting refactor: the index-tree-opening lambda that existed in three near-identical
copies is now one private `openIndexTree(indexName, transactor)`.

**Arm 2 — a query planned onto an unmaintained index fails loudly.**
`getBestAccessPlan` asserts, at the moment a secondary index wins plan selection, that the
target table actually maintains it (`OptimysticModule.assertIndexMaintained` → new public
vtab method `indexMaintenanceState(name)`, which requires both the descriptor in the
manager's schema and an open tree). Violation throws a `QuereusError` naming table and index.
A vtab not yet (even provisionally) initialized reports `unknown` and the guard deliberately
passes; the scan-time backstop in `resolveIndexTarget` throws after initialization instead.
Legacy `idxNum >= 10` scans only have the backstop, since they bypass `getBestAccessPlan`'s
modern result.

**Collapse-the-two-sets option: considered and declined during implementation.** Quereus owns
`TableSchema.indexes`, and the vtab initializes lazily/asynchronously while
`getBestAccessPlan` is synchronous — the maintained set may not exist at plan time. Reasoning
is documented on `assertIndexMaintained`.

## Review findings

Reviewed the implement diff (`680376a`) fresh against the current sources, then ran
`yarn build` + `yarn test` in `packages/quereus-plugin-optimystic` and `yarn typecheck` +
`yarn lint` from the repo root. All green: build clean, **448 passing / 11 pending /
0 failing**, typecheck clean, lint clean (no output). No pre-existing failures surfaced, so
`tickets/.pre-existing-error.md` was not written.

### Fixed in this pass (minor)

- **The plan-time guard (Arm 2) was not actually pinned by any test.** Verified by flipping:
  with `assertIndexMaintained`'s call site disabled, the guard spec still passed — the
  scan-time backstop in `resolveIndexTarget` caught the same case and threw a message the
  spec could not tell apart. The entire Arm 2 could have been deleted with a green suite.
  The spec now asserts the plan-time signature specifically: a `QuereusError` (not the plain
  `Error` that `runQuery`'s catch re-wraps as `Query failed: …`), carrying the
  catalog-vs-maintained wording. Re-flipped to confirm the strengthened spec fails without
  the guard, then restored.
- **Arm 1 flip-verified as the handoff claimed.** With `reconcileMaintainedIndexes`'s call
  disabled, the early-return-reconcile spec fails exactly as described (committed index entry
  count stays 1 instead of 2). Restored; the claim holds.
- **Three near-identical copies of the invariant's error message** (two in
  `resolveIndexTarget`, one in `assertIndexMaintained`) collapsed into one module-level
  `unmaintainedIndexMessage(tableName, indexName, detail)`. The recognizable
  `does not maintain index '<name>'` phrase and the remediation sentence are now identical by
  construction across all three sites; only the `detail` clause differs. `resolveIndexTarget`
  also now throws `QuereusError` rather than a bare `Error`, matching the other site.
- **DML routed through an unmaintained index was untested.** Added an arm asserting an
  `UPDATE … where <indexed column> = ?` also fails loudly (an update reading through a stale
  index would silently touch a subset of the rows it claims to match), plus that the rejected
  statement left no partial write behind. It passes — the guard does cover the DML read path.
- **README had no record of a new user-visible error.** Added a `Limitations` bullet in
  `packages/quereus-plugin-optimystic/README.md` covering the
  `Table 'X' does not maintain index 'Y'` failure, the idempotent `CREATE INDEX` remedy, and
  the fact that re-attaching does not backfill. This was the only doc that should have moved:
  `docs/optimystic.md` and `docs/transactions.md` describe the collection/transaction layers
  and say nothing about the vtab's maintained-index set, so neither went stale.

### Filed as a ticket (major)

- **`fix/1-index-reattach-leaves-rows-unindexed`** — reconciliation repairs the *wiring* but
  not the *contents*. Rows a divergent connection wrote after a sibling populated the index,
  but before that connection re-declared it, never get index entries — and once reconciled
  the maintained-index guard passes, so the incomplete index answers silently. That is the
  same user-visible symptom as the originating report, still reachable through a narrower
  window. The implementer documented this as a known gap; it is filed rather than fixed
  inline because there is a genuine fork (backfill on attach / refuse to attach / attach and
  warn) with different cost and failure-mode profiles, and the backfill option changes the
  commit shape of a `CREATE INDEX` that runs inside a transaction. The ticket also proposes
  the generalized coverage for the class: one assertion that an index seek and a full scan
  agree on every distinct indexed value, reused across the existing index specs.

### Parked as a tripwire, not a ticket

- **`reconcileMaintainedIndexes` narrows rather than widens if handed a lossy schema.**
  `IndexManager.setSchema` replaces the index list wholesale, so a `storedSchema` missing an
  index the manager already maintains would *drop* it. Not reachable today through any path
  in this repo — it needs a stale or index-losing persisted schema, which is precisely what
  the sibling implement ticket `schema-catalog-index-list-is-lossy` closes on the supply
  side. Recorded as a `NOTE:` at the `setSchema` call naming the condition and the fix
  (name-keyed union of the two lists) if it ever trips.

### Checked and clean

- **Resource cleanup** — the new two-node spec's `createMesh(2, …)` harness
  (`packages/db-p2p/src/testing/mesh-harness.ts`) is fully in-process: mock key network, mock
  peer network, `MemoryRawStorage`. No sockets, timers or handles to release, and it exposes
  no teardown API. Matches the sibling `two-node-multi-collection-commit.spec.ts`, which also
  has no `afterEach`. Nothing leaks.
- **`registerCollection` idempotence** — the reconcile path's claim was verified against
  `txn-bridge.ts:263`: the registry is a `Map` keyed by `collection.id`, and
  `createOrGetCollection` returns the same instance for the same URI, so the re-register is a
  true no-op rather than a tracker-swapping overwrite.
- **Unique-enforcement indexes** — `indexMaintenanceState` and `resolveIndexTarget` both key
  off `getIndexSchema`, which only sees declared indexes, not the synthesized
  unique-enforcement descriptors. That is correct: those are never surfaced to the planner,
  so they can never be the `bestIndexName` the guard checks. `setSchema` also leaves the
  separate `uniqueEnforcementIndexes` list intact, so reconciliation cannot drop them.
- **No `dropIndex` path exists** on the vtab, so there is no second way for the maintained
  set to shrink out from under the catalog.
- **Type safety** — `openIndexTree` tightened the extracted lambda's `transactor?: any` to
  `transactor?: ITransactor`, matching `IndexTreeFactory`. No new `any` introduced.

### Considered and deliberately not filed

- **`optimystic-module.ts` is 2921 lines** (measured:
  `find packages -name "*.ts" … | xargs wc -l | sort -rn`), holding three classes
  (`OptimysticVirtualTable`, `OptimysticCommittedTable`, `OptimysticModule`). This diff added
  ~110 of them. It is the largest source file in the repo — but only barely:
  `packages/db-p2p/src/cohort-topic/host.ts` is 2901 and `cluster/cluster-repo.ts` is 2034, so
  ~2900 lines is the established norm here rather than an outlier this ticket created. Filing
  a split for one of two near-identical-sized files would be arbitrary; if file size is to be
  addressed it should be a deliberate sweep, not a side effect of this review.
- **A write-time cross-check** against the catalog (so a divergent connection's *writes*
  fail rather than only its reads) — the handoff flagged this as out of scope. It stays out
  of scope, and for a sharper reason than the handoff gave: the vtab does hold a
  `TableSchema`, but it is the copy captured when *this* connection was constructed, so in
  the exact divergence scenario that copy lacks the index too and a comparison against it
  would find nothing. A real write-time check needs Quereus's live catalog at DML time, which
  is new plumbing.
- **The guard spec reaches into module internals** (`tables` map, `indexManager.setSchema`)
  via `as unknown as` casts. Left as-is: the implement ticket sanctioned it, and after Arm 1
  no public path can produce the "tree open but nothing maintains it" state, so a test that
  refuses to touch internals cannot construct the case the guard exists for. The coupling is
  to two method names, both stable.
- **The guard turns a query that could have been answered by a full scan into a hard error**
  when an unmaintained index wins on cost. That is the ticket's stated intent (loud beats
  silently-wrong) and matches the pre-existing scan-time behaviour, only earlier.

## Residual gaps, stated plainly

- The originating production symptom (`fix/secondary-index-update-never-reaches-the-sibling`)
  is **not** verified fixed — its trigger was never reproducible in this repo, and the
  two-node mock-mesh specs passed before this work as well as after. What is guaranteed: the
  one known divergence-producing site heals itself, and any remaining supply of divergence
  surfaces as a named error instead of silently-empty results.
- Reconciliation does not backfill — see `fix/1-index-reattach-leaves-rows-unindexed`.
- A committed read planned concurrently with an in-flight `CREATE INDEX` on the same table can
  transiently observe `unmaintained` and fail; the window is the one `resolveIndexTarget`
  already had, and a retry resolves it. Documented as a `NOTE:` on `assertIndexMaintained`.
- The sibling implement ticket `schema-catalog-index-list-is-lossy` owns the schema-catalog
  side of the divergence supply. Nothing here depends on it; its review should confirm the two
  fixes compose (specifically that the `NOTE:` tripwire above becomes unreachable).
