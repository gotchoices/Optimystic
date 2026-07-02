----
description: Two places in the sorted-key index skip waiting for an asynchronous step to finish, so a caller can receive a cursor before it has actually moved and a delete can run concurrently with the next operation.
files: packages/db-core/src/btree/btree.ts
difficulty: easy
----
Two missing `await`s in the B-tree.

First, `prior()` (around btree.ts:278-282) calls `this.movePrior(newPath)` without awaiting it, unlike `next()` which awaits `moveNext` (around btree.ts:265-269). It appears to work mid-leaf because the decrement is synchronous, but crossing a leaf boundary awaits a store read: the caller receives the path before it has moved, and the move then mutates the returned path underneath them. This is exposed publicly via `Tree.prior`.

Second, `internalUpdate`'s key-changing path (around btree.ts:463) runs `this.internalDelete(await this.find(oldKey))` without awaiting the `internalDelete`. The delete's asynchronous rebalance then interleaves with the immediately following `find(newKey)` operating on the same nodes, and any rebalance error becomes an unhandled promise rejection that also defeats the `AtomicProxy` rollback that was supposed to make the update atomic.

Expected behavior: `prior()` returns only after the cursor has fully moved (including across leaf boundaries); a key-changing update completes its structural delete before the subsequent find/insert runs, and rebalance errors propagate so atomic rollback works.

Suggested fix (from review, treat as a hint): add both `await`s. A regression test should cross a leaf boundary with `prior()` and should exercise a key-changing update that triggers a rebalance.
