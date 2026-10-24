description: A query joining two Optimystic tables with a filter on one of them used to run as a slow row-by-row loop, because the table module reported wildly inflated row counts for tables nobody had analyzed. It now reports the same estimates Quereus's in-memory tables do, so the planner picks the same fast hash join and index seek; review the change.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticModule.getBestAccessPlan`, `equalityTupleSelectivity`, `enforcesUniqueness`, constants `UNKNOWN_TABLE_ROWS` / `EQ_SELECTIVITY_WITHOUT_STATS`), packages/quereus-plugin-optimystic/test/access-plan-estimates.spec.ts (new), packages/quereus-plugin-optimystic/test/ordering-claim-guard.spec.ts, packages/quereus-plugin-optimystic/README.md (`## Limitations`)
----
# Joins over Optimystic tables get the plans memory tables get — review

GitHub [#44](https://github.com/gotchoices/Optimystic/issues/44). The issue's query (`log_entry_items join bundles on b.id = lei.source_bundle_id where b.type_id = ? group by …`, index on `bundles(type_id)`) planned on Optimystic as a nested-loop `JOIN` with a `FILTER` over `INDEXSEEK bundles USING primary` — one block read per outer row. Memory tables planned it as `HASHJOIN` over `SEQSCAN log_entry_items` and `INDEXSEEK bundles USING idx_bundles_type`.

Root cause: `getBestAccessPlan` fell back to 1,000,000 rows for an un-analyzed table, so a secondary-index equality seek reported 100,000 rows, while Quereus sizes the other side's sequential scan from the catalog (unknown → the join rule's default of 100). Same unknown size, two scales, 1000× apart.

## What changed — all in `OptimysticModule.getBestAccessPlan` and two helpers beside `orderingMatchesIndex`

- **Fallback** is `request.estimatedRows ?? UNKNOWN_TABLE_ROWS` (1000), `??` per Quereus's module-authoring rule (a measured 0 is priced as empty). The old comment defending 1,000,000 is replaced by the reason an unknown size must be one number for scans and seeks, plus a tripwire `NOTE:`: express network scan cost through `expectedLatencyMs` or by sizing the table (`feat-optimystic-persisted-planner-statistics`), never by inflating the row count.
- **Equality selectivity** comes from `equalityTupleSelectivity`: with `analyze` statistics (`rowCount > 0`) covering every seek column, `combineConjunctive([1 / max(distinctCount, 1), …])` (imported from `@quereus/quereus`); otherwise 0.1 for the whole tuple, wholesale. This replaces 0.1 per matched column. Mirrors `equalityTupleSelectivity` in `@quereus/quereus/src/vtab/memory/module.ts`.
- **Unique full match**: an equality on every column of a unique index reports `rows: 1`, `isSet: true`, cost `log2(N)·2 + 1`. `enforcesUniqueness` excludes **partial** unique indexes (`predicate !== undefined`) — a deliberate deviation from the memory module, because this plugin does not enforce partial UNIQUE at all (`resolveSecondaryUniqueDecision` skips them), so a partial unique index can match many rows here. The stale "quereus 0.4.8" comment is gone.
- **Secondary indexes are skipped when `fullPkEquality`** instead of behind `bestCost > 10`.
- **Every reported `rows` is floored at 1** (initial full-scan value and the range branch).
- **Fixed inline, not in the ticket:** when a later, cheaper index won, `bestOrdering` was only ever *set*, never cleared, so the plan could promise the ordering of an index that lost — the engine would skip its sort and return mis-ordered rows. Pre-existing (reachable before this change whenever a later index matched more equality columns); per-column statistics make it more reachable, so `bestOrdering` is now assigned or cleared on every index win.

Untouched as instructed: range handling, `orderingMatchesIndex` / `treeDeliversOrdering`, `assertIndexMaintained`, the partial-primary-key branch.

## Tests

- `test/access-plan-estimates.spec.ts`
  - "hash-joins the scan to a seek on the filtered side's index, as memory tables do" — the issue's schema and query, 20 + 60 rows, never analyzed; `query_plan` must contain `HASHJOIN`, an `INDEXSEEK` naming `bundles` and `idx_bundles_type`, and no `JOIN`. **Verified failing** with the fallback temporarily set back to 1,000,000: it printed exactly the issue's plan.
  - "sizes an indexed equality from the column's distinct count" — analyzed, distinctCount 4 over 1000 → `rows` 250.
  - "falls back to a tenth of the table when the column has no statistics" — same request, column absent from `columnStats` → `rows` 100.
  - "reports one row, as a set, for an equality on every column of a unique index" — two-column unique index, both matched → `rows` 1, `isSet` true.
- `test/ordering-claim-guard.spec.ts`
  - "does NOT keep the ordering promise of an index that lost to a cheaper one" — reproduces the stale-ordering bug above (two indexes, statistics making the second cheaper). Reasoned to fail on the old code, not run against it.
  - The `TABLE_ROWS` comment no longer claims the fallback is also 1,000,000.

Join-selection log (`DEBUG=quereus:optimizer:rule:join-physical-selection`) on the plan-shape spec now prints memory's numbers: nl 1100, hash 120, index-nl 180, mirrored 3150, for 100 × 100 rows.

## Validation run

- `yarn build`, `yarn typecheck` (covers `test/`), `yarn test:smoke` in `packages/quereus-plugin-optimystic`: clean.
- Full `yarn test` in the package (mocha + smoke): 1061 passing, 14 pending, 0 failing.
- `yarn lint:docs` at root: clean.
- Not run: `yarn test:integration`, the rest of the monorepo.

## For the reviewer

- **Seek-dependent specs** (`index-support`, `schema-batch`, `index-seek-correctness`, `queryWithSeeks` users) all still pass: at 1000 rows a secondary equality seek costs about 120 against a 1000 scan.
- **No-statistics, multi-column index matches now tie with one-column matches** (wholesale 0.1 per tuple, the memory module's rule), so the first-declared index wins. Previously the longer match won on cost. Results are unaffected; only which index gets used. Worth a look if a plan regression shows up on a composite index over an un-analyzed table.
- The index-nested-loop rule (`probeModule` in `@quereus/quereus/src/planner/rules/join/index-nested-loop.ts`) re-probes this method with synthesized join-key equalities; only numbers changed, not answer shape, and `validateAccessPlan` passed across the suite.
- Empty analyzed table (`estimatedRows` 0), unique-vs-primary-key precedence, and the `rowCount` 0 statistics guard are by inspection only.
- README `## Limitations` gains a bullet: un-analyzed tables are planned as 1000 rows; `analyze` statistics last only for the process and auto-refresh only after 500 changed rows (`auto_analyze_min_mutations`); persisting them is not yet implemented.
