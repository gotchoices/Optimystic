description: When a database connection reconnected to a secondary index it had been ignoring, the rows it had written while ignoring that index stayed missing from it forever — lookups by that column never found them and nothing reported an error. Reconnecting now fills in the missing entries.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/query-helpers.ts, packages/quereus-plugin-optimystic/test/index-maintenance-invariant.spec.ts, packages/quereus-plugin-optimystic/test/index-support.spec.ts, packages/quereus-plugin-optimystic/test/secondary-unique.spec.ts, packages/quereus-plugin-optimystic/test/two-node-secondary-index-convergence.spec.ts, packages/quereus-plugin-optimystic/README.md
----

# Complete: backfill index entries when reconciliation re-attaches a secondary index

## What was wrong

Two connections share one collection. A declares the table and writes rows. B declares a
secondary index and populates it from the rows that exist at that moment. A — which does not
know about the index — commits another row; that write stages nothing into the index tree,
because A's `IndexManager` carries no descriptor for it. A then re-declares the index, which
used to wire A onto it (descriptor, tree, transaction-bridge registration) and stop there. From
then on A maintained the index for FUTURE writes and the planner-side maintenance guard passed,
so a lookup by the indexed column was routed into a tree with no entry for the row A wrote while
detached. The row was committed and a full scan returned it; the index-driven seek returned
nothing, on **both** connections, with no error.

## What shipped

All in `packages/quereus-plugin-optimystic/src/optimystic-module.ts`.

- `reconcileMaintainedIndexes` returns the index names it newly attached (no descriptor in the
  manager, or no open tree), computed before it mutates anything — the wiring it does is what
  erases the evidence. Nothing newly attached → `[]`, so the warm re-declare pays no scan.
- New `backfillIndexTrees(indexNames)` next to `ensureUniquePopulated`, sharing its
  stage-then-sync-in-isolation shape: resolve each name to `{descriptor, tree}`, refresh
  `this.collection`, walk it once, stage `createIndexKey(descriptor, row) + pk` into only those
  trees, sync only those trees. Idempotent — entries are keyed `indexColumns‖primaryKey`, so
  re-staging an existing entry is a byte-identical rewrite.
- Both `addIndex` arms call it with what reconcile returned: the already-persisted early return
  (the arm that fixes the bug) and the build arm, where it replaces the old `insertIndexEntries`
  populate loop and its blanket `for (const tree of getIndexTrees()) await tree.sync()`.

Coverage: `test/query-helpers.ts` gained `expectIndexAgreesWithScan(db, table, column)` — for
every distinct value in `column`, the index-routed predicate query must return exactly the full
scan's rows for that value, and must actually reach `executeIndexScan` (so a full-scan fallback
fails rather than passes vacuously). Called from `index-maintenance-invariant`,
`two-node-secondary-index-convergence`, `index-support` and `secondary-unique`. The point
regression is `index-maintenance-invariant.spec.ts` → "re-attaching to an index backfills the
rows written while detached from it".

`README.md` § Limitations restates the new behaviour and its cost.

## Review findings

### Verified about the implementation (no defect)

- **The `attached` set is computed correctly on both arms.** `IndexManager.getIndexSchema` reads
  only `this.schema.indexes` (`src/schema/index-manager.ts:474`), and the build arm registers the
  tree but does not call `setSchema` before reconcile — so the brand-new index really is reported
  as attached, which is what lets one populate site serve both arms.
- **Key format matches the live DML path exactly.** Backfill's `createIndexKey(descriptor, row) +
  pk` key and `[treeKey, pk]` payload are byte-identical to `IndexManager.insertIndexEntries`
  (`index-manager.ts:289-307`), so the idempotence claim holds and a backfilled entry is
  indistinguishable from one a live insert wrote.
- **Only declared indexes are ever named.** `attached` is filtered from `storedSchema.indexes`, so
  synthesized `_uniq_` enforcement trees stay on their own lazy `ensureUniquePopulated` path — no
  second populate route to keep in step.
- **Dropping the blanket `sync()` over every index tree is safe.** Live DML staging is flushed
  through the transaction bridge at commit, and `ensureUniquePopulated` syncs its own tree; no
  path relied on `addIndex` flushing trees it did not populate.
- **The `!this.collection || !this.rowCodec` early return is defensive only.** `doInitialize`
  assigns `this.collection` before anything else (`optimystic-module.ts:349`) and `addIndex`
  awaits initialization, so backfill cannot silently skip a live table.
- **Both `reconcileMaintainedIndexes` callers consume the return value** — grepped; there is no
  third caller silently dropping the backfill.

### Fixed in this pass (minor)

- **`expectIndexAgreesWithScan` overclaimed its reach.** Its docstring sold it as generalizing
  "orphaned entries left by an UPDATE", but the values it queries come from the scan, so an entry
  for a value no longer held by any row is never queried and never seen. Docstring now states the
  limit and points at direct key assertions for that case.
- **The old populate loop's scale `NOTE:` was deleted with the loop.** Its rows×indexes half is
  genuinely fixed by staging per named index, but the residual — one staged action per row per
  index, all held pending until the sync, and every row re-staged on every attach — was left
  unrecorded. Restored as a `NOTE:` on `backfillIndexTrees`.
- **README cost sentence understated the work.** "costs one scan of the table" → also re-stages
  every row's entry into the attached tree.

### Recorded as tripwires, not tickets

- **Backfill only adds entries; it never purges.** A writer detached from an index that UPDATEs a
  row leaves the old entry behind, and re-attach adds the new entry beside it. Probed directly
  (scratch spec, since deleted): after a detached `update … set token='tok-z'`, the tree holds both
  `tok-a‖pk1` and `tok-z‖pk1`, and `where token = 'tok-a'` **routes into the index and
  `executeIndexScan` yields row `[1,'tok-z']`** — a row that does not match the seek key. The
  statement still returns no rows only because Quereus re-applies the predicate, even though
  `getBestAccessPlan` reports that filter as `handledFilters: true`. So today's correctness rests
  on the engine distrusting the vtab's own promise. Parked as a `NOTE:` at the yield site in
  `executeIndexScan` naming the observed evidence and the fix (re-derive `createIndexKey` from the
  fetched row, skip entries that do not prefix-match) for the day the engine trusts
  `handledFilters` or a covering-index read lands that never fetches the row. Conditional on a
  dependency's behaviour changing, hence a tripwire rather than a ticket.
- **Cold open still does not verify** (implementer's own `NOTE:` above `reconcileMaintainedIndexes`)
  — left as an accepted tradeoff at the site; making every table open pay an O(rows) scan is the
  wrong trade, and a re-declare heals it.

### Left alone deliberately

- **`CREATE INDEX` inside an open transaction force-flushes the trees it populates**, so those
  entries survive a `ROLLBACK`. Pre-existing on the build path and carried as a `NOTE:` on
  `backfillIndexTrees`; the helper narrows it (only newly attached trees sync, and the caller
  cannot have staged into a tree attached microseconds earlier). Not re-filed.
- **Partial indexes (`predicate`) are ignored by backfill**, matching `insertIndexEntries` on the
  live DML path — backfill and live maintenance agree, which is the property that matters. Noted
  at the site.
- **`optimystic-module.ts` is 3088 lines** (`wc -l`). Already claimed by
  `backlog/debt-optimystic-vtab-class-is-too-big-to-review.md`; not re-filed.

### Gaps accepted without a ticket

- **Multi-index attach (`attached.length > 1`) has no test.** The stage loop is uniform per named
  target, and reaching that shape needs a concurrent writer's index to land between the fresh
  catalog read and the write-back — high setup cost, no distinct code path. Left uncovered
  knowingly.
- **Integration specs (`OPTIMYSTIC_INTEGRATION=1`) were not run** in either the implement or the
  review pass; they exercise real TCP meshes and sit outside the agent-runnable time budget.

### No new tickets filed

Nothing found rose to a major defect: the one behavioural gap (stale entries) is not reachable as
a wrong result on the current engine, and is recorded where the next reader meets it.

## Validation

From `packages/quereus-plugin-optimystic`: `yarn build` then `yarn test` → **464 passing, 11
pending, 0 failing** (same as the implement handoff; my review edits are comments and docs).
Root `yarn typecheck` and `yarn lint` both clean. No pre-existing failures surfaced, so no
`tickets/.pre-existing-error.md` was written.

The regression test was verified non-vacuous during implement (stubbing the
`backfillIndexTrees(attached)` call in the early-return arm fails it with `row 2 gained its index
entry on re-attach: expected 1 to equal 2`); this pass independently confirmed the stale-entry
behaviour above with a throwaway spec run against the shipped build.
