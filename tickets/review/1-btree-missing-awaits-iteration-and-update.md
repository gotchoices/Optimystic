----
description: Review two missing-await fixes in the B-tree (prior() and internalUpdate()) plus their regression tests.
files: packages/db-core/src/btree/btree.ts, packages/db-core/test/tree.spec.ts
difficulty: easy
----

## What was done

Two one-line fixes and two regression tests in the B-tree implementation.

### Fix 1 — `prior()` missing await (btree.ts ~line 280)

`movePrior` is async (it loads a sibling leaf from the store when the cursor is at leaf index 0). The `await` was missing, so `prior()` returned the path before the store read completed and callers received a partially-mutated path. Fixed by adding `await` before `this.movePrior(newPath)`.

### Fix 2 — `internalUpdate` key-change path missing await (btree.ts ~line 463)

When an entry's key changes, `internalUpdate` deletes the old key and re-inserts at the new key. `internalDelete` is async (calls async rebalance routines). The `await` was missing, so the rebalance raced with the immediately following `find(newKey)`, and any rebalance error became an unhandled promise rejection that bypassed the `AtomicProxy` rollback. Fixed by adding `await` before `this.internalDelete(...)`.

### Tests added (tree.spec.ts)

- **`prior() should cross leaf boundary correctly`** — inserts 65 entries (one more than the leaf capacity of 64), which forces a leaf split. Navigates to key 65 (first entry of leaf 2), calls `prior()`, and asserts the result is key 64 (last entry of leaf 1).

- **`key-changing update should complete delete before re-find`** — inserts 70 entries across multiple leaves, then calls `btree.updateAt` to move key 35 to key 1000 (accessed via `(tree as any).btree` since `Tree` does not expose `updateAt` publicly). Asserts key 35 is gone, key 1000 exists with the right value, and surrounding keys are intact.

## Test results

All 1037 tests pass (`npm test` in `packages/db-core`).

## Known gaps / reviewer notes

- **Test 2 uses `(tree as any).btree`** — the `internalUpdate` key-change path is not reachable through the public `Tree.replace` API (which always calls `upsert`, keyed on `entry.key`, not a "search at old key, store at new key" operation). The cast is the only way to exercise this path through the existing test harness without adding a new public method. Reviewer should decide whether to accept this or expose `updateAt` on `Tree`.

- The TypeScript diagnostics about `describe`/`it` not being found in tree.spec.ts are pre-existing (all tests in that file have the same issue); not introduced by this ticket.

- Line 515 in btree.ts has a pre-existing `'await' has no effect on the type` diagnostic (`await this.store.insert(newBranch)`) — not introduced by this ticket.

## Review findings

- Tripwire noted in code: none; both fixes are simple correctness patches with no conditional future concern.
