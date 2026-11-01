description: A query on an Optimystic table never uses an index declared with a filter (`create index … where …`), even when the query's own conditions guarantee every row it wants is inside that filter, so such queries scan the whole table where they could look the rows up directly.
prereq: optimystic-partial-index-holds-only-the-rows-its-predicate-admits
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (`getBestAccessPlan`)
tradeoffs: Proving that a query's conditions imply an index's filter needs a predicate-implication check that Quereus's own memory and store modules do not have either (they skip partial indexes the same way), so the natural home for it may be the Quereus planner rather than this plugin, and no current declaration is known to need it.
----
# Plan through a partial index when the query implies its predicate

Once a partial index holds only the rows its predicate admits (ticket `optimystic-partial-index-holds-only-the-rows-its-predicate-admits`), `getBestAccessPlan` skips every index with a predicate, as Quereus's `MemoryTableModule.gatherAvailableIndexes` and its store module do: seeking one for a query whose `where` does not imply the predicate would return too few rows.

## Wanted

A partial index is offered to the planner for a query whose filters prove the index's predicate holds for every row the query can return — for example `where c = 'x' and flag = 1` against `create index i on t (c) where flag = 1`, or `where c = 'x'` against `create index i on t (c) where c is not null`. Every other query keeps the full scan.

## Notes

- The proof has to be conservative: a missed implication costs a full scan, a wrong one silently drops rows.
- The vtab sees only the pushed-down filters (`BestAccessPlanRequest.filters`), not the whole `where`, so what it can prove is limited to those; the Quereus planner has the full expression and may be the better place. Check what Quereus offers (its `coverage-prover.ts` proves a materialized view's `where` equivalent to a partial constraint's predicate) before writing a prover here.
