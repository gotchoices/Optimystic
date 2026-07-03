description: A SQL query with a "greater than / less than" filter on a table's primary key was returning every row instead of just the matching ones; fixed and verified.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/test/composite-pk-point-lookup.spec.ts, packages/quereus-plugin-optimystic/README.md
difficulty: easy
----

## Summary

Primary-key range predicates (`WHERE pk > x`, `<`, `>=`, `<=`) on the Optimystic
virtual-table module returned the whole table. `getBestAccessPlan`'s range branch
falsely reported the filter as handled (`bestHandledFilters = [true]`,
`bestIndexName = '_primary_'`, `bestSeekColumnIndexes`), so Quereus omitted its own
predicate re-check and dispatched `plan=3` to `executeRangeQuery` — a stub that just
calls `executeTableScan`. Net: predicate silently dropped, all rows returned.

**Fix** (`optimystic-module.ts:1746`): the range branch now mirrors the
partial-PK-equality branch — reports the filter **not handled**
(`bestHandledFilters = request.filters.map(() => false)`), sets no
index/seek/ordering, keeps only the 0.25-selectivity cost hint. Quereus applies the
predicate itself over a full scan → correct subset. Full O(log n + k) range seek is
deferred (see tripwire below).

## Review findings

Adversarial pass over the implement diff (`161043c`). Scope: correctness of the
plan-branch change, test adequacy, doc drift, deferral justification.

- **Correctness — CONFIRMED sound.** The range branch now matches the existing
  partial-PK-eq branch (`optimystic-module.ts:1735`) exactly in shape: not-handled +
  no seek + cost hint. Verified `bestIsSet` need not be re-set to `false` here — it is
  only ever `true` after the full-PK-equality branch, which `break`s immediately, so it
  is still `false` when the range branch runs. Return object at `:1826` propagates
  `handledFilters: [false...]` with `indexName`/`seekColumnIndexes` undefined → engine
  full scan. No defect.

- **Deferral rationale — CONFIRMED.** The `// NOTE:` tripwire claims the seek is unsafe
  because `RowCodec.serializeKeyPart` encodes numbers via `value.toString()`
  (`row-codec.ts:162`, `:166`) and the tree compares raw lexicographically. Read both
  sites — accurate: `"10" < "9"` lexicographically, so a numeric range span would be
  wrong. README:80's "order-preserving injective tuple framing" refers to the *tuple
  element framing* (`key-encoding.ts`), which is order-preserving; the per-element
  *numeric payload* is not. No contradiction. Both deferred tickets referenced by the
  NOTE exist: `tickets/backlog/debt-optimystic-pk-range-seek.md` and
  `tickets/fix/optimystic-tree-comparator-lexicographic-missort.md`. Tripwire points at
  real work.

- **Doc drift — FIXED inline (minor).** `README.md:82` still claimed "range scans are
  optimized" — false after this fix. Rewrote to: point lookups are O(log n) seeks;
  range predicates and all other predicates currently apply over a full scan.

- **Test coverage — adequate, one gap noted (minor, not fixed).** New regression test
  covers `>` and `<` (`id > 'c'` → 2 rows; `id > 'a' AND id < 'e'` → 3 rows). Does not
  separately exercise `>=`/`<=`, but all four ops share one branch, so `>` proves the
  path. TEXT-only keys keep assertions valid under the still-lexicographic comparator —
  correct scoping (tests "predicate applied at all", not seek precision). The test fails
  before the fix (returned 5) and passes after — genuine regression guard.

- **Dead-code / stub — noted, no action.** `executeRangeQuery` (`optimystic-module.ts:594`)
  is now unreachable via `plan=3` (nothing emits a range seek plan). Left in place as
  documented; becomes live again when `debt-optimystic-pk-range-seek` lands. Not a defect.

- **Resource cleanup / error handling / type safety — checked, nothing found.** Change is
  a pure planner-hint edit; no new resources, no new throw paths, types unchanged
  (`typecheck` clean).

### Tripwire (recorded, not a ticket)

The existing `// NOTE:` at `optimystic-module.ts:1747` is the tripwire: range seek is
deliberately not pushed down until an order-preserving comparator lands. It already names
the follow-up (`debt-optimystic-pk-range-seek`, prereq
`optimystic-tree-comparator-lexicographic-missort`). No new tripwire needed.

## Validation

From `packages/quereus-plugin-optimystic`:

```
yarn build      # success
yarn typecheck  # clean
yarn test       # 294 passing, 11 pending, 0 failing (3m)
```

## Deferred (unchanged from implement)

- Full range seek not implemented — correctness restored, no performance win yet.
  Tracked in `debt-optimystic-pk-range-seek` (blocked on
  `optimystic-tree-comparator-lexicographic-missort`).
