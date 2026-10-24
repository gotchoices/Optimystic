description: A query joining two Optimystic tables with a filter on one of them used to run as a slow row-by-row loop, because the table module reported wildly inflated row counts for tables nobody had analyzed. It now reports the same estimates Quereus's in-memory tables do, so the planner picks the same fast hash join and index seek.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`OptimysticModule.getBestAccessPlan`, `equalityTupleSelectivity`, `enforcesUniqueness`, constants `UNKNOWN_TABLE_ROWS` / `EQ_SELECTIVITY_WITHOUT_STATS`), packages/quereus-plugin-optimystic/test/access-plan-estimates.spec.ts, packages/quereus-plugin-optimystic/test/ordering-claim-guard.spec.ts, packages/quereus-plugin-optimystic/README.md (`## Limitations`), tickets/backlog/feat-optimystic-persisted-planner-statistics.md
----
# Joins over Optimystic tables get the plans memory tables get

GitHub [#44](https://github.com/gotchoices/Optimystic/issues/44). The issue's query (`log_entry_items join bundles on b.id = lei.source_bundle_id where b.type_id = ? group by …`, index on `bundles(type_id)`) planned on Optimystic as a nested-loop `JOIN` with one primary-key seek of `bundles` per outer row; on memory tables it planned as `HASHJOIN` over a scan of `log_entry_items` and an `INDEXSEEK` on `idx_bundles_type`.

Root cause: `getBestAccessPlan` fell back to 1,000,000 rows for an un-analyzed table, so a secondary-index equality seek reported 100,000 rows, while Quereus sized the other side's sequential scan from the catalog (unknown → the join rule's default). Same unknown size, two scales, 1000× apart.

## What landed (`ticket(implement): joins-over-optimystic-tables-get-the-plans-memory-tables-get`)

- Un-analyzed fallback is `request.estimatedRows ?? UNKNOWN_TABLE_ROWS` (1000, Quereus's memory/store default); a measured 0 is priced as empty. Tripwire `NOTE:` at the site: express network scan cost through a per-read cost or real statistics, never by inflating the row count.
- Equality selectivity follows the memory module: `analyze` distinct counts combined by Quereus's `combineConjunctive` when every seek column has statistics, else 0.1 for the whole tuple.
- An equality on every column of a non-partial unique index reports `rows: 1`, `isSet: true`. Partial unique indexes are excluded because this plugin does not enforce partial UNIQUE (a deliberate deviation from the memory module).
- Secondary indexes are skipped when the full primary key is matched by equality; every reported `rows` is floored at 1.
- Pre-existing bug fixed inline: a losing index's `providesOrdering` could survive when a later, cheaper index won, so the engine could skip a needed sort.
- README `## Limitations` explains the 1000-row default and that `analyze` statistics are per-process.

## Review findings

Read the implement diff first, then compared each estimate against `@quereus/quereus/src/vtab/memory/module.ts` (`equalityTupleSelectivity`, `isUniqueIndex`, `estimateEqualityRows`, `gatherAvailableIndexes`).

- **Correctness — fixed inline (plan regression the handoff flagged).** With no statistics, every equality tuple estimates the same 0.1 of the table, so a one-column index and a composite index matching more equality columns tied on cost and the first-declared won under the strict `<`. The longer seek reads fewer rows and leaves less residual filtering, and the old code preferred it. Added a tie-break in `getBestAccessPlan`: on equal cost, the index with more matched equality columns wins. Pinned by "prefers the longer equality match when statistics leave the two estimates tied" (fails without the tie-break: `idx_category` is declared first).
- **Correctness — test added, no code change.** The partial-unique exclusion in `enforcesUniqueness` guards a real hazard: `isSet: true` on an unenforced index lets the engine assume at most one row where several can match. It deviates from the reference implementation, so a future "mirror the memory module" pass could silently drop it. Pinned by "does NOT report a partial unique index's seek as one row".
- **Partial indexes as access paths — checked, no issue.** The memory module refuses to plan through a partial index (it would drop rows outside the predicate). Here that is safe: index maintenance and backfill ignore `predicate` and populate every row (the `NOTE:` on `backfillIndexTrees` in `optimystic-module.ts`), and `executeIndexScan` verifies each entry against its row. The two must change together if partial indexes are ever honoured; that note already exists.
- **Unique `isSet` under stale index entries — checked, no issue.** Orphan entries a detached writer left behind are skipped by `executeIndexScan`'s `rowImpliesEntry` check, so a unique seek yields at most one real row. `=` never matches NULL, so multiple NULLs under a unique index do not break `isSet`.
- **Dependency range — checked.** `combineConjunctive` is exported by `@quereus/quereus` since v4.13.0, inside the declared `^4.20.3` peer range.
- **Ordering fix and its test — checked.** The new ordering-claim-guard case fails on the old code too (old per-column 0.1 made the two-column index win while the earlier index's ordering stayed set), so it pins the defect rather than the new estimates.
- **Tests — kept all.** The three planner-level estimate tests each pin a branch (`analyze` factor, wholesale fallback, unique full match); the SQL test is the issue's reproduction. None restates wiring.
- **Docs.** README limitation is accurate. `tickets/backlog/feat-optimystic-persisted-planner-statistics.md`'s Context still described `|| 1000000` and a flat 0.1 per equality; updated to the current behaviour. `docs/` has no planner-estimate content to update.
- **Untouched by design (pre-existing, noted only):** the primary-key range and partial-primary-key branches report reduced `rows` while leaving their filters to the engine, so the engine's residual filter estimate may count the same predicate twice. Not changed here (the ticket told implement not to touch range handling; `debt-optimystic-pk-range-seek` owns that branch).
- **Source hygiene:** `equalityTupleSelectivity` and `enforcesUniqueness` don't use `this`; left as private methods beside `orderingMatchesIndex` to match the surrounding style. File size of `optimystic-module.ts` is not new to this change.
- **Not checked by run:** `yarn test:integration` and the rest of the monorepo. The change is confined to plan estimates in one package.

## Validation

- `yarn build`, `yarn typecheck` (exit 0), `yarn test` in `packages/quereus-plugin-optimystic`: 1063 passing, 14 pending, 0 failing; smoke ok.
- `eslint` on the three changed source/test files: clean. `yarn lint:docs` at root: clean.
