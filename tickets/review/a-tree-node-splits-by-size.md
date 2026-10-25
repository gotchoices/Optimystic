description: A table's rows are stored in tree nodes of up to 64 rows each however large the rows are, so a table of large rows built nodes too big to copy between machines. Tree nodes now split by size as well as by count, and a separate ordering bug in branch splits was found and fixed on the way.
architecture: packages/db-core/docs/btree.md#node-size
files: packages/db-core/src/btree/btree.ts (`nodeTargetBytes`, `leafEdit`, `leafRuns`, `branchInsert`, `branchRuns`, `growRoot`, `divideItems`, `fewestRuns`, `balancedSplit`, `leafUnderfull`, `leavesMerge`, `branchesMerge`), packages/db-core/src/collections/tree/tree.ts, packages/db-core/test/btree-node-size.spec.ts, packages/db-core/docs/btree.md, docs/internals.md, packages/db-core/README.md
difficulty: hard
----
# A tree node splits by size

## What landed

- `BTree` takes an optional `nodeTargetBytes` (constructor and `BTree.create`, after `nodeCapacity` and `newId`), measured like every block limit as the UTF-8 length of the node's JSON. `Tree` passes `BLOCK_TARGET_BYTES` (1 MiB) to every B-tree it builds: the per-action write tree, the create-path tree and the reopen tree. A bare `BTree` without a target behaves as before and never serializes a node to measure it, the same opt-in shape the log's `blockTargetBytes` has.
- **Fit rule.** A node fits when it holds at most `nodeCapacity` items and either no more than the target's bytes or the least a node holds: one entry for a leaf, **two children (one key) for a branch**, since nothing smaller routes. So a node over the target holds only that minimum. The ticket said "a single entry or child"; I chose two children for branches, because a one-child branch is a degenerate node and the ticket left the branch case to the implementer.
- **Division** (`divideItems`). An insert or an in-place update (`upsert`, `updateAt`, `merge`) is judged on the leaf as it would stand with the edit applied. Over the count alone, the node splits in two at the midpoint exactly as before, so a tree of small entries writes byte-identical transforms (I checked the old and new operation sequences by hand for both halves of the count split, leaf and branch). Over the bytes, the node divides into the fewest runs that each fit, balanced where two suffice. This is more than the ticket asked for (it asked for a two-way split by bytes), and it is why an entry larger than the target lands alone in its own leaf even when it is inserted in the middle of a leaf, and why a leaf that outgrew the target before this change is brought within it by one write rather than halving per write. A parent absorbs all of a child's new nodes at once and divides by the same rules; a root that cannot hold them starts as the old root alone and absorbs them through the same path.
- **Rebalance on delete.** A node is under-full only when below half the count and below half the byte target, so a leaf of a few large entries is left alone and a delete from it reads no sibling. A borrow is refused when the receiver would pass the target; a merge when the merged node would, except a merge that removes an empty leaf, which is never refused so no empty leaf survives a delete.
- **Determinism.** Every division is a pure function of the node's content and the edit.
- Docs: new "Node size" section in `packages/db-core/docs/btree.md` with the invariants table and rebalancing rules updated; a paragraph in `docs/internals.md` under "A transaction's size limit", and the "still open" paragraph there no longer names this ticket; one bullet in `packages/db-core/README.md`.

## A pre-existing bug, fixed on the way

While tracing the old `branchInsert` I found that when a **middle** child of a full branch split, and the new key landed in that child's **right** half, the old code inserted the new leaf into **both** halves of the dividing branch (it compared the already-reduced path index against the midpoint a second time). A scan then returned the moved entries twice and a point lookup for a key in the misplaced sibling returned nothing. I reproduced it at fan-out 4 with the keys 0, 10, …, 90, 35, 37, 38 before changing anything: the scan read 35, 37, 38 twice and `get(50)` was `undefined`. The rewrite defines every division over the node's resulting content, which removes the defect, and the new spec pins the shape. **Blast radius for the reviewer to weigh:** at the default fan-out it needs a branch of 64 leaves, so a table of roughly 2,000 rows or more whose inserts arrive out of key order, with the split child not the last. The existing specs insert ascending (where the split child is always last), and the property spec's sequences (at most 40 operations) rarely fill a branch, which is how it went unnoticed. Trees already written with the defect are not repaired by this change; I did not look for any, and did not raise the property spec's sequence length (it would catch this class at little cost; a reviewer may want to).

## Tests added (`packages/db-core/test/btree-node-size.spec.ts`)

- *divides a leaf by bytes, and leaves an entry larger than the target alone in its leaf* — 200 entries of varied size at a 2,000-byte target: every node within the rules, at least 20 leaves (the count rule alone would make at most 6), scan and point lookups agree with a model; then an entry over the target by itself, inserted mid-leaf, is the only entry of its leaf.
- *divides a leaf when an in-place update grows an entry past the target* — 40 small entries in one leaf, then each grown through `upsert` and through `merge` (so `updateAt`): leaves multiply, every node within the rules, and the returned path is still on the entry after it moved.
- *divides a branch by bytes when its keys are large* — 300-character keys at a 1,200-byte target build a tree of at least four levels where the count rule would give two; rules, scan and lookups hold.
- *keeps every node within the rules through a delete sweep that removes most entries* — two shapes (varied entry sizes; large keys), 170 of 200 entries deleted in a fixed random order, the rules and the scan checked after every delete. This is the test the ticket asked for if deletes needed new logic; they did (byte-checked borrow and merge, under-full by both measures).
- *places a split child correctly when a middle child of a full branch splits toward its right half* — the reproduction of the pre-existing bug above, at fan-out 4 with no byte target.
- *a tree of 140 KB rows over TestTransactor builds no node over BLOCK_TARGET_BYTES unless it holds one entry* — the ticket's named reproduction: 64 rows of 140 KB, one `replace` each, walked from the collection header through the transactor; at least ten leaves and an ordered scan of all 64. Runs in about 0.6 s.

No test restates the division arithmetic; each checks the externally visible rule (every node within the limits, order preserved, model agreement).

## Validation

- `npx tsc --noEmit -p packages/db-core/tsconfig.json` clean; `eslint` on the changed source and the new spec clean.
- `yarn workspace @optimystic/db-core test` — 1916 passing (the existing B-tree, property, tree, guard and read-view specs unchanged and green).
- `yarn build` (root) clean; `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1064 passing, 14 pending, smoke ok. `yarn workspace @optimystic/upgrade-check test` — 143 passing (trees older releases wrote still read).
- `yarn lint:docs` — all citations resolve.
- Not run: the db-p2p suite (no db-p2p source changed, and small-entry trees write the same transforms as before), `yarn test:integration`, `yarn check:rn`.

## Known gaps and choices for the reviewer

- **Branch minimum is two children, not one.** Stated above and in the docs. A branch with absurd keys (two keys that together pass the target) therefore stays over the target with two children; `fewestRuns` also gives a trailing lone child one more from the run before it where that run can spare one.
- **Only the node's own content is measured.** As with the log, the measure is the node's JSON; nothing about the transaction envelope. Over by at most one entry is possible only for nodes written before this change on their next write, which is where the division heals them.
- **No way to set a tree collection's target.** `Tree.createOrOpen` and `Tree.open` do not take a target; `BLOCK_TARGET_BYTES` is a constant, so unlike `nodeCapacity` nothing needs persisting. The collection-level test therefore uses real 140 KB rows.
- **`Tree.readView` builds its B-tree with neither `nodeCapacity` nor the target** (pre-existing for `nodeCapacity`). It is read-only, so neither matters; left as it was.
- **`growRoot` mints a header for the whole root before deciding it fits**; when it does not (keys that two of pass the target, or more new nodes than a branch holds) that id is discarded and another minted. Harmless; noted in case a reviewer wonders about the gap in test-store ids.
- **`branchInsert` now points the path's branch entry at the new branch when the path moves right.** The old code left it at the old node with an index valid only for the new one. Strictly more correct; no caller navigates from an insert's returned path today.
- **Tripwires left in code (`NOTE:`):** the per-write serialization of a leaf at `leafRuns`; the sibling reads a permanently under-full leaf pays per delete at `rebalanceLeaf`.
- **Property spec not extended** with a byte-target run or longer sequences; see the bug section.
