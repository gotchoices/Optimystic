# BTree

BTree is a B+tree implementation designed for distributed storage, providing efficient sorted access to data through immutable block-based storage.

## Block Types

| BlockId | Type | Description |
|---------|------|-------------|
| TR | TreeRoot | Root reference block (trunk) |
| TL | TreeLeaf | Leaf nodes containing actual data |
| TB | TreeBranch | Branch nodes for navigation |

## Overview

BTree is a B+tree implementation with the following characteristics:

* **Data at leaves only** - All entries are stored in leaf nodes
* **Sorted access** - Keys are maintained in sorted order for efficient range queries
* **Immutable blocks** - Updates use block operations for consistency
* **Type-safe** - Generic implementation supporting custom key/entry types
* **Distributed-ready** - Designed for network storage and retrieval

## Core API

### Basic Operations

```typescript
// Create a new tree
const tree = BTree.create(store, createTrunk, keyFromEntry, compare);

// Find entries
const path = await tree.find(key);           // Returns Path (may be "off" if not found)
const entry = await tree.get(key);           // Returns entry or undefined
const entry = tree.at(path);                 // Get entry at path position

// Modify entries
const insertPath = await tree.insert(entry);     // Insert new entry
const updatePath = await tree.updateAt(path, newEntry);  // Update at path
const upsertPath = await tree.upsert(entry);     // Insert or update
const deleted = await tree.deleteAt(path);       // Delete at path

// Navigation
const firstPath = await tree.first();        // First entry in tree
const lastPath = await tree.last();          // Last entry in tree
const nextPath = await tree.next(path);      // Next entry from path
const priorPath = await tree.prior(path);    // Previous entry from path
```

### Range Queries

```typescript
// Define ranges with KeyBound and KeyRange
const range = new KeyRange(
  new KeyBound(startKey, true),    // inclusive start
  new KeyBound(endKey, false),     // exclusive end  
  true                             // ascending order
);

// Iterate over range
for await (const path of tree.range(range)) {
  const entry = tree.at(path);
  console.log(entry);
}

// Count entries in range
const count = await tree.getCount({
  path: await tree.find(startKey),
  ascending: true
});
```

## Path System

The Path system provides cursor-like navigation through the tree:

```typescript
export class Path<TKey, TEntry> {
  branches: PathBranch<TKey>[];    // Navigation path through branches
  leafNode: LeafNode<TEntry>;      // Current leaf node
  leafIndex: number;               // Index within leaf
  on: boolean;                     // true if on entry, false if between
  version: number;                 // Tree version for validation
}
```

### Path Usage

```typescript
// Find returns a path that may be "on" or "off" an entry
const path = await tree.find(key);
if (path.on) {
  const entry = tree.at(path);     // Get the entry
  await tree.deleteAt(path);       // Delete it
} else {
  // Path is positioned at insertion point
  await tree.insert(newEntry);    // Insert will go here
}

// Navigate using paths
const nextPath = await tree.next(path);
const priorPath = await tree.prior(path);
```

## Tree Structure

### Leaf Nodes

```typescript
interface LeafNode<TEntry> extends ITreeNode {
  entries: TEntry[];    // Sorted array of entries
}
```

### Branch Nodes

```typescript
interface BranchNode<TKey> extends ITreeNode {
  partitions: TKey[];   // Partition keys for routing
  nodes: BlockId[];     // Child node references
}
```

**Branch Layout:**
```
NodeIDs:     [ID0] [ID1] [ID2] [ID3]
                ^     ^     ^
               /     /     /
Partitions:        P1    P2    P3
```

- Partition keys represent the lowest key in the subtree to the right
- `nodes` array has one more entry than `partitions` array
- Navigation uses binary search to find correct child node

## Trunk Management

The trunk manages the root reference, allowing trees to be embedded in other structures:

```typescript
interface ITreeTrunk {
  get(): Promise<ITreeNode>;        // Get root node
  set(node: ITreeNode): Promise<void>;  // Set root node  
  getId(): Promise<BlockId>;        // Get root node ID
}

// Independent tree with dedicated root block
const trunk = IndependentTrunk.create(store, rootId);
const tree = new BTree(store, trunk, keyFromEntry, compare);
```

## Block Integration

### Storage Operations

All tree modifications use block operations for consistency:

```typescript
// Insert entry into leaf
apply(store, leafNode, [entries$, index, 0, [entry]]);

// Update branch partitions
apply(store, branchNode, [partitions$, index, 1, [newKey]]);

// Delete entry from leaf
apply(store, leafNode, [entries$, index, 1, []]);
```

### Rebalancing

The tree automatically rebalances during insertions and deletions:

- **Splits** - When a node would exceed its capacity (64 entries or children) or, under a byte target, its size (see [Node size](#node-size))
- **Merges** - When nodes fall below minimum capacity, and the merged node stays within the byte target
- **Borrowing** - Transfer entries between siblings, within the byte target
- **Root changes** - Create new root during splits or collapse during merges

## Type Safety

Generic implementation supports custom types:

```typescript
// Simple key-only tree
const keyset = new Keyset<string>(store, trunk);

// Complex entries with custom key extraction
const userTree = new BTree(
  store,
  trunk,
  (user: User) => user.id,           // Extract key from entry
  (a, b) => a.localeCompare(b)       // Custom comparison
);
```

## Advanced Features

### Iteration

```typescript
// Forward iteration
for await (const path of tree.ascending(startPath)) {
  const entry = tree.at(path);
  // Process entry
}

// Backward iteration  
for await (const path of tree.descending(startPath)) {
  const entry = tree.at(path);
  // Process entry
}
```

### Validation

```typescript
// Paths become invalid after tree mutations
const path = await tree.find(key);
await tree.insert(otherEntry);  // Tree mutated
console.log(tree.isValid(path)); // false - path invalidated
```

### Merging

```typescript
// Conditional insert/update
const [resultPath, wasUpdate] = await tree.merge(
  newEntry,
  (existing) => ({ ...existing, updated: true })
);
```

## Invariants

The B-tree maintains these structural invariants at all times:

| Property | Value | Notes |
|----------|-------|-------|
| Node capacity | 64 entries/children | `NodeCapacity` constant |
| Node size target (optional) | `nodeTargetBytes` of JSON | `Tree` sets `BLOCK_TARGET_BYTES` (1 MiB); a node over it holds one entry (leaf) or two children (branch) |
| Minimum fill (non-root) | 32 entries/children, or half the byte target | Under-full only when below both (`NodeCapacity >>> 1`, `nodeTargetBytes / 2`) |
| Split point | `(length + 1) >>> 1` | Midpoint of overfull node when the count is the reason; by bytes otherwise (see [Node size](#node-size)) |
| Data location | Leaf nodes only | B+-tree variant (no leaf linked list) |
| Entry immutability | `Object.freeze()` on insert/upsert | Prevents mutation after storage |

### Rebalancing Rules

- **Split**: triggered when an insert or an in-place update would take a node past `NodeCapacity`, or past the byte target. When the count is the reason it splits at `(entries.length + 1) >>> 1`, promoting the first key of the new right node into the parent branch; when bytes are, see [Node size](#node-size).
- **Borrow**: after a delete, if a sibling has more than `NodeCapacity >>> 1` entries, one entry is transferred — unless it would take the receiving node past the byte target.
- **Merge**: after a delete, if two siblings' combined entries fit within `NodeCapacity` and the byte target, they are merged and the parent partition is removed. Merges cascade upward. A merge that removes an empty leaf is never refused.
- **Root collapse**: when the root branch has zero partitions (one child), that child becomes the new root.

### Atomic Mutations

Trees created via `BTree.create()` wrap the store in an `AtomicProxy`, so each public mutation method (`insert`, `upsert`, `merge`, `updateAt`, `deleteAt`, `drop`) collects all block operations into an `Atomic` tracker and commits them as a batch on success, or discards them on error. The BTree and its trunk share the same proxy, so root pointer updates are part of the same atomic batch. Nested mutations (e.g., `merge` → `updateAt`) are re-entrant safe — inner calls skip creating a new tracker.

Trees constructed directly via `new BTree()` do not get atomicity; this path is used by the collection system which manages its own tracker externally.

### Path Invalidation

A monotonic `_version` counter tracks tree mutations. Paths capture the version at creation time; any subsequent mutation increments the version, making all outstanding paths invalid. Operations that accept a path (`at`, `deleteAt`, `updateAt`, `moveNext`, `movePrior`, `ascending`, `descending`) call `validatePath()` which throws on stale paths. Mutation operations (`insert`, `upsert`, `deleteAt`, `updateAt`, `merge`) return a fresh path with the new version.

## Node size

Every node is a block, and a block that outgrows what one message carries can never be copied to another machine (see [docs/internals.md §A transaction's size limit](../../../docs/internals.md#a-transactions-size-limit)). A node holds up to 64 entries however large they are, and nothing else would stop a table of large rows from building a leaf past that limit: each row is its own small transaction, so the per-transaction limit never sees the leaf grow. So a tree can also be given a byte target, `nodeTargetBytes` on the `BTree` constructor and `BTree.create` in `packages/db-core/src/btree/btree.ts`, measured like every block limit as the UTF-8 length of the node's JSON (`jsonEncodedBytes` in `packages/db-core/src/network/transaction-size.ts`). The tree collection sets it to `BLOCK_TARGET_BYTES` (1 MiB, `packages/db-core/src/network/block-size.ts`) on every B-tree it builds, write and read side alike. A bare `BTree` without one splits by count alone and never serializes a node to measure it.

**Fit.** A node fits when it holds at most `NodeCapacity` items and either no more than the target's bytes or the least a node of its kind holds: one entry for a leaf, two children (one key) for a branch, since nothing smaller routes. So a node may exceed the target only while holding that minimum, and a leaf of one entry is never larger than the transaction that wrote the entry.

**Division** (`divideItems` in `packages/db-core/src/btree/btree.ts`). An insert, or an in-place update that grows an entry (`upsert`, `updateAt`, `merge`), is judged on the node as it would stand with the edit applied:

- Over the count alone, the node splits in two at the midpoint, the odd item going to the half the edit lands in — the division the tree has always made, kept exactly so a tree of small entries writes the transforms it always did (64 entries of 16 KiB is 1 MiB, so for entries of that size and below the count still decides).
- Over the bytes, the node divides into the fewest runs that each fit, and where two suffice into the two whose larger run is smallest. An entry larger than the target by itself is therefore left alone in a leaf of its own, with its neighbours within the target on either side, and a leaf that outgrew the target before this rule existed is brought within it by its next insert or update, in one write.
- A parent absorbs all of a child's new nodes at once, each under the lowest key beneath it, and divides by the same rules if it cannot hold them. A branch's bytes are its keys and child ids, so only large keys ever make bytes the reason there.

The division is a pure function of the node's content and the edit, so a conflict replay or a retried attempt re-stages identical transforms.

**Rebalance on delete.** A node is under-full only when it is below half the count *and* below half the byte target, so a leaf of a few large entries — under half the count for good — is a healthy block that no delete tries to fill, and a delete from it reads no sibling. A borrow is refused when the receiving node would pass the target, and a merge when the merged node would, so a merge the count allows can still be refused; the one exception is a merge that removes an empty leaf, which adds nothing to the other and is never refused, so no empty leaf outlives the delete that emptied it. A leaf that is under-full by both measures and refused by both siblings costs a delete from it two sibling reads and no write.

**Cost.** One serialization of the node's entries per insert or in-place update, and of the leaf and the siblings it weighs per rebalance — the same order of cost as the commit path's digest of each touched block. The `NOTE:` at `leafRuns` in `packages/db-core/src/btree/btree.ts` names the remedy (a running byte count per leaf) if bulk inserts ever show it in a profile.

## Performance Characteristics

### Time Complexity

| Operation | Complexity | Notes |
|-----------|-----------|-------|
| `find` / `get` | O(log₆₄ n) | Binary search at each level |
| `insert` | O(log₆₄ n) | Plus amortized O(1) split cost |
| `deleteAt` | O(log₆₄ n) | Plus amortized rebalance |
| `updateAt` | O(log₆₄ n) | O(1) if key unchanged; delete+insert if key changes |
| `upsert` / `merge` | O(log₆₄ n) | find + insert or update |
| `first` / `last` | O(log₆₄ n) | Descend one edge of tree |
| `next` / `prior` | O(1) amortized | O(log₆₄ n) worst-case at block boundary |
| `range` iteration | O(k + log₆₄ n) | k = results returned |
| `getCount` | O(n / avg-fill) | Visits every leaf node |
| `drop` | O(n / 64) | Visits every node |

### Space and Memory

- **Branching factor 64** → tree height ≈ log₆₄(n). A tree with 1M entries is ~3 levels deep.
- **Blocks loaded on demand** via the `BlockStore` abstraction; no full-tree materialization.
- **Structured cloning** (`structuredClone`) used for block isolation — reads never alias stored data.
- **Block size** depends on entry size, bounded for a tree collection by `BLOCK_TARGET_BYTES` (see [Node size](#node-size)); `ring-selector.ts` estimates ~100 KB typical.

### Network Efficiency

- Each tree operation touches at most O(log₆₄ n) blocks, so only a small fraction of the tree is fetched per operation.
- Splits and merges create/delete at most 2 blocks per level, keeping write amplification low.
