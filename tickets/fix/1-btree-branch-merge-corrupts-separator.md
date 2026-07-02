----
description: When two internal nodes of the sorted-key index are merged at the far-left edge, a routing key higher up in the tree is corrupted, making a range of entries unreachable.
files: packages/db-core/src/btree/btree.ts
difficulty: medium
----
In `rebalanceBranch` (around btree.ts:741-743), after merging a right sibling into a branch node at `pIndex === 0`, the code writes `pNode.partitions[0]` — which, post-delete, is the separator to the merged child's *next* sibling and is strictly greater than the merged subtree's minimum — into the nearest ancestor separator.

As a result, any key in the range `[subtreeMin, pNode.partitions[0])` routes into the wrong subtree and becomes unreachable. An internal merge does not change the subtree minimum, so no ancestor separator update is needed at all.

This requires a 3+ level tree (roughly 2000+ entries) under delete load to manifest, which is beyond the current test sizes.

Expected behavior: after an internal-node merge at the left edge, all keys in the affected subtree remain findable and range scans return the complete set.

Suggested fix (from review, treat as a hint): remove the `if (pIndex === 0 …) updatePartition(...)` block entirely.

A reproduction needs a tall enough tree (multiple internal levels) and a delete sequence that triggers a right-merge at index 0, then asserts keys just below the merge boundary are still findable.
