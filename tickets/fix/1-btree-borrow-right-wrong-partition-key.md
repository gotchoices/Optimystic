----
description: A rebalancing step in the sorted-key index stores the wrong routing key, so an entry moved between two neighboring nodes can no longer be found.
files: packages/db-core/src/btree/btree.ts
difficulty: medium
----
In the B-tree, when a leaf underflows and borrows the first entry from its right sibling (`rebalanceLeaf`, around btree.ts:658-664), the parent's separator/partition key is updated using the key of the entry that was *moved out* of the right sibling, rather than the right sibling's *new* first key after the shift.

Because `indexOfKey` routes a lookup where `key === partition` into the right child (btree.ts:381), a later `find(borrowedKey)` descends into the right sibling — where the borrowed entry no longer lives — and misses it entirely. The borrowed entry becomes unreachable.

The branch-level borrow (around btree.ts:714-721) performs the equivalent update correctly, which confirms the leaf case is the anomaly. Current tests exercise the merge path rather than the borrow path, so this code is effectively untested.

Expected behavior: after a borrow-from-right, every entry (including the borrowed one) remains findable via `find`, and range scans across the affected keys return the full set.

Suggested fix (from review, treat as a hint): after the two `apply` calls, use the right sibling's post-shift first entry — `this.keyFromEntry(rightSib.entries[0]!)` — as the new partition key.

A reproduction should construct a tree in a state that triggers borrow-from-right (rather than merge) on delete, then assert the borrowed key is still findable.
