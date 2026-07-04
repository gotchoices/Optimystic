description: Verified the fix that stops the query planner from claiming rows are already sorted in ways the storage tree can't actually deliver — which previously returned genuinely mis-ordered results.
prereq:
files: packages/quereus-plugin-optimystic/src/optimystic-module.ts, packages/quereus-plugin-optimystic/src/schema/row-codec.ts, packages/quereus-plugin-optimystic/test/ordering-claim-guard.spec.ts, packages/quereus-plugin-optimystic/test/row-codec.spec.ts, packages/quereus-plugin-optimystic/README.md
----

## Summary

The Optimystic virtual-table query planner used to tell the SQL engine (via
`providesOrdering`) that a chosen index already returned rows in the requested
`ORDER BY` order for orderings the storage B+tree cannot physically deliver
(descending, numeric, non-BINARY collation). The engine then skipped its own sort
and returned **genuinely mis-ordered rows**. The implement stage added a guard
(`treeDeliversOrdering`) that only promises the exact envelope the raw ascending
lexicographic, forward-iterated tree honours — **ASC + BINARY + TEXT** — and lets
the engine sort everything else. This review confirmed the fix is correct and
complete, ran the full validation, and closed two small coverage/documentation
gaps inline.

## Review findings

**What was checked**

- Read the full implement diff (`af587ae`) before the handoff summary: the guard
  logic (`orderingMatchesIndex` + `treeDeliversOrdering`), the affinity-driven
  `row-codec.ts` decode, the flipped `row-codec.spec.ts` assertions, the new
  `ordering-claim-guard.spec.ts`, and the README softening.
- **Completeness of the guard vs. every site that sets `bestOrdering`.** Traced
  all three assignments in `getBestAccessPlan`: (1) full-PK point lookup — a
  single row trivially satisfies any `ORDER BY`, correct and unguarded by design;
  (2) secondary-index seek — now routed through the guard; (3) everywhere else
  (full scan, partial-PK, range) leaves `bestOrdering` undefined. So the guard
  covers every path that could over-promise. No gap.
- **Dead-reference sweep** for the deleted `orderingMatchesPrimaryKey` — no
  callers remain.
- **The physicalType↔storage coupling.** Confirmed `serializeIndexValue` keys the
  payload off the *runtime JS value type* (string → raw order-preserving, number →
  non-order-preserving `toExponential(15)`), while the guard gates on the
  *declared* `logicalType.physicalType`. They agree only because Quereus coerces
  TEXT-affinity inserts to strings before they reach the vtab.
- **Collation / DESC / numeric edge cases** in `treeDeliversOrdering`: undefined
  `collation` defaults to BINARY (deliverable, correct); undefined `logicalType`
  fails closed (engine sorts); `desc` truthy check treats undefined as ASC
  (correct). All conservative-safe.
- **Row-codec Phase 2** confirmed still dead code (comparator not wired into any
  `Tree.createOrOpen`); the change only de-risks its per-part decode.
- **Docs**: README `Limitations` and the schema paragraph now match the new
  ASC+BINARY+TEXT reality.
- Ran build ✓, typecheck ✓, eslint on changed files ✓, and the **full package
  suite: 304 passing, 11 pending, 0 failing** (~3 min, run from
  `packages/quereus-plugin-optimystic`). No pre-existing failures surfaced.

**Minor — fixed inline this pass**

- *Missing positive end-to-end coverage.* The implement tests proved the guard
  *blocks* over-promising (negative SQL cases) and *makes* the promise
  (planner-level positive), but nothing exercised the highest-risk path
  end-to-end: when the guard **does** push the ordering down, the engine skips its
  sort and trusts the tree — a silently-mis-delivered promised ordering would go
  uncaught. Added an ASC+BINARY+TEXT SQL test
  (`ordering-claim-guard.spec.ts`) that inserts out-of-order TEXT rows and asserts
  they come back correctly ordered. Passes (verifies the guard + the sibling
  comparator fix `optimystic-tree-comparator-lexicographic-missort` together).

**Tripwire — parked as a code comment, not a ticket**

- The guard gates on the *declared* `physicalType === TEXT`, but the actual stored
  payload is chosen by the runtime value type in `serializeIndexValue`. These
  agree only under Quereus's TEXT-affinity insert coercion. Fine today; would
  over-order only if a numeric value ever reached a TEXT column un-coerced. Left a
  `NOTE:` at the `treeDeliversOrdering` TEXT check pointing at that assumption and
  the remedy (anchor the check to the persisted affinity). Conditional, not a
  present defect — no ticket.

**Major — none.** No new fix/plan/backlog tickets filed. The known gaps the
implementer listed (true numeric/DESC/non-BINARY ordering, wiring the dead
comparator) are already tracked by `debt-optimystic-true-key-ordering` (gated on
`debt-optimystic-key-format-migration`) and `debt-optimystic-pk-range-seek`; both
already reference this work and need no change.

**Speculative/other — none beyond the tripwire above.**
