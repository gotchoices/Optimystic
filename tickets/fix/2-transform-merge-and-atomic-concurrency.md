----
description: Three related correctness issues in the change-merging and atomic-update machinery: merging two change sets can drop operations, overlapping atomic updates can interfere with each other, and one index-tree merge path uses a stale position.
files: packages/db-core/src/transform/helpers.ts, packages/db-core/src/transform/atomic-proxy.ts, packages/db-core/src/btree/btree.ts
difficulty: hard
----
Three related bugs the review grouped together. Each is small; they share the merge/atomicity theme.

(a) `mergeTransforms` clobbers per-block ops (helpers.ts:74-80). `updates: { ...a.updates, ...b.updates }` replaces a block's entire operation array rather than concatenating the two. It happens to be safe for the current caller because that caller's per-block updates are disjoint, but the helper reads as general-purpose and will silently lose operations for any future overlapping use. Expected: merge the operation lists per block id and dedupe deletes, rather than letting one side's array replace the other's.

(b) `AtomicProxy` re-entrancy detection breaks under interleaved `atomic()` calls (atomic-proxy.ts:32-48). It detects re-entrancy via `_active !== _base`, which cannot distinguish genuine nesting from a second *concurrent* `atomic()`. Two overlapping un-awaited inserts on a bare BTree end up sharing one `Atomic`, and the first commit flushes the second's half-finished mutations — even though the class advertises itself as re-entrant safe. Expected: nesting is still supported, but a second concurrent/foreign `atomic()` does not share state with an in-flight one. Suggested (hint): serialize `atomic()` behind a promise-queue mutex, or throw on foreign overlap.

(c) Branch left-merge path index is off by the merged length (btree.ts:751-755). The branch-level left-merge adjusts `pathBranch.index` *after* the merge has already appended nodes, so the index is shifted by the merged length and points to the wrong child. The leaf-level equivalent (around btree.ts:688-690) does it in the correct order. Expected: after a branch left-merge the path still points at the correct child. Suggested (hint): capture `leftSib.nodes.length` before the `apply` calls and use it to compute the adjusted index. Note: this is the "merge-index bug" the review's recommended property/fuzz test would catch, alongside the other B-tree rebalance bugs.

Reproductions: (a) merge two transforms that both touch the same block id and assert no ops are lost; (b) fire two overlapping un-awaited inserts on a bare BTree and assert the first commit does not flush the second's partial state; (c) drive a delete sequence that triggers a branch left-merge and assert subsequent lookups on the affected child succeed.
