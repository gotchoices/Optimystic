----
description: Range scans over the sorted-key index can silently return nothing when the starting key falls right at the end of a node, because the scan fails to step into the following node.
files: packages/db-core/src/btree/btree.ts
difficulty: medium
----
`internalNext` (around btree.ts:391-397) handles an "off" path (a cursor positioned on a gap rather than on an entry) by only trying to "get on" at the current position. When the cursor sits at `leafIndex === entries.length` — the crack between a leaf's last entry and its parent partition — the get-on attempt fails and the method returns without falling through to the branch-popping leaf-advance logic that would move into the next leaf.

Such a crack is routinely produced by `find(key)` when the key falls between a leaf's last entry and the parent partition (for example, a value equal to a just-deleted leaf maximum). The consequence: `range({ first: <such a key> })` yields zero results even though later entries clearly exist in the right sibling.

`internalPrior` handles the symmetric crack correctly (around btree.ts:428 and 450-453), which confirms the forward path is the one that is wrong.

Expected behavior: a range scan starting from a key positioned at an end-of-leaf crack advances into the following leaf and returns all subsequent entries.

Suggested fix (from review, treat as a hint): when the get-on attempt fails and `leafIndex >= entries.length`, fall through to the branch-popping advance instead of returning early.
