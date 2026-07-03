description: A SQL query with a "greater than / less than" filter on a table's primary key returns every row instead of just the matching ones; fix by no longer telling the engine we applied that filter.
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/composite-pk-point-lookup.spec.ts
difficulty: easy
----

## Bug (confirmed)

For the Optimystic virtual-table module, a primary-key range predicate
(`WHERE pk > x`, `<`, `>=`, `<=`) returns the **whole table** instead of the
matching subset.

Traced end to end:

1. `getBestAccessPlan` — range branch at `optimystic-module.ts:1746-1766` — marks
   the range filter **handled**:
   ```
   bestHandledFilters = request.filters.map((_, idx) => idx === i);
   bestIndexName = '_primary_';
   bestSeekColumnIndexes = [...pkColumns];
   // and may set bestOrdering via orderingMatchesPrimaryKey(...)
   ```
2. Quereus (`rule-select-access-path.ts:659-719`) reads that plan and emits a
   `plan=3` range `IndexSeekNode`. Because the constraint is reported handled
   (`omit`), the engine does **not** re-check it — the module owns applying it.
3. Dispatch (`optimystic-module.ts:487`) routes `plan=3` to
   `executeRangeQuery`, which is a stub (`optimystic-module.ts:594-601`) that
   ignores `_filterInfo` and calls `executeTableScan`.

Net effect: the predicate is silently dropped and every row comes back.

> Reproduction was confirmed by code trace, not a live run. The regression test
> below is the runnable proof and must be added as part of this ticket.

## Why the "short-term / safe" resolution, not the full seek

The ticket offers two fixes. **Do the safe one here.** The full range seek
(build a `KeyRange` and iterate only the matching span) is **not correct yet**
and is deferred to a separate backlog ticket
(`debt-optimystic-pk-range-seek`, prereq `optimystic-tree-comparator-lexicographic-missort`):

- `RowCodec.serializeKeyPart` (`row-codec.ts:150-179`) encodes numbers with
  `value.toString()`, which is **not** order-preserving (`"10" < "9"`, negatives
  invert).
- The tree is opened with a **raw lexicographic string comparator**; the
  order-aware `createPrimaryKeyComparator` is dead code (see the NOTE at
  `row-codec.ts:249-252`).

So a real seek span would be wrong for numeric / DESC / non-BINARY-collation
keys until sq-2 (`optimystic-tree-comparator-lexicographic-missort`) wires up a
correct comparator. Claiming `providesOrdering` for a range has the same
dependency. Until then, the only correct move is to stop claiming the filter is
handled and let the engine apply it over a full scan — correct results, no seek
optimization.

## The fix

In `getBestAccessPlan`, make the primary-key range branch behave like the
existing **partial-PK-equality** branch (`optimystic-module.ts:1735-1745`),
which already does the right thing: keep the reduced-selectivity cost/row
estimate as a planner hint, but report the filter as **not handled** and provide
**no** index/seek/ordering, so Quereus applies the predicate itself.

Concretely, in the `isPkColumn && ['>','>=','<','<='].includes(filter.op)` branch:

- set `bestHandledFilters = request.filters.map(() => false);`
- do **not** set `bestIndexName`, `bestSeekColumnIndexes`, or `bestOrdering`
  (leave them undefined for this branch);
- keep `bestCost` / `bestRows` selectivity estimate if it improves on the
  running best (harmless, purely a cost hint).

Leave `executeRangeQuery` as-is for now (it becomes reachable again only when the
full seek lands); optionally tighten its comment to point at
`debt-optimystic-pk-range-seek`.

Add a `// NOTE:` at the range branch recording that the seek is deliberately not
pushed down pending the ordering fix, so the set stays greppable.

## Regression test

Add to `packages/quereus-plugin-optimystic/test/composite-pk-point-lookup.spec.ts`
(reuse its `createDb` / `selectScalar` local-transactor harness — no mocking) or
a sibling `pk-range-filter.spec.ts` using the same pattern:

- create a table with a TEXT primary key, insert several rows (e.g. keys
  `'a'..'e'`);
- `SELECT count(1) FROM t WHERE id > 'c'` must equal the matching subset (2),
  **not** the full table (5);
- also assert a lower+upper case, e.g. `WHERE id > 'a' AND id < 'e'`;
- keep keys TEXT and lexicographically spaced so the assertion holds regardless
  of the still-lexicographic comparator (the point is the predicate is applied at
  all, not seek precision).

## Validate

From `packages/quereus-plugin-optimystic`:

```
yarn build 2>&1 | tee /tmp/build.log
yarn test 2>&1 | tee /tmp/test.log
```

(The suite imports from `dist/`, so build before test.) Confirm the new test
fails before the fix and passes after. Type-check with `yarn typecheck`.

## TODO

- [ ] Edit the PK range branch in `getBestAccessPlan` to report the range filter
      not-handled with no index/seek/ordering (mirror the partial-PK-eq branch).
- [ ] Add the `// NOTE:` tripwire at the branch pointing at the deferred seek.
- [ ] Add the regression test (subset returned, not full table; incl. lower+upper).
- [ ] `yarn build && yarn test && yarn typecheck` in the plugin package; stream output.
- [ ] Hand off to review noting the full seek is deferred to
      `debt-optimystic-pk-range-seek`.
