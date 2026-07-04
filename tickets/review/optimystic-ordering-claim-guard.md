description: Verify the fix that stops the query planner from claiming rows are already sorted in ways the storage tree can't actually deliver — which previously returned genuinely mis-ordered results.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/ordering-claim-guard.spec.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/README.md
difficulty: medium
----

## What this fixed (one paragraph)

The Optimystic virtual-table query planner tells the SQL engine, via
`providesOrdering`, when a chosen access path already returns rows in the
requested `ORDER BY` order — the engine then skips its own sort and trusts the
rows as-is. The storage B+tree is opened with a raw lexicographic string
comparator and iterated forward only, so it can only ever *deliver* an
**ascending, BINARY-collation, TEXT** ordering. The old planner promised
orderings it couldn't deliver (descending, numeric, non-BINARY), so those queries
came back **genuinely mis-ordered — wrong results, not just slow**. The fix
tightens the promise to exactly the envelope the tree can honour; everything else
falls back to the engine's own sort (correct, just not pushed down).

## Changes made

**Phase 1 — the fix** (`optimystic-module.ts`):
- `orderingMatchesIndex` now takes the table's column metadata and, per ordered
  column, calls a new helper `treeDeliversOrdering(orderSpec, tableInfo)` that
  returns true only when the column is **ASC** (`orderSpec.desc === false`),
  **BINARY**-collated, and physically **TEXT** (`logicalType.physicalType ===
  PhysicalType.TEXT`). Any ordered column failing this → `providesOrdering` stays
  undefined → engine sorts.
- **Behaviour-change note for the reviewer:** the old code matched the index's
  declared `desc` flag against the query (`orderSpec.desc === indexCol.desc`).
  That check is *gone*. Rationale: the tree ignores the declared `desc` flag at
  write time (it always stores ascending lexicographic), so the flag is
  irrelevant to what is delivered. Only the *query's* direction matters, and only
  ASC is deliverable. Consequence: a DESC-declared index queried **ASC** on a
  TEXT/BINARY column is now (correctly) promised, where before it was rejected;
  any **DESC** query is now always rejected.
- The point-lookup branch (full-PK equality, single row) is unchanged — any
  `ORDER BY` is trivially satisfied by one row.
- Deleted the dead, un-guarded `orderingMatchesPrimaryKey` helper (no callers) so
  it can't be wired up unsafely later.

**Phase 2 — dead-comparator prep** (`row-codec.ts`, no live behaviour change):
- `deserializeKeyPart` / `keyElementToValue` are now **affinity-driven** (the
  comparator threads each PK column's affinity in) instead of sniffing with
  `Number()`. TEXT `"123"`, `" "`, `"1e2"`, `"0xff"` now stay strings; only
  INTEGER/REAL/NUMERIC affinities parse to a number.
- This comparator (`createPrimaryKeyComparator`) is **still dead code** — it is
  not wired into the tree. Wiring it flips stored order and is gated work
  (`debt-optimystic-true-key-ordering`, itself gated on the
  `debt-optimystic-key-format-migration` product decision). The three `NOTE:`
  comments that said "sq-2" now cite `debt-optimystic-true-key-ordering`.

**Phase 3 — tests** (`ordering-claim-guard.spec.ts` new, `row-codec.spec.ts`
flips): see validation section.

**Phase 4 — docs** (`README.md`): softened the two "primary keys must be TEXT"
claims to "TEXT for ordered/range performance; other types work correctly but are
not pushed down / order-provided," and added a sentence spelling out the
ASC+BINARY+TEXT `ORDER BY` envelope.

## How it was validated (reviewer: treat this as the floor, not the ceiling)

Build, typecheck, and the full package suite are green:
`yarn build` ✓, `yarn typecheck` ✓, `yarn test` → **303 passing, 11 pending, 0
failing** (~3 min; run from `packages/quereus-plugin-optimystic`). No
pre-existing failures were surfaced.

**Fail-before / pass-after was verified empirically**, not just asserted: I
temporarily neutralised the guard (`treeDeliversOrdering` → `return true`),
rebuilt, and ran the new spec — all guard tests went red, including the SQL
end-to-end ones, which returned the exact mis-orderings:
- numeric suffix: `[10, 100, 2, 5]` instead of `[2, 5, 10, 100]`
- DESC text: `['apple','banana','cherry']` (ascending) instead of
  `['cherry','banana','apple']`
Then I reverted and confirmed all green. So the SQL layer *does* reproduce (the
optimizer passes the compound `ORDER BY` through and trusts `providesOrdering`).

### Test inventory (use cases)

`test/ordering-claim-guard.spec.ts`:
- **Planner-level (deterministic, feed `requiredOrdering` straight in — these are
  the authoritative fail-before/pass-after tests, independent of how the
  optimizer shapes ORDER BY):**
  - ASC + BINARY + TEXT prefix → `providesOrdering` IS set (safe case still
    pushed down; positive control against over-blocking).
  - REAL suffix column → `providesOrdering` undefined, index seek still chosen.
  - DESC column (on a TEXT column, so only the direction disqualifies it) →
    undefined.
  - NOCASE (non-BINARY) column → undefined.
  - single-column DESC on the leading index column → undefined.
- **End-to-end SQL (user-visible correctness):**
  - numeric suffix across the exponent-10 boundary returns `[2,5,10,100]`.
  - DESC text returns true descending order.

`test/row-codec.spec.ts`: the three former "known bug" tests are flipped to
assert affinity-driven correctness (TEXT keeps `"123"`, `" "`, `"1e2"` as
strings). All other row-codec tests unchanged and passing.

## Known gaps / what is deliberately NOT done (out of scope)

- **True numeric / DESC / non-BINARY ordering is not implemented.** Those queries
  now fall back to the engine's own sort — correct, but `O(n log n)` where the
  tree could do `O(log n + k)`. Widening the promise requires the tree's stored
  order to equal SQL value order, which flips on-disk order and is gated:
  `debt-optimystic-true-key-ordering` (→ `debt-optimystic-key-format-migration`).
- **The order-aware `createPrimaryKeyComparator` remains dead code.** Phase 2 only
  de-risked its per-part decode; it is not wired into any tree. Reviewer should
  confirm this is still true (no `Tree.createOrOpen` passes it) — wiring it is the
  gated ticket's job.
- **Collation guard is a name check** (`col.collation` uppercased === `'BINARY'`).
  It does not consult `collationExplicit`. This is intentional: an implicit
  default is BINARY and *is* deliverable, so treating "absent/BINARY" as safe is
  correct. Worth a reviewer glance that no non-BINARY default sneaks through.
- **`treeDeliversOrdering` keys off `logicalType.physicalType`**, not the stored
  affinity string. For real columns these agree; flagging in case the reviewer
  wants the check anchored to the persisted `affinity` instead.

## Tripwires parked (not tickets)

None filed as tickets. The one conditional concern — the affinity-driven
`deserializeKeyPart` guards `Number(' ') === 0` via `serialized.trim() !== ''` —
lives inline as a code comment at the numeric branch in `row-codec.ts`; it only
matters if/when the dead comparator is ever wired up. No separate ticket
warranted.

## Downstream tickets (already consistent — no action needed here)

- `debt-optimystic-true-key-ordering` and `debt-optimystic-pk-range-seek` already
  reference this ticket and correctly state their real gate is
  `debt-optimystic-true-key-ordering` (not this guard). Their prereqs were
  already repointed; nothing left to change.
