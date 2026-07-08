description: The query planner for Optimystic-backed tables guesses how big each table is and how selective a filter is, using fixed default numbers; give it real, persisted statistics so it picks better query plans.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts
----

## Context

`OptimysticModule.getBestAccessPlan` estimates query cost from
`tableInfo.estimatedRows || 1000000` and a handful of hardcoded selectivity constants
(0.1 per equality, 0.25 per range, etc.). There is no real per-table statistics source:
an earlier `StatisticsCollector` was inert (it only counted rows seen in the current
process, was never persisted, and was never read back by the planner) and was removed
in `optimystic-statistics-remove`.

This ticket is the *replacement* idea, deliberately deferred: build statistics the
planner can actually trust.

## What a useful version would provide

- A **persisted, approximate row count** per table (survives process restart; the
  current `estimatedRows` is only as good as whatever the catalog last stored).
- **Per-column distinct-value estimates** for the indexed / UNIQUE columns, so
  equality selectivity is data-driven instead of a flat 0.1.
- A **refresh policy**: when statistics are (re)computed — e.g. an explicit
  `ANALYZE`-style call, a threshold on rows changed since last refresh, or a
  post-bulk-load hook — and where they are stored (a dedicated stats tree, or folded
  into the schema tree).

## Why it's backlog, not now

It is a genuine feature with its own storage, refresh-timing, and distributed-consistency
questions (multiple nodes writing stats for the same collection), none of which the
UNIQUE-probe / statistics-removal work needed. It shares no code with them beyond
`getBestAccessPlan`, which continues to work correctly on `estimatedRows` in the
meantime.

## Cases a future plan/implement pass should pin

- Empty table — estimates must not divide-by-zero or over-favour an index seek.
- Skewed distribution — a low-distinct-count column should not be treated as highly
  selective.
- Post-bulk-load refresh — after inserting many rows, a re-analyze should move the
  planned cost/rows for a subsequent query.
- Multi-node — two nodes computing stats for the same collection must not corrupt each
  other's persisted stats.
