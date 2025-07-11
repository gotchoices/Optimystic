# Chains - linked block primitives

## Overview

**Chains** are fundamental ordered data structures that can function as stacks, queues, or logs depending on how they're used. **Logs** build upon chains to provide transaction logging.

## Chain Architecture

### Core Components

Chains consist of two types of blocks:

```typescript
// Header block - tracks the chain's endpoints
type ChainHeaderNode = IBlock & {
  headId: BlockId;  // First block in chain
  tailId: BlockId;  // Last block in chain
};

// Data block - contains actual entries
type ChainDataNode<TEntry> = IBlock & {
  entries: TEntry[];              // Up to 32 entries per block
  priorId: BlockId | undefined;   // Link to previous block
  nextId: BlockId | undefined;    // Link to next block
};
```

### Chain Navigation

Chains provide a `ChainPath` abstraction for precise navigation:

```typescript
type ChainPath<TEntry> = {
  headerBlock: ChainHeaderNode;
  block: ChainDataNode<TEntry>;
  index: number;  // Index within the block
};
```

This enables efficient traversal and random access within the distributed chain structure.

## Chain APIs

### Creation and Access

```typescript
// Create a new chain
const chain = await Chain.create<string>(store, {
  newId: 'my-chain-id',
  createDataBlock: () => ({ header: store.createBlockHeader(ChainDataBlockType) }),
  createHeaderBlock: (id) => ({ header: store.createBlockHeader(ChainHeaderBlockType, id) })
});

// Open existing chain
const chain = await Chain.open<string>(store, 'existing-chain-id');
```

### Stack Operations (LIFO)

```typescript
// Push to tail (stack push)
await chain.add('item1', 'item2', 'item3');

// Pop from tail (stack pop)
const items = await chain.pop(2);  // Returns ['item3', 'item2']
```

### Queue Operations (FIFO)

```typescript
// Enqueue to tail
await chain.add('first', 'second', 'third');

// Dequeue from head
const items = await chain.dequeue(2);  // Returns ['first', 'second']
```

### Navigation and Iteration

```typescript
// Get chain endpoints
const headPath = await chain.getHead();
const tailPath = await chain.getTail();

// Iterate forward (head to tail)
for await (const path of chain.select(undefined, true)) {
  const entry = entryAt(path);
  console.log(entry);
}

// Iterate backward (tail to head)
for await (const path of chain.select(undefined, false)) {
  const entry = entryAt(path);
  console.log(entry);
}

// Navigate step by step
const nextPath = await chain.next(currentPath);
const prevPath = await chain.prev(currentPath);
```

## Use Cases

Besides forming the basis for logs, chains can be used for other purposes.

### Message Queues

```typescript
// Work queue
const workQueue = await Chain.create<WorkItem>(store);
await workQueue.add(workItem1, workItem2);

// Process work items
const items = await workQueue.dequeue(5);
items.forEach(item => processWork(item));
```

### Activity Feeds

```typescript
// Activity feed (stack-like access)
const feed = await Chain.create<ActivityItem>(store);
await feed.add(newActivity);

// Get recent activities
const recent = await feed.pop(10);
```

## Performance Characteristics

### Block Efficiency

- **32 entries per block** optimize storage and network transfer
- **Linked structure** enables efficient insertion and traversal
- **Block reuse** minimizes storage overhead

### Scalability

- **Distributed storage** across peer networks
- **Lazy loading** of chain blocks
- **Efficient navigation** through block links

