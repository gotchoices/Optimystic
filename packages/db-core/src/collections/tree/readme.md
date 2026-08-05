# Tree Collection

The Tree Collection combines the logical transaction logging of a collection, with a BTree data structure.

## CollectionTrunk

To avoid having both a collection header and a btree header, we enable the collection header to double as the btree header.  This is accomplished using the "...Trunk" abstraction provided by the BTree.  The trunk interface abstracts accessing or updating the root of the tree, from the btree proper.  For this implementation, we introduce a CollectionTrunk class that implements the trunk interface.  The CollectionTrunk reads the root id from the collection header, and updates the collection header with the new root id when the root changes.

## Replace Action

The replace action is a unit of change to the tree collection.  It is a list of key-value pairs, where the key is the key to replace, and the value is the new value to replace the old value with.  If the value is not provided, the key is deleted.

```ts
tree.replace([
	{ key: 5, value: { a: 1, b: 'Value' } },
	{ key: 10 },
]);
```
Replaces the value at key 5 with { a: 1, b: 'Value' }, and deletes the value at key 10.

## Committed read views (`readView`)

`tree.readView(snapshot)` builds a read-only view of the tree as captured by an earlier
`tree.snapshot()` — typically the pre-transaction state recorded before any DML was staged.
It is how a `committed.<Table>` reference (e.g. inside a deferred CHECK) reads committed
rows while the live tree still holds the transaction's in-flight changes.

The view guarantees **one consistent answer from first read to last**:

- It never sees mutations staged into the live tree after the snapshot was taken.
- It is pinned to the collection's committed revision at view-creation time: commits that
  fold into the live tree's cache — or clear it (a live read's `update()` after another
  writer commits) — while the view is being walked do not change what the view returns.
  This holds even for blocks the view has to fetch from storage mid-scan (the view carries
  its own frozen action context, which the transactor honours on `get`).
- A block the storage layer cannot reconstruct at the pinned revision surfaces as
  `BlockUnavailableError`, never as a silently absent block.

By default a view records **no read dependencies** — it is not part of any transaction's
conflict set, so an unrelated committed read can never fail a writer's commit validation.
Pass `{ recordReads: true }` to opt back in.

Each view privately holds up to the block-cache LRU budget (128 blocks, cloned at creation)
plus whatever it faults in; views are intended to be per-scan and dropped when the scan ends.
