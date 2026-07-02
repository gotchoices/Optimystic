description: Fixed a bug where merging two internal nodes at the left edge of a deep sorted-key index corrupted a routing key higher up, making a range of entries unreachable. Fixed and reviewed.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: medium
---

## What was implemented

One bug fixed in `packages/db-core/src/btree/btree.ts`, one regression test added in `packages/db-core/test/btree.spec.ts`.

### Fix — `rebalanceBranch`, "merge right sibling into self" case

Removed a wrong ancestor-separator update (old btree.ts lines ~742-744):

```ts
if (pIndex === 0 && pNode.partitions.length > 0) {
	this.updatePartition(pIndex, path, depth - 1, pNode.partitions[0]!);
}
```

After `deletePartition(pNode, pIndex)`, `pNode.partitions[0]` is the separator to the merged child's *next* sibling — strictly greater than the merged subtree's minimum key. An internal merge never changes the subtree's minimum (every absorbed key is `>=` the old separator, which is `>` every key already in the node), so no ancestor separator update is needed at all. With the too-large value written, any key in `[subtreeMin, corruptedSeparator)` routed into the wrong subtree and became unreachable.

Stayed hidden because `updatePartition(nodeIndex=0, path, D-1, ...)` is a no-op unless `D-1 !== 0`; only corrupts when the merged branch sits at path-depth `D >= 2`, first reachable in a 4-level tree (~66k sequential inserts at NodeCapacity=64).

### Regression test

`packages/db-core/test/btree.spec.ts` — "should not corrupt separators on left-edge internal branch merge (4-level tree)": inserts 70,000 sequential values, asserts the tree actually reached `>= 3` branch levels, deletes a contiguous 3000-key range starting at the root's first separator (forcing a left-edge internal merge), then asserts every non-deleted key is reachable, deleted keys return `undefined`, and a full forward scan returns the complete remaining set in order.

## Review findings

**Verdict: implementation correct. Fix verified, test verified as a real guard, no defects found.**

### Checked — correctness of the fix
- **The removed write was unconditionally wrong.** Re-derived the invariant: for the leftmost path, an ancestor separator equals its subtree's minimum key. "Merge right sibling into self" keeps `branch` as the leftmost node and absorbs `rightSib` to its right, so the subtree minimum is unchanged → no ancestor update is correct. **Confirmed correct.**
- **Symmetry across all four rebalance-branch paths is now consistent.** Audited every case in `rebalanceBranch` (btree.ts:713-756):
  - *borrow-from-right* (715): `rightSib` loses its first node → its min rises → `updatePartition(pIndex+1, rightKey)`. Correct, untouched.
  - *borrow-from-left* (726): `branch` gains a node at front → its min drops → `updatePartition(pIndex, pKey)`. Correct, untouched.
  - *merge-right-into-self* (736): min unchanged → **no** ancestor update. Now correct after removal.
  - *merge-self-into-left* (746): `leftSib` stays leftmost, keeps its min → no ancestor update, and none is present. Consistent.
- **Leaf-merge case (btree.ts:678-686) left correct.** Its `pIndex===0` block writes `leaf.entries[0]` — the *true* subtree minimum, which the merge does not change — so it is an idempotent rewrite of the value the separator already holds. Harmless; correctly untouched. (The bug was specific to the branch case using `pNode.partitions[0]` instead of the true min.)
- **No sibling instances of the bad pattern.** Grepped `src/` for `updatePartition(.*partitions[0]` — zero matches. The corrupting shape existed only at the fixed site.

### Checked — test is a real guard (not green-on-green)
- Re-ran the adversarial verification the implementer described: temporarily restored the buggy block, ran `... mocha ... --grep "4-level"` → **1 failing** (`AssertionError: expected false to be true` at btree.spec.ts:656 — the point-lookup / `path.on` assertion). Removed the block again; `git diff` on btree.ts is empty (matches the committed fix). The test genuinely exercises the bug.
- The depth guard (`>= 3` branch levels) is a correct defense against the test silently degrading to a 3-level tree (where the bug is a no-op) if `NodeCapacity` ever grows past what 70k entries can fill.

### Checked — docs
- `packages/db-core/docs/btree.md` (Rebalancing, lines 246-248) describes merge/borrow at a design level ("the parent partition is removed. Merges cascade upward."). This is accurate and does not mention the ancestor-separator update; the bug was an implementation detail below the doc's altitude. **No doc change needed.**

### Coverage gap — reviewed and accepted (no ticket, no tripwire)
- The test exercises exactly one deletion shape (contiguous delete at the root's first separator, right mid-subtree). The fix is a pure *removal* of an unconditional-wrong write, so it is correct for all internal-merge paths by construction — there is no dormant path that the removal breaks. A randomized large-tree delete-fuzz would broaden coverage but guards against nothing specific here. Not filed as a ticket (no defect), and not recorded as a tripwire (no condition trips it into being work) — deliberately accepted.

### Tripwire (carried forward from the implement handoff)
- **Test cost.** The 4-level regression needs ~66k+ inserts (~4s wall-clock, heaviest btree spec). If the suite ever needs slimming, gate it behind a longer timeout rather than dropping N below ~66k — below the 4-level threshold it does not exercise the bug. Parked in the implementer's notes; no single code site beyond the existing `this.timeout(180000)` to tag.

### Not my diff — flagged, not chased
- `npx tsc --noEmit` emits `TS5101: Option 'downlevelIteration' is deprecated` (tsconfig.json). Config-level deprecation independent of this change; the real gates (`yarn test`, `yarn build`) run clean. Consistent with the sibling review's finding; not re-filed.

### Closes prior tripwire
- This ticket closes the "4-level tree untested" tripwire recorded in `1-btree-branch-split-missing-store-insert`'s review findings.

## Test results

`yarn test` (packages/db-core): **1035 passing** (~5s), including the new 4-level regression test. `yarn build` (tsc): clean.
