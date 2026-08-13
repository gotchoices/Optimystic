----
description: A table can end up in a state where queries are routed through a secondary index that nothing keeps up to date — writes quietly skip it, so lookups through that index return nothing and no error is ever raised. Make that mismatch impossible, or at least loud.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/two-node-multi-collection-commit.spec.ts
difficulty: hard
----

# Two index sets, no one checks they agree

Every Optimystic table carries **two independent notions of "which secondary indexes exist"**:

- **The planner's set** — Quereus's `TableSchema.indexes`. This is what `getBestAccessPlan`
  offers, and therefore what decides whether a `where Token = ?` query does an index seek
  (`IndexManager.findByIndex`) or a full table scan.
- **The maintenance set** — `IndexManager.getAllMaintainedIndexes()`, i.e. the vtab's own
  in-memory copy of the persisted schema's `indexes` plus its synthesized unique-enforcement
  descriptors. This is what `insertIndexEntries` / `updateIndexEntries` /
  `deleteIndexEntries` iterate, and therefore what decides whether a write ever touches an
  index tree.

Nothing anywhere compares them. When the maintenance set is missing an index the planner
still has, the failure is **completely silent**:

- writes iterate an index list that does not contain it, so nothing is staged into its tree;
- `markDirtyTrees` marks only trees the same `IndexManager` knows about, so the tree is never
  flushed either;
- reads still get routed into that index, descend an empty (or frozen) tree, and honestly
  return no rows.

No exception, no log line, no revision anywhere that looks wrong. This is the shape reported
in `fix/secondary-index-update-never-reaches-the-sibling`: a row replicates fine, but every
index-driven lookup for it — on the writer or on a sibling node — comes back empty forever.
For a table whose seat-cap / quota logic reads through that index (sereus's
`FormationUsage` + `FormationUsageByToken`), the cap silently under-counts and the guard it
protects stops guarding.

## What the investigation established (do not redo this)

The originating fix ticket read the log as "the pend covered 3 blocks including the index
leaf, but only 2 committed". **Both halves of that reading are wrong**, and the corrected
reading is what points at this ticket:

- A first commit of a freshly invented collection pends exactly **3** blocks — its header,
  its root/leaf node, and its new log-tail block. All three belong to the DATA collection.
  None of them is an index block.
- `NetworkTransactor.commit` (`packages/db-core/src/transactor/network-transactor.ts`, the
  `commit`/`commitBlock` pair) commits the **tail block in its own call** and then the
  remainder in a second call. So one 3-block pend legitimately shows up downstream as a
  `blockIds=1` commit followed by a `blockIds=2` commit. Nothing is dropped.

So the real symptom is simpler and stronger than reported: the index collection is **absent
from the write transaction entirely** — no pend, no commit, nothing staged.

Also established: the reported `actionId` (`_ZlxPKt8o4WCh_xSuxmD2Q`, 16 random bytes,
base64url) is the id `Collection.syncInternal` mints, **not** the coordinator's `tx:<hash>`.
The reported run therefore went through the **legacy** per-tree sweep
(`TransactionBridge.commitDirtyTreesLegacy`), not the session/consensus coordinator. The
sibling report's `SyncRetryExhaustedError`, which only `Collection.syncInternal` throws,
agrees. **Do not go looking for a bug in coordinator/session wiring** — that path was
audited and is not implicated.

Given the legacy sweep, the elimination is tight:

- an index tree with anything staged is **always** flushed (`markDirtyTrees` marks every tree
  `IndexManager.getIndexTrees()` returns, and the sweep syncs each one);
- a staged entry whose tree is missing throws loudly (`Index tree not found: …`);
- therefore the only way the index collection can be silently missing from the transaction is
  **the maintenance loop having no index to iterate** — `getAllMaintainedIndexes()` returning
  a list without it.

### Not reproduced in this repo

Eight two-node / two-Database shapes were driven against the in-process mock mesh
(`createMesh(2, …)` + `buildNetworkTransactors` from `@optimystic/db-p2p/testing`) — legacy
mode and session mode, node B re-declaring the DDL, node B hydrating from the catalog, both
nodes declaring before either writes, both nodes writing, and an interleaving where one
Database declares the index only after a sibling already persisted it. **All eight converge
correctly**: the sibling's index seek finds the row and both nodes' index trees hold the
expected entry count.

So the trigger needs something the mock mesh does not have (real cohort timing, a real
restart, or sereus's specific boot ordering). That is exactly why this ticket's deliverable
is a **guard plus an invariant**, not a point patch: with the guard in place the same
production run reports *which* index diverged instead of returning empty rows forever, which
is what makes the remaining trigger findable.

## The one site that knowingly leaves the two sets disagreeing

`OptimysticVirtualTable.addIndex` (`optimystic-module.ts`, the `if (existing)` early return
around line 1925). When the index is already present in the persisted schema, `addIndex`
returns without ever adding it to `IndexManager`'s schema and without opening its tree. Its
comment states the premise outright:

> The tree itself already exists and is registered — nothing else to rebuild.

Nothing verifies that. It is true only when this vtab's `IndexManager` happened to be built
from a persisted schema that *already* carried the index. A vtab that initialized while the
persisted schema had no indexes, and then receives its `CREATE INDEX` after some other writer
persisted the same index, takes this branch and stays permanently index-less for
maintenance — while Quereus's catalog, and therefore the planner, has the index and keeps
routing seeks into it.

The same divergence can arrive from the schema-catalog side; that is a separate site and gets
its own ticket (`schema-catalog-index-list-is-lossy`). This ticket owns the vtab-side
invariant that makes either supply of divergence harmless or loud.

## What to build

**An invariant at the vtab seam: the set of indexes the planner may route through is the set
this table maintains.** Two arms, both at the vtab/IndexManager boundary.

**Arm 1 — `addIndex` reconciles instead of assuming.** The early return is a legitimate
optimisation for the persisted schema (no need to re-write it), but it must not skip the
in-memory reconciliation. On that branch, ensure the `IndexManager` actually carries the
index: open/register its tree if absent, fold the index descriptor into the manager's schema,
and register the collection with the transaction bridge — the same three things the full path
does. Make it idempotent so a warm re-declare stays cheap.

**Arm 2 — an unmaintained index must fail loudly, not return empty.** A seek routed at an
index that `getAllMaintainedIndexes()` does not contain (or whose tree `getIndexTree` does not
have) is a broken invariant, not an empty result. Throw an error that names the table and the
index. Today `IndexManager.findByIndex` already throws `Index tree not found` for a missing
tree; the gap is the index that has a tree but is absent from the maintained set, and the
planner-side path that offers an index the vtab never maintains. Prefer catching this where
the access plan is chosen, so the query fails before it silently answers wrong.

Consider whether the two sets can be collapsed into one so the mismatch is unrepresentable
(deriving the planner's offered set from `getAllMaintainedIndexes()`). If that is feasible
without fighting Quereus's catalog ownership, prefer it and reduce Arm 2 to a cheap assertion.

## Done means

- A vtab that receives `CREATE INDEX` for an index already present in the persisted schema
  ends up maintaining that index — its tree is open, registered with the bridge, and
  subsequent INSERT/UPDATE/DELETE stage into it.
- A query planned onto an index the table does not maintain fails with an error naming the
  table and index, instead of returning an empty result set.
- Tests pass and the build is clean.

## TODO

Phase 1 — pin the current behaviour

- Add a unit-level spec that constructs the divergent state directly (a table whose
  `IndexManager` lacks an index the planner has) and asserts today's silent-empty behaviour,
  so the fix has something to flip.
- Add a two-node convergence spec for secondary indexes. Reuse the harness in
  `test/two-node-multi-collection-commit.spec.ts` (`createMesh(2, { responsibilityK: 2,
  clusterSize: 2, superMajorityThreshold: 0.67 })` + `buildNetworkTransactors`, one `Database`
  per node with `plugin.collectionFactory.registerTransactor('shared:test', transactor)`).
  Cover: A inserts / B index-seeks, and both nodes insert / both index-seek. Assert on the
  index tree's committed entry count via a fresh `Tree` (the `countTreeEntries` pattern in
  `test/session-mode-commit.spec.ts`), not just on query results. These pass today — land
  them as regression coverage.

Phase 2 — Arm 1

- Make `addIndex`'s already-persisted branch reconcile the `IndexManager` (tree open +
  register, schema fold, bridge registration), idempotently.
- Extend the unit spec: after the early-return branch, an insert must stage into the index
  tree.

Phase 3 — Arm 2

- Decide where the guard lives (access-plan selection is preferred over `findByIndex`, so the
  query fails before answering).
- Throw a named, actionable error for an index the table does not maintain.
- Spec it.

Phase 4 — validate

- `yarn build` then `yarn test` from `packages/quereus-plugin-optimystic`, and
  `yarn typecheck` from the repo root (it must run after `yarn build`).
- Note in the review handoff that the originating production symptom
  (`fix/secondary-index-update-never-reaches-the-sibling`) is **not** verified fixed by this
  work — its trigger was not reproducible here. What this ticket guarantees is that the same
  divergence now surfaces as a named error rather than silently-empty query results.
