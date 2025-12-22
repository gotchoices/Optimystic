# Collections in Optimystic

Collections are the high-level abstraction in Optimystic that combine data structures (like B-trees) with transaction logs to provide distributed, consistent, and conflict-resilient data storage across peer-to-peer networks.

## Overview

A **Collection** is a logical grouping of related data that can be queried and modified as a unit. Collections provide:

- **Distributed transactions** with strong consistency guarantees
- **Conflict resolution** for concurrent operations
- **Action-based mutations** through a command pattern
- **Integration with specialized data structures** (B-trees, chains, etc.)
- **Automatic synchronization** across the network

## Architecture

### Core Components

Collections integrate several key systems:

```typescript
// Collection structure
class Collection<TAction> {
  private pending: Action<TAction>[] = [];           // Local pending actions
  private readonly source: TransactorSource<IBlock>; // Network transaction source
  private readonly sourceCache: CacheSource<IBlock>; // Block caching layer
  public readonly tracker: Tracker<IBlock>;          // Change tracking
  private readonly handlers: Record<ActionType, ActionHandler<TAction>>; // Action handlers
}
```

### Transaction Log Integration

Every collection has an associated transaction log that records all mutations:

```typescript
// Collection header block
type CollectionHeaderBlock = IBlock & {
  header: {
    type: CollectionHeaderType;
  };
};

// The collection ID doubles as the log ID
type CollectionId = BlockId;
```

## Snapshot Model

Collections operate as a **limited snapshot of remote state**. This snapshot model provides:

- **Local Changes**: Applied immediately to the local snapshot
- **Batched Operations**: Multiple changes accumulated before synchronization
- **Cached Reads**: Served from the local snapshot for performance
- **Explicit Synchronization**: Controlled updates with remote state

### Local Snapshot and Batching

```typescript
// Changes are applied to local snapshot immediately
await collection.act(action1, action2, action3);

// Batch is synchronized with remote state explicitly
await collection.updateAndSync();
```

## Action System

The **action abstraction** is central to collections - it allows the system to "play" actions whether they originate locally or from remote peers during synchronization.

### Action Structure

```typescript
type Action<T> = {
  type: ActionType;  // Action identifier
  data: T;          // Action payload
};

type ActionHandler<T> = (action: Action<T>, store: BlockStore<IBlock>) => Promise<void>;
```

### Action Replay

Actions can be applied in different contexts:

```typescript
// Local actions - applied to local snapshot
await collection.act(localAction);

// Remote actions - replayed during synchronization
// (handled internally by update process)

// Conflict resolution - replayed after state updates
// (handled internally by conflict resolution)
```

## Communication with Remote State

Collections communicate with remote state through a **transactor** (covered in detail in another document). The transactor handles:

- **Network protocols** for distributed coordination
- **Consensus mechanisms** for transaction ordering
- **Conflict detection** across network participants
- **Block distribution** and storage coordination

### Action Context

Collections maintain awareness of the distributed action state:

```typescript
type ActionContext = {
  committed: ActionRev[];  // Actions that may not be checkpointed
  rev: number;             // Latest known revision number
  actionId?: ActionId;     // Optional uncommitted pending action ID
};
```

This context represents the collection's current understanding of the remote state's revision.

## Update and Sync Operations

### Update Process

The `update()` operation refreshes the local snapshot with remote changes:

```typescript
async update() {
  // 1. Query remote state from our current revision
  const source = new TransactorSource(this.id, this.transactor, undefined);
  const tracker = new Tracker(source);
  
  // 2. Get latest entries from the log since our last update
  const log = await Log.open<Action<TAction>>(tracker, this.id);
  const latest = log ? await log.getFrom(this.source.actionContext?.rev ?? 0) : undefined;
  
  // 3. Process remote actions and detect conflicts
  let anyConflicts = false;
  for (const entry of latest?.entries ?? []) {
    // Filter pending actions that conflict with remote actions
    this.pending = this.pending.map(p => 
      this.doFilterConflict(p, entry.actions) ? p : undefined
    ).filter(Boolean) as Action<TAction>[];
    
    // Invalidate cache for affected blocks
    this.sourceCache.clear(entry.blockIds);
    anyConflicts = anyConflicts || tracker.conflicts(new Set(entry.blockIds)).length > 0;
  }
  
  // 4. If conflicts detected, replay local actions on updated state
  if (anyConflicts) {
    await this.replayActions();
  }
  
  // 5. Update our snapshot's revision context
  this.source.trxContext = latest?.context;
}
```

Key aspects of the update process:

- **Incremental**: Only fetches changes since the last known revision
- **Conflict-aware**: Detects when local and remote changes affect the same blocks
- **Selective caching**: Only invalidates cache for affected blocks
- **Action replay**: Re-applies local actions on the updated state to resolve conflicts

### Sync Process

The `sync()` operation pushes local changes to the remote state:

```typescript
async sync() {
  const lockId = `Collection.sync:${this.id}`;
  const release = await Latches.acquire(lockId);
  try {
    while (this.pending.length || !isTransformsEmpty(this.tracker.transforms)) {
      // 1. Snapshot current pending actions
      const pending = [...this.pending];
      const actionId = generateActionId();

      // 2. Create transaction snapshot
      const snapshot = copyTransforms(this.tracker.transforms);
      const tracker = new Tracker(this.sourceCache, snapshot);

      // 3. Add transaction to log (locally)
      const log = await Log.open<Action<TAction>>(tracker, this.id);
      const newRev = (this.source.trxContext?.rev ?? 0) + 1;
      const addResult = await log.addActions(
        pending, actionId, newRev,
        () => tracker.transformedBlockIds()
      );

      // 4. Attempt to commit to remote via transactor
      const staleFailure = await this.source.transact(
        tracker.transforms, actionId, newRev,
        this.id, addResult.tailPath.block.header.id
      );

      if (staleFailure) {
        // 5a. Stale failure - remote state has changed
        if (staleFailure.pending) {
          // Wait for pending transactions to complete
          await new Promise(resolve => setTimeout(resolve, PendingRetryDelayMs));
        }
        // Refresh snapshot and retry
        await this.update();
      } else {
        // 5b. Success - update local state
        this.pending = this.pending.slice(pending.length);
        const transforms = tracker.reset();
        await this.replayActions();
        this.sourceCache.transformCache(transforms);
        this.source.trxContext = {
          committed: [...(this.source.trxContext?.committed ?? []), { actionId, rev: newRev }],
          rev: newRev
        };
      }
    }
  } finally {
    release();
  }
}
```

Key aspects of the sync process:

- **Atomic batching**: Groups multiple actions into a single transaction
- **Optimistic concurrency**: Assumes success but handles failures gracefully
- **Stale detection**: Retries when remote state has changed during sync
- **Pending management**: Waits for conflicting transactions to complete
- **State consistency**: Maintains proper revision tracking and cache coherence

## Conflict Resolution

When multiple participants modify the same collection concurrently, conflicts arise. Collections handle this through **action filtering** and **state replay**.

### Conflict Detection and Resolution

```typescript
// Optional conflict filter function
filterConflict?: (action: Action<TAction>, potential: Action<TAction>[]) => Action<TAction> | undefined
```

The conflict resolution process:

1. **Local pending actions** are compared against **remote actions** from the updated log
2. **Conflict filter** determines how to handle each conflict:
   - Return `undefined` to discard the local action
   - Return the original action to keep it unchanged
   - Return a modified action to resolve the conflict
3. **Action replay** applies the remaining local actions to the updated snapshot

### Conflict Resolution Strategies

```typescript
// Example: Last-writer-wins for updates
const filterConflict = (local: UpdateAction, remote: UpdateAction[]) => {
  const hasConflict = remote.some(r => r.data.key === local.data.key);
  return hasConflict ? undefined : local;  // Discard if remote updated same key
};

// Example: Merge compatible operations
const filterConflict = (local: IncrementAction, remote: IncrementAction[]) => {
  const remoteIncrement = remote
    .filter(r => r.data.key === local.data.key)
    .reduce((sum, r) => sum + r.data.value, 0);
  
  // Adjust local increment to account for remote changes
  return {
    ...local,
    data: { ...local.data, value: local.data.value + remoteIncrement }
  };
};
```

## Collection Types

### Tree Collection

Tree collections provide indexed access to data using B-tree data structures:

```typescript
class Tree<TKey, TEntry> {
  // Combines Collection with BTree
  private readonly collection: Collection<TreeReplaceAction<TKey, TEntry>>;
  private readonly btree: BTree<TKey, TEntry>;
}
```

#### Tree Actions

```typescript
// Replace action for tree modifications
type TreeReplaceAction<TKey, TEntry> = [
  key: TKey,
  entry?: TEntry,  // undefined = delete
][];

// Tree operations
await tree.replace([
  ['key1', newEntry1],
  ['key2', undefined],  // Delete key2
  ['key3', newEntry3]
]);
```

#### Tree API

```typescript
// Read operations
const entry = await tree.get('key');
const path = await tree.find('key');
const firstPath = await tree.first();
const lastPath = await tree.last();

// Range queries
for await (const path of tree.range({ from: 'a', to: 'z' })) {
  console.log(tree.at(path));
}

// Navigation
const nextPath = await tree.next(currentPath);
const priorPath = await tree.prior(currentPath);
```

#### Tree Integration

Trees integrate B-tree operations with the collection's action system:

```typescript
const init: CollectionInitOptions<TreeReplaceAction<TKey, TEntry>> = {
  modules: {
    "replace": async ({ data: actions }, trx) => {
      // Action handler - can replay both local and remote actions
      for (const [key, entry] of actions) {
        if (entry) {
          await btree.upsert(entry);
        } else {
          await btree.deleteAt(await btree.find(key));
        }
      }
    }
  },
  createHeaderBlock: (id, store) => ({
    header: store.createBlockHeader(TreeHeaderBlockType, id),
    rootId: btreeRootId,
  })
};
```

The action handler is called during:
- **Local operations**: When `tree.replace()` is called
- **Remote synchronization**: When `update()` processes remote actions  
- **Conflict resolution**: When `replayActions()` re-applies local actions

### Diary Collection

Diary collections provide append-only log storage:

```typescript
class Diary<TEntry> {
  private readonly collection: Collection<TEntry>;
}
```

#### Diary Actions

```typescript
// Simple append action
await diary.append(data);

// Equivalent to:
await collection.act({ type: "append", data });
```

#### Diary API

```typescript
// Create diary
const diary = await Diary.create<MyData>(network, diaryId);

// Append entries
await diary.append(entry1);
await diary.append(entry2);

// Read entries
for await (const entry of diary.select(true)) {  // forward order
  console.log(entry);
}

for await (const entry of diary.select(false)) { // reverse order
  console.log(entry);
}
```

#### Diary Integration

Diaries use the transaction log itself as the primary data store:

```typescript
const init: CollectionInitOptions<TEntry> = {
  modules: {
    "append": async (action, trx) => {
      // Append-only diary doesn't need to modify any blocks
      // All entries are stored in the log
    }
  },
  createHeaderBlock: (id, store) => ({
    header: store.createBlockHeader(DiaryHeaderBlockType, id)
  })
};
```

## Integration with Optimystic

### Block System Integration

Collections are built on Optimystic's block system:

```typescript
// Collections use block operations
const trx = new Atomic(this.tracker);
await handler(action, trx);
trx.commit();

// Block changes are tracked
const transformedIds = tracker.transformedBlockIds();
```

### Transactor and Source Integration

Collections coordinate with a transactor source and a transactor:

```typescript
// TransactorSource handles network communication
const source = new TransactorSource(id, transactor, actionContext);

// Network actions
await source.transact(transforms, actionId, newRev, collectionId, logBlockId);
```

### Caching System

Collections use multi-level caching:

```typescript
// Source cache for unmodified blocks
const sourceCache = new CacheSource(source);

// Transform tracking for modifications
const tracker = new Tracker(sourceCache);

// Cache invalidation on conflicts
this.sourceCache.clear(entry.blockIds);
```

## Usage Patterns

### Simple Data Store

```typescript
// Create a diary for events
const eventLog = await Diary.create<Event>(network, 'events');

// Add events
await eventLog.append({ type: 'user_login', userId: '123' });
await eventLog.append({ type: 'user_logout', userId: '123' });

// Read events
for await (const event of eventLog.select()) {
  processEvent(event);
}
```

### Indexed Data

```typescript
// Create a tree for user data
const userTree = await Tree.createOrOpen<string, User>(
  network, 
  'users',
  user => user.id,  // Key extractor
  (a, b) => a.localeCompare(b)  // Comparator
);

// Update users
await userTree.replace([
  ['user1', { id: 'user1', name: 'Alice' }],
  ['user2', { id: 'user2', name: 'Bob' }]
]);

// Query users
const user = await userTree.get('user1');
for await (const path of userTree.range({ from: 'user1', to: 'user9' })) {
  console.log(userTree.at(path));
}
```

### Custom Collections

```typescript
class CustomCollection<TData> {
  private collection: Collection<CustomAction<TData>>;
  
  static async create<TData>(network: ITransactor, id: CollectionId) {
    const init: CollectionInitOptions<CustomAction<TData>> = {
      modules: {
        "custom_action": async (action, trx) => {
          // Custom logic here
        }
      },
      createHeaderBlock: (id, store) => ({
        header: store.createBlockHeader(CustomHeaderBlockType, id)
      }),
      filterConflict: (local, remote) => {
        // Custom conflict resolution
        return resolveConflict(local, remote);
      }
    };
    
    const collection = await Collection.createOrOpen(network, id, init);
    return new CustomCollection(collection);
  }
}
```
