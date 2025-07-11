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

## Performance Characteristics

- **Node Capacity**: 64 entries per node
- **Tree Height**: O(log n) for balanced access
- **Range Queries**: Efficient iteration without loading entire tree
- **Memory Usage**: Blocks loaded on-demand, structured cloning for consistency
- **Network Efficiency**: Block-based storage minimizes network transfers


