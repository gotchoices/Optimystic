description: A randomized stress test that replays random insert/delete/lookup/range operations against the sorted-key index and checks it always matches a simple reference list, catching rare rebalancing and iteration bugs.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.property.spec.ts, packages/db-core/package.json
difficulty: medium
----

## What landed

Two changes in `packages/db-core` (implement commit `789541e`):

1. **Configurable fan-out on `BTree`** (`src/btree/btree.ts`). `NodeCapacity` (module const `= 64`) is now the *default* for a new per-instance `nodeCapacity` field. The constructor gained a defaulted `nodeCapacity = NodeCapacity` param; `BTree.create(...)` gained a `nodeCapacity` param at position 5, before the pre-existing (and currently unused) `newId`. All 12 in-method `NodeCapacity` references became `this.nodeCapacity`; the const and the two constructor/create defaults still reference `NodeCapacity`.

2. **Model-based property/fuzz suite** (`test/btree.property.spec.ts`). Seeded fast-check drives a random insert/delete/find/range op mix and, after every op, checks the tree against a plain sorted `number[]` reference model (count, both full scans, point lookups incl. between-entry/out-of-range, and range scans from many start keys). Small per-instance fan-out (4-8) forces multi-level trees from dozens of entries so borrow/merge/cascade fire cheaply; a deterministic third test asserts `branchLevels >= 3` at fan-out 4 to prove the rare rebalance branches are actually exercised.

## Review findings

**Checked — no defects found.** The implement diff is a mechanical, behavior-preserving refactor plus a new test file; both build and the full suite pass.

- **Refactor completeness (verified good).** All 12 `NodeCapacity` → `this.nodeCapacity` conversions are present and correct (leafInsert, branchInsert, rebalanceLeaf ×5, rebalanceBranch ×5); none missed. The module const and the two default-parameter references correctly still point at `NodeCapacity`. Grep confirms no other module references the symbol.
- **Caller blast radius (verified good).** The only production caller, `src/collections/tree/tree.ts:57`, passes 4 positional args (through `compare`), so `nodeCapacity` defaults to 64 — unchanged behavior. `newId` has zero callers repo-wide, so inserting `nodeCapacity` ahead of it breaks nothing today. The param ordering is acceptable as-is (no `newId` caller exists to disturb, and appending would be no cleaner); left unchanged.
- **Dependency hygiene (verified good).** `fast-check ^4.7.0` is declared under `devDependencies` and resolves to installed `4.7.0`, so a clean CI install runs the new spec.
- **Model/battery correctness (verified good).** Traced the reference-model semantics for ascending/descending scans, point lookups (present, ±0.5 between-entry, min-1/max+1), and first-only / bounded range scans against `Array.filter`; all match the tree's dup-rejecting, inclusive-bound behavior.
- **Test results (verified).** `tsc --noEmit` (local pinned 5.9.3) clean; property spec 3/3 passing (139ms/–/54ms); full db-core suite **1042 passing, 0 failing** (~7s). Lint is a repo stub (`echo`, not configured), so `tsc` is the type gate.

**Minor observation (no change made).** The `default fan-out (64) over larger sequences` test uses `maxLength 60` and `keyMax 300`; reaching a leaf split at capacity 64 needs 65 distinct inserts, which that op budget cannot produce, so this test only cross-checks *single-leaf* agreement rather than the "larger" trees its name implies. This is not a defect — multi-level coverage is guaranteed by the deterministic third test (`branchLevels >= 3` at fan-out 4). Left as-is: forcing a split at fan-out 64 would require ~3× the op budget and still be probabilistic (risking flake), for coverage the small-fan-out suite already provides deterministically.

**Tripwires (conditional; parked, not ticketed).**
- *Fixed-seed corpus.* `SEED` is pinned (per the ticket's reproducibility requirement), so the same op-sequences run every CI run — this is a permanent regression guard, not a run-to-run varying fuzzer. It will not discover *new* counterexamples over time. A future nightly/opt-in variant could omit `seed` (or read it from env). No single code site; recorded here.
- *Per-op battery cost.* A `NOTE:` comment at `checkInvariants` (btree.property.spec.ts:115-119) flags that the battery is ~O(model.length × rangeStarts) per op; cheap at current sizes but should switch to sampling present-key lookups if `numRuns`/`maxLength` are pushed much higher.

**Not covered (out of ticket scope; future extensions, no ticket filed).** The op mix is insert/delete/find/range only — `updateAt`/`upsert`/`merge` key-change paths and exclusive (`inclusive = false`) range bounds remain covered only by the non-fuzz `btree.spec.ts`. Natural extensions if fuzz coverage is later broadened, but not gaps in the delivered scope.

## How to run / validate

```
cd packages/db-core
# property spec only:
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/btree.property.spec.ts" --colors --reporter spec
# full suite:
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --colors --reporter min
# typecheck (use the LOCAL pinned tsc; a newer global tsc aborts on the pre-existing downlevelIteration deprecation):
node node_modules/typescript/bin/tsc --noEmit
```

Seed is `0x0b7ee5` (= 753381), `console.log`'d at suite start and passed with `endOnFailure: true`. To reproduce a CI failure, paste the logged seed and fast-check's printed counterexample back into `fc.assert`'s options.
