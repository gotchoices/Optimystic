description: Speed up primary-key range queries (like "id > 100") by jumping straight to the matching rows instead of scanning the whole table — only safe once the table's sort order is fixed.
prereq: optimystic-tree-comparator-lexicographic-missort
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts
----

## Context

Follow-on to the safe fix in `optimystic-pk-range-filter-not-applied`. That fix
made primary-key range predicates (`WHERE pk > x`) return **correct** results by
telling the SQL engine to apply the predicate over a full scan. It did **not**
add the seek optimization: the module still scans every row and lets the engine
filter.

This ticket implements the real range seek — jump to the start of the matching
key span and iterate only that span — so a range query is `O(log n + k)` instead
of `O(n)`.

## Why this is gated (do not start before the prereq lands)

A correct seek needs the tree's key order to match SQL value order. Today it does
not:

- `RowCodec.serializeKeyPart` (`row-codec.ts:150-179`) encodes numbers as
  `value.toString()` — not order-preserving (`"10" < "9"`, negatives invert).
- The tree opens with a raw lexicographic string comparator; the order-aware
  `createPrimaryKeyComparator` is dead code (`row-codec.ts:249-252`).

So a `KeyRange` built today would bracket the wrong rows for numeric / DESC /
non-BINARY keys. `optimystic-tree-comparator-lexicographic-missort` (sq-2) fixes
the comparator and encoding; this seek builds on that. Only after sq-2 may
`getBestAccessPlan` re-advertise the range as handled (and, where sq-2 allows,
`providesOrdering`).

## What to build

The plumbing to reconstruct the range is already available on `FilterInfo`:

- `filterInfo.constraints` is `Array<{ constraint: { iColumn, op, usable }, argvIndex }>`,
  ordered lower-bound then upper-bound for a `plan=3` seek
  (see `@quereus/quereus` `rule-select-access-path.ts:686-705`).
- `op` is an `IndexConstraintOp` enum: `GT=4`, `GE=32`, `LT=16`, `LE=8`.
- The bound value for a constraint is `filterInfo.args[argvIndex - 1]`.

`executeRangeQuery` (`optimystic-module.ts:594-601`, currently a full-scan stub)
should:

- walk `filterInfo.constraints`, classify each as lower (`GT`/`GE`) or upper
  (`LT`/`LE`), read its value from `args[argvIndex-1]`;
- encode each bound with the SAME keying as stored rows
  (`rowCodec.createPrimaryKey([value])` for a single-column PK) into a
  `KeyBound<string>` with `inclusive = (op === GE || op === LE)`;
- build `new KeyRange<string>(lowerBound, upperBound, isAscending)` and iterate
  `read.range(range)`, decoding each entry (mirror `executeTableScan`'s
  path-validity / retry handling at `optimystic-module.ts:672`).

Then flip `getBestAccessPlan`'s range branch back to reporting the filter
handled (and set `providesOrdering` only within what sq-2 guarantees).

Also reconcile: for a composite PK, only the constrained leading column(s) form
the seek prefix — verify `seekColumnIndexes` / bound assembly does not assume a
full PK. `rule-select` picks the single constrained `rangeCol`, but the module's
`bestSeekColumnIndexes = [...pkColumns]` currently reports all PK columns; check
this does not misframe a composite-PK range.

## Acceptance

- Range predicate on an integer PK returns exactly the in-range rows, in correct
  order, after sq-2.
- Regression tests cover integer PK, DESC ordering, and lower+upper bounds — not
  just the TEXT-key case the safe-fix ticket added.
- A large-table timing / row-count sanity check shows the seek visits ~k rows,
  not n (assert via row-visit count or an EXPLAIN-style plan check, not
  wall-clock).
