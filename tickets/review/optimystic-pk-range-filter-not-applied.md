description: Range predicate on a primary key now returns the matching subset; fix stops falsely claiming the filter was handled.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/composite-pk-point-lookup.spec.ts
difficulty: easy
----

## What was done

**Bug:** `getBestAccessPlan` range branch (`>`, `>=`, `<`, `<=` on PK column) set
`bestHandledFilters = [true for that filter]` and reported `bestIndexName = '_primary_'`
/ `bestSeekColumnIndexes`. Quereus treated the filter as applied by the module (`omit`),
dispatched `plan=3` to `executeRangeQuery` (a stub that calls `executeTableScan`), and
never re-checked the predicate → full table returned.

**Fix (`optimystic-module.ts` ~line 1746):** Range branch now mirrors the partial-PK-equality
branch — sets `bestHandledFilters = request.filters.map(() => false)`, removes
`bestIndexName`/`bestSeekColumnIndexes`/`bestOrdering` assignments, keeps the 0.25
selectivity cost hint. Quereus applies the predicate itself over a full scan → correct results.

**`// NOTE:` tripwire** added at the branch explaining why the seek is not pushed down:
`RowCodec.serializeKeyPart` uses `toString()` (not order-preserving for numbers) and the
tree uses a raw lexicographic comparator. The note names the deferred ticket
`debt-optimystic-pk-range-seek` and its prereq `optimystic-tree-comparator-lexicographic-missort`.

**Regression test** added to `test/composite-pk-point-lookup.spec.ts`:
- TEXT PK table with rows `'a'..'e'`
- `WHERE id > 'c'` → 2 rows (not 5)
- `WHERE id > 'a' AND id < 'e'` → 3 rows

## Validation

```
yarn build   # clean
yarn typecheck  # clean
mocha test/composite-pk-point-lookup.spec.ts  # 5 passing (1s)
```

## Known gaps / deferred

- **Full range seek not implemented.** `executeRangeQuery` is still a stub calling
  `executeTableScan`. Correctness is restored but there is no O(log n + k) performance win.
  Tracked in `debt-optimystic-pk-range-seek` (blocked on `optimystic-tree-comparator-lexicographic-missort`).
- The regression test intentionally uses only TEXT/lexicographic keys so assertions hold
  regardless of the comparator — it tests "predicate is applied at all", not seek precision.

## Review findings

- Tripwire at `optimystic-module.ts` range branch (the `// NOTE:` tag) records the deferred
  seek rationale and points at `debt-optimystic-pk-range-seek`.
