description: A query joining two Optimystic tables with a filter runs as a slow row-by-row loop with a lookup per row, while the same query on in-memory tables uses a fast hash join and an index; on Optimystic each lookup is a block read, so this costs 10–30 times more. Make the table module tell the query planner what it needs to choose the same efficient plan.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts (access-plan reporting, row estimates), packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/README.md
----
# Joins over Optimystic tables get the plans memory tables get

GitHub [#44](https://github.com/gotchoices/Optimystic/issues/44) (kjeib). Read the issue in full (`gh issue view 44`); it has both `query_plan(...)` outputs, numbers and repro files.

With a filter on the joined table, a join over Optimystic tables plans as a sequential scan of one table plus a primary-key `INDEX SEEK` into the other for each outer row, then filters. The identical schema and SQL on Quereus memory tables plans a `HASH JOIN`, with an `INDEX SEEK` on the secondary index for the filter. Without the `WHERE`, Optimystic gets hash joins too.

Maintainer's position: Quereus already has what its planner needs to pick the efficient algorithm if the module reports things properly. So the fix is in what this module reports (cost, row estimates, which constraints and orderings an index access serves, uniqueness, cardinality), not in Quereus. Compare with how the memory vtab answers the same planner questions (the memory module in `@quereus/quereus`) and close the differences that matter. Only if a genuine Quereus gap turns up, file it as an external blocker that names it precisely.

## Expected

- The issue's query on Optimystic tables plans the same join shape as on memory tables (a hash join, and a secondary-index seek for the filter), and its read count no longer grows with the number of outer rows.
- Reported estimates stay honest; don't fake costs to steer one query.

## Test

A plugin spec asserting the plan shape (`query_plan`) for the issue's query on Optimystic tables.
