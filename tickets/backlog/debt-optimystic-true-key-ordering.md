description: Make Optimystic tables actually store rows in true value order — so numeric and descending sorts can be served directly from the tree instead of the engine having to re-sort — which first requires deciding how to handle databases already on disk.
prereq: debt-optimystic-key-format-migration
files: packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/src/schema/index-manager.ts, packages/quereus-plugin-optimystic/src/optimystic-module.ts
difficulty: hard
----

## Context

`optimystic-ordering-claim-guard` fixed the *correctness* bug where the planner
promised sort orders the storage tree couldn't deliver: it now only promises
"already ordered" for ascending, BINARY-collation, TEXT columns, and the engine
re-sorts everything else. Correct, but numeric and descending `ORDER BY`, and
range predicates on numeric keys, all fall back to a full scan + engine sort —
`O(n log n)` where the tree could give `O(log n + k)`.

This ticket makes the tree's stored order *equal* the SQL value order, so those
orderings and range seeks can be served directly.

## Why this is gated

Optimystic B+trees are ordered at write time by their comparator
(`collection-factory.ts:46`, raw lexicographic). Delivering true order requires
**either**:

- an **order-preserving key encoding** — encode numbers so lexicographic byte
  order equals numeric order (sign-aware, fixed-width exponent, negatives), for
  both `RowCodec.serializeKeyPart` (primary keys) and `serializeIndexValue`
  (index keys), **or**
- a **schema-aware tree comparator** — wire the already-written (but dead)
  `RowCodec.createPrimaryKeyComparator` (`row-codec.ts:238`) into
  `Tree.createOrOpen`, plus an analogous per-index comparator for index trees.
  (Its type-sniff bug was fixed in `optimystic-ordering-claim-guard`; it decodes
  affinity-driven now.)

**Both approaches change the order keys sit in the tree**, so a collection
persisted under today's ordering becomes internally inconsistent after the
change — the exact hazard tracked by `debt-optimystic-key-format-migration`.
That migration decision must be made first; hence the `prereq`.

Descending orderings and non-BINARY collations still cannot be served by forward
ascending iteration alone — they need reverse iteration and/or a collation-aware
comparator. Decide per-case whether to support them at the tree level or keep
letting the engine re-sort (the guard already makes the latter correct).

## Downstream

`debt-optimystic-pk-range-seek` depends on this: a correct range seek needs tree
order to match value order. Only after this lands may `getBestAccessPlan`
re-widen its `providesOrdering` / range-handled claims beyond the guard's
ASC/BINARY/TEXT envelope.

## Open questions for whoever picks this up

- Encoding vs comparator: encoding keeps the cheap lexicographic tree compare and
  is uniform across data + index trees; a comparator avoids re-encoding every
  payload but must be threaded per-tree (data + each index) and is costlier per
  compare. Pick one and apply it consistently to both key kinds.
- Reconcile with `serializeIndexValue`'s existing partial `toExponential(15)`
  scheme — replace, don't layer.
- Reverse iteration support in `Tree`/`read.range` for DESC, or leave DESC to the
  engine.
