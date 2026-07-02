description: Fixed a bug where merging two internal nodes at the left edge of a deep sorted-key index corrupted a routing key higher up, making a range of entries unreachable. Ready for review.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: medium
---

## What was implemented

One bug fixed in `packages/db-core/src/btree/btree.ts`, one regression test added in `packages/db-core/test/btree.spec.ts`.

### Fix — `rebalanceBranch`, "merge right sibling into self" case

Removed a wrong ancestor-separator update. Before (btree.ts, old lines ~741-744):

```ts
apply(this.store, branch, [nodes$, branch.nodes.length, 0, rightSib.nodes]);
if (pIndex === 0 && pNode.partitions.length > 0) {	// if parent is left edge, new right sibling is now the first partition
	this.updatePartition(pIndex, path, depth - 1, pNode.partitions[0]!);
}
this.store.delete(rightSib.header.id);
return this.rebalanceBranch(path, depth - 1);
```

After:

```ts
apply(this.store, branch, [nodes$, branch.nodes.length, 0, rightSib.nodes]);
this.store.delete(rightSib.header.id);
return this.rebalanceBranch(path, depth - 1);
```

**Why it was wrong.** After `deletePartition(pNode, pIndex)`, `pNode.partitions[0]` is the separator to the merged child's *next* sibling — strictly greater than the merged subtree's minimum key. `updatePartition(0, path, depth-1, ...)` walks up (btree.ts:762-769) to the nearest ancestor separator and overwrites it with that too-large value. But an internal merge never changes the subtree's minimum key (every absorbed key is `>=` the old separator, which is `>` every key already in the node), so **no ancestor separator update is needed at all.** With the too-large value written, any key in `[subtreeMin, corruptedSeparator)` routed into the wrong sibling subtree and became unreachable.

**Why it stayed hidden.** `updatePartition(nodeIndex=0, path, D-1, ...)` is a no-op unless `D-1 !== 0` — at the root it only recurses, it doesn't write. So the block only corrupts something when the merged branch is at path-depth `D >= 2` (its parent is itself a non-root branch), which first happens in a **4-level tree** (root → mid → branch → leaf). Sequential inserts reach 4 levels at ~66,000 entries (NodeCapacity=64). Below that the block is a harmless no-op, which is why every existing spec and the sibling ticket's 3-level delete stress passed.

The neighbouring **leaf**-merge case (btree.ts:678-686) writes `leaf.entries[0]` — the *true* subtree minimum — so it is harmless (rewrites the value the separator already holds). The two **borrow** cases (btree.ts:715-733) legitimately change subtree minima and their `updatePartition` calls are correct. **None of those were touched.**

### Regression test

`packages/db-core/test/btree.spec.ts` — "should not corrupt separators on left-edge internal branch merge (4-level tree)" (`.timeout(180000)`):

- Inserts 70,000 sequential values (builds a 4-level tree).
- Reads the root branch via `btree.trunk.get()`; takes `B = root.partitions[0]` (the observed boundary, ~32768 = minimum key of the right mid-subtree).
- **Asserts the tree actually reached 4 levels** by walking `nodes[0]` while the node type is `TreeBranchBlockType`, requiring `>= 3` branch levels. This guards against the test silently degrading to a 3-level tree (where the bug is a no-op and the test would pass trivially) if `NodeCapacity` ever grows so 70k no longer suffices.
- Deletes the contiguous range `[B, B+3000)`, forcing a left-edge (`pIndex === 0`) internal merge inside the right mid-subtree.
- Asserts every non-deleted key `0..69999` is still reachable via `get`, every deleted key returns `undefined`, and a full forward scan returns the complete remaining set in order.

## How to validate

- From `packages/db-core`: `yarn test` — full suite, **1035 passing**, ~5s.
- To confirm the test is a real guard (not just green-on-green): temporarily restore the deleted `if (pIndex === 0 ...) { updatePartition(...) }` block, run `... mocha ... --grep "4-level"`, and observe it fail (`AssertionError: expected false to be true`). This was done during implement — buggy code: the point-lookup / scan assertions fail; fixed code: passes. Then remove the block again.
- `yarn build` (tsc) is clean.

## Known gaps / notes for the reviewer

- **Single deletion pattern.** The test exercises exactly one shape: a contiguous delete starting at the root's first separator, forcing a left-edge merge in the *right* mid-subtree. It does not fuzz other deletion orders that could trigger internal merges at depth (e.g. left-edge merges deeper than one level below root, or merges reached via a different delete sequence). The fix is a pure removal of an unconditional-wrong write, so it is correct for all such cases by construction — but only this one path has an executable regression guard. A randomized large-tree delete-fuzz would broaden coverage; deferred as not warranted for a delete-only fix.
- **Cost.** The test needs ~66k+ inserts to reach 4 levels; ~4s wall-clock in-memory. It is the heaviest btree spec but well within the idle timeout. If the default suite ever needs to slim down, gate it behind a longer timeout rather than shrinking N below ~66k — below the 4-level threshold it does not exercise the bug at all.
- **Depth reached, not guaranteed minimal.** The depth walk asserts `>= 3` branch levels (4-level). It does not assert the root has exactly 2 children; the ticket observed 2, but the test does not depend on that — it reads `B` dynamically.
- **Pre-existing, not chased:** the sibling review (`btree-branch-split-missing-store-insert`, now in complete/) noted `npx tsc --noEmit` emits `TS5101: Option 'downlevelIteration' is deprecated` (tsconfig.json). That is a config-level deprecation independent of this change; the real gate (`yarn test`, plus `yarn build` here) runs clean. Not re-filed.

## Context

This fix depended on `btree-branch-split-missing-store-insert` (the branch-split `store.insert` fix), which has already landed in complete/ — without it a 4-level tree cannot be built at all, so the reproduction was previously masked. This ticket closes the "4-level tree untested" tripwire recorded in that sibling's review findings.
