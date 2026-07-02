----
description: When two internal nodes of the sorted-key index are merged at the left edge of a subtree deep in a tall tree, a routing key higher up is corrupted, making a range of entries unreachable.
prereq: btree-branch-split-missing-store-insert
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: medium
----
## Problem

In `rebalanceBranch` (btree.ts, around lines 735-746), the "merge right sibling into self" branch runs this after absorbing the right sibling:

```ts
if (pIndex === 0 && pNode.partitions.length > 0) {	// if parent is left edge, new right sibling is now the first partition
	this.updatePartition(pIndex, path, depth - 1, pNode.partitions[0]!);
}
```

After `deletePartition(pNode, pIndex)`, `pNode.partitions[0]` is the separator to the merged child's *next* sibling — strictly greater than the merged subtree's minimum key. `updatePartition(0, path, depth-1, ...)` walks up to the nearest ancestor separator (see below) and overwrites it with that too-large value.

An internal merge does not change the subtree's minimum key (all absorbed keys are `>=` the old separator, which is `>` every key already in the node). So no ancestor separator update is needed at all — the block is simply wrong. Any key in `[subtreeMin, corruptedSeparator)` then routes into the wrong sibling subtree and becomes unreachable.

### Depth required — this needs a 4-level tree, not 3

`updatePartition(nodeIndex=0, path, D-1, key)` (btree.ts:761) does nothing unless `D-1 !== 0` (it only recurses; at the root it is a no-op). `D` is the path-depth of the branch being rebalanced. The branch just above the leaves sits at `D = 1`, whose parent is the root at depth 0 → `D-1 === 0` → no-op, no corruption. The block only corrupts something when the merged branch is at `D >= 2`, i.e. its parent is itself a non-root branch. That first happens in a **4-level** tree (root → mid → branch → leaf), which with sequential inserts appears at roughly **66,000** entries — the original ticket's "3+ levels / 2000+ entries" estimate was too low. (At 3 levels the block is a harmless no-op, which is why existing tests and a 3-level delete stress never caught it.)

## Reproduction (confirmed, once the `prereq` insert fix is in place)

Build a 4-level tree, then delete a contiguous range starting at the root's first separator (the minimum key of the right mid-subtree). This forces a left-edge (`pIndex === 0`) internal merge inside that mid-subtree, corrupting the root separator upward.

```
const N = 70000
for (let i = 0; i < N; i++) await btree.insert(i)        // 4-level tree; root has 2 children
const root = <the root branch>
const B = root.partitions[0]                              // observed: 32768
for (let k = B; k < B + 3000; k++) await btree.deleteAt(await btree.find(k))

// Buggy: 2047 keys unreachable, first missing = 32769 (B+1)
// Fixed: 0 unreachable
```

Measured on the buggy code: `missing 2047, firstMissing 32769`. With the fix: `missing 0`.

Reading the root branch in a test: get the root id via the tree's trunk accessor and `store.tryGet(rootId)`; `root.partitions[0]` is the boundary `B`. (See the explore harness approach used during the fix stage — walk `nodes[0]` while the node type is `TreeBranchBlockType` to confirm depth.)

## Fix

Remove the block entirely:

```ts
apply(this.store, branch, [nodes$, branch.nodes.length, 0, rightSib.nodes]);
this.store.delete(rightSib.header.id);
return this.rebalanceBranch(path, depth - 1);
```

Note the neighbouring leaf-merge case (btree.ts:680-682) writes `leaf.entries[0]` — the *true* subtree minimum — so it is harmless (writes the value the separator already holds). Do **not** "fix" that one; only the branch-merge block is defective. Leave the borrow cases (btree.ts:714-732) untouched — they legitimately change subtree minima and their `updatePartition` calls are correct.

## Test-cost note

The regression test needs ~66k+ inserts to reach 4 levels (~4s wall-clock in-memory in the fix-stage run). Keep N at 70000 for margin. This is heavier than the other btree specs but well within the idle timeout; if it proves too slow for the default suite, gate it behind a longer mocha `.timeout(...)` rather than shrinking N below the 4-level threshold (below ~66k it does not exercise the bug at all).

## TODO

- Delete the `if (pIndex === 0 && pNode.partitions.length > 0) { updatePartition(...) }` block from the "merge right sibling into self" case in `rebalanceBranch` (btree.ts ~741-743).
- Add a regression test in `packages/db-core/test/btree.spec.ts`: insert 70000 sequential, read `root.partitions[0]` as `B`, delete `[B, B+3000)`, then assert every non-deleted key `0..69999` is still `get`-able and a full scan returns the complete remaining set in order. Set an explicit `.timeout(180000)`.
- Run the package tests: from `packages/db-core`, `yarn test 2>&1 | tee /tmp/btree-test.log`.
