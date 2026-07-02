description: The SQL layer sorts rows as plain text, so numeric keys come out as "1, 10, 2", descending order comes out ascending, and non-default text collations are ignored — while the planner still promises correctly ordered results.
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: hard
----

## Bug

The query planner (`getBestAccessPlan`) advertises `providesOrdering` for
primary-key ranges and index matches, including `DESC`. But the underlying tree
iterates in plain ascending string (lexicographic) order:

- an INTEGER primary key yields `"1", "10", "2"` instead of `1, 2, 10`;
- `DESC` still comes back ascending;
- non-BINARY collations are ignored.

Because the planner claims the ordering is already provided, the engine does not
re-sort — so the SQL result set is genuinely mis-ordered (wrong results, not just
slow). The README says "primary keys must be TEXT," but nothing enforces it;
numeric PKs silently mis-sort rather than erroring.

A correct comparator, `RowCodec.createPrimaryKeyComparator`
(`row-codec.ts:155-184, 243-292`), already exists but is dead code — it is
referenced only by tests and never passed to `Tree.createOrOpen`
(`collection-factory.ts:43`). It also has a bug: `deserializeKeyPart`
(`row-codec.ts` region noted in review) mis-classifies numeric-looking TEXT such
as `'123'`, so it cannot simply be wired in as-is.

## Expected behavior

Ordering the planner claims must match ordering the tree delivers. Options:

- Wire the real comparator into `Tree.createOrOpen` **after** fixing its
  type-sniffing (so `'123'` stored as TEXT stays TEXT), or
- move to an order-preserving key encoding.

At minimum, until true ordering exists: reject non-TEXT / DESC / collated PKs at
`create()`, and stop advertising `providesOrdering` beyond ascending BINARY TEXT.

## Edge cases

- Integer vs text PK ordering; mixed numeric-looking text values.
- DESC index and DESC PK ranges.
- Non-BINARY / case-insensitive collations.
- Round-trip: value stored, key serialized, comparator, deserialize, must be
  consistent. Coordinate with sq-1 (range) and sq-3/sq-4 (key encoding).
