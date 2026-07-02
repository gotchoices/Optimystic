description: Review a new randomized stress test that replays random insert/delete/lookup/range operations against the sorted-key index and checks it always agrees with a simple reference list, catching rare rebalancing and iteration bugs.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.property.spec.ts (new), packages/db-core/test/btree.spec.ts (unchanged, regression baseline), packages/db-core/test/test-block-store.ts, packages/db-core/test/transform.property.spec.ts (pattern followed)
difficulty: medium
----

## What landed

Two changes in `packages/db-core`:

1. **Configurable fan-out on `BTree`** (`src/btree/btree.ts`). `NodeCapacity` (the module const `= 64`) is now the *default* for a new per-instance field `nodeCapacity`. The constructor gained a defaulted `nodeCapacity = NodeCapacity` parameter, and `BTree.create(...)` gained a `nodeCapacity` parameter **inserted at position 5, before the pre-existing `newId`** (`create(store, createTrunk, keyFromEntry, compare, nodeCapacity, newId)`). Every one of the 12 `NodeCapacity` references inside instance methods (`leafInsert`, `branchInsert`, `rebalanceLeaf`, `rebalanceBranch`) was replaced with `this.nodeCapacity`. The module const and the two constructor/create defaults still reference `NodeCapacity`. No other module references `NodeCapacity` (verified by grep), so blast radius is one file plus its in-file callers.

2. **New model-based property/fuzz suite** (`test/btree.property.spec.ts`). Seeded fast-check (`^4.7.0`) drives a random insert/delete/find/range op mix and, **after every op**, checks the tree against a plain sorted `number[]` reference model.

Full db-core suite: **1042 passing, 0 failing**. Local pinned `tsc` 5.9.3 (`node node_modules/typescript/bin/tsc --noEmit`) is clean including the new spec. The prereq fix `btree-range-scan-stops-at-leaf-boundary` is landed (commit `f251ca3`), so the range portion lands green.

## Why the fan-out change was necessary

At fixed fan-out 64, forcing a 3-4 level tree (where borrow/merge/cascade fire) needs thousands of entries — the existing 4-level regression inserts 70 000 and runs ~6 s. Far too slow inside a fast-check property with 100 runs. With `nodeCapacity` 4-8, the property builds multi-level trees from dozens of entries per run; the `it('reaches a multi-level tree at fan-out 4 ...')` guard asserts `branchLevels >= 3` at capacity 4, proving the property is actually exercising the rare rebalance branches rather than single-leaf inserts.

## What the suite checks (after every operation)

- **Count** — `getCount()` equals `model.length`.
- **Full ascending scan** — `first()` + `moveNext`/`at` deep-equals the model.
- **Full descending scan** — `last()` + `movePrior` deep-equals the reversed model.
- **Point lookups** — every present key resolves to itself; every present key ±0.5 (between-entry) and min-1 / max+1 (out-of-range) resolve to `undefined`.
- **Range scans from many start keys** — ascending first-only (`>= s`), descending first-only (`<= s`), plus one bounded ascending and one bounded descending (`first`+`last`). Start keys include model min/mid/max, out-of-range keys, `max + 0.5`, `mid + 0.5`, and the just-applied op's key ± 0.5 — so delete-driven and between-entry / end-of-leaf-crack starts are exercised.

Op semantics mirror the tree: `insert` of a present key is a no-op and `insert().on === false` on conflict; `delete` of an absent key is a no-op and `find().on === false`.

## How to run / validate

```
cd packages/db-core
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/btree.property.spec.ts" --colors --reporter spec
```

Full suite: `yarn test` (or the mocha invocation above with `"test/**/*.spec.ts"`). Typecheck: `node node_modules/typescript/bin/tsc --noEmit` (use the **local** tsc — a globally-installed newer tsc will abort on the pre-existing `downlevelIteration` tsconfig deprecation, which is unrelated to this ticket).

Seed is pinned (`SEED = 0x0b7ee5` = `753381`), `console.log`'d at suite start, and passed with `endOnFailure: true`. To reproduce a CI failure, paste the logged seed (and fast-check's printed counterexample) back into `fc.assert`'s options.

## Known gaps / where to push (reviewer: treat tests as a floor)

- **Fixed seed = fixed corpus.** Per the ticket's reproducibility requirement the seed is pinned, so the same 100 (small) / 20 (large) op-sequences run every time. This is a *permanent guard*, not a run-to-run varying fuzzer — it will not discover new counterexamples across CI runs. A reviewer wanting wider coverage could add a nightly/opt-in variant that omits `seed` (or reads it from env). Parked as a tripwire, not a ticket.
- **Mutating ops are insert/delete only.** `updateAt`, `upsert`, and `merge` are not in the op mix (ticket scoped to insert/delete/find/range). Their key-change / delete-reinsert paths are covered only by `btree.spec.ts`, not fuzzed. A natural extension.
- **Bounds are always inclusive.** `KeyBound.inclusive = false` is never exercised by the range battery (the model filters assume inclusive). Exclusive-bound range semantics remain covered only by non-fuzz tests.
- **`range` op kind is folded into the battery.** Because the invariant battery runs range checks (driven by the op's `probeKey`) after *every* op, a distinct `range` op only varies which start keys get tested; it does not generate independent `first`/`last`/direction tuples. Coverage is broader (ranges checked every op) but less targeted per-op than a literal generated range. Verify this matches intent.
- **Per-op battery cost is ~O(model.length × rangeStarts).** Cheap at current sizes; a `NOTE:` tripwire at the `checkInvariants` site flags that pushing `numRuns`/`maxLength` much higher should switch to sampling present-key lookups.
- **`create` param order.** `nodeCapacity` was inserted *before* `newId`. `newId` is currently dead (no caller passes it; both callers — `tree.ts:57` and `btree.spec.ts:17` — ignore the trunk factory's third arg), so this is safe today, but a future caller wanting `newId` must now also pass `nodeCapacity`. Confirm the ordering is acceptable vs. appending `nodeCapacity` last.

## Review findings

- Tripwire (fixed-seed corpus): the pinned seed makes this a fixed guard, not a run-to-run varying fuzzer — noted in the "Known gaps" above; no code site, parked here.
- Tripwire (battery cost): `NOTE:` comment at `checkInvariants` in `test/btree.property.spec.ts` — per-op cost grows with model size; switch to sampling if run sizes are pushed much higher.
