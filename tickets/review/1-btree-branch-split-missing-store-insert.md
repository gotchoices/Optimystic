----
description: Growing the sorted-key index past ~2080 entries throws "Missing block" and corrupts the tree, because a newly-created internal node is never saved to storage.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: easy
----
## What was implemented

Two bugs fixed in `packages/db-core/src/btree/btree.ts`:

### Fix 1 — `branchInsert`: missing `store.insert` (the ticket's stated bug)

`branchInsert` (~line 631) created `newBranch` via `newBranchNode(...)` but never persisted it. On the next lookup the tree tried to load that id from the store and threw `Missing block (block-NN)`. Added:

```ts
const newBranch = newBranchNode(this.store, newPartitions, newNodes);
this.store.insert(newBranch);   // ← added
```

This mirrors the identical `this.store.insert(newLeaf)` in `leafInsert`.

### Fix 2 — `internalNext`: missing `await` on `moveToFirst` (latent, exposed by fix 1)

Line 417 called `this.moveToFirst(...)` without `await`. In a 2-level tree (branch → leaves), `moveToFirst` receives a leaf and resolves synchronously, so the missing `await` was invisible. In a 3-level tree, `moveToFirst` receives a branch and must itself `await get(store, ...)` to descend one more level. Without the outer `await`, `internalNext` returned before `path.leafNode` was updated, leaving the path pointing at the previous leaf's last entry. The next scan step read that stale entry (duplicate `1023`), then advanced using the corrupt `path.branches` state, skipping the first child of the new branch (all of leaf 32, entries 1024–1055). `internalPrior` had the same pattern but was written correctly (`await this.moveToLast(...)`).

Fix: added `await` to the `moveToFirst` call in `internalNext`.

### Regression test

Added to `packages/db-core/test/btree.spec.ts` (last `it` block):

- Inserts 2200 sequential values (integers 0–2199).
- Verifies every value via point lookup (`btree.get(i)`).
- Verifies a full forward scan (`first()` / `moveNext()`) returns exactly `[0..2199]` in order.

Before fix 1 this threw `Missing block (block-67)` at insert 2081. After fix 1 but before fix 2, all `get` calls passed but the scan silently returned 2169 entries with one duplicate and a 32-entry gap.

## Test results

All 1034 tests pass, including the new regression test.

## Gaps / things to verify

- **No descending-scan coverage for 3-level trees.** The regression test only covers ascending iteration (`first()/moveNext()`). A parallel descending scan (`last()/movePrior()`) over 2200 entries would give symmetric coverage for `internalPrior`, which already has `await` but is worth confirming at depth. Current test suite has no descending stress test above 500 entries.
- **Only one branch split exercised.** 2200 entries triggers exactly one branch split. To cover a 4-level tree (third branch split needed) you'd need ~130,000 entries with NodeCapacity=64. If deeper trees are a real use case, a 4-level test is worth adding — but that is clearly out of scope for this ticket.

## Review findings

- `internalNext` missing-await tripwire promoted to an actual fix after discovering it is reachable in the 3-level tree produced by this ticket's inserts.
- No other `moveToFirst` / `moveToLast` call sites were missing `await`; the `getFirst` / `getLast` / `moveToFirst` / `moveToLast` calls in lines 529–547 all use correct `await`.
