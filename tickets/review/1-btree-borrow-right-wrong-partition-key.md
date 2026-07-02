----
description: Review one-line fix and regression test for borrow-from-right rebalancing storing the wrong partition key in the B-tree leaf node.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
----
## What was done

### Fix (`btree.ts:662`)

Changed `this.keyFromEntry(entry)` → `this.keyFromEntry(rightSib.entries[0]!)`.

`entry` is the value removed from the right sibling and appended to the underflowing leaf. `apply()` mutates in-place synchronously, so immediately after the removal call `rightSib.entries[0]` already holds the sibling's new first key — the correct separator. Before the fix, the separator was set to the moved entry's key, making `get(movedKey)` descend into the right sibling (where it no longer lives) and return `undefined`.

### Test (`btree.spec.ts`, inside `atomic rollback` describe)

New `it`: "should find borrowed entry after borrow-from-right rebalance"

- Inserts 65 values (0–64) → two leaves: `[0..31]` and `[32..64]`.
- Deletes 0 → leaf underflows → borrows entry 32 from right sibling.
- Asserts `get(32) === 32` (point lookup on the borrowed entry).
- Asserts full iteration returns `[1..64]` (range scan across the affected separator).

### Build / test result

`yarn workspace @optimystic/db-core test` — **1032 passing**. No regressions.

## Gaps and notes for reviewer

- **Borrow-from-left symmetry** (`btree.ts:672`): that branch uses `this.keyFromEntry(entry)` where `entry` is the *last* entry of the left sibling before removal, and then updates `pIndex` (not `pIndex+1`). This is the moved entry's key, which is correct for left-borrow (the separator between left and current leaf equals the key of the newly-first entry of the current leaf, which is the borrowed entry). Worth a quick eyeball to confirm, but it's a different invariant and was out of scope here.
- **Branch-level borrow-right** (`btree.ts:714–721`): already correct per ticket analysis; not changed.
- Test is placed inside the existing `atomic rollback` describe because it reuses the `collectAll`-style iteration pattern already there. Could move to a dedicated `borrow` describe if preferred — purely cosmetic.
