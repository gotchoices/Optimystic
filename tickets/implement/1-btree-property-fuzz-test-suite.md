----
description: Add a randomized stress test for the sorted-key index that replays random insert/delete/lookup/range operations against a simple reference map and checks they always agree, to catch rare rebalancing and iteration bugs.
prereq: btree-range-scan-stops-at-leaf-boundary
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.property.spec.ts (new), packages/db-core/test/btree.spec.ts (pattern), packages/db-core/test/transform.property.spec.ts (fast-check pattern), packages/db-core/test/test-block-store.ts, packages/db-core/package.json (fast-check already present)
difficulty: medium
----
Build a seeded, reproducible property/fuzz test for `BTree` (packages/db-core/src/btree/btree.ts) that drives it with a random mix of `insert`, `delete`, `find`/`get`, and `range` operations and, after each operation, checks the tree against a **reference model** — a plain JS sorted array of keys — for full equivalence. `fast-check` (^4.7.0) is already a devDependency; follow the existing pattern in `packages/db-core/test/transform.property.spec.ts` (uses `fc.assert(fc.asyncProperty(...), { numRuns })`).

## Why this ticket exists

The B-tree's rare rebalance branches (borrow-from-sibling, node merge, multi-level cascade) and its iteration cracks are where testing thins and where real correctness bugs have lived. A model-based property test mechanically surfaces them. Several sibling bugs it was written to catch — borrow-from-right wrong partition key, internal-merge separator corruption, branch-split missing store-insert, missing awaits in iteration/update — **have already landed** (all in `tickets/complete/`). One remains open: **`btree-range-scan-stops-at-leaf-boundary`** (end-of-leaf range-scan stall, still live in `internalNext` around btree.ts:391-397). A range scan whose start key lands on an end-of-leaf crack currently yields nothing. The range portion of this suite will exercise exactly that crack.

Because authoring a permanently-red test breaks the whole db-core suite for every other ticket, this suite is **prereq'd on that fix** so it lands green and stays green as a permanent guard, rather than landing red. (When the fix-stage ticket `btree-range-scan-stops-at-leaf-boundary` clears through implement, the runner un-defers this ticket.)

## The reference model

Keep a `number[]` of the keys currently expected present, sorted ascending. The B-tree rejects duplicate keys (`insert` returns a path with `on === false` on conflict — btree.ts:495-504), so the model mirrors that: an insert of an already-present key is a no-op on the model. After each operation, assert:

- **Point lookups** — for a sample of present keys, `get(k)` returns `k`; for a sample of absent keys (including keys between entries and just outside the min/max), `get(k)` is `undefined`.
- **Full ascending scan** — walk `first()` + `moveNext` collecting `at(path)`; must deep-equal the model array.
- **Full descending scan** — walk `last()` + `movePrior`; must deep-equal the reversed model.
- **Count** — `getCount()` equals `model.length`.
- **Range scans from arbitrary start keys** — pick random start keys, *including keys that fall between entries and exactly at a leaf's last entry / a just-deleted maximum* (the boundary that triggers the open bug). `range({ first: KeyBound(start) })` must yield exactly the model's slice `>= start`. Also test a `last` bound and `isAscending: false`.

Use `Path`/`at`/`moveNext`/`movePrior` for scans (see btree.spec.ts:57-68). Note the mutation-during-iteration constraint (btree.ts:90-91): do all read-back scans *between* mutations, never interleaved with a mutation, or the path-invalidation guard throws.

## Configurable fan-out (the enabling change)

`NodeCapacity` is currently a module-level `export const NodeCapacity = 64` (btree.ts:9), referenced only inside instance methods (`leafInsert`, `branchInsert`, `rebalanceLeaf`, `rebalanceBranch` — see grep sites at btree.ts:580, 613, 648, 659, 669, 678, 688, 705, 715, 726, 736, 746). With fan-out fixed at 64, forcing a 3-4 level tree — where borrow/merge/cascade actually fire — needs thousands of entries (the existing 4-level regression test inserts 70 000 and runs ~180 s). That is far too slow to run inside a fast-check property with many iterations.

**Make fan-out a per-instance value defaulting to 64**, so the property test can construct trees with capacity ~4-8 and force multi-level rebalancing with only dozens of entries per run. This is the change that makes the suite both fast and thorough.

Recommended shape (keep the module const as the default so all existing callers are unaffected):

```ts
export const NodeCapacity = 64;

export class BTree<TKey, TEntry> {
  constructor(
    public readonly store: BlockStore<ITreeNode>,
    public readonly trunk: ITreeTrunk,
    public readonly keyFromEntry = (entry: TEntry) => entry as unknown as TKey,
    public readonly compare = (a, b) => a < b ? -1 : a > b ? 1 : 0,
    public readonly nodeCapacity = NodeCapacity,   // NEW, defaulted
  ) { ... }
  // ...
}
```

Then replace every `NodeCapacity` inside instance methods with `this.nodeCapacity`, and thread an optional `nodeCapacity` through `BTree.create(...)` (btree.ts:43-57) into the constructor. All `NodeCapacity >>> 1` half-capacity checks become `this.nodeCapacity >>> 1`. Tradeoff: a handful of mechanical edits in one file; the alternative (large-N only) makes the suite too slow to keep. No other module references `NodeCapacity` (verified by grep), so the blast radius is contained to btree.ts and its callers within the same file.

If for any reason the fan-out change is deferred, the fallback is a smaller single "large-N" property (e.g. a few hundred entries) — document the reduced coverage — but the configurable-fan-out path is strongly preferred.

## Seeding & reproducibility

Drive fast-check with a fixed seed so failures reproduce, and log it. fast-check already prints the failing counterexample and seed on failure; additionally pass an explicit `seed` (and `endOnFailure: true`) in the `fc.assert` options and `console.log` it at suite start, so a CI failure is replayable by pasting the seed back. Keep `numRuns` modest (e.g. 100-300) and set a generous mocha `this.timeout(...)` on the property `it(...)`.

Generate operation sequences with `fc.array(arbOp, { maxLength: N })` where `arbOp` is an `fc.oneof` over insert/delete/find/range shaped records (mirror the `Action` union pattern in transform.property.spec.ts:117-130). Keys drawn from a bounded integer domain (e.g. `fc.integer({ min: 0, max: 200 })`) so inserts, hits, and misses all occur with reasonable frequency and deletes actually target present keys often enough to trigger rebalancing.

## Expected outcome

A new `packages/db-core/test/btree.property.spec.ts` in the db-core suite: seeded, reproducible, fast (multi-level trees via small fan-out), that checks the tree against a sorted-array model after every op across insert/delete/find/range. It passes once its prereq (`btree-range-scan-stops-at-leaf-boundary`) has landed, and stays in the suite as a permanent guard against rebalance/iteration regressions.

## TODO

- Make `nodeCapacity` a per-instance value on `BTree` (default `NodeCapacity`); thread it through `BTree.create`; replace module-const references inside instance methods with `this.nodeCapacity`. Verify existing btree.spec.ts still passes unchanged.
- Create `packages/db-core/test/btree.property.spec.ts` following the fast-check pattern in transform.property.spec.ts and the tree-construction pattern in btree.spec.ts (`new TestBlockStore()` + `BTree.create(store, trunkFactory, undefined, undefined, smallCapacity)`).
- Implement the sorted-array reference model with insert (dup = no-op) and delete semantics matching the tree.
- Generate random op sequences (insert/delete/find/range) over a bounded key domain via fast-check; assert model equivalence after each op: point lookups (present + absent + between-entry + out-of-range), full ascending scan, full descending scan, `getCount`, and range scans from arbitrary start keys including end-of-leaf-crack keys, with both a `first`-only bound and a `first`+`last` bound, ascending and descending.
- Run the property at small fan-out (~4-8) with enough entries per sequence to force several internal levels; a second describe at default capacity 64 with larger sequences is optional but nice.
- Pin and log the fast-check seed; set `endOnFailure: true`; set a generous mocha timeout.
- Run `yarn test` (or the package `test` script) in `packages/db-core` streaming output (`... 2>&1 | tee /tmp/btree-prop.log`); confirm the full db-core suite is green (given the prereq fix has landed) and the new spec exercises multi-level rebalancing.
