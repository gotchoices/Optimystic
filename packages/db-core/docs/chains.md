# Chains - linked block primitives

## Overview

**Chains** are fundamental ordered data structures that can function as stacks, queues, or logs depending on how they're used. **Logs** build upon chains to provide transaction logging.

## Chain Architecture

### Core Components

Chains consist of two types of blocks:

```typescript
// Chain header fields - extracted so upstream headers can include them
type IChainHeader = {
  headId: BlockId;  // First block in chain
  tailId: BlockId;  // Last block in chain
};

// Header block - tracks the chain's endpoints
type ChainHeaderNode = IBlock & IChainHeader;

// Data block - contains actual entries
type ChainDataNode<TEntry> = IBlock & {
  entries: TEntry[];              // Up to 32 entries per block (fewer with a byte target)
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

// Create a chain using a pre-existing block as the header (merged header pattern)
const chain = await Chain.create<string>(store, {
  existingHeaderId: upstreamBlock.header.id
});

// Open existing chain
const chain = await Chain.open<string>(store, 'existing-chain-id');
```

### Block roll-over: by count, and optionally by size

`Chain.add` starts a new tail block when the current one holds `EntriesPerBlock` (32) entries. A chain given a byte target in its options (`ChainInitOptions.blockTargetBytes`) also starts one when the tail holds at least one entry and the next entry would take the tail's encoded size — the UTF-8 length of its JSON (`jsonEncodedBytes`) — past the target. A tail holding no entry always takes the next one, so an entry larger than the target sits alone in its own block. An `add` of several entries packs them by both rules, block after block.

The size rule is opt-in so `Chain` stays generic: a chain without a target rolls over by count alone and never serializes a block to measure it. The log opts in (`Log.getChainOptions` sets `BLOCK_TARGET_BYTES`, 1 MiB, from `packages/db-core/src/network/block-size.ts`), because every log entry carries its action's data, and 32 large entries in one block made a block too large to copy between machines. So a log block either holds one entry — and is then no larger than the transaction that wrote it — or stays near the target; a log of entries of 32 KiB or less rolls over by count exactly as before.

The split is a pure function of the tail block's content and the entries being added, so a retried append at the same revision splits identically. A tail written before the rule existed that is already past the target stops growing: the next append rolls over. Nothing shrinks it.

Measuring costs one serialization of the tail block per append (see the `NOTE:` at `Chain.takenBy` in `packages/db-core/src/chain/chain.ts`).

### Merged Header Pattern

When a chain is embedded in a larger structure (e.g. a collection), the upstream header block can serve double duty as the chain header. The `IChainHeader` interface (`headId`, `tailId`) is extracted so upstream types can formally include these fields:

```typescript
// Upstream header includes chain fields
type CollectionHeaderBlock = IBlock & Partial<IChainHeader>;

// Create chain on the existing header — no extra block inserted
const chain = await Chain.create<string>(store, {
  existingHeaderId: collectionHeader.header.id
});
```

This avoids an extra level of indirection and makes the merged relationship type-safe.

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

- **At most 32 entries per block** — and, for the log, at most about `BLOCK_TARGET_BYTES` (1 MiB) per block holding more than one entry — keep each block small enough to copy between machines in one message
- **Linked structure** enables efficient insertion and traversal
- **Block reuse** minimizes storage overhead

### Scalability

- **Distributed storage** across peer networks
- **Lazy loading** of chain blocks
- **Efficient navigation** through block links

