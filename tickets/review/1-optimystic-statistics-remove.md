description: Review removal of the dead StatisticsCollector from the optimystic plugin.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: easy
----

## What was done

Deleted `packages/quereus-plugin-optimystic/src/schema/statistics-collector.ts` (~173 lines) and
removed all references from `optimystic-module.ts`:

- `import { StatisticsCollector }` line
- `private statisticsCollector?: StatisticsCollector` field
- `this.statisticsCollector = new StatisticsCollector(storedSchema)` in `doInitialize`
- `this.statisticsCollector?.incrementRowCount()` in INSERT path
- `this.statisticsCollector?.decrementRowCount()` in UPDATE-REPLACE path (displaced-row case)
- `this.statisticsCollector?.decrementRowCount()` in DELETE path
- Stale "statisticsCollector is per-table, not per-module / For now, use default estimates" comment
  in `getBestAccessPlan`

No barrel/index imports or test references found.

## Validation

- `yarn workspace @optimystic/quereus-plugin-optimystic build` — clean, no TS errors.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — **308 passing, 0 failing**, 11 pending.
- Smoke test: `smoke ok quereus@4.3.0`

## Use cases for reviewer to check

- INSERT, UPDATE (including UPDATE OR REPLACE with PK collision), and DELETE paths in `update()` —
  verify the return values and surrounding logic are untouched (purely subtractive diff).
- `getBestAccessPlan` — verify cost math unchanged; only the two stale comment lines removed.
- No `statistics-collector` import survives anywhere in `src/` or `test/`.

## Review findings

No concerns. Change is purely subtractive — dead code removal with zero behavioural delta.
The future statistics feature is tracked in `tickets/backlog/feat-optimystic-persisted-planner-statistics.md`.
