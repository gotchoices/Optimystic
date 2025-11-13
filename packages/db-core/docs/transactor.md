# Transactors in Optimystic

Transactors are the core coordination layer in Optimystic that manages distributed transactions across peer-to-peer networks. They provide the critical bridge between local collection operations and the distributed consensus required for consistent state across multiple participants.

## Abstract Role

A **transactor** serves as the distributed transaction coordinator, handling:

- **Distributed Consensus**: Coordinating agreement on transaction ordering across network participants
- **Conflict Resolution**: Detecting and resolving concurrent modifications to the same blocks
- **Version Management**: Tracking block versions and ensuring transactions apply to current state
- **Transaction Lifecycle**: Managing the pend → commit flow for atomic operations
- **Network Coordination**: Communicating with peer networks to maintain consistency

### Relationship to Collections

Collections operate on **local snapshots** of distributed state. The transactor enables these snapshots to:

1. **Fetch current state** from the distributed network
2. **Detect conflicts** between local and remote changes  
3. **Submit transactions** for network-wide coordination
4. **Receive updates** when remote state changes

```typescript
// Collection uses transactor through TransactorSource
const source = new TransactorSource(collectionId, transactor, context);
const collection = new Collection(handlers, source, ...);

// Update local snapshot from remote state
await collection.update();  // Uses transactor.get()

// Sync local changes to remote state  
await collection.sync();    // Uses transactor.pend() + commit()
```

## Transactor Interface

The `ITransactor` interface defines the core distributed transaction operations:

```typescript
interface ITransactor {
  // Read operations
  get(blockGets: BlockGets): Promise<GetBlockResults>;
  getStatus(actionRefs: ActionBlocks[]): Promise<BlockActionStatus[]>;

  // Action operations
  pend(blockAction: PendRequest): Promise<PendResult>;
  commit(request: CommitRequest): Promise<CommitResult>;
  cancel(actionRef: ActionBlocks): Promise<void>;
}
```

### Read Operations

**Get Blocks**: Retrieves current block state and detects pending transactions

```typescript
// Get blocks with version context
const result = await transactor.get({
  blockIds: ['block1', 'block2'],
  context: { committed: [...], rev: 123 }
});

// Returns current block state plus any pending transactions
const { block, state } = result['block1'];
if (state.pendings.length > 0) {
  // Handle pending transactions
}
```

**Get Status**: Checks transaction status across multiple blocks

```typescript
const statuses = await transactor.getStatus([
  { blockId: 'block1', trxId: 'tx1' },
  { blockId: 'block2', trxId: 'tx2' }
]);
```

### Transaction Operations

**Pend**: Submits a transaction for coordination without committing

```typescript
const pendResult = await transactor.pend({
  transforms: {
    inserts: { 'newBlock': blockData },
    updates: { 'existingBlock': [operation1, operation2] },
    deletes: new Set(['deletedBlock'])
  },
  trxId: 'transaction-123',
  rev: 124,
  policy: 'r'  // Retry policy
});

if (!pendResult.success) {
  // Handle stale state - need to update and retry
  await collection.update();
}
```

**Commit**: Finalizes a pending transaction

```typescript
const commitResult = await transactor.commit({
  headerId: 'collection-header',  // Optional: prioritize collection header
  tailId: 'log-tail-block',       // Optional: prioritize log tail
  blockIds: pendResult.blockIds,  // Blocks from pend operation
  trxId: 'transaction-123',
  rev: 124
});

if (!commitResult.success) {
  // Transaction failed due to conflicts
  return commitResult; // Contains conflict information
}
```

## TransactorSource Integration

The `TransactorSource` class adapts the transactor for use with collections' block-based operations:

```typescript
class TransactorSource<TBlock extends IBlock> implements BlockSource<TBlock> {
  constructor(
    private readonly collectionId: BlockId,
    private readonly transactor: ITransactor,
    public trxContext: TrxContext | undefined
  ) {}
  
  // BlockSource implementation
  async tryGet(id: BlockId): Promise<TBlock | undefined>;
  createBlockHeader(type: BlockType, newId?: BlockId): BlockHeader;
  generateId(): BlockId;
  
  // Transaction coordination
  async transact(transforms: Transforms, trxId: TrxId, rev: number, 
                headerId: BlockId, tailId: BlockId): Promise<StaleFailure | undefined>;
}
```

### Block Retrieval

```typescript
async tryGet(id: BlockId): Promise<TBlock | undefined> {
  const result = await this.transactor.get({ 
    blockIds: [id], 
    context: this.trxContext 
  });
  
  if (result) {
    const { block, state } = result[id];
    // TODO: Track pending transactions for future updates
    return block as TBlock;
  }
}
```

### Transaction Execution

```typescript
async transact(transforms: Transforms, trxId: TrxId, rev: number, 
              headerId: BlockId, tailId: BlockId): Promise<StaleFailure | undefined> {
  // Step 1: Pend the transaction
  const pendResult = await this.transactor.pend({ 
    transforms, trxId, rev, policy: 'r' 
  });
  
  if (!pendResult.success) {
    return pendResult; // Stale failure
  }
  
  // Step 2: Commit the transaction
  const commitResult = await this.transactor.commit({
    headerId: transforms.inserts[headerId] ? headerId : undefined,
    tailId,
    blockIds: pendResult.blockIds,
    trxId,
    rev
  });
  
  if (!commitResult.success) {
    return commitResult; // Commit failure
  }
  
  return undefined; // Success
}
```

## Transaction Lifecycle

### Two-Phase Process

Optimystic uses a **pend → commit** pattern for atomic distributed transactions:

1. **Pend Phase**: 
   - Submit transaction to network for coordination
   - Check for conflicts with current block versions
   - Reserve transaction slot if successful
   - Return failure if state is stale

2. **Commit Phase**:
   - **Log tail first**: Append to the collection's log tail block
   - **Transaction ordering**: If log append succeeds, transaction will eventually complete
   - **Other blocks**: Apply remaining changes to other affected blocks
   - **Atomic completion**: All changes succeed or fail together

### Transaction Ordering Strategy

The key insight in Optimystic's transaction model is **log-first ordering**:

```typescript
await transactor.commit({
  headerId: 'collection-header',  // Optional: new collections only
  tailId: 'log-tail-block',       // CRITICAL: Process this block first
  blockIds: allAffectedBlocks,    // All blocks including tail
  trxId: 'transaction-123',
  rev: 124
});
```

**Why tail-first matters**:
- The **log tail determines transaction order** across the distributed system
- Once a transaction is **appended to the log**, it has claimed its position in the global ordering
- **Other block updates** can proceed knowing the transaction will eventually complete
- **Conflict resolution** is simplified because log ordering provides the definitive sequence

### Conflict Resolution

When transactions conflict, the transactor returns detailed `StaleFailure` information:

```typescript
type StaleFailure = {
  success: false;
  reason?: string;
  missing?: TrxTransforms[];  // Committed transactions newer than our revision
  pending?: TrxPending[];     // Currently pending transactions on affected blocks
};
```

#### Missing Actions

**Missing actions** represent committed changes that occurred after our local snapshot:

```typescript
type ActionTransforms = {
  actionId: ActionId;
  rev?: number;
  transforms: Transforms;  // The actual changes that were committed
};
```

When `missing` actions are returned:
- **Remote state has advanced** beyond our local revision
- **We need to update** our snapshot with these committed changes
- **Our action must be rebased** on the newer state

#### Pending Actions

**Pending actions** represent in-flight changes on blocks we want to modify:

```typescript
type ActionPending = {
  blockId: BlockId;
  actionId: ActionId;
  transform?: Transform;  // The pending change (if policy allows)
};
```

When `pending` transactions are returned:
- **Another participant** is currently modifying the same blocks
- **We can wait** for them to complete or fail
- **We can proceed** with knowledge of the pending changes (depending on policy)

#### Handling Conflict Resolution

```typescript
const staleFailure = await source.transact(transforms, actionId, rev, headerId, tailId);
if (staleFailure) {
  if (staleFailure.missing) {
    // Remote state has advanced - we need to update our snapshot
    await collection.update();  // Fetch missing actions
    // Filter/replay our pending actions against new state
    await collection.replayActions();
  }

  if (staleFailure.pending) {
    // Other actions are in progress
    // Strategy 1: Wait and retry
    await new Promise(resolve => setTimeout(resolve, 100));

    // Strategy 2: Proceed with awareness of pending changes
    // (depending on application logic and conflict tolerance)
  }

  // Retry the action with updated state
}
```

#### Pending Transaction Policies

The `pend` operation accepts different policies for handling concurrent transactions:

```typescript
type PendRequest = {
  transforms: Transforms;
  trxId: TrxId;
  rev?: number;
  policy: 'c' | 'f' | 'r';  // Continue, Fail, or Return
};
```

- **'c' (Continue)**: Proceed normally even if pending transactions exist
- **'f' (Fail)**: Fail immediately if any pending transactions exist
- **'r' (Return)**: Fail but return detailed information about pending transactions

## Core Transaction Model

The transactor's primary responsibility is maintaining **distributed consensus** on transaction ordering through the log-first strategy:

1. **Log Append**: Transaction order is established by successfully appending to the collection's log tail
2. **Distributed Agreement**: All network participants agree on the log ordering
3. **Block Updates**: Other blocks are updated based on the established transaction order
4. **Conflict Resolution**: Conflicts are resolved through missing/pending transaction information
5. **Atomic Completion**: All changes in a transaction succeed or fail together

### Network Coordination

While the `ITransactor` interface is abstract, implementations coordinate across distributed networks through:

- **Consensus Protocols**: Ensure all participants agree on transaction ordering
- **Conflict Detection**: Identify when multiple participants modify the same blocks
- **Version Management**: Track block versions across the distributed system
- **Recovery Mechanisms**: Handle network partitions and participant failures

The transactor abstraction allows collections to operate consistently across peer-to-peer networks without needing to understand the underlying consensus mechanisms, providing a clean interface for distributed transaction coordination.

