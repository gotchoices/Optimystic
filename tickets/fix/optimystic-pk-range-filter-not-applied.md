description: A SQL query with a "greater than / less than" filter on a table's primary key returns every row in the table instead of just the matching ones.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: medium
----

## Bug

For the Optimystic virtual-table module, the query planner (`getBestAccessPlan`)
tells the SQL engine that a primary-key range predicate (e.g. `WHERE pk > x`) is
**handled** by the module. Per the Quereus contract, a filter marked handled is
**not** re-checked by the engine — the module is responsible for applying it.

But the executor never applies it. `executeRangeQuery` is a stub that falls back
to a full scan and ignores `_filterInfo` entirely. The net effect: the predicate
is silently lost and the query returns the whole table.

Relevant locations (from the review, verify current lines):
- `getBestAccessPlan` marks the range filter handled around `optimystic-module.ts:1765`.
- `executeRangeQuery` full-scan stub around `optimystic-module.ts:590-597`.

## Expected behavior

A range predicate on the primary key returns only rows in range. Two acceptable
resolutions:

- **Short term / safe:** stop claiming the filter is handled — return
  `handledFilters` all-false (and drop `providesOrdering`) for range ops, so the
  engine applies the predicate itself. Correct results, no seek optimization.
- **Full:** implement the range seek — build a `KeyRange` from `filterInfo.args`
  and iterate only the matching span.

Interacts with sq-2 (comparator / ordering): any `providesOrdering` claim for a
range is only valid once the tree iterates in true key order, so the two should
be reconciled together.

## Repro sketch

Create a table with an integer/text PK, insert several rows, run
`SELECT * FROM t WHERE pk > <mid>`; observe all rows returned instead of the
upper subset. Add as a regression test in the plugin package.
