description: When a database connection reconnected to a secondary index it had been ignoring, the rows it had written while ignoring that index stayed missing from it forever — lookups by that column never found them and nothing reported an error. Reconnecting now fills in the missing entries.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/index-maintenance-invariant.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
----

# Review: backfill index entries when reconciliation re-attaches a secondary index

## What was wrong

Two connections share one collection. A declares the table and writes rows. B declares a
secondary index (and populates it from the rows that existed at that moment). A — which does
not know about the index yet — commits another row; that write stages nothing into the index
tree, because A's `IndexManager` carries no descriptor for it. A then re-declares the index
(`create index …`), which used to wire A onto the index (descriptor, tree, transaction-bridge
registration) and stop there. From that point on A maintains the index for FUTURE writes and
the planner-side maintenance guard passes — so a lookup by the indexed column is routed into a
tree that has no entry for the row A wrote while detached. The row is committed and a full scan
returns it; the index-driven seek returns nothing, on **both** connections, with no error.

## What changed

All in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`.

- `reconcileMaintainedIndexes` now **returns the index names it newly attached** (no descriptor
  in the manager, or no open tree). The set is computed before it mutates anything, because the
  wiring it does is exactly what erases the evidence. Nothing newly attached → `[]`.
- New `backfillIndexTrees(indexNames)` next to `ensureUniquePopulated`, sharing its
  stage-then-sync-in-isolation shape: resolve each name to `{descriptor, tree}`, refresh
  `this.collection`, walk it once, stage `createIndexKey(descriptor, row) + pk` into only those
  trees, then sync only those trees. Idempotent — entries are keyed `indexColumns‖primaryKey`,
  so re-staging an existing entry is a byte-identical rewrite.
- Both `addIndex` arms call it with what reconcile returned: the already-persisted early-return
  branch (after the `effective !== storedSchema` `setSchema` fold — this is the arm that fixes
  the bug), and the build branch, where it **replaces** the old `insertIndexEntries` populate
  loop and its blanket `for (const tree of getIndexTrees()) await tree.sync()`. Reconcile
  reports a brand-new index as attached, so one populate site now serves both paths.

Two behaviour changes fall out of folding the build path onto the same helper, both noted at
the site: backfill calls `this.collection.update()` first (the old loop did not, so a
`CREATE INDEX` now also covers rows a sibling committed since this connection last pulled), and
it syncs only the trees it populated rather than every index tree.

Also updated: `packages/quereus-plugin-optimystic/README.md` § Limitations, whose bullet stated
the old "re-attaching does not backfill" behaviour.

## How to exercise it

Two `Database` instances over one `MemoryRawStorage` via a shared `local` transactor (the
`buildSharedLocalTransactor` / `registerWithSharedTransactor` helpers in
`test/index-maintenance-invariant.spec.ts`):

```
await dbA.exec(ddl);                                             // A declares the table, no index
await dbA.exec(`insert into backfill values (1, 'tok-a')`);
await dbB.exec(ddl);
await dbB.exec(`create index backfill_by_token on backfill(token)`);   // B builds + populates
await dbA.exec(`insert into backfill values (2, 'tok-b')`);      // A writes while detached
await pluginA.hydrate(dbA);
await dbA.exec(`create index backfill_by_token on backfill(token)`);   // A re-attaches
select id from backfill where token = 'tok-b'                    // must be [2] on A and on B
```

Before the fix: index entries stay at 1 and both seeks return `[]`. After: 2 entries, both
seeks return `[{"id":2}]`. This is committed as
`test/index-maintenance-invariant.spec.ts` → "re-attaching to an index backfills the rows
written while detached from it".

## Coverage added

**One generalized assertion, not another bespoke spec.** `test/query-helpers.ts` gained:

```ts
export async function expectIndexAgreesWithScan(
  db: Database, table: string, column: string
): Promise<void>
```

It reads every row via `select * from <table>`, groups the rows by their value in `column`, and
for each distinct value runs the predicate form and asserts the returned row set equals that
group exactly (compared as multisets, column-order independent). The class it generalizes is
"an index tree that does not account for every committed row" — which covers write-past-a-
detached-index, orphaned entries left by UPDATE/DELETE, and a re-attach that never backfilled.

Anti-vacuity: each value-form query must reach `OptimysticVirtualTable.executeIndexScan`, so a
full-scan fallback fails the assertion rather than passing it. The probe patches the shared
`dist` prototype, the same mechanism `test/read-pull-mechanism.spec.ts` uses, and restores in a
`finally`. With a single equality filter, `getBestAccessPlan` can only match an index whose
first column is `column`, so "an index scan ran" pins the right index.

Call sites: `index-maintenance-invariant` (both connections in the new test),
`two-node-secondary-index-convergence` (both nodes, both cases), `index-support` (as `afterEach`
over the `Index-based queries`, `Index optimization` and `Index edge cases` blocks, plus each
orphan-regression case and the pre-existing-rows populate case), and `secondary-unique` (the two
cases that have a DECLARED index).

## Validation run

From `packages/quereus-plugin-optimystic`: `yarn build` then `yarn test` → **464 passing, 11
pending, 0 failing** (baseline before this ticket was 463 passing / 11 pending; the delta is the
one new test). Root `yarn typecheck` and `yarn lint` both clean. Integration specs
(`OPTIMYSTIC_INTEGRATION=1`) were **not** run.

The new test was verified to be non-vacuous: with the `backfillIndexTrees(attached)` call in the
early-return branch stubbed out, it fails with `row 2 gained its index entry on re-attach:
expected 1 to equal 2`. `expectIndexAgreesWithScan` was separately verified against the same
stubbed build via a scratch spec (since deleted) and reported
`scratchy.token = s:tok-b: the index-routed row set must equal the full scan's: expected [] to
deeply equal [ … ]` — so the helper catches the disagreement on its own, not only via the
count assertion that happens to run first.

## Known gaps — please probe these

- **Cold open does not verify.** Backfill only runs on a `CREATE INDEX` that actually attaches
  something. A connection that opens the table and finds the index already in the persisted
  schema attaches nothing and therefore does not scan, so rows orphaned by some *other*
  divergent writer stay orphaned until someone re-declares the index. Deliberate — making every
  table open pay an O(rows) verification scan is the wrong trade — and parked as a `NOTE:`
  tripwire above `reconcileMaintainedIndexes`, not as a ticket.
- **`CREATE INDEX` inside an open transaction still force-flushes** the trees it populates, so
  those entries survive a later `ROLLBACK`. Pre-existing on the build path; the helper narrows
  it (only newly-attached trees are synced, and the caller cannot have staged into those). Not
  fixed here; carried forward as a `NOTE:` on `backfillIndexTrees`. Worth checking whether the
  narrowing argument actually holds for the early-return arm under a session-mode coordinator.
- **Partial indexes (`predicate`) are ignored** by backfill — matching `insertIndexEntries` on
  the live DML path, which ignores it too. Out of scope; noted at the site.
- **Multi-index scale is untested.** The helper stages per named index, and the only case where
  `attached.length > 1` is a union-added sibling index arriving in the same reconcile. No test
  drives that shape; a reviewer wanting to stress it should construct a schema where a
  concurrent writer's index lands between the fresh catalog read and the write-back.
- **`expectIndexAgreesWithScan` cost is O(distinct values) queries.** It was pointed at
  low-cardinality columns on purpose (`users.city`, 10 distinct, rather than `users.email`,
  100). If a reviewer moves it onto a high-cardinality column, expect the spec to slow down.
- **The NULL group is exempt from the routing requirement.** `where <column> is null` is not an
  equality filter, so `getBestAccessPlan` never pushes it into a seek — only its row set is
  compared. Exercised by `index-support`'s `Index edge cases` block (nullable `value` column).
- **`queryAll` in `test/query-helpers.ts` gained an optional `params` argument.** Existing
  callers (`distributed-quereus`, `distributed-transaction-validation`) pass nothing and are
  unaffected, but the signature change is worth a glance.
