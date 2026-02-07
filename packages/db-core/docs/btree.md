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

- **Splits** - When nodes exceed capacity (64 entries)
- **Merges** - When nodes fall below minimum capacity
- **Borrowing** - Transfer entries between siblings
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
| Minimum fill (non-root) | 32 entries/children | `NodeCapacity >>> 1` |
| Split point | `(length + 1) >>> 1` | Midpoint of overfull node |
| Data location | Leaf nodes only | B+-tree variant (no leaf linked list) |
| Entry immutability | `Object.freeze()` on insert/upsert | Prevents mutation after storage |

### Rebalancing Rules

- **Split**: triggered when a node reaches `NodeCapacity` during insert. Splits at `(entries.length + 1) >>> 1`, promoting the first key of the new right node into the parent branch.
- **Borrow**: after a delete, if a sibling has more than `NodeCapacity >>> 1` entries, one entry is transferred.
- **Merge**: after a delete, if two siblings' combined entries fit within `NodeCapacity`, they are merged and the parent partition is removed. Merges cascade upward.
- **Root collapse**: when the root branch has zero partitions (one child), that child becomes the new root.

### Path Invalidation

A monotonic `_version` counter tracks tree mutations. Paths capture the version at creation time; any subsequent mutation increments the version, making all outstanding paths invalid. Operations that accept a path (`at`, `deleteAt`, `updateAt`, `moveNext`, `movePrior`, `ascending`, `descending`) call `validatePath()` which throws on stale paths. Mutation operations (`insert`, `upsert`, `deleteAt`, `updateAt`, `merge`) return a fresh path with the new version.

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
- **Block size** depends on entry size; `ring-selector.ts` estimates ~100 KB typical.

### Network Efficiency

- Each tree operation touches at most O(log₆₄ n) blocks, so only a small fraction of the tree is fetched per operation.
- Splits and merges create/delete at most 2 blocks per level, keeping write amplification low.
