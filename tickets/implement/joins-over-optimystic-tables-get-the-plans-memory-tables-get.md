description: A query joining two Optimystic tables with a filter on one of them runs as a slow row-by-row loop, because the table module tells the query planner that a filtered lookup on a table of unknown size returns 100,000 rows. Make it report the same honest estimates Quereus's in-memory tables report, so the planner picks the same fast hash join and index seek.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticModule.getBestAccessPlan`), packages/quereus-plugin-optimystic/test/ordering-claim-guard.spec.ts (pattern for calling `getBestAccessPlan` directly), packages/quereus-plugin-optimystic/README.md (`## Limitations`), tickets/backlog/feat-optimystic-persisted-planner-statistics.md (already updated by the plan pass; read only)
----
# Joins over Optimystic tables get the plans memory tables get

GitHub [#44](https://github.com/gotchoices/Optimystic/issues/44). Reported query, with an index declared on `bundles(type_id)`:

```sql
select lei.source_bundle_id as id, count(*) as n
from log_entry_items lei join bundles b on b.id = lei.source_bundle_id
where b.type_id = ? group by lei.source_bundle_id
```

On memory tables this plans as `HASHJOIN` over a scan of `log_entry_items` and an `INDEXSEEK bundles USING idx_bundles_type`. On Optimystic tables it plans as a nested-loop `JOIN` with a `FILTER` over an `INDEXSEEK bundles USING primary`, which is one block read per `log_entry_items` row.

## Root cause (reproduced)

Reproduced on the working tree against Quereus 4.20.3 (the sibling checkout), with a 20-row `bundles` and a 60-row `log_entry_items`, never analyzed. Quereus's join-selection log (`DEBUG=quereus:optimizer:rule:join-physical-selection,quereus:optimizer:rule:index-nested-loop`) shows the comparison that decides it:

- **Memory:** hash 120, index-nested-loop 180, for 100 × 100 rows → hash join.
- **Optimystic:** the `bundles` side counts as 100,000 rows, so hash costs about 40,000 and index-nested-loop 180 → nested loop.

Where the 100,000 comes from: `getBestAccessPlan` falls back to `request.estimatedRows || 1000000` for a table nobody has run `analyze` on, and prices an equality on a secondary index at 0.1 of that. Quereus takes an index seek's row count from the module's answer (`IndexSeekNode.computePhysical` relays `rows`), but takes a sequential scan's row count from the catalog, which for an un-analyzed table is unknown and becomes the join rule's own default of 100. So the filtered side of the join was counted 1000× larger than the unfiltered side, for two tables of the same unknown size. The memory module's fallback is 1000 rows, so its seek reports 100 and the two sides are on one scale.

This is the common case, not a corner. Quereus's `auto_analyze` (on by default) only refreshes a table after `auto_analyze_min_mutations` (500) changed rows counted in the current process, and statistics are not persisted across a restart (backlog `feat-optimystic-persisted-planner-statistics`). Small application tables — the reporter's have 170–480 rows — are therefore planned on the fallback for their whole life.

Verified: replacing the fallback with `request.estimatedRows ?? 1000` and rebuilding makes the Optimystic plan `HASHJOIN` over `SEQSCAN log_entry_items` and `INDEXSEEK bundles USING idx_bundles_type`, with the join log printing exactly memory's numbers (hash 120, index-nl 180, mirrored 3150). After `analyze`, both backends already agree before any change: each drives from the filtered `bundles` seek and seeks `log_entry_items` through its `source_bundle_id` index. No Quereus gap is involved.

The remaining difference in the plan — memory shows `INDEXSCAN … USING _primary_` where Optimystic shows `SEQSCAN` — is memory advertising primary-key order for merge joins. Optimystic's tree cannot honestly promise that order for non-text keys (backlog `debt-optimystic-true-key-ordering`); leave it.

## What to change — all in `OptimysticModule.getBestAccessPlan`

Keep the method's existing structure and cost formulas; change what it reports in these four places. The goal is parity with the memory module's answers (`MemoryTableModule.getBestAccessPlan` in `@quereus/quereus/src/vtab/memory/module.ts`, especially `equalityTupleSelectivity` and `estimateEqualityRows`), not new costing.

1. **Fallback row count: `request.estimatedRows ?? 1000`.** 1000 is the last-resort default the memory and store modules both use. `??` rather than `||`, as `@quereus/quereus/docs/module-authoring.md` now requires: a measured empty table (`0`) is priced as empty, only `undefined` is unknown. Replace the long comment above it, including the `NOTE:` defending 1,000,000: say why an unknown size must be the same number for a table's scans and its seeks (the root cause above, briefly), and leave a tripwire in its place — `NOTE:` if full scans of a network-backed table should look costlier than local ones, say so through per-read cost (`expectedLatencyMs`, whose absence is explained at the `concurrencyMode` doc on this class) or by sizing the table (`feat-optimystic-persisted-planner-statistics`), never by inflating the row count, which every join and aggregate above the access reads as cardinality.
2. **Equality selectivity from `analyze` statistics, by the memory module's rule.** For an equality match on index columns `c1…ck`: if `tableInfo.statistics` is present with `rowCount > 0` and every `ci` has a column entry (`statistics.columnStats` is keyed by the lowercase *current* column name — look it up through `tableInfo.columns[ci].name`), selectivity is `combineConjunctive([1 / max(distinctCount, 1), …])` (`combineConjunctive` is exported by `@quereus/quereus` for exactly this). Otherwise use `0.1` for the whole tuple — wholesale, never mixing a measured factor with the constant. This replaces the current `0.1` per matched column. Put it in a small private helper beside `orderingMatchesIndex`.
3. **Unique secondary index, every column matched by equality: `rows: 1`, `isSet: true`.** `TableIndexSchema.unique` exists now; the comment claiming it does not ("quereus 0.4.8") is stale — delete it. A prefix match on a unique index is not unique and stays as computed in item 2. The cost for this case stays the existing formula with `rows` = 1.
4. **Skip secondary indexes explicitly once a full primary-key equality was found**, instead of the `bestCost > 10` gate. That gate was a proxy for "found a point seek" that depended on the table size (a primary-key seek costs about 20 at 1000 rows, so the gate no longer skips anything); with item 3 a unique index can price within a fraction of the primary-key seek, and the choice between them must not hang on that.

Also floor every reported `rows` at 1 (the range branch's `Math.floor(N × 0.25)` can reach 0 for a tiny or empty table), matching both Quereus modules; `rows: 0` is legal but distorts every cost above it.

Do not touch: range handling (no pushdown, see `debt-optimystic-pk-range-seek`), `orderingMatchesIndex` / `treeDeliversOrdering`, `assertIndexMaintained`, the partial-primary-key branch.

## Edge cases & interactions

- **Never-analyzed table** → 1000 rows; secondary equality seek reports 100 rows (or 1 for a unique full match). The issue's join picks the hash join (the spec below).
- **Analyzed empty table** (`estimatedRows` 0) → priced as 0, every `rows` floored at 1, the full-scan cost keeps its existing `Math.max(1000, …)` floor so a seek still beats a scan. By inspection.
- **Statistics with `rowCount` 0 but rows present** (an `analyze` run before a load) → no statistics for selectivity (item 2's `rowCount > 0` test), but the 0 row count is still honored as the planner's figure: engine-wide snapshot semantics, not this module's to override. By inspection.
- **Column added or renamed after `analyze`** → its name has no `columnStats` entry → wholesale `0.1`. Covered by the estimator spec.
- **Unique index vs. primary key**, both fully matched → primary key wins (item 4). By inspection.
- **Multi-column index** partially matched by equality → item 2 over the matched prefix only; not unique even when the index is.
- **The index-nested-loop rule's probes** (`probeModule` in `@quereus/quereus/src/planner/rules/join/index-nested-loop.ts`) call this method with synthesized join-key equalities plus the displaced seek's predicates, and admit a seek only when its `cost` is no higher and `rows` strictly lower than the plan it displaces. Nothing here changes the shape of an answer, only its numbers; the rule still validates every answer (`validateAccessPlan`), so the result must stay valid. Run with the join log above when checking the spec.
- **Existing seek-dependent specs** (`queryWithSeeks`, `indexSeekTraces` users such as `index-support.spec.ts`, `schema-batch.spec.ts`, `index-seek-correctness.spec.ts`) rely on equality predicates being served by index seeks. At 1000 rows a secondary equality seek costs about 120 against a scan of 1000, so they should keep seeking; if one stops, read why before changing the test.
- **Committed reads** (`committed.<Table>`) plan through this same method; nothing per-connection is read, so nothing changes for them.
- **Prepared statements** keep the plan they were compiled with until a schema change (including the `table_modified` an `analyze` emits) recompiles them — Quereus's semantics, unchanged.

## Tests

- **Plan shape for the issue's query** (new spec, e.g. `test/join-plan-shape.spec.ts`; the ticket's required test). Two Optimystic tables shaped like the issue's — `bundles (id text primary key, type_id text, name text)` with `create index idx_bundles_type on bundles(type_id)`, and `log_entry_items (entry_id text, item_id text, source_bundle_id text null, primary key (entry_id, item_id))` with an index on `source_bundle_id` — a few dozen rows, never analyzed. Read `query_plan(<the query above, with a literal>)`: expect a `HASHJOIN` row, an `INDEXSEEK` row whose detail names `bundles` and `idx_bundles_type`, and no `JOIN` (nested loop) row. Before the change it fails with exactly the issue's plan. Setup pattern: `test/index-support.spec.ts` (plugin `register`, `'test'` transactor). Remember the specs import `dist/`, so rebuild before running.
- **Estimator contract** (direct `getBestAccessPlan` calls, in the style of `test/ordering-claim-guard.spec.ts`; one `it` each): an equality on an indexed column of an analyzed table reports `rows` = `estimatedRows / distinctCount`; the same request whose column is absent from `columnStats` reports `rows` = `0.1 × estimatedRows`; an equality on every column of a unique index reports `rows` 1 and `isSet` true.

Nothing else needs a test: the fallback constant and the explicit skip are covered by the plan-shape spec and by inspection.

## Docs

Add a bullet to the plugin README's `## Limitations` saying, plainly: a table nobody has analyzed is planned as 1000 rows, the same default as Quereus's memory tables; `analyze` gives the planner real sizes and value counts; those statistics last only for the process and are re-collected automatically only after 500 changed rows (`auto_analyze_min_mutations`); persisting them is backlog. Keep to the doc-citation rules in AGENTS.md (no line numbers).

## TODO

- Rewrite the fallback in `getBestAccessPlan` (item 1) and its comment, with the tripwire `NOTE:`.
- Add the selectivity helper (item 2) and use it in the secondary-index loop.
- Unique full-match rows/isSet (item 3); delete the stale "0.4.8" comment.
- Replace the `bestCost > 10` gate (item 4); floor reported rows at 1.
- Write the plan-shape spec and the three estimator cases; `yarn build` then `yarn test` in `packages/quereus-plugin-optimystic`, and `yarn typecheck` there.
- README `## Limitations` bullet.
