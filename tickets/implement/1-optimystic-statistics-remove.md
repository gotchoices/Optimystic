description: A table-statistics component the query planner was supposed to use is never actually consulted and holds unreliable numbers, so remove it rather than leave dead code around.
prereq:
files: packages/quereus-plugin-optimystic/src/schema/statistics-collector.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: easy
----

## Background

`StatisticsCollector` (`schema/statistics-collector.ts`, ~173 lines) is instantiated
per table and fed `incrementRowCount()` / `decrementRowCount()` from the DML paths in
`optimystic-module.ts`, but **nothing ever reads it back for planning**:

- `getBestAccessPlan` is a method on the *module* (`OptimysticModule`), while the
  collector is a field on the *table* (`OptimysticVirtualTable`). The module has no
  handle to the per-table collector — the code even admits this in a comment
  ("statisticsCollector is per-table, not per-module … For now, use default
  estimates"). Cost estimation instead reads `tableInfo.estimatedRows || 1000000`.
- The only live signal the collector holds is `rowCount`, and even that is unusable
  for planning: it starts at `0` on every process start and only counts DML this
  process has seen. It is never seeded from storage and never persisted, so for a
  table with existing rows it reports `0`. `distinctCount` / histogram fields are
  never populated at all (`updateStatistics` is a `// TODO` no-op).

## Decision: delete it

Wiring the collector into `getBestAccessPlan` as-is would make plans **worse** (a
freshly-started process would estimate 0 rows for a large table). The correct
long-term row-count source is `tableInfo.estimatedRows`, which the catalog can supply
and which persists — `getBestAccessPlan` already uses it. So the collector is pure
maintenance surface with no effect. Remove it.

A future, real statistics feature (persisted counts, sampled distinct-counts, honest
histograms) is captured separately in `tickets/backlog/feat-optimystic-persisted-planner-statistics.md`;
it is out of scope here and shares no code with this removal.

## Edge cases & interactions

- **DML result parity.** The `incrementRowCount()` / `decrementRowCount()` calls sit
  inside the INSERT / UPDATE-REPLACE / DELETE branches of `update()`. Removing them
  must not change any `UpdateResult` returned — they are fire-and-forget side effects
  today. Verify the surrounding conflict/return logic is untouched.
- **No behavioural test asserts on statistics** — confirm via grep that nothing in
  `test/` references `StatisticsCollector`, `getStatistics`, `getRowCount`,
  `incrementRowCount`, or `estimateTableScanCost`. If something does, it is asserting
  on dead machinery and should be removed with it.
- **`getBestAccessPlan` stays as-is** apart from dropping the now-stale "For now, use
  default estimates" comment that refers to the collector. Do not change its cost math
  in this ticket.
- **Import graph.** After deleting the file, ensure no remaining `import` of
  `statistics-collector.js` survives (module barrel/index files included).

## TODO

- Delete `packages/quereus-plugin-optimystic/src/schema/statistics-collector.ts`.
- In `optimystic-module.ts`, remove:
  - the `import { StatisticsCollector } from './schema/statistics-collector.js';`
  - the `private statisticsCollector?: StatisticsCollector;` field
  - the `this.statisticsCollector = new StatisticsCollector(storedSchema);` line in
    `doInitialize`
  - the three `this.statisticsCollector?.incrementRowCount()` /
    `decrementRowCount()` call sites in `update()`
  - the stale collector reference in the `getBestAccessPlan` lead comment
- Grep the whole package (`src/` and `test/`) for any other reference and clean it up.
- Build the package and run the optimystic test suite; stream output
  (`yarn ... 2>&1 | tee /tmp/opt-stats.log`). Nothing should regress — the change is
  purely subtractive.
