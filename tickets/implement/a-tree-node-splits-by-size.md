description: A table's rows are stored in tree nodes of up to 64 rows each however large the rows are, so a table of large rows (130 KB or more each) builds nodes too big to copy between machines. Make a tree node split once it is full by size as well as by count.
prereq: a-log-block-rolls-over-by-size
architecture: packages/db-core/docs/btree.md
files: packages/db-core/src/btree/btree.ts (`NodeCapacity`, `BTree.leafInsert`, `BTree.branchInsert`, `BTree.rebalanceLeaf`, `BTree.rebalanceBranch`, the in-place update paths), packages/db-core/src/btree/nodes.ts, packages/db-core/src/collections/tree/tree.ts, packages/db-core/docs/btree.md, docs/internals.md
difficulty: hard
repro: static
----
# A tree node splits by size

## What is wrong

`BTree` in `packages/db-core/src/btree/btree.ts` splits a leaf when it holds `NodeCapacity` (64) entries and a branch when it holds 64 children, and rebalances on delete by the same counts (`nodeCapacity >>> 1`). A leaf's size is therefore 64 times its average entry, unbounded: 64 rows of 130 KB make a leaf over `MAX_BLOCK_MESSAGE_BYTES` (8 MiB), and every SQL table is a tree whose leaf entries are whole rows. Each write is a small transaction (its pend carries one update operation on the leaf), so the per-transaction limit never sees the leaf grow. Once over the frame, the leaf can never be replicated, repaired or read remotely — the same failure the log has, fixed for the log in `a-log-block-rolls-over-by-size`.

Inferred from the split rule, not run. To confirm: insert 64 entries of 140 KB into a `Tree` over `TestTransactor` and measure the leaf's encoded size.

## Expected

No tree node holding more than one entry (leaf) or child (branch) encodes past `BLOCK_TARGET_BYTES` (from `a-log-block-rolls-over-by-size`, recommended 1 MiB) by more than one entry; a node over it holds a single entry, and is then no larger than the transaction that wrote that entry. Small-entry trees behave exactly as today (64 × 16 KiB = 1 MiB, so the count rule still decides for them).

Requirements the implementer must hold together:

- **Splits.** A leaf splits when an insert would exceed the count *or* the byte target; the split point divides by bytes when bytes are the reason, so neither half is left over the target if a single entry can avoid it. Branches likewise, by the size of their partition keys and child ids (large keys are the only way a branch grows; include branches if the shared split code makes it natural, otherwise record the branch case as a `NOTE:` tripwire at `branchInsert`).
- **In-place updates.** An entry replaced by a larger one (`updateAt`, the `merge`/upsert path) can grow a leaf with no insert; it must trigger the same split.
- **Rebalance on delete.** Today a leaf under half count borrows or merges. With size splits a leaf of a few large entries is "under half" permanently. Underflow must not cause churn (every delete attempting a borrow/merge that cannot succeed is acceptable only if it is cheap and touches nothing), and a borrow or merge must never produce a node over the byte target — a merge allowed by count but not by bytes is refused.
- **Determinism.** The split decision is a pure function of node content and the entry, so a conflict replay or retried attempt re-stages identical transforms.
- **Cost.** Measuring a node's encoded size per insert is one serialization of the node; leave a `NOTE:` tripwire at the measure (if bulk inserts ever show it in a profile, keep a running size estimate).
- Existing oversized leaves written before this change shrink on their next insert or update (they split); state that in the docs.

## TODO

- Add the size rule to leaf and (if natural) branch insert, in-place update, borrow and merge.
- Regression test at the `BTree` level over `TestTransactor` (the reproduction): 64 entries of 140 KB leave no node over the target unless it holds one entry, and an ordered scan returns all 64. If deletes needed new logic, one test that deleting most of those entries keeps the tree valid and every node within the rules.
- Run the db-core suite and `yarn test` in `packages/quereus-plugin-optimystic` (its index interleaving and mutation sweeps exercise the tree heavily).
- Update `packages/db-core/docs/btree.md` (the minimum-fill row and the split description) and the block-size paragraph in `docs/internals.md`.
