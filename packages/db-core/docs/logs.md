# Logs in Optimystic

Logs form the backbone of Optimystic's distributed transaction system, providing ordered, persistent data structures that enable consistent distributed operations across peer-to-peer networks.  Logs build on chains for actual storage.


## Log Architecture

Logs extend chains specifically for transaction logging, adding:

- **Transaction integrity** through SHA256 block hashing
- **Checkpoint management** for efficient transaction state queries
- **Action tracking** with transaction IDs and revision numbers
- **Multi-collection coordination** for distributed transactions

### Log Entry Structure

```typescript
type LogEntry<TAction> = {
  timestamp: number;
  rev: number;           // Monotonically increasing revision
  action?: ActionEntry<TAction>;
  checkpoint?: CheckpointEntry;
};

type ActionEntry<TAction> = {
  trxId: TrxId;
  actions: TAction[];
  blockIds: BlockId[];        // Blocks affected by transaction
  collectionIds?: CollectionId[];  // Collections involved
};

type CheckpointEntry = {
  pendings: TrxRev[];     // Currently uncommitted transactions
};
```

### Block Integrity

Logs maintain integrity through block hashing:

```typescript
// Each block contains hash of previous block
type LogBlock<TAction> = ChainDataNode<LogEntry<TAction>> & {
  priorHash?: string;  // Base64url encoded SHA256 of previous block
};
```

## Log APIs

### Creation and Access

```typescript
// Create new log
const log = await Log.create<MyAction>(store, 'log-id');

// Open existing log
const log = await Log.open<MyAction>(store, 'existing-log-id');
```

### Transaction Operations

```typescript
// Add actions to log
const { entry, tailPath } = await log.addActions(
  [action1, action2],           // Actions to perform
  'transaction-id',             // Transaction ID
  123,                          // Revision number
  () => ['block1', 'block2'],   // Block IDs affected
  ['collection1', 'collection2'], // Collections involved
  Date.now()                    // Timestamp
);

// Add checkpoint
const { entry, tailPath } = await log.addCheckpoint(
  [{ trxId: 'tx1', rev: 120 }, { trxId: 'tx2', rev: 121 }],  // Pending transactions
  123,                          // Current revision
  Date.now()                    // Timestamp
);
```

### Transaction Context

```typescript
// Get current transaction context
const context = await log.getTrxContext();
// Returns: { committed: TrxRev[], rev: number }

// Get actions from specific revision
const { context, entries } = await log.getFrom(100);
// Returns all actions after revision 100
```

### Log Traversal

```typescript
// Iterate through log entries
for await (const entry of log.select(undefined, true)) {
  if (entry.action) {
    console.log('Action:', entry.action);
  } else if (entry.checkpoint) {
    console.log('Checkpoint:', entry.checkpoint);
  }
}
```

## Integration with Optimystic

### Block System Integration

Chains and logs are built on Optimystic's block system:

```typescript
// Chains use block operations for modifications
apply(store, block, [entries$, index, deleteCount, newEntries]);
apply(store, headerBlock, [tailId$, 0, 0, newTailId]);

// Atomic operations ensure consistency
const trx = new Atomic(store);
trx.insert(newBlock);
apply(trx, existingBlock, operation);
trx.commit();
```

### Transaction System Integration

Logs coordinate with the broader transaction system:

- **Transaction IDs** link log entries to distributed transactions
- **Block IDs** track all blocks affected by a transaction
- **Collection IDs** enable cross-collection transaction coordination
- **Revision numbers** provide ordering for distributed operations

### Network Layer Integration

Chains and logs support distributed operations:

- **Block distribution** across peer-to-peer networks
- **Consensus mechanisms** for transaction ordering
- **Conflict resolution** through revision tracking
- **Checkpointing** for efficient state synchronization

## Use Cases

### Transaction Logs

```typescript
// Database transaction log
const txLog = await Log.create<DatabaseAction>(store);
await txLog.addActions(
  [{ type: 'INSERT', table: 'users', data: userData }],
  transactionId,
  revisionNumber,
  () => affectedBlockIds
);
```

### Event Sourcing

```typescript
// Event log for state reconstruction
const eventLog = await Log.create<DomainEvent>(store);
for await (const entry of eventLog.select()) {
  if (entry.action) {
    entry.action.actions.forEach(event => applyEvent(event));
  }
}
```

## Performance Characteristics

### Network Optimization

- **Localized operations** reduce network round-trips
- **Atomic transactions** ensure consistency across distributed blocks
- **Checkpoint compression** reduces log size for long-running systems

### Scalability

- **Distributed storage** across peer networks
- **Lazy loading** of chain blocks
- **Efficient navigation** through block links

## Implementation Notes

- **Thread Safety**: Operations use atomic transactions for consistency
- **Error Handling**: Graceful handling of missing blocks and network partitions
- **Memory Management**: Efficient block caching and lazy loading
- **Integrity**: SHA256 hashing ensures log integrity
- **Recovery**: Checkpoint system enables efficient state recovery

Logs provide the foundational data structure that enables Optimystic's distributed database capabilities. 
