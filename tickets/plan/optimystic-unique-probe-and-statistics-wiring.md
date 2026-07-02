description: Enforcing a uniqueness constraint currently rescans the entire table for every row changed, making bulk inserts extremely slow, and a whole statistics-gathering component the query planner was meant to use is never called.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/statistics-collector.ts
difficulty: medium
----

## Problem

Two related pieces of planner/constraint machinery are inefficient or inert.

### 1. UNIQUE enforcement is a full table scan per row

`checkUniqueConstraints` (`optimystic-module.ts:839-869`, plan hook
`1696-1698`) scans the entire collection once per DML row. A bulk insert into a
UNIQUE-constrained table is O(n²). A completed ticket
(`optimystic-insert-pk-uniqueness-not-enforced`) made uniqueness *correct* via a
point `collection.get`, but UNIQUE (non-PK) constraint checking still does a full
scan.

### 2. Planner statistics are dead machinery

`getBestAccessPlan` uses hardcoded default costs, and the ~173-line
`StatisticsCollector` (`schema/statistics-collector.ts`) is consulted by nothing.
Either it should feed planning or it should be removed — right now it is
maintenance surface with no effect.

## Why plan (not just fix)

The statistics half is a genuine design decision (wire it into cost estimation
vs delete it), and the UNIQUE probe depends on the index-tree encoding, which is
itself under revision in sibling tickets (index-key type sensitivity, key-part
escaping). This needs a small design pass, not a blind edit.

## Desired outcome

- **UNIQUE probe:** enforce UNIQUE via the existing per-index trees using a point
  range (`findByIndexIn`) instead of a full scan, so cost is ~O(log n) per row.
  Must remain correct against committed + same-transaction-staged state (the
  invariant the PK-uniqueness fix established).
- **Statistics:** decide and execute — either wire `StatisticsCollector` into
  `getBestAccessPlan` cost estimation (define what it collects and when it
  refreshes), or delete it and remove references. Document the choice.

## Interactions

- Index-key encoding correctness: depends on sq-3 (type-sensitive index keys)
  and sq-4 (unescaped separators) landing, since the probe reads index trees.
  Note as coordination, design as if they land.
- UNIQUE-vs-onconflict: keep consistent with the completed
  `optimystic-vtab-onconflict-not-honored` semantics.

## Edge cases / tests to note for implementation

- Bulk insert of N rows into a UNIQUE column — assert index probes, not N scans.
- Duplicate detected against a row staged earlier in the same transaction.
- Multi-column UNIQUE constraint.
- If statistics wired: empty table, skewed distribution, post-bulk-load refresh.
