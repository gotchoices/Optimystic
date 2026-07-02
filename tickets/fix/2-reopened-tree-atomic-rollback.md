----
description: Collections opened from existing storage have weaker crash-safety than freshly created ones, so a failure partway through a change can leave half-applied edits with no automatic rollback.
files: packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transform/atomic-proxy.ts
difficulty: medium
----
`Collection.internalTransact` hands each action handler an `Atomic` store specifically so that a failure leaves no partial state. But the tree collection's `"replace"` handler (around collections/tree/tree.ts:45-54) ignores the passed store and mutates through the captured outer `btree` instead.

Compounding this, the reopen path constructs `new BTree(collection.tracker, …)` (around tree.ts:69-70) without an `AtomicProxy` — only `BTree.create` installs one. So on an *existing* (reopened) collection, a mid-action failure leaves half-applied node mutations staged with no rollback, whereas a freshly created collection would have rolled them back. Reopened trees thus have strictly weaker atomicity than newly created ones.

Expected behavior: a mid-action failure on a reopened tree collection rolls back cleanly, leaving no partially applied node mutations — matching the guarantee a freshly created collection provides.

Suggested fix (from review, treat as a hint): construct the reopened BTree over an `AtomicProxy(collection.tracker)`, or make the `"replace"` handler operate through the passed transaction store (`_trx`) rather than the captured outer btree.

A reproduction should reopen an existing tree-backed collection, force a failure partway through a replace action, and assert no partial mutations remain staged.
