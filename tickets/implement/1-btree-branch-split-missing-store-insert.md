----
description: Growing the sorted-key index past ~2080 entries throws "Missing block" and corrupts the tree, because a newly-created internal node is never saved to storage.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/btree.spec.ts
difficulty: easy
----
## Problem

`branchInsert` (btree.ts, around line 631) splits a full internal (branch) node into two, creating `newBranch` via `newBranchNode(...)`. `newBranchNode` (btree.ts:817) only builds the node object with a fresh block header — it does **not** persist it. Every other split site persists its new node immediately after creating it: `leafInsert` calls `this.store.insert(newLeaf)` at btree.ts:594. `branchInsert` is missing the analogous `this.store.insert(newBranch)` call.

The `newBranch` id is then handed upward in the returned `Split` and wired into a parent (or a brand-new root at btree.ts:514-516) as a child. On the next lookup, `getPath` tries to load that child id and throws `Missing block (block-NN)` from `get` (blocks/helpers.ts:5).

This only bites once a branch node itself fills to `NodeCapacity` (64) children and splits — i.e. when the tree grows from 2 levels to 3. With sequential inserts that happens at exactly the **2081st** entry (`NodeCapacity` = 64, leaves ~32 each → ~64 leaves fill the root branch, which then splits).

## Reproduction (confirmed)

Pure sequential insert, no deletes:

```
for (let i = 0; i < 2200; i++) await btree.insert(i)   // throws at i === 2081
```

Error:

```
Error: Missing block (block-67)
  at get (.../blocks/helpers.ts:5:15)
  at BTree.getPath (.../btree.ts:306)
  at BTree.find (.../btree.ts:56)
  at BTree.internalInsert (.../btree.ts:448)
```

Any N < 2081 passes; N >= 2081 throws. This is a pre-existing defect at HEAD, independent of the delete/merge path.

## Fix

Persist `newBranch` right after it is created in `branchInsert`, mirroring `leafInsert`:

```ts
const newBranch = newBranchNode(this.store, newPartitions, newNodes);
this.store.insert(newBranch);   // <-- add this line
```

An internal merge / borrow does not create nodes, so no other site needs a matching change; `leafInsert` and the new-root creation (btree.ts:515) already persist their nodes.

## Why this is its own ticket

The sibling ticket `btree-branch-merge-corrupts-separator` needs a **tall** tree to reproduce its bug, but this insert defect makes the tree unbuildable past 2 levels. That ticket lists this one as a `prereq`.

## TODO

- Add `this.store.insert(newBranch);` immediately after the `newBranchNode(...)` call in `branchInsert` (btree.ts ~line 631).
- Add a regression test in `packages/db-core/test/btree.spec.ts`: insert ~2200 sequential values, assert `btree.get(i) === i` for all, and that a full first()→moveNext scan returns `[0..2199]`. (Pre-fix this throws at i=2081; post-fix it passes.)
- Run the package tests: from `packages/db-core`, `yarn test 2>&1 | tee /tmp/btree-test.log` (streamed, not silently redirected).
