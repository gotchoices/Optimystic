# Optimystic Block Subsystem

The block subsystem is the foundation of Optimystic's distributed database system, providing immutable, versioned data storage units that can be efficiently distributed across a peer-to-peer network.

## Overview

Blocks are the fundamental storage units in Optimystic, designed to be:
- **Immutable** - Once created, blocks cannot be modified directly
- **Versioned** - Changes are tracked through operations and transforms
- **Distributed** - Can be stored and retrieved across the network
- **Typed** - Each block has a registered type for identification
- **Addressable** - Uniquely identified by base64url-encoded block IDs

## Core Components

### Block Structure

Every block in Optimystic implements the `IBlock` interface:

```typescript
export type IBlock = {
  header: BlockHeader;
}

export type BlockHeader = {
  id: BlockId;           // Domain-wide unique identifier
  type: BlockType;       // Short code identifying block type
  collectionId: BlockId; // ID of the collection this block belongs to
}
```

### Block Operations

Blocks are modified through operations that describe precise changes:

```typescript
export type BlockOperation = [
  entity: string,      // Property name to modify
  index: number,       // Array index (0 for non-array properties)
  deleteCount: number, // Number of elements to remove
  inserted: unknown[] | unknown // New value(s) to insert
]
```

Operations support both array modifications (splice-like) and property assignments.

### Block Types

Block types are registered to provide human-readable names and prevent collisions:

```typescript
// Register a new block type
const MyBlockType = registerBlockType('MB', 'MyBlock');

// Each block type gets a unique short code and descriptive name
```

## Storage Interfaces

### BlockSource

The `BlockSource` interface provides read-only access to blocks:

```typescript
export type BlockSource<T extends IBlock> = {
  createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
  tryGet(id: BlockId): Promise<T | undefined>;
  generateId(): BlockId;
};
```

### BlockStore

The `BlockStore` interface extends `BlockSource` with write operations:

```typescript
export type BlockStore<T extends IBlock> = BlockSource<T> & {
  insert(block: T): void;
  update(blockId: BlockId, op: BlockOperation): void;
  delete(blockId: BlockId): void;
};
```

## Key Features

### Immutability with Operations

While blocks themselves are immutable, they can be modified through operations:

```typescript
// Apply an operation to a block
apply(store, block, ['items', 0, 1, ['newValue']]);

// This updates the block in the store while maintaining immutability
```

### Transform Tracking

The `Tracker` class allows collecting operations without immediately applying them:

```typescript
const tracker = new Tracker(originalStore);

// Make changes to tracker
tracker.insert(newBlock);
tracker.update(blockId, operation);

// Get accumulated transforms
const transforms = tracker.transforms;

// Apply all transforms at once or rollback
tracker.reset();
```

### Type Safety

The system uses TypeScript generics to ensure type safety:

```typescript
// Type-safe block store for specific block types
const treeStore: BlockStore<ITreeNode> = new TestBlockStore();
const chainStore: BlockStore<ChainDataNode<string>> = new ChainStore();
```

## Usage in Optimystic

### B-Tree Storage

Blocks store B-tree nodes with entries and navigation links:

```typescript
interface LeafNode<TEntry> extends ITreeNode {
  entries: TEntry[];
}

interface BranchNode<TKey> extends ITreeNode {
  partitions: TKey[];
  nodes: BlockId[];
}
```

### Chain Storage

Blocks store linked chain nodes for transaction logs:

```typescript
type ChainDataNode<TEntry> = IBlock & {
  entries: TEntry[];
  priorId: BlockId | undefined;
  nextId: BlockId | undefined;
};
```

### Collection Headers

Blocks store collection metadata and configuration:

```typescript
type CollectionHeaderBlock = IBlock & {
  name: string;
  version: number;
  // ... other collection metadata
};
```

## Transform System

The block subsystem integrates with Optimystic's transform system for atomic updates:

```typescript
// Create transforms describing changes
const transforms: Transforms = {
  inserts: { [blockId]: newBlock },
  updates: { [blockId]: [operation1, operation2] },
  deletes: [deletedBlockId]
};

// Apply transforms to a store
applyTransformToStore(transforms, store);
```

## Testing

The subsystem includes comprehensive test utilities:

```typescript
// In-memory block store for testing
const testStore = new TestBlockStore();

// Test operations
testStore.insert(block);
testStore.update(blockId, operation);
console.log(await testStore.tryGet(blockId));
```

## Implementation Notes

- **Block IDs**: Base64url-encoded 256-bit random values for DHT address space and collision resistance
- **Deep Cloning**: Operations use `structuredClone` for immutability
- **Serializable**: Blocks should be serializable via the JSON.parse and JSON.stringify
- **Error Handling**: Missing blocks throw descriptive errors
- **Memory Management**: Blocks are stored as structured clones
- **Network Ready**: Designed for distributed storage and retrieval

## Integration Points

The block subsystem is used throughout Optimystic:

- **Collections**: Store application data and metadata
- **Transaction Logs**: Track changes and maintain consistency
- **B-Trees**: Provide indexed access to data
- **Chains**: Maintain ordered sequences of operations
- **Network Layer**: Distribute blocks across peers
- **Storage Layer**: Persist blocks with compression and archival

This foundation enables Optimystic to provide a robust, scalable distributed database system with strong consistency guarantees and efficient peer-to-peer operation. 
