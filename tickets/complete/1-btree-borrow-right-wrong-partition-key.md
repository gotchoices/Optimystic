----
description: Fixed a rebalancing step in the sorted-key index that stored the wrong routing key, making an entry moved between neighboring nodes unfindable; added regression tests for both borrow directions.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts, packages/db-core/docs/btree.md
----
## Summary

One-line correctness fix in `BTree.rebalanceLeaf` borrow-from-right (`btree.ts:662`): the parent separator was set to the key of the entry *moved out* of the right sibling instead of the sibling's *new* first key. Because `indexOfKey` routes `key === separator` into the right child, the borrowed entry became unreachable via point lookup. Fix uses `rightSib.entries[0]` after the in-place removal.

## Review findings

Adversarial pass over implement commit `927be4f`.

### Checked and confirmed correct

- **The fix itself (`btree.ts:662`)** — verified against partition indexing: `updatePartition(pIndex+1)` writes `partitions[pIndex]`, the separator between `leaf` (`nodes[pIndex]`) and `rightSib` (`nodes[pIndex+1]`). New value = rightSib's post-shift first key = correct separator per the documented invariant (`docs/btree.md:131`, "partition keys represent the lowest key in the subtree to the right"). `apply()` mutates in-place synchronously, so `rightSib.entries[0]` already holds the new first key at that point. Guard requires `rightSib.entries.length > 32`, so `[0]` is always defined post-removal.
- **Regression test meaningfulness** — probed by reintroducing the buggy line; the implementer's test fails with `expected undefined to equal 32`, confirming it is not a no-op.
- **Branch-level borrow-right (`btree.ts:714-721`)** — analogous update already correct; unchanged.
- **Docs (`docs/btree.md`)** — the borrow description (line 246) and the routing invariant (line 131) are accurate and the fixed code now conforms; no update needed.
- **Build + full suite** — `tsc` clean; `1033 passing` (was 1032, +1 from the added left-borrow test). No lint script exists for `@optimystic/db-core` (build = `tsc` serves as the type gate).

### Found and fixed inline (minor)

- **Borrow-from-left (`btree.ts:668-674`) had zero test coverage** — the implementer flagged this symmetric path for "an eyeball" but left it untested. Verified correct by analysis (`updatePartition(pIndex)` → `partitions[pIndex-1]`, the leftSib/leaf separator; new value = borrowed entry = leaf's new first key). Added regression test `should find borrowed entry after borrow-from-left rebalance` (`btree.spec.ts`): grows the left leaf to 33 entries, underflows the rightmost leaf so borrow-from-left is the taken branch, then asserts `get(31)`/`get(30)`/`get(32)` route correctly across the new separator plus a full scan. Probed with a wrong separator (`leftSib` last key post-removal, = 30) → test fails `expected undefined to equal 30`, confirming it guards the separator.

### Major findings

None. The change is a correct one-line fix with adequate, now-symmetric, regression coverage.

### Coverage notes (no action)

- Both borrow tests exercise a 2-level tree (leaf directly under root). The 3+ level case is not tested, but the fixed line and its left-borrow twin take the identical `nodeIndex > 0` branch of `updatePartition` (local partition write, no ancestor recursion), so deeper trees add no new code path for these two fixes. Not conditional and not a defect — just an untested-but-equivalent path; not worth a tripwire.
