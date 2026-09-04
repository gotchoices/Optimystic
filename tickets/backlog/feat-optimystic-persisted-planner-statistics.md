description: The query planner for Optimystic-backed tables guesses how big each table is and how selective a filter is, using fixed default numbers; give it real, persisted statistics so it picks better query plans.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (`getBestAccessPlan` — reads the row count and the selectivity constants)
  - packages/quereus-plugin-optimystic/src/schema/schema-manager.ts (`StoredTableSchema.estimatedRows` — the persistence slot, deliberately inert; see the arm below)
difficulty: hard
tradeoffs: The planner works correctly on default estimates today, and real statistics bring their own storage, refresh-timing, and multi-node-consistency questions — a lot of machinery for query plans nobody has complained about.
----

## Context

`OptimysticModule.getBestAccessPlan` estimates query cost from
`request.estimatedRows || 1000000` and a handful of hardcoded selectivity constants
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

## Arm: the persistence slot already exists, and quereus 4.19 made wiring it a one-line temptation

Added 2026-09-04, during review of the quereus 4.19 upgrade. This does not change the ticket's
shape — it records a decision made at the code site so the next reader does not redo the analysis,
and it removes one obstacle a future implementer would otherwise have to rediscover.

**The slot.** `StoredTableSchema.estimatedRows` (`schema/schema-manager.ts`) is a row-count field in
the schema we already persist per table. It has always been inert: quereus never set
`TableSchema.estimatedRows` for a plain virtual table — only its materialized-view helpers did — so
the value the store path used to copy was `undefined` on every real table, and `undefined` keys
vanish under JSON. **No persisted optimystic schema carries one**, which means an implementer of
this ticket has a free, backward-compatible slot rather than a format migration.

**What 4.19 changed.** The in-memory row count moved from `TableSchema.estimatedRows` to
`TableSchema.statistics.rowCount`, and unlike the old field, `ANALYZE` *does* populate that one
(`runtime/emit/analyze.ts`). So the migration presented a one-line opportunity to map the stored
slot to and from `statistics` — which would have delivered this ticket's first bullet (a persisted
row count surviving restart) as an unreviewed side effect. It was deliberately NOT taken. Both
conversion sites carry a `NOTE:` saying so and pointing here.

**Two things that decision preserves, and that an implementer must now decide deliberately:**

- **`ANALYZE` would start dirtying the stored schema.** Persisting the count makes the candidate
  schema differ from the persisted one after an `ANALYZE`, so the next table initialization fails
  `schemasEqual` and takes the write branch in `OptimysticModule.doInitialize` — committing a
  schema rewrite per table. On a distributed backend that is a real write caused by what a user
  reads as a statistics-only command. Not obviously wrong; it just needs to be a choice, with a
  view on when it happens (at ANALYZE time? lazily on next open?).
- **It walks straight into this ticket's own multi-node question.** "Two nodes computing stats for
  the same collection must not corrupt each other's persisted stats" is listed below as a case to
  pin, and folding statistics into the *schema* tree — which every node writes through the same
  `schemasEqual`/rewrite path — is precisely the design that makes that question sharp. Deciding
  where statistics live (a dedicated stats tree vs. the schema tree) should come before wiring the
  slot, not after.

**Partial persistence is its own trap.** The stored slot holds a row count and nothing else, so a
naive mapping would round-trip `rowCount` while dropping `columnStats`, `histogram` and
`lastAnalyzed`. A restarted table would then present to quereus as *analyzed* — `statistics` present,
`catalogRowCount` answering — while carrying no column statistics at all. Quereus degrades safely
there (its providers gate on real column statistics and fall back wholesale), so this is not a
correctness bug, but it means a restart would silently downgrade statistics quality while still
looking analyzed. Whatever this ticket persists should either carry the column statistics too or
make the partiality explicit.

## Cases a future plan/implement pass should pin

- Empty table — estimates must not divide-by-zero or over-favour an index seek.
- Skewed distribution — a low-distinct-count column should not be treated as highly
  selective.
- Post-bulk-load refresh — after inserting many rows, a re-analyze should move the
  planned cost/rows for a subsequent query.
- Multi-node — two nodes computing stats for the same collection must not corrupt each
  other's persisted stats.
