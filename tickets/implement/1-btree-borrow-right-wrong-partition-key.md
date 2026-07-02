----
description: Fix a rebalancing step in the sorted-key index that stores the wrong routing key, making an entry moved between two neighboring nodes unfindable, and add a regression test.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: easy
----
## Problem

In `BTree.rebalanceLeaf` (`packages/db-core/src/btree/btree.ts:658-664`), when a leaf underflows on delete and borrows the first entry from its right sibling, the parent's separator/partition key is set to the key of the entry that was *moved out* of the right sibling, instead of the right sibling's *new* first key after the shift.

```ts
if (rightSib && rightSib.entries.length > (NodeCapacity >>> 1)) {   // borrow from right
    const entry = rightSib.entries[0]!;
    apply(this.store, rightSib, [entries$, 0, 1, []]);              // removes rightSib.entries[0]
    apply(this.store, leaf, [entries$, leaf.entries.length, 0, [entry]]);
    this.updatePartition(pIndex + 1, path, depth - 1, this.keyFromEntry(entry));  // BUG: uses moved-out key
    return undefined;
}
```

`indexOfKey` (`btree.ts:370-389`) routes a lookup where `key === partition` into the **right** child (`return split + 1`, line 381). After the borrow, the separator equals the moved entry's key, so `find(movedKey)` descends into the right sibling — where that entry no longer lives — and misses it. The borrowed entry becomes unreachable.

The branch-level borrow (`btree.ts:714-721`) does the analogous update correctly, confirming the leaf case is the anomaly. Existing delete tests exercise the merge path, not the borrow path, so this code was effectively untested.

## Root cause confirmed

`apply` mutates the block in place synchronously (`applyOperation` → `Array.prototype.splice`, `packages/db-core/src/transform/helpers.ts:10-16`, called via `packages/db-core/src/blocks/helpers.ts:10-13`). So immediately after the first `apply` removes `rightSib.entries[0]`, `rightSib.entries[0]` already holds the sibling's new first entry. The correct separator is `this.keyFromEntry(rightSib.entries[0]!)`.

## Fix

Replace the partition key at `btree.ts:662`:

```ts
this.updatePartition(pIndex + 1, path, depth - 1, this.keyFromEntry(rightSib.entries[0]!));
```

(`rightSib.entries` is guaranteed non-empty here: the borrow guard requires `rightSib.entries.length > NodeCapacity/2 = 32`, so after removing one it still has ≥ 32.)

## Reproduction (drives borrow-from-right, not merge)

`NodeCapacity = 64` (`btree.ts:9`); half = 32. Rebalance fires when a leaf drops below 32 entries; borrow-from-right is attempted first and taken when the right sibling has > 32 entries.

- Insert `0..64` (65 values) → leaf1 = `[0..31]` (32), leaf2 = `[32..64]` (33), single root branch with partition `[32]`.
- Delete `0` → leaf1 drops to 31 entries → rebalance → right sibling (leaf2, 33 > 32) → borrow. Entry `32` moves into leaf1; leaf2 becomes `[33..64]`.
  - Correct separator becomes `33`; buggy separator stays `32`.
- Assert `await btree.get(32) === 32` (fails as `undefined` before the fix).
- Also assert full-range iteration returns `[1..64]` (every remaining key) to cover range scans across the affected boundary.

Add this as a new `it(...)` in `packages/db-core/test/btree.spec.ts` (a `borrow` describe block or alongside the delete tests). Follow the existing `collectAll`/iteration style already in the file.

## TODO

- Apply the one-line fix at `packages/db-core/src/btree/btree.ts:662` (use `rightSib.entries[0]` post-shift first key).
- Add a regression test in `packages/db-core/test/btree.spec.ts` per the reproduction above: assert `get(32)` and full iteration after the borrow.
- Consider a second borrow-from-right assertion where the delete target is the borrowed key's neighbor, to double-check `find` on both sides of the new separator (optional; keep if cheap).
- Run build + tests for `packages/db-core` (`yarn workspace ... build` / test — check `AGENTS.md` for the exact commands) streaming output with `tee`. Confirm the new test fails before the fix and passes after, and no existing btree tests regress.
- Hand off to review with an honest note on what was and wasn't covered (borrow-from-left is a separate, symmetric path — it already uses the moved entry's key at `btree.ts:672`, but note that case inserts at index 0 of `leaf` and updates `pIndex`, so its correctness is out of scope here; flag it for the reviewer to eyeball rather than assume).
